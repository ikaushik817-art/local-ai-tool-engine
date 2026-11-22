// The contract of the tools, tested without any prompt wording: typed results, every pair of tools that make sense
// together, longer chains, a failure in the middle, and files that already exist. Plans are written as steps, so
// this checks the executor and the tools, not the grammar of the planner.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { config } from "../config.js";
import { createToolRegistry } from "../tools/registry.js";
import { executePlan, checkPlan, formatReport } from "../engine/planner.js";
import { resultText } from "../memory.js";

const root = mkdtempSync(path.join(os.tmpdir(), "ai-contracts-"));
config.filesDir = root;
config.notesFile = path.join(root, "notes.json");
mkdirSync(path.join(root, "ai-output"));
const out = (name) => path.join(root, "ai-output", name);
const saved = (name, text) => writeFileSync(out(name), text);
const fresh = () => writeFileSync(config.notesFile, "[]");

const T = (tool, args = {}, as, extra = {}) => ({ tool, args, as, label: tool, ...extra });
const typedWeather = (registry, celsius = 30) => {
    registry.getTool("weather").execute = async () => ({ place: "Delhi", temperature: celsius, unit: "°C", text: `Delhi: clear sky, ${celsius}°C.` });
    return registry;
};
const withResearch = (registry) => {
    registry.getTool("research").execute = async ({ question }) => ({ question, sources: [{ title: "Docs", link: "https://a.example/1", excerpt: `${question} explained.` }] });
    return registry;
};
async function run(steps, registry = createToolRegistry()) {
    const problem = checkPlan(steps, registry);
    assert.equal(problem, "", problem);
    return executePlan(steps, { registry, runTool: (tool, args) => tool.execute(args, { confirm: async () => true }) });
}

test("every tool that works offline returns a typed result or plain text, never nothing and never [object Object]", async () => {
    fresh();
    saved("smoke.txt", "3 1 2");
    const calls = {
        calculator: { expression: "2+2" }, compare_numbers: { a: 1, b: 1 }, compare_text: { a: "x", b: "x" }, convert: { value: 1, from: "km", to: "m" },
        datetime: {}, number_stats: { numbers: "3 1 2", operation: "max" }, random_numbers: { count: 2, min: 1, max: 9 }, read_file: { path: "smoke.txt" },
        search_files: { query: "smoke" }, text_stats: { text: "a b" }, text_transform: { text: "a", operation: "uppercase" }, write_file: { path: "smoke-new.txt", content: "x" },
        append_file: { path: "smoke.txt", content: "more" }, remember: { text: "contract note" }, recall: {}, forget: { text: "contract note" }
    };
    const registry = createToolRegistry();
    for (const [name, args] of Object.entries(calls)) {
        const result = await registry.getTool(name).execute(args, { confirm: async () => true });
        assert.ok(result !== undefined && result !== null, `${name} returned nothing`);
        assert.ok(resultText(result).length > 0 && !/\[object Object\]|undefined/.test(resultText(result)), `${name}: ${resultText(result)}`);
    }
    // the typed ones say it in fields too
    const typed = { number_stats: ["value", "summary"], text_stats: ["words", "characters"], random_numbers: ["numbers"], write_file: ["path"], convert: ["value", "unit"], compare_numbers: ["equal", "difference"], compare_text: ["equal", "differences"], datetime: ["date"], search_files: ["count", "files"], append_file: ["path", "bytes"], remember: ["saved", "note"], forget: ["removed"], recall: ["count", "notes"] };
    for (const [name, fields] of Object.entries(typed)) {
        const result = await registry.getTool(name).execute(calls[name], { confirm: async () => true });
        for (const field of fields) assert.ok(result[field] !== undefined, `${name}.${field}`);
        assert.equal(typeof result.text, "string", `${name}.text`);
    }
});

