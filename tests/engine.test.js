import test from "node:test";
import assert from "node:assert/strict";
import { createToolEngine, getCalculationExpression } from "../engine/toolEngine.js";
import { createToolRegistry } from "../tools/registry.js";
import { createMemory } from "../memory.js";
import { calculate } from "../tools/calculator.js";
import { config } from "../config.js";

// Fresh engine per test: own memory, own registry, scripted fake model.
function setup({ generate, selectTool, builtins = true, tools = [] } = {}) {
    const calls = { generate: [], selectTool: 0 };
    const model = {
        async generate(messages) {
            calls.generate.push(messages);
            return generate ? generate(messages) : { type: "text", content: "model answer" };
        },
        async selectTool(messages, defs) {
            calls.selectTool++;
            return selectTool ? selectTool(messages, defs, calls.selectTool) : { type: "text", tool: "none", arguments: {} };
        }
    };
    const registry = createToolRegistry({ includeBuiltins: builtins });
    registry.registerTools(tools);
    const memory = createMemory();
    return { engine: createToolEngine(model, registry, { memory }), calls, memory, registry };
}

const echoTool = (extra = {}) => ({
    name: "echo_tool",
    description: "Echoes input.",
    parameters: { text: "string" },
    execute: async ({ text }) => `echo:${text}`,
    ...extra
});

// ---- calculator ----

test("calculator: division by zero gives a clear message", () => {
    assert.throws(() => calculate("10 / 0"), /divide by zero/i);
    assert.throws(() => calculate("5 / (3 - 3)"), /divide by zero/i);
    assert.throws(() => calculate("5 % 0"), /divide by zero/i);
});

test("calculator: floats, percent vs remainder, unicode operators", () => {
    assert.equal(calculate("0.1 + 0.2"), 0.3);
    assert.equal(calculate("10 % 3"), 1);
    assert.equal(calculate("10%3"), 1);
    assert.equal(calculate("50%"), 0.5);
    assert.equal(calculate("6 × 7"), 42);
    assert.equal(calculate("2 ** 10"), 1024);
    assert.equal(calculate("1,000 + 1"), 1001);
});

test("calculator: garbage and huge input are rejected", () => {
    assert.throws(() => calculate("abc + 1"), /Invalid/);
    assert.throws(() => calculate("2 +"), /Invalid/);
    assert.throws(() => calculate("1+".repeat(150) + "1"), /too long/);
});

test("expression extraction handles brackets and plain questions", () => {
    assert.equal(getCalculationExpression("calculate (2+3)*4"), "(2+3)*4");
    assert.equal(getCalculationExpression("what is 12 * 12?"), "12 * 12");
    assert.equal(getCalculationExpression("what is 12-05-2024?"), null);
    assert.equal(getCalculationExpression("what is 2024?"), null);
});

test("engine: division by zero is reported, model is not asked to guess", async () => {
    const { engine, calls } = setup();
    assert.equal(await engine.run("calculate 10 / 0"), "Calculation failed: Cannot divide by zero.");
    assert.equal(calls.generate.length, 0);
});

test("engine: bare calculation answers exactly", async () => {
    const { engine } = setup();
    assert.equal(await engine.run("what is 245 * 37?"), "245 * 37 = 9065");
});

test("engine: calculation with context goes through the model but keeps the exact number", async () => {
    const good = setup({ generate: () => ({ content: "You'd pay 9,065 in total." }) });
    assert.match(await good.engine.run("I need 245 items at 37 each, calculate 245 * 37 for the total"), /9,065/);

    const wrong = setup({ generate: () => ({ content: "That comes to 9000." }) });
    assert.equal(await wrong.engine.run("I need 245 items at 37 each, calculate 245 * 37 for the total"), "245 * 37 = 9065");
});

// ---- custom tools ----

