// Steadier web search: Brave, Tavily or your own SearXNG first, DuckDuckGo as the spare. Against local fake servers.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { config } from "../config.js";
import { webSearch, clearSearchCache } from "../tools/webSearch.js";

const REACT = [{ title: "React <strong>Hooks</strong> guide", url: "https://react.dev/hooks", description: "Hooks let you use state &amp; effects in React." },
               { title: "Unrelated cooking page", url: "https://food.example/pasta", description: "Pasta." }];

async function fake(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = ""; req.on("data", (c) => (body += c));
        req.on("end", () => { seen.push({ url: req.url, method: req.method, headers: req.headers, body }); handler(req, res, body); });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const json = (res, data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };

async function withConfig(values, fn) {
    clearSearchCache(); // a fresh start: no answers remembered, no engine resting
    const saved = Object.fromEntries(Object.keys(values).map((k) => [k, config[k]]));
    Object.assign(config, { braveKey: "", tavilyKey: "", searxngUrl: "", searchProvider: "auto" }, values);
    try { return await fn(); } finally { Object.assign(config, saved, { braveKey: "", tavilyKey: "", searxngUrl: "", searchProvider: "auto" }); }
}

test("brave: the key is sent as a header, tags and entities are cleaned, unrelated results are dropped", async () => {
    const s = await fake((req, res) => json(res, { web: { results: REACT } }));
    try {
        await withConfig({ braveKey: "brave-key-123", braveUrl: `${s.url}/res` }, async () => {
            const results = await webSearch("react hooks guide");
            assert.deepEqual(results.map((r) => r.title), ["React Hooks guide"]);
            assert.equal(results[0].description, "Hooks let you use state & effects in React.");
            assert.equal(results[0].link, "https://react.dev/hooks");
            assert.equal(s.seen[0].headers["x-subscription-token"], "brave-key-123");
            assert.match(s.seen[0].url, /q=react%20hooks%20guide/);
        });
    } finally { await s.close(); }
});

test("tavily: a POST with the key as a bearer token", async () => {
    const s = await fake((req, res) => json(res, { results: REACT.map((r) => ({ title: r.title, url: r.url, content: r.description })) }));
    try {
        await withConfig({ tavilyKey: "tvly-abc", tavilyUrl: `${s.url}/search` }, async () => {
            const results = await webSearch("react hooks guide");
            assert.equal(results.length, 1);
            assert.equal(s.seen[0].method, "POST");
            assert.equal(s.seen[0].headers.authorization, "Bearer tvly-abc");
            assert.equal(JSON.parse(s.seen[0].body).query, "react hooks guide");
        });
    } finally { await s.close(); }
});

test("searxng: your own server, asked for JSON", async () => {
    const s = await fake((req, res) => json(res, { results: REACT.map((r) => ({ title: r.title, url: r.url, content: r.description })) }));
    try {
        await withConfig({ searxngUrl: `${s.url}/` }, async () => {
            assert.equal((await webSearch("react hooks guide")).length, 1);
            assert.match(s.seen[0].url, /^\/search\?q=react%20hooks%20guide&format=json$/);
        });
    } finally { await s.close(); }
});

test("a provider that fails hands over to the next one; the first that works wins; a refused key is explained", async () => {
    const bad = await fake((req, res) => json(res, { error: "no" }, 401));
    const limited = await fake((req, res) => json(res, {}, 429));
    const good = await fake((req, res) => json(res, { results: REACT.map((r) => ({ title: r.title, url: r.url, content: r.description })) }));
    try {
        await withConfig({ braveKey: "k", braveUrl: bad.url, tavilyKey: "k", tavilyUrl: limited.url, searxngUrl: good.url }, async () => {
            const results = await webSearch("react hooks guide");
            assert.equal(results.length, 1, "brave said no, tavily was rate-limited, searxng answered");
            assert.equal(bad.seen.length, 1); assert.equal(limited.seen.length, 1); assert.equal(good.seen.length, 1);
        });
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => (String(url).includes("duckduckgo") ? Promise.reject(new TypeError("offline")) : realFetch(url, init));
        try {
            await withConfig({ braveKey: "k", braveUrl: bad.url }, async () => {
                await assert.rejects(webSearch("react hooks guide"), /Couldn't reach the search engine/, "all failed: the last error is shown");
            });
        } finally { globalThis.fetch = realFetch; }
    } finally { await bad.close(); await limited.close(); await good.close(); }
});

test("a provider with nothing relevant hands over too, and AI_SEARCH_PROVIDER picks who goes first", async () => {
    const empty = await fake((req, res) => json(res, { web: { results: [{ title: "Pasta", url: "https://food.example", description: "cooking" }] } }));
    const good = await fake((req, res) => json(res, { results: REACT.map((r) => ({ title: r.title, url: r.url, content: r.description })) }));
    try {
        await withConfig({ braveKey: "k", braveUrl: empty.url, searxngUrl: good.url }, async () => {
            assert.equal((await webSearch("react hooks guide")).length, 1);
            assert.equal(empty.seen.length, 1);
        });
        empty.seen.length = 0; good.seen.length = 0;
        await withConfig({ braveKey: "k", braveUrl: empty.url, searxngUrl: good.url, searchProvider: "searxng" }, async () => {
            await webSearch("react hooks guide");
            assert.equal(good.seen.length, 1);
            assert.equal(empty.seen.length, 0, "searxng was asked first and answered");
        });
    } finally { await empty.close(); await good.close(); }
});

test("with no keys set, nothing is sent to Brave, Tavily or SearXNG", async () => {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { seen.push(String(url)); throw new TypeError("offline"); };
    try {
        await withConfig({}, async () => { await assert.rejects(webSearch("react hooks guide")); });
    } finally { globalThis.fetch = realFetch; }
    assert.deepEqual(seen.filter((u) => !u.includes("duckduckgo") && !u.includes("nodejs.org")), []);
});

const FRESH_RESULTS = { results: REACT.map((r) => ({ title: r.title, url: r.url, content: r.description })) };

test("the same question twice within ten minutes is answered from memory, and a copy is returned (changing it can't spoil the next answer)", async () => {
    const s = await fake((req, res) => json(res, FRESH_RESULTS));
    try {
        await withConfig({ searxngUrl: s.url }, async () => {
            const first = await webSearch("react hooks guide");
            first[0].title = "TAMPERED";
            const second = await webSearch("react hooks guide");
            assert.equal(s.seen.length, 1, "the engine was asked once");
            assert.equal(second[0].title, "React Hooks guide");
            await webSearch("React   Hooks GUIDE");
            assert.equal(s.seen.length, 1, "case and spacing don't matter");
            await webSearch("react hooks guide official documentation");
            assert.equal(s.seen.length, 2, "a different question is a different search");
        });
    } finally { await s.close(); }
});

test("an engine that just failed sits out for a minute, so the next question doesn't wait for it again", async () => {
    const broken = await fake((req, res) => json(res, {}, 429));
    const good = await fake((req, res) => json(res, FRESH_RESULTS));
    try {
        await withConfig({ braveKey: "k", braveUrl: broken.url, searxngUrl: good.url }, async () => {
            await webSearch("react hooks guide");
            await webSearch("react hooks tutorial for beginners");
            assert.equal(broken.seen.length, 1, "brave said 429 once and was left alone for the second question");
            assert.equal(good.seen.length, 2);
        });
    } finally { await broken.close(); await good.close(); }
});

test("'latest' with no year gets this year added, so old pages don't win; a year you wrote is kept", async () => {
    const s = await fake((req, res) => json(res, FRESH_RESULTS));
    try {
        await withConfig({ searxngUrl: s.url }, async () => {
            await webSearch("latest react hooks guide");
            assert.match(decodeURIComponent(s.seen[0].url), new RegExp(`latest react hooks guide ${new Date().getFullYear()}`));
            await webSearch("react hooks guide 2021");
            assert.doesNotMatch(decodeURIComponent(s.seen[1].url), /2021 \d{4}/);
            await webSearch("react hooks guide");
            assert.doesNotMatch(decodeURIComponent(s.seen[2].url), /guide \d{4}/, "not a freshness question: left alone");
        });
    } finally { await s.close(); }
});

test("duckduckgo has a second door: when the normal page is rate-limited, the lite page answers", async () => {
    const LITE = `<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://react.dev/hooks")}&rut=x" class='result-link'>React Hooks guide</a></td></tr>
      <tr><td class='result-snippet'>Hooks let you use state &amp; effects in React.</td></tr>
      <tr><td><a rel="nofollow" href="https://food.example/pasta" class='result-link'>Pasta</a></td></tr><tr><td class='result-snippet'>Cooking.</td></tr></table>`;
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        seen.push([String(url), init?.method ?? "GET", init?.body]);
        if (String(url).includes("html.duckduckgo.com")) return new Response("busy", { status: 429 });
        if (String(url).includes("lite.duckduckgo.com")) return new Response(LITE, { status: 200 });
        return realFetch(url, init);
    };
    try {
        await withConfig({}, async () => {
            const results = await webSearch("react hooks guide");
            assert.deepEqual(results.map((r) => [r.title, r.link]), [["React Hooks guide", "https://react.dev/hooks"]]);
            assert.equal(results[0].description, "Hooks let you use state & effects in React.");
            const lite = seen.find(([u]) => u.includes("lite.duckduckgo.com"));
            assert.equal(lite[1], "POST");
            assert.equal(lite[2], "q=react%20hooks%20guide");
        });
    } finally { globalThis.fetch = realFetch; }
});