const PAIRS = [
    ["random_numbers → number_stats", () => [T("random_numbers", { count: 4, min: 1, max: 50 }, "n"), T("number_stats", { numbers: "{{n}}", operation: "sum" }, "s")],
        (v) => assert.equal(v.s.value, v.n.reduce((a, b) => a + b, 0))],
    ["random_numbers → write_file", () => [T("random_numbers", { count: 3, min: 1, max: 9 }, "n"), T("write_file", { path: "pair-rn.txt", content: "{{n}}" }, "w")],
        (v) => assert.equal(readFileSync(out(v.w), "utf8"), v.n.join(", "))],
    ["number_stats → calculator", () => [T("number_stats", { numbers: "4 9 2", operation: "max" }, "s"), T("calculator", { expression: "{{s.value}}*2" }, "c")],
        (v) => assert.equal(v.c, 18)],
    ["number_stats → compare_numbers", () => [T("number_stats", { numbers: "4 9 2", operation: "max" }, "s"), T("compare_numbers", { a: "{{s.value}}", b: "9" }, "c")],
        (v) => assert.equal(v.c.equal, true)],
    ["number_stats → remember → recall", () => [T("number_stats", { numbers: "4 9 2", operation: "max" }, "s"), T("remember", { text: "{{s.summary}}" }), T("recall", { query: "Largest" }, "r")],
        (v) => assert.match(v.r.text, /Largest: 9/)],
    ["text_stats → calculator", () => [T("text_stats", { text: "a b c" }, "t", { pick: "words" }), T("calculator", { expression: "{{t}}+1" }, "c")],
        (v) => assert.equal(v.c, 4)],
    ["text_stats → write_file", () => [T("text_stats", { text: "a b c" }, "t", { pick: "words" }), T("write_file", { path: "pair-ts.txt", content: "{{t}}" }, "w")],
        (v) => assert.equal(readFileSync(out(v.w), "utf8"), "3")],
    ["read_file → text_stats", () => { saved("pair-a.txt", "x y"); return [T("read_file", { path: "pair-a.txt" }, "r"), T("text_stats", { text: "{{r.content}}" }, "t", { pick: "words" })]; },
        (v) => assert.equal(v.t, 2)],
    ["read_file → number_stats", () => { saved("pair-b.txt", "5 10 20"); return [T("read_file", { path: "pair-b.txt" }, "r"), T("number_stats", { numbers: "{{r.content}}", operation: "sum" }, "s")]; },
        (v) => assert.equal(v.s.value, 35)],
    ["read_file → compare_text", () => { saved("pair-c.txt", "5 10 20\n"); return [T("read_file", { path: "pair-c.txt" }, "r"), T("compare_text", { a: "{{r.content}}", b: "5 10 20" }, "c")]; },
        (v) => assert.equal(v.c.equal, true)],
    ["read_file → write_file", () => { saved("pair-d.txt", "copy me"); return [T("read_file", { path: "pair-d.txt" }, "r"), T("write_file", { path: "pair-d2.txt", content: "{{r.content}}" }, "w")]; },
        (v) => assert.equal(readFileSync(out(v.w), "utf8"), "copy me")],
    ["weather → convert", () => [T("weather", { city: "Delhi" }, "w"), T("convert", { value: "{{w.temperature}}", from: "celsius", to: "fahrenheit" }, "c")],
        (v) => assert.equal(v.c.value, 86), typedWeather],
    ["weather → write_file", () => [T("weather", { city: "Delhi" }, "w"), T("write_file", { path: "pair-w.txt", content: "{{w.text}}" }, "f")],
        (v) => assert.match(readFileSync(out(v.f), "utf8"), /Delhi: clear sky, 30°C/), typedWeather],
    ["weather → calculator", () => [T("weather", { city: "Delhi" }, "w"), T("calculator", { expression: "{{w.temperature}}*2" }, "c")],
        (v) => assert.equal(v.c, 60), typedWeather],
    ["calculator → write_file", () => [T("calculator", { expression: "6*7" }, "c"), T("write_file", { path: "pair-calc.txt", content: "{{c}}" }, "w")],
        (v) => assert.equal(readFileSync(out(v.w), "utf8"), "42")],
    ["calculator → compare_numbers", () => [T("calculator", { expression: "6*7" }, "c"), T("compare_numbers", { a: "{{c}}", b: "42" }, "m")],
        (v) => assert.equal(v.m.equal, true)],
    ["research → write_file", () => [T("research", { question: "hooks" }, "r"), T("write_file", { path: "pair-r.txt", content: "{{r}}" }, "w")],
        (v) => assert.match(readFileSync(out(v.w), "utf8"), /https:\/\/a\.example\/1/), withResearch],
    ["research → remember → recall", () => [T("research", { question: "hooks" }, "r"), T("remember", { text: "hooks were researched" }), T("recall", { query: "hooks" }, "m")],
        (v) => assert.match(v.m.text, /hooks were researched/), withResearch],
    ["remember → recall → forget → recall", () => [T("remember", { text: "pair favorite is 1" }), T("remember", { text: "pair favorite is 2" }), T("forget", { text: "the latest one" }), T("recall", { query: "pair favorite" }, "m")],
        (v) => assert.match(v.m.text, /is 1/) && assert.doesNotMatch(v.m.text, /is 2/) && assert.equal(v.m.count, 1)],
    ["convert → write_file", () => [T("convert", { value: 2, from: "km", to: "m" }, "c"), T("write_file", { path: "pair-conv.txt", content: "{{c}}" }, "w")],
        (v) => assert.match(readFileSync(out(v.w), "utf8"), /2000/)],
    ["datetime → write_file", () => [T("datetime", {}, "d"), T("write_file", { path: "pair-date.txt", content: "{{d}}" }, "w")],
        (v) => assert.match(readFileSync(out(v.w), "utf8"), /20\d\d/)]
];
for (const [name, build, check, prepare = (r) => r] of PAIRS) {
    test(`pair: ${name}`, async () => {
        fresh();
        const result = await run(build(), prepare(createToolRegistry()));
        assert.equal(result.stopped, "finished", result.problem);
        check(result.vars);
    });
}