test("engine: tool result reaches the model and the model writes the answer", async () => {
    const { engine, calls } = setup({
        tools: [echoTool()],
        selectTool: (_m, _d, n) => n === 1 ? { type: "tool_call", tool: "echo_tool", arguments: { text: "hi" } } : { type: "text", tool: "none" },
        generate: () => ({ content: "The tool said hi." })
    });
    assert.equal(await engine.run("use the echo tool"), "The tool said hi.");
    const sent = JSON.stringify(calls.generate[0]);
    assert.ok(sent.includes("echo:hi"));
});

test("engine: returnDirect tools skip the model", async () => {
    const { engine, calls } = setup({
        tools: [echoTool({ returnDirect: true })],
        selectTool: (_m, _d, n) => n === 1 ? { type: "tool_call", tool: "echo_tool", arguments: { text: "x" } } : { type: "text" }
    });
    assert.equal(await engine.run("echo x"), "echo:x");
    assert.equal(calls.generate.length, 0);
});

test("engine: repeated identical tool calls run once (no infinite loop)", async () => {
    let runs = 0;
    const { engine, calls } = setup({
        tools: [echoTool({ execute: async () => { runs++; return "ok"; } })],
        selectTool: () => ({ type: "tool_call", tool: "echo_tool", arguments: { text: "same" } })
    });
    await engine.run("loop please");
    assert.equal(runs, 1);
    assert.equal(calls.selectTool, 2);
});

test("engine: changing arguments is capped by maxToolCalls", async () => {
    let runs = 0;
    const { engine } = setup({
        tools: [echoTool({ execute: async () => { runs++; return "ok"; } })],
        selectTool: (_m, _d, n) => ({ type: "tool_call", tool: "echo_tool", arguments: { text: `try ${n}` } })
    });
    await engine.run("never stop");
    assert.equal(runs, config.maxToolCalls);
});

test("engine: tool that throws is reported, not crashed", async () => {
    const { engine } = setup({
        tools: [echoTool({ execute: async () => { throw new Error("boom"); } })],
        selectTool: (_m, _d, n) => n === 1 ? { type: "tool_call", tool: "echo_tool", arguments: { text: "a" } } : { type: "text" },
        generate: () => { throw new Error("model down"); }
    });
    assert.equal(await engine.run("use it"), "echo_tool failed: boom");
});

test("engine: invalid tool arguments never reach execute", async () => {
    let ran = false;
    const { engine, memory } = setup({
        tools: [echoTool({ execute: async () => { ran = true; return "x"; } })],
        selectTool: (_m, _d, n) => n === 1 ? { type: "tool_call", tool: "echo_tool", arguments: {} } : { type: "text" }
    });
    await engine.run("use it");
    assert.equal(ran, false);
    assert.ok(memory.getMessages().some((m) => /Missing argument/.test(m.content)));
});

test("engine: optional parameters can be left out", async () => {
    const { engine } = setup({
        tools: [{ name: "opt_tool", parameters: { note: "string (optional)" }, returnDirect: true, execute: async () => "fine" }],
        selectTool: (_m, _d, n) => n === 1 ? { type: "tool_call", tool: "opt_tool", arguments: {} } : { type: "text" }
    });
    assert.equal(await engine.run("go"), "fine");
});

test("engine: unknown tool name from the model is ignored", async () => {
    const { engine } = setup({
        tools: [echoTool()],
        selectTool: () => ({ type: "tool_call", tool: "made_up", arguments: {} })
    });
    assert.equal(await engine.run("hello"), "model answer");
});

test("engine: malformed tool selection falls back to a normal answer", async () => {
    const { engine } = setup({
        tools: [echoTool()],
        selectTool: () => { throw new Error("Model returned invalid tool-selection JSON: nope"); }
    });
    assert.equal(await engine.run("hello"), "model answer");
});

// ---- plain chat failures ----

test("engine: empty model reply gives a helpful message", async () => {
    const { engine } = setup({ generate: () => ({ content: "   " }) });
    assert.match(await engine.run("hi"), /empty reply/);
});

