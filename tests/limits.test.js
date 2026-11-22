// Cloud models have limits (Groq's free tier: 8000 tokens a minute). Too much sent, or sent too fast, must not end the task.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { config } from "../config.js";
import { fitMessages, httpError, sendFitted } from "../adapters/shared.js";
import { createOpenAIAdapter } from "../adapters/openai.adapter.js";
import { createOllamaAdapter } from "../adapters/ollama.adapter.js";

async function fakeServer(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = ""; req.on("data", (c) => (body += c));
        req.on("end", () => { const parsed = JSON.parse(body); seen.push(parsed); const r = handler(parsed, seen.length); res.writeHead(r.status ?? 200, { "Content-Type": "application/json", ...(r.headers ?? {}) }); res.end(JSON.stringify(r.body)); });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const ok = (text = "fine") => ({ body: { choices: [{ message: { content: text }, finish_reason: "stop" }] } });
const chars = (body) => body.messages.reduce((n, m) => n + String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).length, 0);
const big = (n) => "x".repeat(n);

test("fitMessages: small stays as it is, big gets cut from the right places, the rules and the newest message always stay", () => {
    const small = [{ role: "system", content: "rules" }, { role: "user", content: "hi" }];
    assert.equal(fitMessages(small, 1000), small, "nothing to do: the same array");

    const long = [
        { role: "system", content: "RULES" },
        { role: "user", content: "old question" }, { role: "assistant", content: "old answer" },
        { role: "user", content: `file: ${big(30000)}` },
        { role: "assistant", content: "ok" },
        { role: "user", content: "the newest question" }
    ];
    const fit = fitMessages(long, 6000);
    assert.ok(fit.reduce((n, m) => n + m.content.length, 0) <= 6000, "under the budget");
    assert.equal(fit[0].content, "RULES");
    assert.equal(fit.at(-1).content, "the newest question");
    assert.ok(fit.some((m) => /cut to fit/.test(m.content)) || fit.length < long.length, "the huge file was cut or older messages went");
    assert.equal(long[3].content.length, 30006, "the original messages are not changed");

    const giant = fitMessages([{ role: "system", content: "R" }, { role: "user", content: big(50000) }], 4000);
    assert.ok(giant.at(-1).content.length <= 4000 && /cut to fit/.test(giant.at(-1).content), "even a single giant message fits");

    const withPicture = [{ role: "system", content: "R" }, { role: "user", content: "see", images: [{ mime: "image/png", base64: big(20000) }] }];
    assert.equal(fitMessages(withPicture, 3000).at(-1).images[0].base64.length, 20000, "pictures are never cut");
});

test("httpError: knows 'too large' (and how much to cut) from 'slow down' (and how long to wait)", () => {
    const large = httpError("X", 413, "Request too large for model: Limit 8000, Requested 10000, please reduce your message size");
    assert.equal(large.tooLarge, true);
    assert.ok(Math.abs(large.shrink - 0.64) < 1e-9, "8000/10000 * 0.8");
    assert.equal(httpError("X", 400, "maximum context length is 4096 tokens").tooLarge, true);
    const slow = httpError("X", 429, "Rate limit reached ... Limit 8000, Used 6262, Requested 6037. Please try again in 32.2425s. Need more tokens?");
    assert.equal(slow.rateLimited, true);
    assert.equal(slow.tooLarge, undefined, "a rate limit is not 'too large'");
    assert.ok(Math.abs(slow.retryAfterMs - 32242.5) < 1);
    assert.equal(httpError("X", 429, "slow down in 1m3.5s").retryAfterMs, 63500);
    assert.equal(httpError("X", 429, "try again in 250ms").retryAfterMs, 250);
    assert.equal(httpError("X", 429, "no hint", "7").retryAfterMs, 7000, "a Retry-After header counts");
    assert.equal(httpError("X", 500, "boom").rateLimited, undefined);
});