test("chain: numbers → files → read → stats → report → read back → compare, in one plan", async () => {
    const steps = [
        T("random_numbers", { count: 5, min: 1, max: 1000 }, "n"),
        T("write_file", { path: "chain{{i}}.txt", content: "{{item}}" }, "made", { each: "n" }),
        T("read_file", { path: "{{item}}" }, "reads", { each: "made" }),
        T("number_stats", { numbers: "{{reads.content}}", labels: "{{reads.file}}", operation: "max" }, "s"),
        T("write_file", { path: "chain-report.txt", content: "{{s.summary}}" }, "rep"),
        T("read_file", { path: "{{rep}}" }, "back"),
        T("compare_text", { a: "{{s.summary}}", b: "{{back.content}}" }, "check")
    ];
    const result = await run(steps);
    assert.equal(result.stopped, "finished", result.problem);
    assert.equal(result.vars.s.value, Math.max(...result.vars.n));
    assert.equal(result.vars.check.equal, true);
});

test("a step that fails in the middle keeps the finished steps and says what was skipped", async () => {
    const steps = [T("random_numbers", { count: 2, min: 1, max: 9 }, "n"), T("write_file", { path: "recover.txt", content: "{{n}}" }, "w"), T("read_file", { path: "no-such-file.txt" }, "r"), T("write_file", { path: "never.txt", content: "x" })];
    const result = await run(steps);
    assert.equal(result.stopped, "failed");
    assert.equal(result.used.filter((u) => !u.error).length, 2, "steps 1 and 2 are kept");
    assert.equal(readFileSync(out(result.vars.w), "utf8").length > 0, true);
    const report = formatReport(result);
    assert.match(report, /I stopped at step 3 because/);
    assert.match(report, /Not done: /);
});

test("files that already exist: every later step follows the real name", async () => {
    saved("collide.txt", "old");
    const result = await run([T("write_file", { path: "collide.txt", content: "new" }, "w"), T("append_file", { path: "collide.txt", content: "more" }), T("read_file", { path: "collide.txt" }, "r"), T("text_stats", { file: "collide.txt" }, "t", { pick: "characters" })]);
    assert.equal(result.stopped, "finished", result.problem);
    assert.equal(result.vars.w, "collide-2.txt");
    assert.equal(readFileSync(out("collide.txt"), "utf8"), "old", "the old file is untouched");
    assert.equal(result.vars.r.content, "newmore");
    assert.equal(result.vars.t, 7);
});

