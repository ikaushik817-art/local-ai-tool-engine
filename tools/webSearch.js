import * as cheerio from "cheerio";

const STOP_WORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "for", "to", "of", "in",
    "on", "at", "and", "or", "with", "please", "find", "search", "look", "up",
    "latest", "current", "today", "recent", "about", "tell", "me", "what",
    "which", "how", "version", "official", "documentation", "docs"
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

// "latest" and "news" almost always mean the user wants fresh info. Words like
// "today" or "current" only count next to a topic word ("current Node version").
export function hasSearchIntent(question) {
    const text = String(question ?? "");
    return EXPLICIT_SEARCH.test(text)
        || /\b(latest|newest|news)\b/i.test(text)
        || (/\b(current|currently|recent|recently|today|right now|this (?:week|month|year))\b/i.test(text) && TOPIC_WORDS.test(text))
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

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchText)}`;
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

        if (title && link && /^https?:\/\//i.test(link)) {
            results.push({ title, link, description });
        }
    });

    return filterRelevantResults(query, results, 5, { preferOfficial });
}