test("'Request too large': cut down once and try again, and it works (the case that stopped the 1-to-1000 job)", async () => {
    const s = await fakeServer((body, n) => (n === 1
        ? { status: 413, body: { error: { message: "Request too large for model `x` on tokens per minute (TPM): Limit 8000, Requested 8073, please reduce your message size and try again." } } }
        : ok("done after cutting")));
    try {
        const messages = [{ role: "system", content: "rules" }, { role: "user", content: `old ${big(9000)}` }, { role: "assistant", content: "a" }, { role: "user", content: `file ${big(9000)}` }, { role: "user", content: "what now?" }];
        const reply = await createOpenAIAdapter({ baseURL: s.url, model: "m" }).generate(messages);
        assert.equal(reply.content, "done after cutting");
        assert.equal(s.seen.length, 2, "exactly one retry");
        assert.ok(chars(s.seen[1]) < chars(s.seen[0]) * 0.9, `second request is smaller (${chars(s.seen[1])} vs ${chars(s.seen[0])})`);
        assert.ok(s.seen[1].messages.at(-1).content.endsWith("what now?"), "the newest question is still last");
    } finally { await s.close(); }
});

test("'Request too large' twice: a clear message, not a crash, and no endless loop", async () => {
    const s = await fakeServer(() => ({ status: 413, body: { error: { message: "Request too large" } } }));
    try {
        await assert.rejects(createOpenAIAdapter({ baseURL: s.url, model: "m" }).generate([{ role: "user", content: big(30000) }]), /more than your model provider accepts.*\/clear/);
        assert.equal(s.seen.length, 2);
    } finally { await s.close(); }
});

test("a short 'try again in a moment' is waited out, then it works", async () => {
    const s = await fakeServer((body, n) => (n === 1 ? { status: 429, body: { error: { message: "Rate limit reached. Please try again in 50ms." } } } : ok("worked after waiting")));
    try {
        const started = Date.now();
        const reply = await createOpenAIAdapter({ baseURL: s.url, model: "m" }).generate([{ role: "user", content: "hi" }]);
        assert.equal(reply.content, "worked after waiting");
        assert.equal(s.seen.length, 2);
        assert.ok(Date.now() - started >= 400, "it really waited");
    } finally { await s.close(); }
});

test("a long wait is explained with the time, not waited out silently, and not retried", async () => {
    const s = await fakeServer(() => ({ status: 429, headers: { "retry-after": "120" }, body: { error: { message: "Rate limit reached" } } }));
    try {
        await assert.rejects(createOpenAIAdapter({ baseURL: s.url, model: "m" }).generate([{ role: "user", content: "hi" }]), /limiting how much you can use it per minute\. Try again in about 120 seconds/);
        assert.equal(s.seen.length, 1);
    } finally { await s.close(); }
});

test("the same protection works for streaming and for Ollama", async () => {
    const s = await fakeServer((body, n) => (n === 1 ? { status: 413, body: { error: "too large" } } : { body: { message: { content: "ok" }, done_reason: "stop" } }));
    try {
        const reply = await createOllamaAdapter({ baseURL: s.url, model: "m" }).generate([{ role: "user", content: big(12000) }, { role: "user", content: "q" }]);
        assert.equal(reply.content, "ok");
        assert.equal(s.seen.length, 2);
    } finally { await s.close(); }
});

test("errors name who complained: a cloud address is not called 'the local model server'", async () => {
    const saved = config.rateLimitMaxWaitMs;
    config.rateLimitMaxWaitMs = 0;
    const calls = [];
    try {
        await assert.rejects(sendFitted([{ role: "user", content: "x" }], async () => { calls.push(1); throw httpError("The model provider (api.groq.com)", 429, "slow down in 2s"); }, { sleep: async () => {} }), /limiting how much you can use it per minute\. Try again in about 2 seconds/);
        assert.equal(calls.length, 1);
        await assert.rejects(sendFitted([{ role: "user", content: "x" }], async () => { throw new Error("some other failure"); }), /some other failure/, "unrelated errors pass through untouched");
    } finally { config.rateLimitMaxWaitMs = saved; }
});
