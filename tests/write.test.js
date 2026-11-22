import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { config } from "../config.js";
import { saveToOutput, chatToMarkdown, wikipedia } from "../tools/more.js";
import { createToolRegistry } from "../tools/registry.js";
import { createToolEngine, guessLocalTool } from "../engine/toolEngine.js";
import { createMemory } from "../memory.js";
import { createAI } from "../sdk.js";

const root = mkdtempSync(path.join(os.tmpdir(), "ai-write-"));
config.filesDir = root;
const out = path.join(root, "ai-output");
const saved = () => (existsSync(out) ? readdirSync(out).sort() : []);
const wipe = () => { for (const f of saved()) writeFileSync(path.join(out, f), ""); /* keep names, tests use fresh names */ };

// ---- saveToOutput ----

test("save: creates the folder, writes the file, never overwrites", async () => {
    assert.equal(await saveToOutput("notes.md", "# Hello"), "Saved to ai-output/notes.md (7 bytes)");
    assert.equal(readFileSync(path.join(out, "notes.md"), "utf8"), "# Hello");
    assert.equal(await saveToOutput("notes.md", "second"), "Saved to ai-output/notes-2.md (6 bytes)");
    assert.equal(await saveToOutput("notes.md", "third"), "Saved to ai-output/notes-3.md (5 bytes)");
    assert.equal(readFileSync(path.join(out, "notes.md"), "utf8"), "# Hello", "the first file is untouched");
    assert.match(await saveToOutput("big.txt", "x".repeat(2048)), /\(2\.0 KB\)/);
});

test("save: only plain names with safe extensions are accepted", async () => {
    for (const bad of ["../escape.md", "sub/dir.md", "sub\\dir.md", "/etc/passwd.txt", "C:\\x.md", ".hidden.md", "run.exe", "page.html", "script.js", "noextension", "", "   ", "a\0b.md", `${"x".repeat(120)}.md`]) {
        await assert.rejects(saveToOutput(bad, "text"), /simple file name|only save|too long/, JSON.stringify(bad));
    }
    assert.ok(!existsSync(path.join(root, "escape.md")));
});

test("save: empty, blank and huge content are refused", async () => {
    await assert.rejects(saveToOutput("a.md", ""), /nothing to save/);
    await assert.rejects(saveToOutput("a.md", "  \n "), /nothing to save/);
    await assert.rejects(saveToOutput("a.md", undefined), /nothing to save/);
    await assert.rejects(saveToOutput("a.md", "x".repeat(101 * 1024)), /too big/);
});

test("chatToMarkdown: you and the AI, no system notes", () => {
    const md = chatToMarkdown([
        { role: "system", content: "secret rules" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }
    ], new Date("2026-11-02T09:30:00Z"));
    assert.equal(md, "# L.A.T.E. chat\n\nSaved 2026-11-02 09:30 UTC\n\n**You:** hi\n\n**AI:** hello\n");
    assert.ok(!md.includes("secret"));
});

// ---- write_file asks first ----

function make({ confirm, generate, picks, tools } = {}) {
    const queue = [...(picks ?? [{ tool: "write_file", arguments: { path: "hello.md", content: "hi there" } }])];
    const calls = { generate: [] };
    const model = {
        async generate(messages, opts) { calls.generate.push({ messages, opts }); return generate ? generate(messages, opts) : { content: "model answer" }; },
        async selectTool() { const next = queue.shift(); return next ? { type: "tool_call", ...next } : { type: "text", tool: "none", arguments: {} }; }
    };
    const registry = createToolRegistry();
    for (const [name, execute] of Object.entries(tools ?? {})) registry.getTool(name).execute = execute;
    return { engine: createToolEngine(model, registry, { memory: createMemory(), confirm }), calls, registry };
}
const ASK = "save a note called hello.md that says hi there";

