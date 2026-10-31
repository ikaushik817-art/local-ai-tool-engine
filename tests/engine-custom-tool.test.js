import test from "node:test";
import assert from "node:assert/strict";

import { createToolEngine } from "../engine/toolEngine.js";
import { registerTool } from "../tools/registry.js";
import { clearMessages } from "../memory.js";

test("engine discovers and executes a registered custom tool", async () => {
clearMessages();


let executed = false;

const unregister = registerTool({
    name: "test_custom",
    description: "Returns a custom test result.",
    parameters: {
        input: "string"
    },
    execute: async ({ input }) => {
        executed = true;
        return `Custom result: ${input}`;
    }
});

const model = {
    async generate() {
        throw new Error("Unexpected generate() call");
    },

    async selectTool() {
        return {
            type: "tool_call",
            tool: "test_custom",
            arguments: {
                input: "hello"
            }
        };
    }
};

try {
    const engine = createToolEngine(model);
    const result = await engine.run("Run my custom tool");

    assert.equal(executed, true);
    assert.equal(result, "Custom result: hello");
} finally {
    unregister();
    clearMessages();
}


});
