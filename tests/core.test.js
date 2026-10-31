import test from "node:test";
import assert from "node:assert/strict";
import { calculate } from "../tools/calculator.js";
import { cleanSearchQuery, filterRelevantResults, isUsefulSearchQuery } from "../tools/webSearch.js";
import { getCalculationExpression } from "../engine/toolEngine.js";
import { clearMessages, addMessage, getMessages } from "../memory.js";

test("calculator returns exact arithmetic result", () => {
    assert.equal(calculate("245 * 37"), 9065);
});

test("calculator supports percentages", () => {
    assert.equal(calculate("20% * 50"), 10);
});

test("calculator rejects empty input", () => {
    assert.throws(() => calculate(" "));
});

test("search query rejects obvious keyboard mash", () => {
    assert.equal(isUsefulSearchQuery("asdfghjklqwerty123456"), false);
    assert.equal(isUsefulSearchQuery("latest Node.js version"), true);
});

test("search relevance keeps matching results and removes unrelated results", () => {
    const results = [
        { title: "Node.js download", description: "Download Node.js releases" },
        { title: "React tutorial", description: "Learn React" }
    ];
    assert.deepEqual(filterRelevantResults("Node.js version", results), [results[0]]);
});

test("empty search results stay empty", () => {
    assert.deepEqual(filterRelevantResults("Node.js", []), []);
});

test("memory returns copies and can be cleared", () => {
    clearMessages();
    addMessage("user", "Hello");
    const copy = getMessages();
    copy.push({ role: "assistant", content: "not saved" });
    assert.equal(getMessages().length, 1);
    clearMessages();
    assert.equal(getMessages().length, 0);
});


test("search query removes tool instructions from a combined request", () => {
    assert.equal(
        cleanSearchQuery("Search for the latest Node.js version and calculate 245 * 37."),
        "the latest Node.js version"
    );
});

test("calculator expression is extracted from a combined request", () => {
    assert.equal(
        getCalculationExpression("Search for the latest Node.js version and calculate 245 * 37."),
        "245 * 37"
    );
});
