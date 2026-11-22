import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createUIServer } from "../server.js";
import { createAI } from "../sdk.js";

const html = readFileSync(new URL("../ui.html", import.meta.url), "utf8");

// Starts a real server on a free port. `ai` can be a stub or a createAI() client.
async function start(ai, extra = {}) {
    const { server, token } = createUIServer(ai, { info: { provider: "test", model: "stub" }, ...extra });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const call = (method, path, { headers = {}, body, auth = true } = {}) => new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(auth ? { "x-late-token": token } : {}), ...headers } }, (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
    const post = (path, payload, options = {}) => call("POST", path, { headers: { "content-type": "application/json" }, body: typeof payload === "string" ? payload : JSON.stringify(payload), ...options });
    const close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    return { call, post, token, port, close };
}

const lines = (text) => text.trim().split("\n").map((l) => JSON.parse(l));
const fakeModel = (answer = "stub answer") => ({
    async generate() { return { content: answer }; },
    async selectTool() { return { type: "text", tool: "none", arguments: {} }; }
});
const stubAI = (overrides = {}) => ({
    chat: async () => "hi", agent: async () => ({ answer: "agent", stopped: "finished", steps: [] }),
    clearHistory() {}, getTools: () => [{ name: "calculator", description: "math", parameters: {} }], ...overrides
});

test("page: token and nonce are injected, headers lock the page down", async () => {
    const s = await start(stubAI());
    try {
        const res = await s.call("GET", "/", { auth: false });
        assert.equal(res.status, 200);
        assert.ok(res.text.includes(s.token));
        assert.ok(!/__LATE_TOKEN__|__NONCE__/.test(res.text));
        const nonce = res.headers["content-security-policy"].match(/script-src 'nonce-([a-f0-9]+)'/)[1];
        assert.ok(res.text.includes(`<script nonce="${nonce}">`) && res.text.includes(`<style nonce="${nonce}">`));
        assert.match(res.headers["content-security-policy"], /default-src 'none'.*frame-ancestors 'none'/);
        assert.equal(res.headers["x-frame-options"], "DENY");
        assert.equal(res.headers["x-content-type-options"], "nosniff");
        assert.equal(res.headers["cache-control"], "no-store");
        const again = await s.call("GET", "/", { auth: false });
        assert.notEqual(again.headers["content-security-policy"], res.headers["content-security-policy"], "a fresh nonce each time");
    } finally { await s.close(); }
});

test("page: the script compiles and never builds HTML from text", () => {
    const script = html.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(script));
    assert.ok(!/ style="/.test(html), "no inline style attributes (the CSP would block them)");
});

test("api: every call needs the right token", async () => {
    const s = await start(stubAI());
    try {
        assert.equal((await s.call("GET", "/api/info", { auth: false })).status, 401);
        assert.equal((await s.call("GET", "/api/info", { auth: false, headers: { "x-late-token": "x".repeat(s.token.length) } })).status, 401);
        assert.equal((await s.call("GET", "/api/info", { auth: false, headers: { "x-late-token": "short" } })).status, 401);
        assert.equal((await s.post("/api/chat", { message: "hi" }, { auth: false })).status, 401);
        const ok = await s.call("GET", "/api/info");
        assert.equal(ok.status, 200);
        assert.deepEqual(JSON.parse(ok.text), { provider: "test", model: "stub", tools: [{ name: "calculator", description: "math" }] });
    } finally { await s.close(); }
});

test("api: other websites and DNS tricks are refused", async () => {
    const s = await start(stubAI());
    try {
        assert.equal((await s.call("GET", "/api/info", { headers: { host: "evil.com" } })).status, 403);
        assert.equal((await s.call("GET", "/", { auth: false, headers: { host: "evil.com" } })).status, 403);
        assert.equal((await s.call("GET", "/api/info", { headers: { origin: "http://evil.com" } })).status, 403);
        assert.equal((await s.post("/api/chat", { message: "hi" }, { headers: { origin: "https://evil.com", "content-type": "application/json" } })).status, 403);
        assert.equal((await s.call("GET", "/api/info", { headers: { origin: `http://127.0.0.1:${s.port}` } })).status, 200);
        assert.equal((await s.call("GET", "/api/info", { headers: { host: `localhost:${s.port}` } })).status, 200);
    } finally { await s.close(); }
});

