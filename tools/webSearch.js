import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../logger.js";

const STOP_WORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "for", "to", "of", "in",
    "on", "at", "and", "or", "with", "please", "find", "search", "look", "up",
    "latest", "current", "today", "recent", "about", "tell", "me", "what",
    "which", "how", "version", "official", "documentation", "docs",
    "yesterday", "today", "tonight", "tomorrow", "recent", "recently", "current", "currently", "latest", "newest"
]);

// Sites that are rarely the "official" answer.
const UNOFFICIAL_HOSTS = /(^|\.)(stackoverflow|medium|w3schools|geeksforgeeks|youtube|reddit|quora|dev\.to|tutorialspoint)\./i;

function normalizeResultUrl(rawUrl) {
    if (!rawUrl) return "";

    try {
        const absoluteUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
        const parsed = new URL(absoluteUrl, "https://duckduckgo.com");
        const destination = parsed.searchParams.get("uddg");
        if (destination) return destination;
        if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname === "/l/") return "";
        return parsed.href;
    } catch {
        return "";
    }
}

function getKeywords(text) {
    return String(text)
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .match(/[a-z0-9+#.-]{2,}/g)?.filter((word) => !STOP_WORDS.has(word)) ?? [];
}

// Avoid sending obvious keyboard-mash queries to the search engine.
export function isUsefulSearchQuery(query) {
    if (typeof query !== "string" || !query.trim()) return false;

    const cleaned = query.trim().toLowerCase();
    if (cleaned.length < 2) return false;

    const words = cleaned.match(/[a-z]+/g) ?? [];
    const longWords = words.filter((word) => word.length >= 12);
    const keyboardMash = longWords.some((word) =>
        !/[aeiou]/.test(word) || /asdf|qwerty|zxcv|hjkl|123456|098765/.test(word)
    );

    return !keyboardMash;
}

const EXPLICIT_SEARCH = /\b(?:search\s+(?:for|the\s+(?:web|internet)|online|about|up)|look\s*up|google|find\s+online|web\s+search)\b|^\s*(?:please\s+)?search\b/i;
const TOPIC_WORDS = /\b(news|version|release[sd]?|updates?|price|prices|score|weather|docs?|documentation|changelog|ceo|president|stock)\b/i;

const FRESH_WORDS = /\b(latest|newest|most recent|recent(?:ly)?|current(?:ly)?|right now|today|tonight|this (?:week|month|year)|last (?:night|week|month|year)|yesterday|upcoming)\b/i;
const FACT_QUESTION = /^\s*(?:please\s+)?(?:who|what|when|where|which|how (?:many|much|old|big|tall|long|far)|is|are|was|were|does|did|find|get|check|tell me|show me|give me)\b/i;
const NOT_FRESH_FACTS = /\b(?:electric(?:al)?|ac|dc)\s+current\b|\bcurrent\s+(?:in|through|flows?|flowing)\b|^\s*(?:what'?s up|how are you|how'?s it going)\b/i;

// Explicit requests, "latest" and "news" always search. "recent", "current" or "today" count next to a
// topic word ("current Node version") or in a factual question ("who won the most recent World Cup?"),
// because a model without internet can only guess those.
export function hasSearchIntent(question) {
    const text = String(question ?? "");
    return EXPLICIT_SEARCH.test(text)
        || /\b(latest|newest|news)\b/i.test(text)
        || (FRESH_WORDS.test(text) && TOPIC_WORDS.test(text))
        || (FRESH_WORDS.test(text) && FACT_QUESTION.test(text) && !NOT_FRESH_FACTS.test(text))
        || wantsOfficialSource(text);
}

export function wantsOfficialSource(question) {
    return /\bofficial\b|\b(?:docs|documentation)\b/i.test(String(question ?? ""));
}

function officialScore(link, keywords) {
    let url;
    try { url = new URL(link); } catch { return 0; }

    const host = url.hostname.replace(/^www\./, "");
    const squashedHost = host.replace(/[^a-z0-9]/g, "");
    let score = 0;
    if (/^(docs|developer|developers|learn|support|help|api)\./.test(host)) score += 1;
    if (keywords.some((word) => {
        const squashed = word.replace(/[^a-z0-9]/g, "");
        return squashed.length >= 3 && squashedHost.includes(squashed);
    })) score += 1;
    if (/\/(docs?|documentation|reference|api)(\/|$)/i.test(url.pathname)) score += 0.5;
    if (UNOFFICIAL_HOSTS.test(host)) score -= 1.5;
    return score;
}

export function filterRelevantResults(query, results, limit = 5, { preferOfficial = false } = {}) {
    const keywords = [...new Set(getKeywords(query))];
    if (keywords.length === 0 || !Array.isArray(results)) return [];

    const seen = new Set();
    const scored = results.map((result) => {
        const text = `${result.title ?? ""} ${result.description ?? ""}`.toLowerCase();
        const matched = keywords.filter((word) => text.includes(word));
        const relevance = matched.length / keywords.length;
        const bonus = preferOfficial && relevance > 0 ? officialScore(result.link, keywords) : 0;
        return { result, relevance, score: relevance + bonus };
    });

    // At least one meaningful query word must appear in the title/snippet.
    return scored
        .filter((item) => item.relevance > 0)
        .sort((a, b) => b.score - a.score)
        .filter(({ result }) => {
            if (!result.link) return true;
            if (seen.has(result.link)) return false;
            seen.add(result.link);
            return true;
        })
        .slice(0, limit)
        .map((item) => item.result);
}

export function cleanSearchQuery(query) {
    return String(query)
        .replace(/\b(?:please\s+)?search\s+(?:the\s+web\s+)?(?:for|about)?\s*/i, "")
        .replace(/\blook up\s*/i, "")
        .replace(/\bfind online\s*/i, "")
        .replace(/\s+and\s+(?:calculate|compute|solve)\b[\s\S]*$/i, "")
        .replace(/[?.!,;]+$/g, "")
        .trim();
}

async function getOfficialNodeVersionResults(query) {
    const mentionsNode = /\bnode(?:\.js)?\b/i.test(query);
    const asksVersion = /\b(version|latest|current|lts|release)\b/i.test(query);
    if (!mentionsNode || !asksVersion) return null;

    // Use Node.js's official release index for version questions, not model guesses.
    const response = await fetch("https://nodejs.org/dist/index.json", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Official Node.js version lookup failed (${response.status}).`);

    const releases = await response.json();
    if (!Array.isArray(releases) || releases.length === 0) {
        throw new Error("The official Node.js release list was empty.");
    }

    const current = releases.find((release) => release && release.version && release.lts === false);
    const lts = releases.find((release) => release && release.version && release.lts);
    const parts = [];
    if (current) parts.push(`Latest Current release: ${current.version}`);
    if (lts) parts.push(`Latest LTS release (recommended for most users): ${lts.version}`);
    if (parts.length === 0) return null;

    return [{
        title: "Node.js official releases",
        description: `${parts.join(". ")}. These versions are read from the official Node.js release index.`,
        link: "https://nodejs.org/en/download"
    }];
}

// ---- steadier searching ----
// The same question twice within ten minutes is answered from memory (faster, and kinder to engines that rate-limit).
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 100;
const cache = new Map();
// An engine that just failed sits out for a minute, so the next question doesn't wait for it to fail again.
const SIT_OUT_MS = 60 * 1000;
const sitOut = new Map();
export const clearSearchCache = () => { cache.clear(); sitOut.clear(); };

const FRESH = /\b(?:latest|current|currently|today|now|newest|recent|recently|this year|new)\b/i;

export async function webSearch(query, options = {}) {
    if (typeof query !== "string" || !query.trim()) {
        throw new Error("A search query is required.");
    }

    if (!isUsefulSearchQuery(query)) return [];

    try {
        const officialResults = await getOfficialNodeVersionResults(query);
        if (officialResults) return officialResults;
    } catch {
        // If the official version endpoint is unavailable, continue with general web search.
    }

    const preferOfficial = options.preferOfficial ?? wantsOfficialSource(query);
    let searchText = query.trim();
    if (preferOfficial && !/\b(docs|documentation)\b/i.test(searchText)) searchText += " official documentation";
    // "latest" with no year: add this year, or engines hand back old pages.
    if (FRESH.test(searchText) && !/\b(?:19|20)\d\d\b/.test(searchText)) searchText += ` ${new Date().getFullYear()}`;

    const key = `${preferOfficial ? "official:" : ""}${searchText.toLowerCase().replace(/\s+/g, " ")}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return structuredClone(hit.results);

    // Providers with a key (steadier) first, DuckDuckGo (no key, can break) as the spare. One that fails or finds nothing
    // relevant hands over to the next. Only the search words are sent, never your files or chat.
    const errors = [];
    const all = providerOrder();
    const rested = all.filter((p) => (sitOut.get(p) ?? 0) <= Date.now());
    const order = rested.length ? rested : all; // if everyone is resting, try them anyway
    for (const [index, provider] of order.entries()) {
        try {
            const raw = await PROVIDERS[provider](searchText);
            sitOut.delete(provider);
            const kept = filterRelevantResults(query, raw, 5, { preferOfficial });
            if (kept.length) {
                if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
                cache.set(key, { at: Date.now(), results: structuredClone(kept) });
                return kept;
            }
            if (index === order.length - 1) return kept;
        } catch (error) {
            errors.push(error);
            sitOut.set(provider, Date.now() + SIT_OUT_MS);
            log.info("search_provider_failed", { provider, message: error.message });
        }
    }
    throw errors[errors.length - 1] ?? new Error("Web search failed.");
}

const stripTags = (text) => String(text ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").trim();
const clean = (list) => list.filter((r) => r.title && /^https?:\/\//i.test(r.link ?? "")).map((r) => ({ title: stripTags(r.title), link: r.link, description: stripTags(r.description) }));

function providerOrder() {
    const keyed = [config.braveKey && "brave", config.tavilyKey && "tavily", config.searxngUrl && "searxng"].filter(Boolean);
    const chosen = config.searchProvider;
    // DuckDuckGo has two doors (the normal page and the "lite" one). When one is rate-limited the other often still answers.
    if (chosen === "duckduckgo") return ["duckduckgo", "duckduckgo-lite"];
    if (["brave", "tavily", "searxng"].includes(chosen) && keyed.includes(chosen)) return [chosen, "duckduckgo", "duckduckgo-lite"];
    return [...keyed, "duckduckgo", "duckduckgo-lite"];
}

async function getJson(url, init, name) {
    let response;
    try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    } catch (error) {
        throw new Error(error?.name === "TimeoutError" || error?.name === "AbortError" ? `${name} timed out.` : `Couldn't reach ${name}.`);
    }
    if (response.status === 401 || response.status === 403) throw new Error(`${name} refused the key. Check it in your settings.`);
    if (response.status === 429) throw new Error(`${name} is rate-limiting requests right now. Try again in a minute.`);
    if (!response.ok) throw new Error(`${name} failed (${response.status}).`);
    try { return await response.json(); } catch { throw new Error(`${name} gave an answer I couldn't read.`); }
}

const PROVIDERS = {
    async brave(text) {
        const data = await getJson(`${config.braveUrl}?q=${encodeURIComponent(text)}&count=10`, { headers: { Accept: "application/json", "X-Subscription-Token": config.braveKey } }, "Brave Search");
        return clean((data?.web?.results ?? []).map((r) => ({ title: r.title, link: r.url, description: r.description })));
    },
    async tavily(text) {
        const data = await getJson(config.tavilyUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.tavilyKey}` }, body: JSON.stringify({ query: text, max_results: 10 }) }, "Tavily");
        return clean((data?.results ?? []).map((r) => ({ title: r.title, link: r.url, description: r.content })));
    },
    async searxng(text) {
        const base = config.searxngUrl.replace(/\/+$/, "");
        const data = await getJson(`${base}/search?q=${encodeURIComponent(text)}&format=json`, { headers: { Accept: "application/json" } }, "your SearXNG server");
        return clean((data?.results ?? []).map((r) => ({ title: r.title, link: r.url, description: r.content })));
    },
    async "duckduckgo-lite"(text) {
        let response;
        try {
            response = await fetch("https://lite.duckduckgo.com/lite/", {
                method: "POST",
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Content-Type": "application/x-www-form-urlencoded" },
                body: `q=${encodeURIComponent(text)}`,
                signal: AbortSignal.timeout(10000)
            });
        } catch (error) {
            throw new Error(error?.name === "TimeoutError" || error?.name === "AbortError" ? "Web search timed out." : "Couldn't reach the search engine. Check your internet connection.");
        }
        if (response.status === 202 || response.status === 429) throw new Error("The search engine is rate-limiting requests right now. Try again in a minute.");
        if (!response.ok) throw new Error(`Web search failed (${response.status}).`);
        const html = await response.text();
        if (/anomaly-modal|unusual traffic/i.test(html)) throw new Error("The search engine is rate-limiting requests right now. Try again in a minute.");

        // The lite page is a plain table: a link with class result-link, then a cell with class result-snippet.
        const links = [...html.matchAll(/<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>/gi)];
        const snippets = [...html.matchAll(/<td\b[^>]*\bresult-snippet\b[^>]*>([\s\S]*?)<\/td>/gi)];
        return clean(links.map((m, i) => ({
            title: m[2],
            link: normalizeResultUrl(/\bhref=['"]([^'"]+)['"]/i.exec(m[1])?.[1]),
            description: snippets[i]?.[1] ?? ""
        })));
    },
    async duckduckgo(text) {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(text)}`;
        let response;
        try {
            response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml"
                },
                signal: AbortSignal.timeout(10000)
            });
        } catch (error) {
            const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
            throw new Error(timedOut
                ? "Web search timed out."
                : "Couldn't reach the search engine. Check your internet connection.");
        }

        if (response.status === 202 || response.status === 429) {
            throw new Error("The search engine is rate-limiting requests right now. Try again in a minute.");
        }
        if (!response.ok) throw new Error(`Web search failed (${response.status}).`);

        const html = await response.text();
        if (/anomaly-modal|unusual traffic/i.test(html)) {
            throw new Error("The search engine is rate-limiting requests right now. Try again in a minute.");
        }

        const $ = cheerio.load(html);
        const results = [];
        $(".result").each((_, element) => {
            const item = $(element);
            const anchor = item.find("a.result__a").first();
            const title = anchor.text().trim();
            const link = normalizeResultUrl(anchor.attr("href"));
            const description = item.find(".result__snippet").text().trim();
            if (title && link && /^https?:\/\//i.test(link)) results.push({ title, link, description });
        });
        return results;
    }
};