test("a plan that reads a field a tool doesn't give, or a variable nobody made, is refused before anything runs", () => {
    const registry = createToolRegistry();
    assert.match(checkPlan([T("number_stats", { numbers: "1 2", operation: "max" }, "s"), T("calculator", { expression: "{{s.valu}}+1" })], registry), /number_stats gives .*value.*not "valu"/);
    assert.match(checkPlan([T("read_file", { path: "a.txt" }, "r"), T("write_file", { path: "b.txt", content: "{{r.text}}" })], registry), /read_file gives file, content/);
    assert.match(checkPlan([T("calculator", { expression: "{{nobody}}+1" })], registry), /isn't available yet/);
    assert.match(checkPlan([T("no_such_tool", {})], registry), /doesn't exist/);
    assert.match(checkPlan([T("calculator", {})], registry), /missing "expression"/);
});

test("a tool that returns nothing, or a field that isn't there, stops the plan instead of passing nothing on", async () => {
    const registry = createToolRegistry();
    registry.registerTool({ name: "nothing", description: "returns nothing", parameters: {}, execute: async () => undefined });
    const empty = await run([T("nothing", {}, "x"), T("write_file", { path: "never2.txt", content: "{{x}}" })], registry);
    assert.equal(empty.stopped, "failed");
    assert.match(empty.problem, /returned nothing/);
    const missing = await run([T("random_numbers", { count: 2, min: 1, max: 9 }, "n"), T("write_file", { path: "never3.txt", content: "{{n.content}}" })]);
    assert.equal(missing.stopped, "failed");
    assert.doesNotMatch(formatReport(missing), /\[object Object\]|undefined/);
});

test("a model that claims a job is done when no tool ran is not believed, and the answer lists only the tools that really ran", async () => {
    const liar = { async generate() { return { content: "Done! All files created, verified and saved. Everything completed successfully." }; }, async selectTool() { return { tool: "none" }; } };
    const { createToolEngine } = await import("../engine/toolEngine.js");
    const { createMemory } = await import("../memory.js");
    const engine = createToolEngine(liar, createToolRegistry(), { memory: createMemory(), confirm: async () => "all" });
    for (const answer of [await engine.run("Create 3 files, then frobnicate them quarterly, then email the results to my boss."), (await engine.agent("Create the files, then verify everything, then save the report.")).answer]) {
        assert.match(answer, /^I didn't run any tools, so nothing was done\./);
        assert.doesNotMatch(answer, /Everything completed/);
    }
    assert.deepEqual(readdirSync(path.join(root, "ai-output")).filter((f) => /^file\d/.test(f)), [], "and no file was made");
});

// ---------- speed: independent work runs together, and nothing is fetched or sent twice ----------
import { memoize } from "../tools/extras.js";
import { weatherData } from "../tools/more.js";

const slowResearch = (registry, ms, { failOn } = {}) => {
    const live = { now: 0, peak: 0 };
    registry.getTool("research").execute = async ({ question }) => {
        live.peak = Math.max(live.peak, ++live.now);
        await new Promise((r) => setTimeout(r, ms));
        live.now--;
        if (question === failOn) throw new Error(`No relevant results for ${question}.`);
        return { question, sources: [{ title: question, link: `https://a.example/${question}`, excerpt: `${question} text.` }] };
    };
    return live;
};
const researchStep = (q, as) => T("research", { question: q }, as);

test("independent research steps run at the same time, and the answers still come in order", async () => {
    const registry = createToolRegistry();
    const live = slowResearch(registry, 300);
    const t0 = Date.now();
    const result = await run([researchStep("alpha", "a"), researchStep("beta", "b"), researchStep("gamma", "c")], registry);
    const took = Date.now() - t0;
    assert.equal(result.stopped, "finished", result.problem);
    assert.equal(live.peak, 3, "all three were running together");
    assert.ok(took < 700, `three 300 ms searches took ${took} ms (one after another would be 900+)`);
    assert.deepEqual(result.used.map((u) => u.args.question), ["alpha", "beta", "gamma"]);
    assert.deepEqual(result.vars.sources, ["https://a.example/alpha", "https://a.example/beta", "https://a.example/gamma"]);
});

test("a research that needs an earlier result waits for it; one that fails is reported at its own step and the finished ones are kept", async () => {
    const registry = createToolRegistry();
    const live = slowResearch(registry, 100);
    await run([researchStep("alpha", "a"), T("research", { question: "about {{a.question}}" }, "b")], registry);
    assert.equal(live.peak, 1, "the second one used the first one's result, so it waited");

    const failing = createToolRegistry();
    slowResearch(failing, 50, { failOn: "beta" });
    const result = await run([researchStep("alpha", "a"), researchStep("beta", "b"), researchStep("gamma", "c")], failing);
    assert.equal(result.stopped, "failed");
    assert.match(result.problem, /No relevant results for beta/);
    assert.equal(result.used.filter((u) => !u.error).length, 1, "alpha is kept");
    assert.match(formatReport(result), /I stopped at step 2 because/);
});

test("a report written from several searches is shown a fixed amount of them, one search is shown whole", async () => {
    const big = (registry) => { registry.getTool("research").execute = async ({ question }) => ({ question, sources: [1, 2, 3].map((i) => ({ title: `${question} ${i}`, link: `https://s${i}.example/${question}`, excerpt: "lorem ipsum dolor sit ".repeat(55) })) }); return registry; };
    const sizes = [];
    const model = { async generate(m) { sizes.push(m.at(-1).content.length); return { content: "Summary." }; }, async selectTool() { throw new Error("no"); } };
    const { createToolEngine } = await import("../engine/toolEngine.js");
    const { createMemory } = await import("../memory.js");
    const ask = async (goal) => createToolEngine(model, big(createToolRegistry()), { memory: createMemory(), confirm: async () => "all" }).agent(goal);
    await ask("Research React hooks, save a report.");
    await ask("Research React hooks, research Node.js streams, research Express middleware, save a report.");
    assert.ok(sizes[0] > 3500, `one search is not cut (${sizes[0]})`);
    assert.ok(sizes[1] < 9500, `three searches share about 8000 characters (${sizes[1]})`);
});

test("memoize: the same question is answered once, also when asked at the same moment; a failure is not remembered", async () => {
    let runs = 0;
    const ask = memoize(async (n) => { runs++; await new Promise((r) => setTimeout(r, 30)); if (n === "bad") throw new Error("down"); return { n }; });
    const [a, b] = await Promise.all([ask("x", "x"), ask("x", "x")]);
    assert.deepEqual([a, b, runs], [{ n: "x" }, { n: "x" }, 1]);
    a.n = "changed"; // callers get their own copy
    assert.deepEqual(await ask("x", "x"), { n: "x" });
    assert.equal(runs, 1);
    await assert.rejects(ask("bad", "bad"), /down/);
    await assert.rejects(ask("bad", "bad"), /down/);
    assert.equal(runs, 3, "the failed one was asked again");
});

test("weather: the same city twice is one request; a different city or unit is another", async () => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (url) => {
        requests++;
        const body = String(url).includes("geocoding") ? { results: [{ name: "Memoville", country: "X", latitude: 1, longitude: 2 }] }
            : { current: { temperature_2m: 20, apparent_temperature: 19, relative_humidity_2m: 50, wind_speed_10m: 5, weather_code: 0 }, current_units: { temperature_2m: "°C", apparent_temperature: "°C" } };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    try {
        const first = await weatherData({ city: "Memoville" });
        const after = requests;
        const second = await weatherData({ city: " memoville " });
        assert.equal(requests, after, "no new request");
        assert.deepEqual(second, first);
        await weatherData({ city: "Memoville", unit: "fahrenheit" });
        assert.ok(requests > after, "another unit is another request");
    } finally { globalThis.fetch = original; }
});

test("a number is never opened as a file: a random_numbers list or a sum can't become a file name", async () => {
    const result = await run([T("random_numbers", { count: 3, min: 1, max: 9 }, "n"), T("read_file", { path: "{{n}}" }, "r")]);
    assert.equal(result.stopped, "failed");
    assert.match(result.problem, /is a number, not a file name/);
    const stats = await run([T("calculator", { expression: "6*7" }, "c"), T("text_stats", { file: "{{c}}" })]);
    assert.match(stats.problem, /is a number, not a file name/);
});


// ---------- the executor corrects wrong picks and tells the truth about failures ----------
test("append_file to a file that doesn't exist is a wrong pick: the text goes into a new file (plan and loop), and the later steps follow", async () => {
    const result = await run([T("append_file", { path: "late-append.txt", content: "hello" }, "w"), T("read_file", { path: "late-append.txt" }, "r")]);
    assert.equal(result.stopped, "finished", result.problem);
    assert.equal(readFileSync(out("late-append.txt"), "utf8"), "hello");
    assert.equal(result.vars.r.content, "hello");
    assert.equal(result.used[0].tool.name, "write_file", "it says what really ran");
    // an existing file is still appended to
    const again = await run([T("append_file", { path: "late-append.txt", content: " world" })]);
    assert.equal(readFileSync(out("late-append.txt"), "utf8"), "hello world");
    assert.equal(again.used[0].tool.name, "append_file");
});

test("results say 'ai-output/x.txt': that is accepted as a name by write_file and append_file too", async () => {
    const registry = createToolRegistry();
    const made = await registry.getTool("write_file").execute({ path: "ai-output/prefixed.txt", content: "x" }, { confirm: async () => true });
    assert.equal(made.path, "prefixed.txt");
    await registry.getTool("append_file").execute({ path: "ai-output/prefixed.txt", content: "y" }, { confirm: async () => true });
    assert.equal(readFileSync(out("prefixed.txt"), "utf8"), "xy");
});

test("a name that came out of a step is the real name: the same name written twice is read as two different files", async () => {
    const result = await run([T("write_file", { path: "twin.txt", content: "one" }, "a"), T("write_file", { path: "twin.txt", content: "two" }, "b"), T("read_file", { path: "{{a}}" }, "ra"), T("read_file", { path: "{{b}}" }, "rb")]);
    assert.equal(result.stopped, "finished", result.problem);
    assert.deepEqual([result.vars.a, result.vars.b], ["twin.txt", "twin-2.txt"]);
    assert.deepEqual([result.vars.ra.content, result.vars.rb.content], ["one", "two"]);
});

test("when some steps of a model-driven job fail, the answer is the tools' results (worked / failed), never the model's claim of success", async () => {
    const picks = [
        { type: "tool_call", tool: "write_file", arguments: { path: "ai-output/loop-a.txt", content: "hello world" } },
        { type: "tool_call", tool: "read_file", arguments: { path: "loop-missing.txt" } },
        { type: "tool_call", tool: "write_file", arguments: { path: "loop-b.txt", content: "2" } },
        { type: "final", tool: "none" }
    ];
    let n = 0;
    const weak = { async generate() { return { content: "All done! Every file was created and verified." }; }, async selectTool() { return picks[n++]; } };
    const { createToolEngine } = await import("../engine/toolEngine.js");
    const { createMemory } = await import("../memory.js");
    const engine = createToolEngine(weak, createToolRegistry(), { memory: createMemory(), confirm: async () => "all" });
    const answer = (await engine.agent("Create loop-a.txt, read loop-missing.txt, then create loop-b.txt, with extra words so rules do not plan it xyz", { plan: false })).answer;
    assert.match(answer, /^Partly done: 2 of 3 steps worked\./);
    assert.match(answer, /read_file failed: Couldn't find "loop-missing\.txt"/);
    assert.doesNotMatch(answer, /All done|verified/);
});

// ---------- one engine for every model: what changes with the size of the model, and what doesn't ----------
import { modelProfile } from "../config.js";
import { createMemory } from "../memory.js";

test("the model profile comes from the model's name: small ones (8B and under, mini/tiny) get less to read and no planning to do", () => {
    for (const name of ["qwen2.5:3b", "qwen2.5:7b", "llama3.2:3b-instruct", "phi3:mini", "gemma:2B", "mistral:8b"]) assert.equal(modelProfile(name).small, true, name);
    for (const name of ["qwen3:14b", "gpt-oss:20b", "gpt-oss-120b", "qwen3.8-27b", "deepseek-chat", "gemini-2.5-pro", "claude-sonnet-5", "", "whatever is loaded"]) assert.equal(modelProfile(name).small, false, name);
    assert.deepEqual(modelProfile("qwen2.5:3b"), { small: true, materialChars: 4000, historyMessages: 16, modelPlan: false });
    assert.deepEqual(modelProfile("qwen3:14b"), { small: false, materialChars: 8000, historyMessages: 40, modelPlan: true });
});

test("a small model is not asked to plan (one model call less), and the work the engine does is the same", async () => {
    const asked = [];
    const model = { async generate(m) { asked.push(JSON.stringify(m).includes("You plan tasks") ? "plan" : "write"); return { content: "1. check the time" }; }, async selectTool() { return { type: "final", tool: "none" }; } };
    const { createToolEngine } = await import("../engine/toolEngine.js");
    for (const [name, plans] of [["qwen3:14b", true], ["qwen2.5:3b", false]]) {
        asked.length = 0;
        const engine = createToolEngine(model, createToolRegistry(), { memory: createMemory(), confirm: async () => "all", profile: modelProfile(name) });
        await engine.agent("Do something unusual with frobnication, then look at the weather of the moon");
        assert.equal(asked.some((x) => x === "plan"), plans, name);
    }
    // a prompt the rules plan runs the same steps with either profile
    const results = [];
    for (const name of ["qwen2.5:3b", "gpt-oss:20b"]) {
        for (const f of readdirSync(path.join(root, "ai-output"))) if (/^file\d/.test(f)) rmSync(out(f)); // the same empty folder for both
        const engine = createToolEngine(model, createToolRegistry(), { memory: createMemory(), confirm: async () => "all", profile: modelProfile(name) });
        results.push((await engine.run("Create 3 files containing random numbers, find the largest value.")).replace(/\d+/g, "N"));
    }
    assert.equal(results[0], results[1], "the same steps and the same wording for a small and a large model");
});

test("a long chat keeps the newest messages, and what was cut off stays as one short line of questions (made by code)", () => {
    const memory = createMemory({ max: 12 });
    for (let i = 1; i <= 30; i++) { memory.addMessage("user", `question number ${i} about hooks`); memory.addMessage("assistant", `answer ${i}`); }
    const messages = memory.getMessages();
    assert.ok(messages.length <= 12, `at most 12, got ${messages.length}`);
    assert.equal(messages.at(-1).content, "answer 30");
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /^Earlier in this chat the person asked: .*question number \d+ about hooks/);
    assert.ok(messages[0].content.length < 700, "the summary stays short");
    memory.clearMessages();
    assert.deepEqual(memory.getMessages(), []);
});

test("independent searches, page reads and weather lookups also run together", async () => {
    const registry = createToolRegistry();
    const live = { now: 0, peak: 0 };
    for (const name of ["web_search", "read_webpage", "wikipedia"]) registry.getTool(name).execute = async () => { live.peak = Math.max(live.peak, ++live.now); await new Promise((r) => setTimeout(r, 200)); live.now--; return { text: name, results: [] }; };
    const t0 = Date.now();
    const result = await run([T("web_search", { query: "alpha" }, "a"), T("read_webpage", { url: "https://1.1.1.1/x" }, "b"), T("wikipedia", { topic: "Alpha" }, "c")], registry);
    assert.equal(result.stopped, "finished", result.problem);
    assert.equal(live.peak, 3);
    assert.ok(Date.now() - t0 < 450, `three 200 ms calls took ${Date.now() - t0} ms`);
});

test("compare_numbers takes the number from a tool's answer line, but not from any other sentence", async () => {
    const registry = createToolRegistry();
    const compare = async (a, b) => registry.getTool("compare_numbers").execute({ a, b, label: "x" });
    assert.equal((await compare("Largest: 897472 (#4). All: #1 = 762596, #2 = 512661, #4 = 897472", "897472")).equal, true);
    assert.equal((await compare("Average: 30. All: #1 = 10, #2 = 20", "30")).equal, true);
    assert.equal((await compare("Sum: 1,500", "1500")).equal, true);
    assert.equal((await compare("Largest: 5 (#1)", "6")).equal, false);
    await assert.rejects(compare("The largest was 5 in file 2", "5"), /isn't a number/);
    await assert.rejects(compare("hello 5", "5"), /isn't a number/);
});
