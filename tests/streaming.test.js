import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOllamaAdapter } from "../adapters/ollama.adapter.js";
import { createOpenAIAdapter } from "../adapters/openai.adapter.js";
import { createThinkFilter, createTokenSink, postStream } from "../adapters/shared.js";

// A fake model server that sends its reply in pieces, like a real streaming one.
// `plan` is { chunks, status?, body?, hang? } or a function (requestBody, requestNumber) => plan.
async function streamServer(plan, { gap = 5 } = {}) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let text = "";
        req.on("data", (c) => (text += c));
        req.on("end", async () => {
            const body = JSON.parse(text);
            seen.push({ url: req.url, body, headers: req.headers });
            const p = typeof plan === "function" ? plan(body, seen.length) : plan;
            if (p.status && p.status !== 200) { res.writeHead(p.status, { "Content-Type": "application/json" }); return res.end(p.body ?? ""); }
            res.writeHead(200, { "Content-Type": "text/plain" });
            for (const chunk of p.chunks ?? []) {
                res.write(chunk);
                await new Promise((r) => setTimeout(r, gap));
            }
            if (!p.hang) res.end();
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const user = [{ role: "user", content: "hi" }];
const nd = (content, extra = {}) => `${JSON.stringify({ message: { content }, done: false, ...extra })}\n`;
const ndDone = (reason = "stop") => `${JSON.stringify({ done: true, done_reason: reason })}\n`;
const sse = (content, finish) => `data: ${JSON.stringify({ choices: [{ delta: content === null ? {} : { content }, finish_reason: finish ?? null }] })}\n\n`;

function collect() {
    const tokens = [];
    return { tokens, onToken: (t) => tokens.push(t) };
}

// ---- the think filter ----

test("think filter: hides thinking, even when tags are split between chunks", () => {
    const out = [];
    const filter = createThinkFilter((t) => out.push(t));
    for (const piece of ["<thi", "nk>secret ", "plans</th", "ink>Answer ", "text"]) filter.push(piece);
    filter.flush();
    assert.equal(out.join(""), "Answer text");
});

test("think filter: text that only looks like a tag is kept, thinking that never ends is dropped", () => {
    const kept = [];
    const a = createThinkFilter((t) => kept.push(t));
    a.push("a < b and <thi");
    a.flush();
    assert.equal(kept.join(""), "a < b and <thi");

    const dropped = [];
    const b = createThinkFilter((t) => dropped.push(t));
    b.push("before <think>never finishes");
    b.flush();
    assert.equal(dropped.join(""), "before ");
});

test("token sink: leading blank space is skipped and a broken consumer can't break it", () => {
    const out = [];
    const sink = createTokenSink((t) => out.push(t));
    sink.push("\n\n");
    sink.push("  Hello");
    sink.push(" there");
    sink.flush();
    assert.deepEqual(out, ["Hello", " there"]);

    const angry = createTokenSink(() => { throw new Error("consumer bug"); });
    assert.doesNotThrow(() => { angry.push("x"); angry.flush(); });
});

// ---- Ollama streaming ----

test("ollama stream: words arrive as they're generated, even when a line is cut in half", async () => {
    const s = await streamServer({ chunks: [nd("Hel").slice(0, 25), `${nd("Hel").slice(25)}${nd("lo")}`, nd(" world"), ndDone()] });
    try {
        const { tokens, onToken } = collect();
        const out = await createOllamaAdapter({ baseURL: s.url }).generate(user, { onToken });
        assert.equal(tokens.join(""), "Hello world");
        assert.ok(tokens.length >= 3, "arrived in pieces, not one blob");
        assert.deepEqual(out, { type: "text", content: "Hello world" });
        assert.equal(s.seen[0].body.stream, true);
    } finally { await s.close(); }
});

test("ollama stream: thinking is hidden from the stream and the final text", async () => {
    const s = await streamServer({ chunks: [nd("<thi"), nd("nk>secret</th"), nd("ink>\n\nAnswer"), ndDone()] });
    try {
        const { tokens, onToken } = collect();
        const out = await createOllamaAdapter({ baseURL: s.url }).generate(user, { onToken });
        assert.equal(tokens.join(""), "Answer");
        assert.equal(out.content, "Answer");
    } finally { await s.close(); }
});

test("ollama stream: a cut-off answer says so, in the stream and in the result", async () => {
    const s = await streamServer({ chunks: [nd("Half an ans"), ndDone("length")] });
    try {
        const { tokens, onToken } = collect();
        const out = await createOllamaAdapter({ baseURL: s.url }).generate(user, { onToken });
        assert.match(out.content, /^Half an ans[\s\S]*cut off/);
        assert.equal(tokens.join(""), out.content);
    } finally { await s.close(); }
});

test("ollama stream: all tokens spent thinking means one retry with more room", async () => {
    const s = await streamServer((body) => (body.options.num_predict <= 10
        ? { chunks: [nd("<think>hmm let me think"), ndDone("length")] }
        : { chunks: [nd("<think>done</think>Final answer"), ndDone()] }));
    try {
        const { tokens, onToken } = collect();
        const out = await createOllamaAdapter({ baseURL: s.url, maxTokens: 10 }).generate(user, { onToken });
        assert.equal(out.content, "Final answer");
        assert.equal(tokens.join(""), "Final answer");
        assert.deepEqual(s.seen.map((r) => r.body.options.num_predict), [10, 40]);
    } finally { await s.close(); }
});

test("ollama stream: missing model, offline server, silent server and mid-stream errors are all explained", async () => {
    const missing = await streamServer({ status: 404, body: '{"error":"model \'nope\' not found"}' });
    try { await assert.rejects(createOllamaAdapter({ baseURL: missing.url, model: "nope" }).generate(user, { onToken() {} }), /ollama pull nope/); } finally { await missing.close(); }

    await assert.rejects(createOllamaAdapter({ baseURL: "http://127.0.0.1:1" }).generate(user, { onToken() {} }), /Can't reach Ollama/);

    const silent = await streamServer({ chunks: [nd("Hi")], hang: true });
    try { await assert.rejects(createOllamaAdapter({ baseURL: silent.url, timeoutMs: 150 }).generate(user, { onToken() {} }), /didn't answer/); } finally { await silent.close(); }

    const broken = await streamServer({ chunks: [nd("Hi"), `${JSON.stringify({ error: "out of memory" })}\n`] });
    try { await assert.rejects(createOllamaAdapter({ baseURL: broken.url }).generate(user, { onToken() {} }), /Ollama error: out of memory/); } finally { await broken.close(); }
});

test("ollama stream: a consumer that throws doesn't break the answer, and no onToken means the normal path", async () => {
    const s = await streamServer((body) => (body.stream
        ? { chunks: [nd("Fine"), ndDone()] }
        : { chunks: [JSON.stringify({ message: { content: "Plain" }, done_reason: "stop" })] }));
    try {
        const adapter = createOllamaAdapter({ baseURL: s.url });
        assert.equal((await adapter.generate(user, { onToken: () => { throw new Error("my bug"); } })).content, "Fine");
        assert.equal((await adapter.generate(user)).content, "Plain");
        assert.equal(s.seen[1].body.stream, false);
    } finally { await s.close(); }
});

// ---- OpenAI-compatible streaming ----

test("openai stream: server-sent events turn into tokens, [DONE] ends it", async () => {
    const s = await streamServer({ chunks: [sse("Hel"), `${sse("lo").slice(0, 20)}`, `${sse("lo").slice(20)}${sse(" there")}`, sse(null, "stop"), "data: [DONE]\n\n"] });
    try {
        const { tokens, onToken } = collect();
        const out = await createOpenAIAdapter({ baseURL: `${s.url}/v1`, apiKey: "k", model: "m" }).generate(user, { onToken });
        assert.equal(tokens.join(""), "Hello there");
        assert.equal(out.content, "Hello there");
        assert.equal(s.seen[0].body.stream, true);
        assert.equal(s.seen[0].headers.authorization, "Bearer k");
    } finally { await s.close(); }
});

test("openai stream: cut-off notice, new-model token parameter, bad key and in-stream errors", async () => {
    const cut = await streamServer({ chunks: [sse("Part"), sse(null, "length"), "data: [DONE]\n\n"] });
    try {
        const { tokens, onToken } = collect();
        const out = await createOpenAIAdapter({ baseURL: cut.url }).generate(user, { onToken });
        assert.match(out.content, /^Part[\s\S]*cut off/);
        assert.equal(tokens.join(""), out.content);
    } finally { await cut.close(); }

    const swap = await streamServer((body) => ("max_tokens" in body
        ? { status: 400, body: '{"error":"Use max_completion_tokens instead"}' }
        : { chunks: [sse("ok"), "data: [DONE]\n\n"] }));
    try {
        const out = await createOpenAIAdapter({ baseURL: swap.url }).generate(user, { onToken() {} });
        assert.equal(out.content, "ok");
        assert.ok("max_completion_tokens" in swap.seen[1].body && !("max_tokens" in swap.seen[1].body));
    } finally { await swap.close(); }

    const badKey = await streamServer({ status: 401, body: "{}" });
    try { await assert.rejects(createOpenAIAdapter({ baseURL: badKey.url }).generate(user, { onToken() {} }), /rejected the API key/); } finally { await badKey.close(); }

    const broken = await streamServer({ chunks: [sse("Hi"), `data: ${JSON.stringify({ error: { message: "rate limited" } })}\n\n`] });
    try { await assert.rejects(createOpenAIAdapter({ baseURL: broken.url }).generate(user, { onToken() {} }), /rate limited/); } finally { await broken.close(); }
});

test("postStream: a quiet server is cut off after the idle time, but a slow steady one is fine", async () => {
    const slow = await streamServer({ chunks: ["a\n", "b\n", "c\n", "d\n"] }, { gap: 60 });
    try {
        const lines = [];
        await postStream(`${slow.url}/x`, {}, { idleMs: 200, onData: (l) => lines.push(l) });
        assert.deepEqual(lines, ["a", "b", "c", "d"], "total time (~240ms) is longer than idleMs, but it never went quiet");
    } finally { await slow.close(); }
});
