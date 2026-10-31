import test from "node:test";
import assert from "node:assert/strict";

import {
registerTool,
registerTools,
getTool,
hasTool,
getToolDefinitions
} from "../tools/registry.js";

test("custom tool registers and executes successfully", async () => {
const unregister = registerTool({
name: "test_greeting",
description: "Returns a greeting",
parameters: {},
execute: async () => "Hello!"
});


try {
    const tool = getTool("test_greeting");

    assert.ok(tool);
    assert.equal(await tool.execute(), "Hello!");
    assert.equal(hasTool("test_greeting"), true);
} finally {
    unregister();
}

assert.equal(hasTool("test_greeting"), false);


});

test("duplicate tool registration is rejected", () => {
const unregister = registerTool({
name: "test_duplicate",
parameters: {},
execute: async () => "First"
});


try {
    assert.throws(
        () => registerTool({
            name: "test_duplicate",
            parameters: {},
            execute: async () => "Second"
        }),
        /already registered/
    );
} finally {
    unregister();
}


});

test("tool definitions expose metadata without execute function", () => {
const unregister = registerTool({
name: "test_metadata",
description: "Metadata test",
parameters: { input: "string" },
execute: async () => "Done"
});


try {
    const definition = getToolDefinitions().find(
        (tool) => tool.name === "test_metadata"
    );

    assert.deepEqual(definition, {
        name: "test_metadata",
        description: "Metadata test",
        parameters: { input: "string" }
    });

    assert.equal("execute" in definition, false);
} finally {
    unregister();
}


});

test("bulk registration rolls back if a tool fails", () => {
assert.throws(
() => registerTools([
{
name: "test_bulk_first",
parameters: {},
execute: async () => "First"
},
{
name: "test_bulk_first",
parameters: {},
execute: async () => "Duplicate"
}
]),
/already registered/
);


assert.equal(hasTool("test_bulk_first"), false);


});

test("invalid tool definitions are rejected", () => {
assert.throws(
() => registerTool({
name: "Invalid Name",
execute: async () => "Test"
}),
/Tool name/
);


assert.throws(
    () => registerTool({
        name: "test_no_execute",
        execute: "not a function"
    }),
    /execute function/
);


});
