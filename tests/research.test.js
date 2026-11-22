// research: three REAL pages when they exist, even when some sites fail or show an empty page.
import test from "node:test";
import assert from "node:assert/strict";
import { research } from "../tools/more.js";

const result = (n, host = `site${n}.example`) => ({ title: `Page ${n}`, link: `https://${host}/p${n}`, description: `Snippet ${n}` });
const text = (label) => `${label}. ` + "React hooks let a function component keep state and run effects. ".repeat(6);
const reader = (pages) => async ({ url }) => {
    const page = pages[url];
    if (page instanceof Error) throw page;
    return { content: page ?? "" };
};

test("a page that fails or shows nothing is replaced by the next result", async () => {
    const results = [1, 2, 3, 4, 5].map((n) => result(n));
    const read = reader({
        "https://site1.example/p1": new Error("timed out"),     // fails
        "https://site2.example/p2": "",                         // a JavaScript-only page: nothing readable
        "https://site3.example/p3": text("Three"),
        "https://site4.example/p4": text("Four"),
        "https://site5.example/p5": text("Five")
    });
    const out = await research({ question: "react hooks explained" }, { search: async () => results, read });
    assert.deepEqual(out.sources.map((s) => s.title), ["Page 3", "Page 4", "Page 5"], "three pages that were really read");
    assert.ok(out.sources.every((s) => !s.snippetOnly));
    assert.match(out.sources[0].excerpt, /React hooks/);
});

test("when too few pages can be read, the rest come from search snippets and say so", async () => {
    const results = [1, 2, 3].map((n) => result(n));
    const read = reader({ "https://site1.example/p1": text("One"), "https://site2.example/p2": new Error("blocked"), "https://site3.example/p3": "tiny" });
    const out = await research({ question: "react hooks explained" }, { search: async () => results, read });
    assert.equal(out.sources.length, 3);
    assert.deepEqual(out.sources.map((s) => !!s.snippetOnly), [false, true, true]);
    assert.equal(out.sources[1].excerpt, "Snippet 2");
});

test("few results: it asks again with just the key words and merges, without repeats", async () => {
    const asked = [];
    const search = async (q) => { asked.push(q); return q.includes("how do I") ? [result(1)] : [result(1), result(2), result(3)]; };
    const read = reader({ "https://site1.example/p1": text("One"), "https://site2.example/p2": text("Two"), "https://site3.example/p3": text("Three") });
    const out = await research({ question: "how do I use react hooks properly" }, { search, read });
    assert.equal(asked.length, 2);
    assert.doesNotMatch(asked[1], /how do I/);
    assert.deepEqual(out.sources.map((s) => s.title), ["Page 1", "Page 2", "Page 3"]);
});

test("enough results: no second search. A failing second search changes nothing", async () => {
    let calls = 0;
    const many = [1, 2, 3, 4, 5].map((n) => result(n));
    const read = reader(Object.fromEntries(many.map((r) => [r.link, text(r.title)])));
    await research({ question: "react hooks explained" }, { search: async () => { calls++; return many; }, read });
    assert.equal(calls, 1);

    let n = 0;
    const out = await research({ question: "how do I use react hooks properly" }, { search: async () => { if (n++) throw new Error("rate limited"); return [result(1)]; }, read: reader({ "https://site1.example/p1": text("One") }) });
    assert.deepEqual(out.sources.map((s) => s.title), ["Page 1"]);
});

test("one page per site, three sources at most, and no results is explained", async () => {
    const results = [result(1, "same.example"), result(2, "same.example"), result(3), result(4), result(5), result(6)];
    const read = reader(Object.fromEntries(results.map((r) => [r.link, text(r.title)])));
    const out = await research({ question: "react hooks explained" }, { search: async () => results, read });
    assert.equal(out.sources.length, 3);
    assert.equal(new Set(out.sources.map((s) => new URL(s.link).hostname)).size, 3);
    assert.deepEqual(await research({ question: "react hooks explained" }, { search: async () => [], read }), { question: "react hooks explained", sources: [], note: "No relevant results were found." });
    await assert.rejects(research({ question: " " }), /question to research is required/);
});
