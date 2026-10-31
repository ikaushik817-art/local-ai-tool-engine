import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOllamaAdapter } from "../adapters/ollama.adapter.js";
import { createOpenAIAdapter } from "../adapters/openai.adapter.js";
import { toChatMessages, cleanReply, parseJson } from "../adapters/shared.js";
import { registerAdapter, createModelAdapter } from "../model.js";
import { createAI } from "../sdk.js";
import { filterRelevantResults, hasSearchIntent, webSearch } from "../tools/webSearch.js";

// Tiny fake model server so adapters are tested without Ollama / LM Studio.
async function fakeServer(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
            const parsed = body ? JSON.parse(body) : {};
            seen.push({ url: req.url, headers: req.headers, body: parsed });
            const out = await handler(req, parsed);
            res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
            res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const user = [{ role: "user", content: "hi" }];

// ---- Ollama ----

test("ollama: normal reply, think tags removed", async () => {
    const s = await fakeServer(() => ({ body: { message: { content: "<think>hmm</think>Hello!" }, done_reason: "stop" } }));
    try {
        const out = await createOllamaAdapter({ baseURL: s.url, model: "m" }).generate(user);
        assert.deepEqual(out, { type: "text", content: "Hello!" });
        assert.equal(s.seen[0].url, "/api/chat");
        assert.equal(s.seen[0].body.model, "m");
    } finally { await s.close(); }
});

test("ollama: truncated reply is flagged", async () => {
    const s = await fakeServer(() => ({ body: { message: { content: "Half an ans" }, done_reason: "length" } }));
    try {
        const out = await createOllamaAdapter({ baseURL: s.url }).generate(user);
        assert.match(out.content, /^Half an ans[\s\S]*cut off/);
    } finally { await s.close(); }
});

test("ollama: missing model gives a pull hint", async () => {
    const s = await fakeServer(() => ({ status: 404, body: { error: "model 'nope' not found" } }));
    try {
        await assert.rejects(createOllamaAdapter({ baseURL: s.url, model: "nope" }).generate(user), /ollama pull nope/);
    } finally { await s.close(); }
});

test("ollama: server not running gives a friendly error", async () => {
    await assert.rejects(createOllamaAdapter({ baseURL: "http://127.0.0.1:1" }).generate(user), /Can't reach Ollama/);
});

test("ollama: slow server times out", async () => {
    const s = await fakeServer(() => new Promise(() => {}));
    try {
        await assert.rejects(createOllamaAdapter({ baseURL: s.url, timeoutMs: 100 }).generate(user), /didn't answer/);
    } finally { await s.close(); }
});

test("ollama: invalid body is rejected", async () => {
    const s = await fakeServer(() => ({ body: { nothing: true } }));
    try {
        await assert.rejects(createOllamaAdapter({ baseURL: s.url }).generate(user), /empty or invalid/);
    } finally { await s.close(); }
});

test("ollama: selectTool parses fenced JSON and rejects junk", async () => {
    let reply = '```json\n{"tool":"echo","arguments":{"a":1}}\n```';
    const s = await fakeServer(() => ({ body: { message: { content: reply } } }));
    try {
        const adapter = createOllamaAdapter({ baseURL: s.url });
        const tools = [{ name: "echo", description: "", parameters: {} }];
        assert.deepEqual(await adapter.selectTool(user, tools), { type: "tool_call", tool: "echo", arguments: { a: 1 } });
        assert.equal(s.seen[0].body.format, "json");
        reply = "I think you should just chat";
        await assert.rejects(adapter.selectTool(user, tools), /invalid tool-selection JSON/);
        reply = '{"tool":"none"}';
        assert.equal((await adapter.selectTool(user, tools)).type, "text");
    } finally { await s.close(); }
});

// ---- OpenAI-compatible (LM Studio etc.) ----

test("openai adapter: works against /chat/completions, optional key, optional model", async () => {
    const s = await fakeServer(() => ({ body: { choices: [{ message: { content: "Hi from LM Studio" }, finish_reason: "stop" }] } }));
    try {
        const out = await createOpenAIAdapter({ baseURL: `${s.url}/v1/`, apiKey: "k" }).generate(user);
        assert.equal(out.content, "Hi from LM Studio");
        assert.equal(s.seen[0].url, "/v1/chat/completions");
        assert.equal(s.seen[0].headers.authorization, "Bearer k");
        assert.equal("model" in s.seen[0].body, false);

        await createOpenAIAdapter({ baseURL: s.url, model: "x" }).generate(user);
        assert.equal(s.seen[1].headers.authorization, undefined);
        assert.equal(s.seen[1].body.model, "x");
    } finally { await s.close(); }
});

test("openai adapter: truncated, error and empty cases", async () => {
    let mode = "length";
    const s = await fakeServer(() => {
        if (mode === "length") return { body: { choices: [{ message: { content: "part" }, finish_reason: "length" }] } };
        if (mode === "err") return { status: 400, body: { error: "No models loaded" } };
        return { body: { choices: [] } };
    });
    try {
        const adapter = createOpenAIAdapter({ baseURL: s.url });
        assert.match((await adapter.generate(user)).content, /cut off/);
        mode = "err";
        await assert.rejects(adapter.generate(user), /400.*No models loaded/);
        mode = "empty";
        await assert.rejects(adapter.generate(user), /empty or invalid/);
    } finally { await s.close(); }
});

test("openai adapter: selectTool works and mid-chat system messages are normalised", async () => {
    const s = await fakeServer(() => ({ body: { choices: [{ message: { content: '{"tool":"echo","arguments":{}}' } }] } }));
    try {
        const adapter = createOpenAIAdapter({ baseURL: s.url });
        const out = await adapter.selectTool([{ role: "user", content: "x" }, { role: "system", content: "Tool result" }], [{ name: "echo", description: "", parameters: {} }]);
        assert.equal(out.tool, "echo");
        const sent = s.seen[0].body.messages;
        assert.equal(sent.filter((m) => m.role === "system").length, 1);
        assert.equal(sent[0].role, "system");
    } finally { await s.close(); }
});

test("shared helpers", () => {
    assert.deepEqual(toChatMessages([
        { role: "system", content: "a" }, { role: "user", content: "b" }, { role: "system", content: "c" }
    ]), [{ role: "system", content: "a" }, { role: "user", content: "b\n\n[note] c" }]);
    assert.equal(cleanReply("<think>x</think> ok "), "ok");
    assert.equal(cleanReply("thinking...</think>answer"), "answer");
    assert.deepEqual(parseJson('sure! {"a":1} done'), { a: 1 });
});

// ---- custom adapters ----

test("registerAdapter: custom adapter works through createAI, duplicates rejected", async () => {
    const unregister = registerAdapter("my-fake", () => ({
        async generate() { return { type: "text", content: "from my adapter" }; },
        async selectTool() { return { type: "text", tool: "none", arguments: {} }; }
    }));
    try {
        assert.equal(await createAI({ provider: "my-fake" }).chat("hello"), "from my adapter");
        assert.throws(() => registerAdapter("my-fake", () => ({})), /already registered/);
        assert.throws(() => registerAdapter("Bad Name", () => ({})), /Adapter name/);
        assert.throws(() => registerAdapter("no-fn", "x"), /must be a function/);
    } finally { unregister(); }
    assert.throws(() => createModelAdapter("my-fake"), /Unsupported AI provider/);
});

test("built-in providers are registered", () => {
    for (const name of ["ollama", "lmstudio", "openai", "openai-compatible"]) {
        assert.equal(typeof createModelAdapter(name).generate, "function");
    }
});

// ---- web search ----

test("search intent: explicit and freshness requests only", () => {
    assert.equal(hasSearchIntent("search for react hooks"), true);
    assert.equal(hasSearchIntent("what is the latest node version"), true);
    assert.equal(hasSearchIntent("official docs for fastify"), true);
    assert.equal(hasSearchIntent("explain binary search"), false);
    assert.equal(hasSearchIntent("write a poem about today"), false);
});

test("search: official sources are ranked first when asked", () => {
    const results = [
        { title: "React hooks tutorial", description: "react hooks guide", link: "https://medium.com/react-hooks" },
        { title: "React Hooks reference", description: "react hooks docs", link: "https://react.dev/reference/react" }
    ];
    assert.equal(filterRelevantResults("react hooks", results, 5, { preferOfficial: true })[0].link, "https://react.dev/reference/react");
});

test("search: duplicate links are removed", () => {
    const r = { title: "Node", description: "node", link: "https://nodejs.org/" };
    assert.equal(filterRelevantResults("node", [r, { ...r }]).length, 1);
});

async function withFetch(fake, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = fake;
    try { return await fn(); } finally { globalThis.fetch = original; }
}

test("search: parses results, and reports blocked / failed / offline", async () => {
    const html = `<div class="result"><a class="result__a" href="https://react.dev/learn">React Learn</a><div class="result__snippet">Learn react hooks</div></div>`;
    const ok = await withFetch(async () => new Response(html), () => webSearch("react hooks"));
    assert.deepEqual(ok.map((r) => r.link), ["https://react.dev/learn"]);

    await withFetch(async () => new Response("", { status: 202 }), () =>
        assert.rejects(webSearch("react hooks"), /rate-limiting/));
    await withFetch(async () => new Response("", { status: 500 }), () =>
        assert.rejects(webSearch("react hooks"), /failed \(500\)/));
    await withFetch(async () => { throw new TypeError("fetch failed"); }, () =>
        assert.rejects(webSearch("react hooks"), /Couldn't reach/));
    assert.deepEqual(await webSearch("asdfghjklqwerty123456"), []);
});

// ---- reasoning models that run out of tokens while "thinking" ----

test("openai adapter: empty answer cut off by the token limit is retried with more room", async () => {
    const s = await fakeServer((_req, body) => body.max_tokens <= 10
        ? { body: { choices: [{ message: { content: null }, finish_reason: "length" }] } }
        : { body: { choices: [{ message: { content: "Here is the answer" }, finish_reason: "stop" }] } });
    try {
        const out = await createOpenAIAdapter({ baseURL: s.url, maxTokens: 10 }).generate(user);
        assert.equal(out.content, "Here is the answer");
        assert.deepEqual(s.seen.map((r) => r.body.max_tokens), [10, 40]);
    } finally { await s.close(); }
});

test("openai adapter: null content without a cut-off is an empty reply, not a crash", async () => {
    const s = await fakeServer(() => ({ body: { choices: [{ message: { content: null }, finish_reason: "stop" }] } }));
    try {
        assert.equal((await createOpenAIAdapter({ baseURL: s.url }).generate(user)).content, "");
    } finally { await s.close(); }
});

test("ollama: thinking that never finishes is retried with more room, then used", async () => {
    const s = await fakeServer((_req, body) => body.options.num_predict <= 10
        ? { body: { message: { content: "<think>let me think about" }, done_reason: "length" } }
        : { body: { message: { content: "<think>done</think>Final answer" }, done_reason: "stop" } });
    try {
        const out = await createOllamaAdapter({ baseURL: s.url, maxTokens: 10 }).generate(user);
        assert.equal(out.content, "Final answer");
    } finally { await s.close(); }
});

test("cleanReply: an unfinished <think> block leaves nothing", () => {
    assert.equal(cleanReply("<think>still going"), "");
    assert.equal(cleanReply("<think>a</think>ok<think>b"), "ok");
});
