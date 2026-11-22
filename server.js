#!/usr/bin/env node
// Local web UI:  npm run ui   (then open the address it prints)
// It only listens on this computer. Every request needs a secret token that is built into the page,
// so another website you happen to have open can't talk to it.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config, activeModelName } from "./config.js";
import { createAI } from "./sdk.js";
import { log } from "./logger.js";
import { inc, render as renderMetrics } from "./metrics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 20 * 1024;
const MAX_MESSAGE = 4000;

const sameToken = (given, expected) => {
    if (typeof given !== "string" || given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let tooBig = false;
        const chunks = [];
        req.on("data", (chunk) => {
            if (tooBig) return; // keep draining quietly; the connection is closed after we answer
            size += chunk.length;
            if (size > MAX_BODY) { tooBig = true; chunks.length = 0; reject(Object.assign(new Error("Message is too big."), { status: 413 })); return; }
            chunks.push(chunk);
        });
        req.on("end", () => { if (!tooBig) resolve(Buffer.concat(chunks).toString("utf8")); });
        req.on("error", reject);
    });
}

const KNOWN_ROUTES = new Set(["/", "/api/info", "/api/chat", "/api/clear", "/api/approve", "/api/health", "/api/history", "/api/metrics"]);

// `ai` is a createAI() client. Returns { server, token }; the caller starts listening.
export function createUIServer(ai, { token = randomBytes(24).toString("hex"), html, info = {}, approvalTimeoutMs = 120000, rateLimit = config.rateLimitPerMinute } = {}) {
    const page = html ?? readFileSync(path.join(here, "ui.html"), "utf8");
    const state = { busy: false, pending: null, recent: [] }; // pending: a permission question waiting for the browser
    const started = Date.now();

    const tooMany = () => {
        const now = Date.now();
        while (state.recent.length && now - state.recent[0] > 60000) state.recent.shift();
        if (rateLimit > 0 && state.recent.length >= rateLimit) return Math.max(1, Math.ceil((60000 - (now - state.recent[0])) / 1000));
        state.recent.push(now);
        return 0;
    };

    const send = (res, status, body, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
        res.end(JSON.stringify(body));
    };

    const server = http.createServer(async (req, res) => {
        try {
            const port = server.address()?.port;
            const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
            // Wrong Host header means DNS rebinding, a foreign Origin means another website. Refuse both.
            if (!allowedHosts.includes(String(req.headers.host ?? "").toLowerCase())) return send(res, 403, { error: "Forbidden." });
            if (req.headers.origin && !allowedHosts.some((host) => req.headers.origin === `http://${host}`)) return send(res, 403, { error: "Forbidden." });

            const url = new URL(req.url, "http://localhost");
            const route = KNOWN_ROUTES.has(url.pathname) ? url.pathname : "other";
            res.on("finish", () => inc("late_http_total", { route, status: res.statusCode }));

            if (url.pathname === "/") {
                if (req.method !== "GET") return send(res, 405, { error: "Method not allowed." });
                const nonce = randomBytes(12).toString("hex");
                const body = page.split("__LATE_TOKEN__").join(token).split("__NONCE__").join(nonce);
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "X-Frame-Options": "DENY",
                    "Referrer-Policy": "no-referrer",
                    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
                });
                return res.end(body);
            }

            if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found." });

            // For uptime checks. Says only that it is alive: no model, no tools, no secrets.
            if (url.pathname === "/api/health") {
                if (req.method !== "GET") return send(res, 405, { error: "Method not allowed." });
                return send(res, 200, { ok: true, uptimeSeconds: Math.round((Date.now() - started) / 1000), busy: state.busy });
            }

            // Numbers for your monitoring. Off unless AI_METRICS_TOKEN is set.
            if (url.pathname === "/api/metrics") {
                const given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
                if (!config.metricsToken) return send(res, 404, { error: "Not found." });
                if (!sameToken(given, config.metricsToken)) return send(res, 401, { error: "Wrong or missing token." });
                res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" });
                return res.end(renderMetrics({ late_active_chats: state.busy ? 1 : 0 }));
            }

            if (!sameToken(req.headers["x-late-token"], token)) return send(res, 401, { error: "Wrong or missing token. Reload the page." });

            const methodFor = { "/api/info": "GET", "/api/history": "GET", "/api/chat": "POST", "/api/clear": "POST", "/api/approve": "POST" }[url.pathname];
            if (!methodFor) return send(res, 404, { error: "Not found." });
            if (req.method !== methodFor) return send(res, 405, { error: "Method not allowed." });

            if (url.pathname === "/api/info") {
                return send(res, 200, { ...info, tools: ai.getTools().map(({ name, description }) => ({ name, description })) });
            }
            if (url.pathname === "/api/history") {
                return send(res, 200, { messages: ai.getHistory?.() ?? [] });
            }
            if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "Send JSON." });

            if (url.pathname === "/api/clear") {
                if (state.busy) return send(res, 409, { error: "Still working. Wait for it to finish." });
                ai.clearHistory();
                return send(res, 200, { ok: true });
            }

            if (url.pathname === "/api/approve") {
                let answer;
                try { answer = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "That wasn't valid JSON." }); }
                const pending = state.pending;
                if (!pending || typeof answer?.id !== "string" || answer.id !== pending.id) return send(res, 404, { error: "Nothing is waiting for that answer." });
                pending.finish(answer.allow === true ? true : answer.allow === "all" ? "all" : false); // anything else counts as "no"
                return send(res, 200, { ok: true });
            }

            // /api/chat
            let body;
            try { body = JSON.parse(await readBody(req)); } catch (error) {
                if (error.status === 413) res.setHeader("Connection", "close");
                return send(res, error.status ?? 400, { error: error.status === 413 ? error.message : "That wasn't valid JSON." });
            }
            const message = typeof body?.message === "string" ? body.message.trim() : "";
            if (!message || message.length > MAX_MESSAGE) return send(res, 400, { error: `Write a message (up to ${MAX_MESSAGE} characters).` });
            if (state.busy) return send(res, 409, { error: "Still working on the last message. Wait for it to finish." });
            const wait = tooMany();
            if (wait) { res.setHeader("Retry-After", String(wait)); log.info("rate_limited", { waitSeconds: wait }); return send(res, 429, { error: `Too many messages. Try again in ${wait} seconds.` }); }

            state.busy = true; // one at a time: the chat history is shared
            const mode = body.mode === "agent" ? "agent" : "chat";
            res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            const write = (event) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };

            // Some tools (like write_file) ask first. The question goes to the browser and we wait for its answer.
            // No answer in time, or the page was closed, counts as "no".
            const askBrowser = (request) => new Promise((resolve) => {
                const id = randomBytes(8).toString("hex");
                const timer = setTimeout(() => finish(false), approvalTimeoutMs);
                const finish = (allow) => { clearTimeout(timer); if (state.pending?.id === id) state.pending = null; resolve(allow); };
                state.pending = { id, finish };
                write({ type: "approval", id, tool: request.tool, args: request.args, preview: request.preview });
            });
            res.on("close", () => state.pending?.finish(false));

            const options = { onStep: write, onToken: (text) => write({ type: "token", text }), confirm: askBrowser };
            try {
                if (mode === "agent") {
                    const result = await ai.agent(message, options);
                    write({ type: "done", answer: result.answer, stopped: result.stopped });
                } else {
                    write({ type: "done", answer: await ai.chat(message, options) });
                }
                inc("late_chat_total", { mode, outcome: "ok" });
            } catch (error) {
                inc("late_chat_total", { mode, outcome: "error" });
                log.error("chat_failed", { mode, message: error.message });
                write({ type: "error", message: error.message });
            } finally {
                state.pending?.finish(false);
                state.busy = false;
                res.end();
            }
        } catch (error) {
            log.error("server_error", { message: error?.message });
            if (!res.headersSent) send(res, 500, { error: "Something went wrong." });
            else res.end();
        }
    });

    // Slow or stalled clients can't hold a connection open forever.
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;

    return { server, token };
}

function startUI() {
    // AI_KEEP_HISTORY=on: the web chat is remembered after you close it too (its own file, apart from the terminal chat).
    const ai = createAI({ historyFile: config.keepHistory ? config.historyFile.replace(/(\.json)?$/, "-web$1") : undefined });
    const { server } = createUIServer(ai, { info: { provider: config.provider, model: activeModelName() } });

    server.on("error", (error) => {
        console.error(error.code === "EADDRINUSE"
            ? `Port ${config.uiPort} is busy. Try another one: AI_UI_PORT=4000 npm run ui`
            : `Could not start the web UI: ${error.message}`);
        process.exit(1);
    });
    server.listen(config.uiPort, config.uiHost, () => {
        console.log("L.A.T.E. web UI is running.");
        console.log(`Open: http://127.0.0.1:${server.address().port}`);
        const local = ["127.0.0.1", "localhost", "::1"].includes(config.uiHost);
        console.log(local ? "Only this computer can reach it. Press Ctrl+C to stop." : `WARNING: listening on ${config.uiHost}. Anyone who can reach this port can reach the page. Publish the port only to 127.0.0.1 (see SECURITY.md).`);
    });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) startUI();