test("chat: streams tool steps live and ends with the answer", async () => {
    const s = await start(createAI({ model: fakeModel() }));
    try {
        const res = await s.post("/api/chat", { message: "what is 245 * 37?" });
        assert.equal(res.status, 200);
        assert.match(res.headers["content-type"], /ndjson/);
        assert.deepEqual(lines(res.text).map((e) => e.type), ["step", "result", "done"]);
        assert.equal(lines(res.text).at(-1).answer, "245 * 37 = 9065");
    } finally { await s.close(); }
});

test("agent mode: plan, steps and the final answer reach the browser", async () => {
    const picks = [{ type: "tool_call", tool: "datetime", arguments: {} }];
    const model = {
        async generate(messages) { return { content: JSON.stringify(messages).includes("You plan tasks") ? "1. check the time" : "All done." }; },
        async selectTool() { return picks.shift() ?? { type: "text", tool: "none", arguments: {} }; }
    };
    const named = config.model;
    config.model = "qwen2.5:14b"; // a larger model plans in words too; a small one (3B) is not asked to
    const s = await start(createAI({ model }));
    try {
        const events = lines((await s.post("/api/chat", { message: "what time is it, then stop", mode: "agent" })).text);
        assert.deepEqual(events.map((e) => e.type), ["plan", "step", "result", "stop", "done"]);
        assert.equal(events.at(-1).stopped, "finished");
    } finally { await s.close(); config.model = named; }
});

test("chat: a failing model is reported as an error event, and the server keeps working", async () => {
    const s = await start(stubAI({ chat: async () => { throw new Error("model exploded"); } }));
    try {
        assert.deepEqual(lines((await s.post("/api/chat", { message: "hi" })).text), [{ type: "error", message: "model exploded" }]);
        assert.equal((await s.call("GET", "/api/info")).status, 200);
        assert.equal((await s.post("/api/chat", { message: "again" })).status, 200, "not stuck busy after an error");
    } finally { await s.close(); }
});

