// Things a real person hit while using it. Each test is one of those moments.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { config } from "../config.js";
import { createOpenAIAdapter } from "../adapters/openai.adapter.js";
import { createToolEngine, guessLocalTool } from "../engine/toolEngine.js";
import { createToolRegistry } from "../tools/registry.js";
import { createMemory } from "../memory.js";
import { hasSearchIntent } from "../tools/webSearch.js";

const root = mkdtempSync(path.join(os.tmpdir(), "ai-regress-"));
config.filesDir = root;
const outDir = path.join(root, "ai-output");
const saved = () => (existsSync(outDir) ? readdirSync(outDir).sort() : []);

async function fakeServer(plan) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let text = "";
        req.on("data", (c) => (text += c));
        req.on("end", () => {
            const body = JSON.parse(text);
            seen.push(body);
            const p = plan(body, seen.length);
            res.writeHead(p.status ?? 200, { "Content-Type": p.stream ? "text/event-stream" : "application/json" });
            res.end(p.stream ? p.stream : JSON.stringify(p.body ?? {}));
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const TOOL_ERROR = "Tool choice is none, but model called a tool";
const ok = { body: { choices: [{ message: { content: "Plain reply" }, finish_reason: "stop" }] } };
const user = [{ role: "user", content: "hi" }];

// ---- "Tool choice is none, but model called a tool" (a Groq model tried to call a tool that doesn't exist) ----

test("model tries to call a tool: one retry with a clear note fixes it (normal and streaming)", async () => {
    const s = await fakeServer((_b, n) => (n === 1 ? { status: 400, body: { error: { message: TOOL_ERROR } } } : ok));
    try {
        const out = await createOpenAIAdapter({ baseURL: s.url }).generate(user);
        assert.equal(out.content, "Plain reply");
        assert.equal(s.seen.length, 2);
        assert.equal(s.seen[0].messages[0].role, "user", "first try is untouched");
        assert.equal(s.seen[1].messages[0].role, "system");
        assert.match(s.seen[1].messages[0].content, /no tools or functions/i);
    } finally { await s.close(); }

    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const live = await fakeServer((_b, n) => (n === 1
        ? { stream: sse({ error: { message: TOOL_ERROR } }) }
        : { stream: `${sse({ choices: [{ delta: { content: "Streamed " } }] })}${sse({ choices: [{ delta: { content: "fine" }, finish_reason: "stop" }] })}data: [DONE]\n\n` }));
    try {
        const tokens = [];
        const out = await createOpenAIAdapter({ baseURL: live.url }).generate(user, { onToken: (t) => tokens.push(t) });
        assert.equal(out.content, "Streamed fine");
        assert.equal(tokens.join(""), "Streamed fine");
        assert.equal(live.seen.length, 2);
    } finally { await live.close(); }
});

test("model tries to call a tool: tool selection is retried too, a second failure is explained, other errors are left alone", async () => {
    const picking = await fakeServer((_b, n) => (n === 1
        ? { status: 400, body: { error: { message: TOOL_ERROR } } }
        : { body: { choices: [{ message: { content: '{"tool":"none","arguments":{}}' } }] } }));
    try {
        const out = await createOpenAIAdapter({ baseURL: picking.url }).selectTool(user, [{ name: "echo", description: "", parameters: {} }]);
        assert.equal(out.type, "text");
    } finally { await picking.close(); }

    const stubborn = await fakeServer(() => ({ status: 400, body: { error: { message: TOOL_ERROR } } }));
    try {
        await assert.rejects(createOpenAIAdapter({ baseURL: stubborn.url }).generate(user), /keeps trying to call a tool that doesn't exist.*another model/);
        assert.equal(stubborn.seen.length, 2, "exactly one retry, not a loop");
    } finally { await stubborn.close(); }

    const other = await fakeServer(() => ({ status: 500, body: { error: { message: "something else went wrong" } } }));
    try {
        await assert.rejects(createOpenAIAdapter({ baseURL: other.url }).generate(user), /something else went wrong/);
        assert.equal(other.seen.length, 1, "unrelated errors aren't retried");
    } finally { await other.close(); }
});

// ---- "create a file named test.txt containing: Apple Banana Orange" ----

function engineFor({ confirm, generate } = {}) {
    const calls = { generate: [], selectTool: 0 };
    const model = {
        async generate(messages) { calls.generate.push(messages); return generate ? generate(messages) : { content: "model answer" }; },
        async selectTool() { calls.selectTool++; throw new Error("a clear request like this must not depend on the model picking a tool"); }
    };
    return { engine: createToolEngine(model, createToolRegistry(), { memory: createMemory(), confirm }), calls };
}

test("creating a file from plain words: asks first, then saves exactly the text, without the model choosing", async () => {
    const asked = [];
    const { engine, calls } = engineFor({ confirm: async (r) => { asked.push(r); return true; } });
    const answer = await engine.run("create a file named test.txt containing: Apple Banana Orange");
    assert.equal(answer, "Saved to ai-output/test.txt (19 bytes)");
    assert.equal(readFileSync(path.join(outDir, "test.txt"), "utf8"), "Apple Banana Orange");
    assert.deepEqual(asked[0].preview, { file: "test.txt", bytes: 19, text: "Apple Banana Orange" });
    assert.equal(calls.selectTool, 0);
});

test("creating a file: saying no saves nothing, and there's no way to ask means nothing is written", async () => {
    const before = saved();
    const no = engineFor({ confirm: async () => false });
    assert.match(await no.engine.run("create a file named never.txt containing: secret"), /^write_file failed: You said no/);
    const silent = engineFor();
    assert.match(await silent.engine.run("create a file named never.txt containing: secret"), /needs your permission/);
    assert.deepEqual(saved(), before);
});

test("creating a file: many ways of saying it, a missing extension, quotes, and a missing text", async () => {
    const registry = createToolRegistry();
    const pick = (q) => guessLocalTool(q, registry);
    const file = (path, content) => ({ tool: "write_file", args: { path, content } });

    assert.deepEqual(pick("Create a file named test.txt containing: Apple Banana Orange"), file("test.txt", "Apple Banana Orange"));
    assert.deepEqual(pick("please make a new file called notes.md with: hello there"), file("notes.md", "hello there"));
    assert.deepEqual(pick("write a text file named list.txt that says buy milk"), file("list.txt", "buy milk"));
    assert.deepEqual(pick("create a file named ideas containing: one two"), file("ideas.txt", "one two"), "no extension means .txt");
    assert.deepEqual(pick('create a file named q.txt containing: "quoted text"'), file("q.txt", "quoted text"));
    assert.deepEqual(pick('write "hello world" to greeting.md'), file("greeting.md", "hello world"));
    assert.deepEqual(pick("create a file named multi.txt containing: line one\nline two"), file("multi.txt", "line one\nline two"));

    assert.match(pick("Create a file named test.txt containing:").reply, /What should test\.txt contain\? .*create a file named test\.txt containing: your text here/);
    assert.match(pick("create a file named test.txt").reply, /What should test\.txt contain/);
    assert.match(pick("create a file named run.exe containing: x").reply, /only save \.md, \.txt, \.json or \.csv/);

    // Not a file request, or an unsafe name: left alone (the engine's normal rules and safety checks apply).
    for (const q of ["write a poem about files", "I need to create a file for my boss", "create a file", "save my work", "make a file named ../escape.txt containing: x"]) {
        assert.equal(pick(q), null, q);
    }
});

test("creating a file with no text asks for it, instead of calling the model or asking permission", async () => {
    let asked = 0;
    const { engine, calls } = engineFor({ confirm: async () => { asked++; return true; } });
    const answer = await engine.run("Create a file named test.txt containing: ");
    assert.match(answer, /What should test\.txt contain\?/);
    assert.equal(asked, 0);
    assert.equal(calls.generate.length, 0);
    assert.ok(!saved().includes("test-2.txt"));
});

test("the model is told it cannot call tools itself, and how to ask for what it can't do alone", async () => {
    const { engine, calls } = engineFor();
    await engine.run("hello there");
    const prompt = calls.generate[0][0].content;
    assert.match(prompt, /can't call functions or tools yourself/);
    assert.match(prompt, /create a file named notes\.txt containing/);
    assert.ok(!/You can read local text files/.test(prompt), "no promise that confuses the model");
});

// ---- "Who won the most recent FIFA World Cup?" and population questions ----

test("questions about recent facts search the web; chat and old facts don't", () => {
    for (const q of [
        "Who won the most recent FIFA World Cup?",
        "Find the current population of Japan and calculate what 15% of it is.",
        "who is the current prime minister of India",
        "what is the most recent iPhone",
        "is it raining right now in Mumbai",
        "tell me the latest cricket score",
        "what happened last week in tech"
    ]) assert.equal(hasSearchIntent(q), true, q);

    for (const q of [
        "hlo", "how are you today?", "what's up today", "write a poem about today", "explain binary search",
        "what is the current in a wire", "what is electric current", "who wrote Hamlet", "what is the capital of France",
        "create a file named test.txt containing: Apple Banana Orange", "I had a recent dream about flying"
    ]) assert.equal(hasSearchIntent(q), false, q);
});

test("a recent-fact question is answered from a search, not from the model's old memory", async () => {
    const registry = createToolRegistry();
    const queries = [];
    registry.getTool("web_search").execute = async ({ query }) => {
        queries.push(query);
        return [{ title: "World Cup winners", description: "Argentina won the 2022 FIFA World Cup", link: "https://example.org/wc" }];
    };
    const model = { async generate() { return { content: "Argentina won it most recently." }; }, async selectTool() { throw new Error("not needed"); } };
    const engine = createToolEngine(model, registry, { memory: createMemory() });
    const answer = await engine.run("Who won the most recent FIFA World Cup?");
    assert.deepEqual(queries, ["Who won the most recent FIFA World Cup"]);
    assert.match(answer, /^Argentina won it most recently\.\n\nSources:\n- World Cup winners: https:\/\/example\.org\/wc/);
});

// ---- "calculate 15% of 80" gave 0.15, and "...0.001% of it" printed 0.00001 ----

import { calculate } from "../tools/calculator.js";
import { getCalculationExpression } from "../engine/toolEngine.js";
import { weather, numbersInText, baseIsGrounded, parseFollowUp } from "../tools/more.js";
import { filterRelevantResults } from "../tools/webSearch.js";

test("percent of a number means percent of THAT number (15% of 80 is 12, not 0.15)", async () => {
    assert.equal(calculate("15% of 80"), 12);
    assert.equal(calculate("15 percent of 200"), 30);
    assert.equal(calculate("20% of 150"), 30);
    assert.equal(calculate("0.001% of 1421000000"), 14210);
    assert.equal(calculate("10%"), 0.1, "a bare percent is unchanged");
    assert.equal(calculate("10 % 3"), 1, "and so is the remainder");
    assert.equal(calculate("5% * 80"), 4);

    assert.equal(getCalculationExpression("calculate 15% of 80"), "15% of 80");
    assert.equal(getCalculationExpression("what is 15% of 80?"), "15% of 80");
    assert.equal(getCalculationExpression("what's 20 percent of 150"), "20% of 150");
    assert.equal(getCalculationExpression("calculate 15% of 1,000 please"), "15% of 1000");
    assert.equal(getCalculationExpression("I got 15% of 80 marks"), null, "not a request");
    assert.equal(getCalculationExpression("calculate 245 * 37"), "245 * 37", "ordinary sums are untouched");

    const { engine } = engineFor();
    assert.equal(await engine.run("calculate 15% of 80"), "15% of 80 = 12");
    assert.equal(await engine.run("what is 20% of 150?"), "20% of 150 = 30");
});

test("'15% of it' is not a sum on its own (it needs something to apply to)", () => {
    for (const q of ["Find the current population of India and calculate 0.001% of it", "calculate 15% of that", "what is the price and calculate 10% of it"]) {
        assert.equal(getCalculationExpression(q), null, q);
    }
});

test("follow-up maths: finds the math part, reads numbers like '1.4 billion', and refuses numbers that aren't in the sources", () => {
    assert.equal(parseFollowUp("find the population of India and calculate 0.001% of it").label, "0.001% of it");
    assert.equal(parseFollowUp("get the price and double it").label, "double of it");
    assert.equal(parseFollowUp("what is the population of Japan"), null);
    assert.equal(parseFollowUp("calculate 15% of 80"), null, "that one has its own number");

    assert.deepEqual(numbersInText("about 1.421 billion (1421 million) people, 17.8% of the world, 2,500 km").sort((a, b) => a - b), [17.8, 2500, 1421000000, 1421000000]);
    assert.equal(baseIsGrounded(1421000000, "about 1.421 billion people"), true);
    assert.equal(baseIsGrounded(1422000000, "about 1.421 billion people"), true, "within half a percent");
    assert.equal(baseIsGrounded(1500000000, "about 1.421 billion people"), false, "an invented figure");
    assert.equal(baseIsGrounded(NaN, "about 1.421 billion people"), false);
});

function searchAndMath(modelReply) {
    const prompts = [];
    const registry = createToolRegistry();
    registry.getTool("web_search").execute = async () => [{ title: "India population", description: "India's population is about 1.421 billion people in 2026", link: "https://example.org/in" }];
    const model = {
        async generate(messages) {
            const text = JSON.stringify(messages);
            prompts.push(text);
            return { content: text.includes("Reply with ONLY JSON") ? modelReply : "India has about 1.421 billion people." };
        },
        async selectTool() { throw new Error("not needed"); }
    };
    return { engine: createToolEngine(model, registry, { memory: createMemory() }), prompts };
}

test("search + maths: the figure comes from the sources, the calculator does the maths, shown before the sources", async () => {
    const { engine, prompts } = searchAndMath('{"number": 1421000000}');
    const answer = await engine.run("Find the current population of India and calculate 0.001% of it");
    assert.equal(answer, "India has about 1.421 billion people.\n\nCalculation: 0.001% of 1,421,000,000 = 14,210\n\nSources:\n- India population: https://example.org/in");
    assert.match(prompts[0], /Do not calculate it yourself/, "the model is told not to do the maths");
    assert.ok(!/0\.00001/.test(answer), "the old nonsense line is gone");

    const double = searchAndMath('{"number": 1421000000}');
    assert.match(await double.engine.run("Find the current population of India and double it"), /Calculation: double 1,421,000,000 = 2,842,000,000/);
});

test("search + maths: a number that isn't in the sources, or a garbled reply, is never calculated", async () => {
    for (const reply of ['{"number": 1500000000}', "it's about one and a half billion", '{"number": "abc"}', "{broken json"]) {
        const { engine } = searchAndMath(reply);
        const answer = await engine.run("Find the current population of India and calculate 0.001% of it");
        assert.match(answer, /couldn't pin down the exact number for "0\.001% of it", so I didn't calculate it/, reply);
        assert.ok(!/Calculation:/.test(answer), reply);
        assert.match(answer, /^India has about 1\.421 billion people\./, "the search answer itself is still shown");
    }
});

test("search without maths asks the model once; a failed search never reaches the maths step", async () => {
    const { engine, prompts } = searchAndMath("{}");
    await engine.run("Find the current population of India");
    assert.equal(prompts.length, 1);

    const registry = createToolRegistry();
    registry.getTool("web_search").execute = async () => { throw new Error("rate-limiting requests"); };
    const calls = [];
    const model = { async generate(m) { calls.push(m); return { content: "x" }; }, async selectTool() { throw new Error("n"); } };
    const answer = await createToolEngine(model, registry, { memory: createMemory() }).run("Find the current population of India and calculate 0.001% of it");
    assert.match(answer, /Web search failed: rate-limiting/);
    assert.equal(calls.length, 0);
});

test("search answers know today's date, and are told not to pad or assume which day 'yesterday' was", async () => {
    const { engine, prompts } = searchAndMath("{}");
    await engine.run("What did Microsoft announce yesterday?");
    assert.ok(prompts[0].includes(`Today's date is ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`));
    assert.match(prompts[0], /real date of the events when the sources show it/);
    assert.match(prompts[0], /say plainly when they don't show it instead of assuming/);
    assert.match(prompts[0], /don't add generic details/);
});

// ---- "Delhi and convert it to Fahrenheit" was taken as a city name ----

test("weather: only the city is the city, and Fahrenheit is asked of the service (exact), not guessed", async () => {
    const registry = createToolRegistry();
    const pick = (q) => guessLocalTool(q, registry);
    assert.deepEqual(pick("What is the current temperature in Delhi and convert it to Fahrenheit?"), { tool: "weather", args: { city: "Delhi", unit: "fahrenheit" } });
    assert.deepEqual(pick("temperature in Delhi in °C"), { tool: "weather", args: { city: "Delhi", unit: "celsius" } });
    assert.deepEqual(pick("weather in Delhi in F"), { tool: "weather", args: { city: "Delhi", unit: "fahrenheit" } });
    assert.deepEqual(pick("what's the weather in New Delhi today?"), { tool: "weather", args: { city: "New Delhi" } });
    assert.deepEqual(pick("weather in Delhi and Mumbai"), { tool: "weather", args: { city: "Delhi" } });

    const urls = [];
    const geo = { results: [{ name: "Delhi", country: "India", latitude: 28.65, longitude: 77.23 }] };
    const now = (unit) => ({ current: { temperature_2m: 75.2, apparent_temperature: 76, relative_humidity_2m: 50, wind_speed_10m: 8, weather_code: 0 }, current_units: { temperature_2m: unit, apparent_temperature: unit, wind_speed_10m: "km/h" } });
    const get = (unit) => async (url) => { urls.push(url); return url.includes("geocoding") ? geo : now(unit); };

    const f = await weather({ city: "Delhi", unit: "Fahrenheit" }, { getJson: get("°F") });
    assert.match(f, /75\.2°F \(feels like 76°F\)/);
    assert.ok(urls.at(-1).endsWith("&temperature_unit=fahrenheit"));
    await weather({ city: "Delhi", unit: "°F" }, { getJson: get("°F") });
    assert.ok(urls.at(-1).endsWith("&temperature_unit=fahrenheit"));
    await weather({ city: "Delhi" }, { getJson: get("°C") });
    assert.ok(!urls.at(-1).includes("temperature_unit"), "Celsius stays the default");

    const seen = [];
    registry.getTool("weather").execute = async (args) => { seen.push(args); return "Delhi, India: clear sky, 75.2°F"; };
    const model = { async generate() { return { content: "x" }; }, async selectTool() { throw new Error("n"); } };
    const answer = await createToolEngine(model, registry, { memory: createMemory() }).run("What is the current temperature in Delhi and convert it to Fahrenheit?");
    assert.deepEqual(seen, [{ city: "Delhi", unit: "fahrenheit" }]);
    assert.equal(answer, "Delhi, India: clear sky, 75.2°F");
});

// ---- the made-up package got PyPI and NuGet as "sources" ----

const generic = [
    { title: "PyPI · The Python Package Index", description: "Find, install and publish Python packages", link: "https://pypi.org/" },
    { title: "npm Package Version Checker", description: "List all versions of a package", link: "https://stellaxon.com/x" },
    { title: "NuGet Gallery | Packages", description: "Find the latest version of a package", link: "https://www.nuget.org/packages" }
];
const ddgPage = (results) => results.map((r) => `<div class="result"><a class="result__a" href="${r.link}">${r.title}</a><div class="result__snippet">${r.description}</div></div>`).join("");
async function withSearchPage(results, fn) {
    const original = globalThis.fetch;
    try { globalThis.fetch = async () => new Response(ddgPage(results)); return await fn(); } finally { globalThis.fetch = original; }
}

test("a long, generic word in the question never throws good results away", () => {
    // "differences" is the longest word here, but the results are about Ollama and LM Studio, and they must survive.
    const results = [
        { title: "Ollama vs LM Studio: which is better?", description: "A comparison of Ollama and LM Studio for running models locally", link: "https://a.com/1" },
        { title: "Open WebUI with Ollama", description: "Open WebUI is a chat interface that works with Ollama", link: "https://a.com/2" }
    ];
    assert.equal(filterRelevantResults("the differences between Ollama, LM Studio, and Open WebUI", results).length, 2);
    assert.equal(filterRelevantResults("explain the architecture of kubernetes networking", [{ title: "Kubernetes networking", description: "how it works", link: "https://k8s.io/n" }]).length, 1);
});

test("when the answer says nothing was found, the searched pages are not listed as sources, but real answers keep theirs", async () => {
    const make = (reply) => {
        const model = { async generate() { return { content: reply }; }, async selectTool() { throw new Error("n"); } };
        return createToolEngine(model, createToolRegistry(), { memory: createMemory() });
    };
    await withSearchPage(generic, async () => {
        for (const reply of ["I wasn’t able to locate any official package listings for abcxyzsuperframework.", "I couldn't find anything about that.", "I'm sorry, but the sources don't mention it.", "Unable to confirm a current version."]) {
            const answer = await make(reply).run("What is the latest version of a package called abcxyzsuperframework?");
            assert.equal(answer, reply, reply);
            assert.ok(!answer.includes("Sources"), reply);
        }
        const real = await make("The NuGet Gallery lists packages with their latest versions.").run("What is the latest version of a package called abcxyzsuperframework?");
        assert.match(real, /\n\nSources:\n- /, "a real answer keeps its sources");
    });
});

test("research on a comparison question keeps its results (it used to say '0 sources')", async () => {
    const results = [{ title: "Ollama vs LM Studio", description: "Ollama and LM Studio and Open WebUI compared", link: "https://a.com/cmp" }];
    await withSearchPage(results, async () => {
        const registry = createToolRegistry();
        const found = await registry.getTool("research").execute({ question: "the differences between Ollama, LM Studio, and Open WebUI" });
        assert.equal(found.sources.length, 1, "the search finds it, the page can't be opened here so the snippet is used");
        assert.equal(found.sources[0].link, "https://a.com/cmp");
    });
});
