// Watching it: numbers for your monitoring, error alerts, and the log summary.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { createUIServer } from "../server.js";
import { render as renderMetrics, reset as resetMetrics } from "../metrics.js";
import { createLogger, summarize, resetAlerts } from "../logger.js";

const lines = (text) => text.trim().split("\n").map((l) => JSON.parse(l));

async function start() {
    const ai = { chat: async (m) => `echo: ${m}`, agent: async () => ({ answer: "a", stopped: "finished", steps: [] }), clearHistory() {}, getTools: () => [], getHistory: () => [] };
    const { server, token } = createUIServer(ai, { info: { provider: "t", model: "m" } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const call = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: p, headers }, (res) => {
            let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on("error", reject); if (body !== undefined) req.write(body); req.end();
    });
    return { call, token, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test("metrics: off without a token, protected with one, and counting real events (no names, no message text)", async () => {
    resetMetrics();
    const saved = config.metricsToken;
    const s = await start();
    try {
        config.metricsToken = "";
        assert.equal((await s.call("GET", "/api/metrics")).status, 404);
        config.metricsToken = "m-secret-token";
        assert.equal((await s.call("GET", "/api/metrics")).status, 401);
        assert.equal((await s.call("GET", "/api/metrics", { headers: { authorization: "Bearer wrong" } })).status, 401);
        const chat = await s.call("POST", "/api/chat", { headers: { "x-late-token": s.token, "content-type": "application/json" }, body: JSON.stringify({ message: "my secret question" }) });
        assert.equal(lines(chat.text).at(-1).type, "done");
        const ok = await s.call("GET", "/api/metrics", { headers: { authorization: "Bearer m-secret-token" } });
        assert.equal(ok.status, 200);
        assert.match(ok.text, /late_uptime_seconds \d+/);
        assert.match(ok.text, /late_chat_total\{mode="chat",outcome="ok"\} 1/);
        assert.match(ok.text, /late_http_total\{route="\/api\/chat",status="200"\} 1/);
        assert.match(ok.text, /late_active_chats 0/);
        assert.doesNotMatch(ok.text, /secret question/);
    } finally { config.metricsToken = saved; await s.close(); }
    assert.match(renderMetrics(), /late_events_total|late_uptime_seconds/);
});

test("the web chat remembers: /api/history shows what was said (needs the page token)", async () => {
    const s = await start();
    try {
        assert.equal((await s.call("GET", "/api/history")).status, 401);
        const ok = await s.call("GET", "/api/history", { headers: { "x-late-token": s.token } });
        assert.deepEqual(JSON.parse(ok.text), { messages: [] });
    } finally { await s.close(); }
});

test("error alerts: a webhook gets a short redacted message, and a flood is held back to one a minute", async () => {
    const received = [];
    const hook = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push(JSON.parse(b)); res.end("ok"); }); });
    await new Promise((r) => hook.listen(0, "127.0.0.1", r));
    const saved = config.errorWebhook;
    config.errorWebhook = `http://127.0.0.1:${hook.address().port}/hook`;
    resetAlerts();
    try {
        const log = createLogger({ level: "off", file: path.join(os.tmpdir(), "late-alert.log") }); // alerts work even when the log file is off
        log.error("chat_failed", { message: "bad key gsk_O0tohKZXFXrdNPflCP7iWGdyb3FYHiqO9ue9w3i92 for the user" });
        log.error("chat_failed", { message: "second" });
        log.error("chat_failed", { message: "third" });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(received.length, 1, "only one message in the first minute");
        assert.match(received[0].text, /^L\.A\.T\.E\. error: chat_failed/);
        assert.doesNotMatch(received[0].text, /gsk_O0/);
        assert.equal(received[0].event, "chat_failed");
        config.errorWebhook = "http://127.0.0.1:1/never"; // a dead webhook must not break the app
        resetAlerts();
        assert.doesNotThrow(() => log.error("x", {}));
    } finally { config.errorWebhook = saved; hook.close(); resetAlerts(); }
});

test("npm run logs: a summary of what ran, what failed and how slow", () => {
    const text = [
        { time: "2026-01-01T10:00:00Z", level: "info", event: "tool", tool: "calculator", ms: 4 },
        { time: "2026-01-01T10:01:00Z", level: "info", event: "tool", tool: "calculator", ms: 6 },
        { time: "2026-01-01T10:02:00Z", level: "error", event: "tool_failed", tool: "research", ms: 900, message: "no network" },
        { time: "2026-01-01T10:03:00Z", level: "error", event: "chat_failed", message: "model down" }
    ].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n";
    const out = summarize(text);
    assert.match(out, /4 log lines/);
    assert.match(out, /calculator\s+2 calls\s+0 failed\s+avg 5 ms/);
    assert.match(out, /research\s+1 calls\s+1 failed/);
    assert.match(out, /chat_failed\s+1\s+last: model down/);
    assert.match(summarize(""), /none yet/);
});