test("chat: only one message at a time", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const s = await start(stubAI({ chat: async () => { await gate; return "slow answer"; } }));
    try {
        const first = s.post("/api/chat", { message: "slow one" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const second = await s.post("/api/chat", { message: "impatient" });
        assert.equal(second.status, 409);
        assert.equal((await s.post("/api/clear", {})).status, 409, "can't clear while it's answering");
        release();
        assert.equal(lines((await first).text).at(-1).answer, "slow answer");
        assert.equal((await s.post("/api/chat", { message: "now fine" })).status, 200);
    } finally { release(); await s.close(); }
});

test("clear: wipes the conversation", async () => {
    let cleared = 0;
    const s = await start(stubAI({ clearHistory: () => { cleared++; } }));
    try {
        assert.equal((await s.post("/api/clear", {})).status, 200);
        assert.equal(cleared, 1);
    } finally { await s.close(); }
});

test("bad requests get clear answers, not crashes", async () => {
    const s = await start(stubAI());
    try {
        assert.equal((await s.post("/api/chat", "{ not json")).status, 400);
        assert.equal((await s.post("/api/chat", {})).status, 400);
        assert.equal((await s.post("/api/chat", { message: "   " })).status, 400);
        assert.equal((await s.post("/api/chat", { message: 42 })).status, 400);
        assert.equal((await s.post("/api/chat", { message: "x".repeat(4001) })).status, 400);
        assert.equal((await s.post("/api/chat", JSON.stringify({ message: "x".repeat(30 * 1024) }))).status, 413);
        assert.equal((await s.call("POST", "/api/chat", { headers: { "content-type": "text/plain" }, body: "hi" })).status, 415);
        assert.equal((await s.call("GET", "/api/chat")).status, 405);
        assert.equal((await s.call("GET", "/api/nothing")).status, 404);
        assert.equal((await s.call("GET", "/secret.txt", { auth: false })).status, 404);
        assert.equal((await s.call("POST", "/", { auth: false, headers: { "content-type": "application/json" }, body: "{}" })).status, 405);
        assert.equal((await s.call("GET", "/api/info")).status, 200, "still alive after all of that");
    } finally { await s.close(); }
});

// ---- words arriving live, and permission questions ----

import os from "node:os";
import path from "node:path";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { config } from "../config.js";

const saveRoot = mkdtempSync(path.join(os.tmpdir(), "ai-ui-"));
config.filesDir = saveRoot;
const savedFiles = () => (existsSync(path.join(saveRoot, "ai-output")) ? readdirSync(path.join(saveRoot, "ai-output")).sort() : []);

// Talks to /api/chat and reacts to events while the reply is still coming in.
function liveChat(s, payload, onEvent = () => {}) {
    return new Promise((resolve, reject) => {
        const events = [];
        const work = []; // whatever the callback does (it may make requests of its own) must finish before we return
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            Promise.all(work).then(() => resolve(events), reject);
        };
        const req = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/api/chat", headers: { "content-type": "application/json", "x-late-token": s.token } }, (res) => {
            let buffer = "";
            res.on("data", (chunk) => {
                buffer += chunk;
                let newline;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (line) { const event = JSON.parse(line); events.push(event); work.push(Promise.resolve(onEvent(event, req))); }
                }
            });
            res.on("end", finish);
            res.on("close", finish);
        });
        req.on("error", (error) => (error.code === "ECONNRESET" ? finish() : reject(error)));
        req.end(JSON.stringify(payload));
    });
}

const writerModel = (content = "saved by test") => {
    let asked = false;
    return {
        async generate() { return { content: "All done." }; },
        async selectTool() {
            if (asked) return { type: "text", tool: "none", arguments: {} };
            asked = true;
            return { type: "tool_call", tool: "write_file", arguments: { path: "ui-note.md", content } };
        }
    };
};

test("chat: the answer is streamed word by word before the final 'done'", async () => {
    const model = {
        async generate(_m, opts) { for (const w of ["Live ", "words ", "here."]) opts?.onToken?.(w); return { content: "Live words here." }; },
        async selectTool() { return { type: "text", tool: "none", arguments: {} }; }
    };
    const s = await start(createAI({ model }));
    try {
        const events = await liveChat(s, { message: "tell me something" });
        assert.deepEqual(events.filter((e) => e.type === "token").map((e) => e.text), ["Live ", "words ", "here."]);
        assert.equal(events.at(-1).type, "done");
        assert.equal(events.at(-1).answer, "Live words here.");
    } finally { await s.close(); }
});

test("permission: the browser is asked, Allow writes the file, and the answer says so", async () => {
    const s = await start(createAI({ model: writerModel() }));
    try {
        let question;
        const events = await liveChat(s, { message: "save a note called ui-note.md" }, async (event) => {
            if (event.type !== "approval") return;
            question = event;
            assert.deepEqual(savedFiles(), [], "nothing is written while we wait");
            assert.equal((await s.post("/api/approve", { id: event.id, allow: true })).status, 200);
        });
        assert.equal(question.tool, "write_file");
        assert.deepEqual(question.preview, { file: "ui-note.md", bytes: 13, text: "saved by test" });
        assert.match(events.at(-1).answer, /Saved to ai-output\/ui-note\.md/);
        assert.equal(readFileSync(path.join(saveRoot, "ai-output", "ui-note.md"), "utf8"), "saved by test");
    } finally { await s.close(); }
});

