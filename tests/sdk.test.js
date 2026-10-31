import test from "node:test";
import assert from "node:assert/strict";
import { createAI } from "../sdk.js";

function fakeModel(toolName, args = {}) {
    return {
        async generate() {
            return { type: "text", content: "Normal answer" };
        },
        async selectTool(messages, tools) {
            assert.ok(messages.some((message) => message.role === "user"));
            assert.ok(tools.some((tool) => tool.name === toolName));
            return { type: "tool_call", tool: toolName, arguments: args };
        }
    };
}

test("public SDK exposes chat and tool registration methods", () => {
    const ai = createAI({ model: fakeModel("sample_tool") });
    assert.equal(typeof ai.chat, "function");
    assert.equal(typeof ai.registerTool, "function");
    assert.equal(typeof ai.registerTools, "function");
    assert.equal(typeof ai.getTools, "function");
});

test("SDK executes a custom tool end-to-end without Ollama", async () => {
    const ai = createAI({ model: fakeModel("sample_tool", { name: "Ishant" }) });
    const unregister = ai.registerTool({
        name: "sample_tool",
        description: "Returns a greeting.",
        parameters: { name: "string" },
        returnDirect: true,
        execute: async ({ name }) => `Hello, ${name}!`
    });

    try {
        assert.equal(await ai.chat("Use sample_tool"), "Hello, Ishant!");
    } finally {
        unregister();
    }
});

test("each SDK instance has an isolated tool registry", async () => {
    const first = createAI({ model: fakeModel("private_tool") });
    const second = createAI({ model: fakeModel("private_tool") });

    const unregister = first.registerTool({
        name: "private_tool",
        description: "Only registered in the first instance.",
        parameters: {},
        execute: async () => "private result"
    });

    try {
        assert.ok(first.getTools().some((tool) => tool.name === "private_tool"));
        assert.ok(!second.getTools().some((tool) => tool.name === "private_tool"));
        assert.equal(await second.chat("Use private_tool"), "Normal answer");
    } finally {
        unregister();
    }
});

test("SDK bulk registration can be undone", () => {
    const ai = createAI({ model: fakeModel("one_tool") });
    const unregister = ai.registerTools([
        { name: "one_tool", parameters: {}, execute: async () => "one" },
        { name: "two_tool", parameters: {}, execute: async () => "two" }
    ]);

    assert.ok(ai.getTools().some((tool) => tool.name === "one_tool"));
    assert.ok(ai.getTools().some((tool) => tool.name === "two_tool"));
    unregister();
    assert.ok(!ai.getTools().some((tool) => tool.name === "one_tool"));
    assert.ok(!ai.getTools().some((tool) => tool.name === "two_tool"));
});


test("SDK can execute a registered tool directly", async () => {
    const ai = createAI({ model: fakeModel("unused_tool") });
    const unregister = ai.registerTool({
        name: "direct_tool",
        description: "A tool called directly by name.",
        parameters: {},
        execute: async () => "Direct result"
    });

    try {
        assert.equal(await ai.executeTool("direct_tool"), "Direct result");
        await assert.rejects(ai.executeTool("missing_tool"), /not registered/);
    } finally {
        unregister();
    }
});