test("write_file: with no way to ask, nothing is written and the reason is shown", async () => {
    const { engine } = make({ generate: () => { throw new Error("model down"); } });
    const answer = await engine.run(ASK);
    assert.match(answer, /write_file failed: "write_file" needs your permission, and this app can't ask/);
    assert.ok(!saved().includes("hello.md"));
});

test("write_file: saying no writes nothing; saying yes writes exactly what was previewed", async () => {
    const no = make({ confirm: async () => false, generate: () => { throw new Error("down"); } });
    assert.match(await no.engine.run(ASK), /You said no, so I didn't run write_file/);
    assert.ok(!saved().includes("hello.md"));

    const seen = [];
    const yes = make({ confirm: async (request) => { seen.push(request); return true; } });
    assert.equal(await yes.engine.run(ASK), "Saved to ai-output/hello.md (8 bytes)");
    assert.equal(readFileSync(path.join(out, "hello.md"), "utf8"), "hi there");
    assert.deepEqual(seen[0], { tool: "write_file", args: { path: "hello.md", content: "hi there" }, preview: { file: "hello.md", bytes: 8, text: "hi there" } });
});

test("write_file: only a real `true` counts as yes", async () => {
    for (const [label, confirm] of [["string yes", async () => "yes"], ["number 1", async () => 1], ["undefined", async () => undefined], ["throws", async () => { throw new Error("prompt crashed"); }]]) {
        const { engine } = make({ confirm, generate: () => { throw new Error("down"); } });
        const before = saved().length;
        assert.match(await engine.run(ASK), /You said no/, label);
        assert.equal(saved().length, before, label);
    }
});

test("write_file: a broken call never bothers the user with a question", async () => {
    let asked = 0;
    const { engine } = make({ picks: [{ tool: "write_file", arguments: { path: "x.md" } }], confirm: async () => { asked++; return true; }, generate: () => { throw new Error("down"); } });
    assert.match(await engine.run(ASK), /Missing argument "content"/);
    assert.equal(asked, 0);
});

test("write_file: a per-question confirm beats the default one, and createAI accepts one", async () => {
    const { engine } = make({ confirm: async () => false, picks: [{ tool: "write_file", arguments: { path: "override.md", content: "ok" } }] });
    assert.match(await engine.run("save override.md", { confirm: async () => true }), /Saved to ai-output\/override\.md/);

    const model = {
        async generate() { return { content: "x" }; },
        async selectTool() { return { type: "tool_call", tool: "write_file", arguments: { path: "sdk.md", content: "from sdk" } }; }
    };
    const ai = createAI({ model, confirm: async () => true });
    assert.match(await ai.chat("save sdk.md please"), /Saved to ai-output\/sdk\.md/);
});

test("write_file: agent mode can research, then save, with permission each time it writes", async () => {
    const research = async () => ({ question: "q", sources: [{ title: "Docs", link: "https://a.dev", excerpt: "text" }] });
    const picks = () => [{ tool: "research", arguments: { question: "hooks" } }, { tool: "write_file", arguments: { path: "report.md", content: "# Report\nhooks are great" } }];

    const yes = make({ picks: picks(), tools: { research }, confirm: async () => true, generate: () => ({ content: "Researched it and saved a report." }) });
    const done = await yes.engine.agent("research hooks and save a report as report.md", { plan: false });
    assert.deepEqual(done.steps.map((s) => [s.tool, s.ok]), [["research", true], ["write_file", true]]);
    assert.match(done.answer, /saved a report/);
    assert.equal(readFileSync(path.join(out, "report.md"), "utf8"), "# Report\nhooks are great");

    const no = make({ picks: picks(), tools: { research }, confirm: async () => false, generate: () => ({ content: "I researched it, but you chose not to save." }) });
    const refused = await no.engine.agent("research hooks and save a report as report.md", { plan: false });
    assert.deepEqual(refused.steps.map((s) => s.ok), [true, false]);
    assert.match(refused.steps[1].summary, /You said no/);
    assert.match(refused.answer, /write_file failed: You said no, so I didn't run write_file\./, "the answer can't read as if it was saved");
    assert.ok(!saved().includes("report-2.md"), "nothing new was written");
});

test("routing: only clear wikipedia requests are claimed", () => {
    const registry = createToolRegistry();
    const pick = (q) => guessLocalTool(q, registry);
    assert.deepEqual(pick("wikipedia Albert Einstein"), { tool: "wikipedia", args: { topic: "Albert Einstein" } });
    assert.deepEqual(pick("wiki about black holes"), { tool: "wikipedia", args: { topic: "black holes" } });
    assert.deepEqual(pick("look up Alan Turing on wikipedia"), { tool: "wikipedia", args: { topic: "Alan Turing" } });
    assert.deepEqual(pick("what does wikipedia say about Mars?"), { tool: "wikipedia", args: { topic: "Mars" } });
    for (const q of ["who is Albert Einstein", "tell me about wikipedia the company", "I wiki-fied my notes"]) assert.equal(pick(q), null, q);
});

// ---- wikipedia ----

const opensearch = (title) => ["x", title ? [title] : [], [], []];
const summary = { title: "Albert Einstein", extract: "Albert Einstein was a German-born theoretical physicist.\n\nHe developed relativity.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Albert_Einstein" } } };

test("wikipedia: finds the page, summarises it, names the source", async () => {
    const urls = [];
    const text = await wikipedia({ topic: "albert einstein" }, { getJson: async (url) => { urls.push(url); return url.includes("opensearch") ? opensearch("Albert Einstein") : summary; } });
    assert.equal(text, "Albert Einstein: Albert Einstein was a German-born theoretical physicist. He developed relativity.\nSource: https://en.wikipedia.org/wiki/Albert_Einstein");
    assert.match(urls[0], /search=albert%20einstein&limit=1/);
    assert.match(urls[1], /\/summary\/Albert_Einstein$/);
});

test("wikipedia: long summaries are shortened, odd pages and missing pages are explained", async () => {
    const long = await wikipedia({ topic: "x" }, { getJson: async (u) => (u.includes("opensearch") ? opensearch("Long") : { title: "Long", extract: "word ".repeat(400) }) });
    assert.ok(long.length < 1100 && /\.\.\.\nSource: /.test(long));

    const multi = await wikipedia({ topic: "mercury" }, { getJson: async (u) => (u.includes("opensearch") ? opensearch("Mercury") : { title: "Mercury", type: "disambiguation", extract: "Mercury may refer to:" }) });
    assert.match(multi, /several meanings/);

    await assert.rejects(wikipedia({ topic: "zzzz" }, { getJson: async () => opensearch(null) }), /couldn't find a Wikipedia page for "zzzz"/);
    await assert.rejects(wikipedia({ topic: "x" }, { getJson: async (u) => (u.includes("opensearch") ? opensearch("Empty") : { extract: "" }) }), /has no summary/);
    await assert.rejects(wikipedia({ topic: " " }), /what to look up/);
    const urls = [];
    await wikipedia({ topic: "a&b#c" }, { getJson: async (u) => { urls.push(u); return u.includes("opensearch") ? opensearch("A/B") : summary; } });
    assert.ok(urls[0].includes("search=a%26b%23c") && urls[1].endsWith("/summary/A%2FB"), "nothing in the topic can change the URL");
});

test("wikipedia: asks politely (User-Agent) and turns network trouble into friendly errors", async () => {
    const original = globalThis.fetch;
    const headers = [];
    try {
        globalThis.fetch = async (url, init) => { headers.push(init.headers["User-Agent"]); return new Response(JSON.stringify(String(url).includes("opensearch") ? opensearch("Albert Einstein") : summary)); };
        await wikipedia({ topic: "einstein" });
        assert.ok(headers.every((h) => h.startsWith("L.A.T.E./")), "Wikipedia asks API users to identify themselves");

        globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
        await assert.rejects(wikipedia({ topic: "x" }), /Couldn't reach Wikipedia/);
        globalThis.fetch = async () => new Response("", { status: 429 });
        await assert.rejects(wikipedia({ topic: "x" }), /error \(429\)/);
    } finally { globalThis.fetch = original; }
});

// ---- words arriving one by one ----

// A model that "types" its answer through onToken, like a streaming adapter does.
const typing = (text) => async (_messages, opts) => {
    for (const word of text.split(/(?<= )/)) opts?.onToken?.(word);
    return { content: text };
};

test("streaming: a plain answer reaches onToken word by word and matches the final answer", async () => {
    const { engine } = make({ generate: typing("Paris is the capital of France.") });
    const tokens = [];
    const answer = await engine.run("what is the capital of France", { onToken: (t) => tokens.push(t) });
    assert.equal(answer, "Paris is the capital of France.");
    assert.equal(tokens.join(""), answer);
    assert.ok(tokens.length > 3);
});

test("streaming: tool answers stream the model's words, and sources are added after", async () => {
    const { engine } = make({
        picks: [], generate: typing("Hooks let function components use state."),
        tools: { research: async () => ({ sources: [{ title: "React Docs", link: "https://react.dev/learn", excerpt: "x" }] }) }
    });
    const tokens = [];
    const answer = await engine.run("research how react hooks work", { onToken: (t) => tokens.push(t) });
    assert.equal(tokens.join(""), "Hooks let function components use state.");
    assert.equal(answer, "Hooks let function components use state.\n\nSources:\n- React Docs: https://react.dev/learn");
});

test("streaming: answers that never use the model, or get checked afterwards, are not streamed", async () => {
    const { engine, calls } = make({ generate: typing("The total is 9,065.") });
    const tokens = [];
    assert.match(await engine.run("what time is it?", { onToken: (t) => tokens.push(t) }), /^It's /);
    assert.equal(calls.generate.length, 0, "an exact tool answer needs no model");
    assert.deepEqual(tokens, []);

    await engine.run("I need 245 items at 37 each, calculate 245 * 37 for the total", { onToken: (t) => tokens.push(t) });
    assert.equal(calls.generate.at(-1).opts, undefined, "the number is checked before it's shown, so no streaming");
    assert.deepEqual(tokens, []);
});

test("streaming: a model that can't stream still works, and a broken onToken can't break the answer", async () => {
    const plain = make({ generate: () => ({ content: "No streaming here." }) });
    const tokens = [];
    assert.equal(await plain.engine.run("hello there", { onToken: (t) => tokens.push(t) }), "No streaming here.");
    assert.deepEqual(tokens, []);

    const typed = make({ generate: typing("Still fine.") });
    assert.equal(await typed.engine.run("hello there", { onToken: () => { throw new Error("my bug"); } }), "Still fine.");
    assert.equal(await typed.engine.run("hello again"), "Still fine.", "and no onToken at all is the normal case");
});

test("streaming: a web search answer streams; agent mode streams only the final answer, not the plan", async () => {
    const search = make({ generate: typing("React hooks are functions."), tools: { web_search: async () => [{ title: "React", description: "react hooks guide", link: "https://react.dev/x" }] } });
    const tokens = [];
    const answer = await search.engine.run("search for react hooks", { onToken: (t) => tokens.push(t) });
    assert.equal(tokens.join(""), "React hooks are functions.");
    assert.match(answer, /^React hooks are functions\.\n\nSources:/);

    const agent = make({ picks: [{ tool: "research", arguments: { question: "time" } }], tools: { research: async () => ({ sources: [] }) }, generate: (m, o) => (JSON.stringify(m).includes("You plan tasks") ? typing("1. check the time")(m, o) : typing("It is time.")(m, o)) });
    const agentTokens = [];
    const out = await agent.engine.agent("what time is it, then answer in a sentence", { onToken: (t) => agentTokens.push(t) });
    assert.equal(agentTokens.join(""), "It is time.", "the plan stays out of the stream");
    assert.equal(out.steps.length, 1);
});