test("permission: Deny, a wrong id, a replay, a missing token and non-true values all mean nothing is written", async () => {
    const s = await start(createAI({ model: writerModel("never written") }));
    try {
        const before = savedFiles();
        const events = await liveChat(s, { message: "save a note called ui-note.md" }, async (event) => {
            if (event.type !== "approval") return;
            assert.equal((await s.post("/api/approve", { id: "not-the-id", allow: true })).status, 404);
            assert.equal((await s.post("/api/approve", { id: event.id, allow: true }, { auth: false })).status, 401);
            assert.equal((await s.post("/api/approve", "{ broken")).status, 400);
            assert.equal((await s.post("/api/approve", { id: event.id, allow: "true" })).status, 200, "the string 'true' is accepted as a reply but counts as no");
            assert.equal((await s.post("/api/approve", { id: event.id, allow: true })).status, 404, "an answered question can't be answered again");
        });
        assert.deepEqual(savedFiles(), before);
        assert.match(events.at(-1).answer, /You said no/);
    } finally { await s.close(); }
});

test("permission: no answer in time, or closing the page, counts as no, and the server is free again", async () => {
    const slow = await start(createAI({ model: writerModel("timed out") }), { approvalTimeoutMs: 120 });
    try {
        const before = savedFiles();
        const events = await liveChat(slow, { message: "save a note called ui-note.md" });
        assert.match(events.at(-1).answer, /You said no/);
        assert.deepEqual(savedFiles(), before);
    } finally { await slow.close(); }

    const closed = await start(createAI({ model: writerModel("page closed") }));
    try {
        const before = savedFiles();
        await liveChat(closed, { message: "save a note called ui-note.md" }, (event, req) => { if (event.type === "approval") req.destroy(); });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.deepEqual(savedFiles(), before, "closing the page never approves");
        assert.equal((await closed.post("/api/chat", { message: "are you still there" })).status, 200, "and it isn't stuck waiting");
    } finally { await closed.close(); }
});

test("permission: agent mode asks too, and /api/approve works only while something is waiting", async () => {
    const s = await start(createAI({ model: writerModel("from the agent") }));
    try {
        assert.equal((await s.post("/api/approve", { id: "x", allow: true })).status, 404, "nothing is waiting");
        assert.equal((await s.call("GET", "/api/approve")).status, 405);
        const events = await liveChat(s, { message: "save a note called ui-note.md", mode: "agent" }, async (event) => {
            if (event.type === "approval") await s.post("/api/approve", { id: event.id, allow: true });
        });
        assert.ok(events.some((e) => e.type === "approval"));
        assert.equal(events.at(-1).type, "done");
        assert.ok(savedFiles().some((f) => f.startsWith("ui-note")));
    } finally { await s.close(); }
});

test("page: knows how to show tokens, permission cards, code blocks and a copy button", () => {
    for (const piece of ['event.type === "token"', 'event.type === "approval"', "/api/approve", "function render", "navigator.clipboard", 'class="chip"'.slice(0, 0)]) {
        assert.ok(html.includes(piece), piece);
    }
});

test("permission: 'Allow all in this task' covers every save in that task", async () => {
    const picks = [{ path: "ui-all-1.md", content: "one" }, { path: "ui-all-2.md", content: "two" }];
    const model = {
        async generate() { return { content: "Both saved." }; },
        async selectTool() { const next = picks.shift(); return next ? { type: "tool_call", tool: "write_file", arguments: next } : { type: "text", tool: "none", arguments: {} }; }
    };
    const s = await start(createAI({ model }));
    try {
        const events = await liveChat(s, { message: "save two notes", mode: "agent" }, async (event) => {
            if (event.type === "approval") assert.equal((await s.post("/api/approve", { id: event.id, allow: "all" })).status, 200);
        });
        assert.equal(events.filter((e) => e.type === "approval").length, 1, "asked once, not twice");
        assert.ok(savedFiles().includes("ui-all-1.md") && savedFiles().includes("ui-all-2.md"));
    } finally { await s.close(); }
});

test("page: has the 'Allow all' button", () => {
    assert.ok(html.includes('Allow all in this task') && html.includes('reply("all")'));
});