test("engine: model failure is reported", async () => {
    const { engine } = setup({ generate: () => { throw new Error("Can't reach Ollama"); } });
    assert.equal(await engine.run("hi"), "Request failed: Can't reach Ollama");
});

test("engine: blank question is rejected without calling the model", async () => {
    const { engine, calls } = setup();
    assert.equal(await engine.run("  "), "Please enter a question.");
    assert.equal(calls.generate.length, 0);
});

test("engine: plain chat prompt tells the model not to make things up", async () => {
    const { engine, calls } = setup();
    await engine.run("hi");
    assert.match(calls.generate[0][0].content, /Never invent/);
});

// ---- web search ----

const searchTool = (execute) => ({
    name: "web_search",
    description: "search",
    parameters: { query: "string" },
    execute
});
const sampleResults = [
    { title: "React Docs", description: "Official React documentation", link: "https://react.dev/learn" },
    { title: "Blog", description: "React tips", link: "https://example.com/react" }
];

test("engine: search answer is written by the model and sources are listed, not dumped", async () => {
    const { engine } = setup({
        builtins: false,
        tools: [searchTool(async () => sampleResults)],
        generate: () => ({ content: "React's official docs cover hooks." })
    });
    const answer = await engine.run("search for react hooks docs");
    assert.match(answer, /^React's official docs cover hooks\./);
    assert.match(answer, /Sources:\n- React Docs: https:\/\/react\.dev\/learn/);
    assert.ok(!answer.includes("1. React Docs"));
});

test("engine: search with a dead model shows a short fallback", async () => {
    const { engine } = setup({
        builtins: false,
        tools: [searchTool(async () => sampleResults)],
        generate: () => { throw new Error("down"); }
    });
    assert.match(await engine.run("search for react hooks"), /couldn't summarize/);
});

test("engine: failed search is reported", async () => {
    const { engine } = setup({
        builtins: false,
        tools: [searchTool(async () => { throw new Error("Couldn't reach the search engine."); })]
    });
    assert.match(await engine.run("search for react hooks"), /Web search failed: Couldn't reach/);
});

test("engine: search and calculation together keep the exact result", async () => {
    const { engine } = setup({
        builtins: false,
        tools: [searchTool(async () => sampleResults), {
            name: "calculator", parameters: { expression: "string" }, execute: async ({ expression }) => calculate(expression)
        }],
        generate: () => ({ content: "Docs found." })
    });
    const answer = await engine.run("search for react hooks and calculate 245 * 37");
    assert.match(answer, /Calculation: 245 \* 37 = 9065/);
});

test("engine: no results gives a clear message", async () => {
    const { engine } = setup({ builtins: false, tools: [searchTool(async () => [])] });
    assert.match(await engine.run("search for zzzz"), /couldn't find/i);
});

// ---- memory ----

test("memory: engines don't share history and tool results keep real newlines", async () => {
    const a = setup({ tools: [echoTool({ returnDirect: true })], selectTool: (_m, _d, n) => n === 1 ? { type: "tool_call", tool: "echo_tool", arguments: { text: "a" } } : { type: "text" } });
    const b = setup();
    await a.engine.run("first");
    assert.equal(b.memory.getMessages().length, 0);
    const toolMsg = a.memory.getMessages().find((m) => m.role === "system");
    assert.ok(toolMsg.content.includes("\n{") || toolMsg.content.includes('\n"'));
    assert.ok(!toolMsg.content.includes("\\n"));
});

test("memory: long tool output is truncated and history is capped", () => {
    const memory = createMemory();
    memory.addToolResult("big", "x".repeat(10000));
    assert.ok(memory.getMessages()[0].content.length < 5300);
    for (let i = 0; i < 100; i++) memory.addMessage("user", `m${i}`);
    assert.ok(memory.getMessages().length <= Math.max(10, config.maxHistoryMessages));
    memory.addMessage("user", "   ");
    assert.equal(memory.getMessages().at(-1).content, "m99");
});
