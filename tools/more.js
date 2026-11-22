// Extra built-in tools: datetime, remember/recall/forget, search_files, research.
// Everything is local or free: no API keys, no extra dependencies.
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { webSearch } from "./webSearch.js";
import { randomInt } from "node:crypto";
import { readWebpage, readFileText, SECRET_PATH, memoize } from "./extras.js";

const STOP_WORDS = new Set(["the", "and", "for", "are", "was", "were", "what", "where", "when", "who", "how", "why", "which", "this", "that", "with", "from", "about", "have", "has", "does", "did", "can", "you", "your", "any", "all", "some", "tell", "find", "show", "file", "files", "folder", "notes", "mine", "into", "than", "then"]);
// Does the note have this word (or a longer form of it: fruit -> fruits)? Whole words only: "art" is not in "party".
const hasWord = (text, word) => new RegExp(`(?:^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text);
const keywordsOf = (text) => [...new Set(String(text).toLowerCase().split(/[^a-z0-9_.@-]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)))];

// ---------- datetime ----------

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const longDate = (d) => d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

// Understands 2026-12-25, "25 December", "December 25th", "25 Dec 2027". Not names like "Diwali".
export function parseTargetDate(text, now = new Date()) {
    const raw = String(text ?? "").trim();
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

    const cleaned = raw.replace(/(\d)(st|nd|rd|th)\b/gi, "$1").replace(/\bof\b/gi, " ").replace(/,/g, " ");
    if (!/[a-z]/i.test(cleaned) || !/\d/.test(cleaned)) return null; // needs a month name and a day
    const hasYear = /\b\d{4}\b/.test(cleaned);
    let date = new Date(hasYear ? cleaned : `${cleaned} ${now.getFullYear()}`);
    if (Number.isNaN(date.getTime())) return null;
    if (!hasYear && startOfDay(date) < startOfDay(now)) date = new Date(`${cleaned} ${now.getFullYear() + 1}`); // already passed: next year
    return Number.isNaN(date.getTime()) ? null : date;
}

// "10000 days", "3 weeks ago", "2 months from today": exact calendar maths, never a guess.
function addToDate(text, now) {
    const m = String(text).trim().toLowerCase().match(/^(\d[\d,]*)\s*(day|week|month|year)s?(?:\s+(ago|before\s+(?:today|now)|from\s+(?:today|now)|after\s+(?:today|now)|later|hence))?$/);
    if (!m) return `I couldn't understand "${text}". Try something like "10000 days" or "3 weeks ago".`;

    const amount = Number(m[1].replace(/,/g, ""));
    const unit = m[2];
    const back = /^(ago|before)/.test(m[3] ?? "");
    const limit = { day: 1e6, week: 2e5, month: 3e4, year: 3e3 }[unit];
    if (!Number.isFinite(amount) || amount > limit) return `${text} is too far away for me to work out.`;

    const target = startOfDay(now);
    const n = back ? -amount : amount;
    if (unit === "day") target.setDate(target.getDate() + n);
    else if (unit === "week") target.setDate(target.getDate() + 7 * n);
    else if (unit === "month") target.setMonth(target.getMonth() + n);
    else target.setFullYear(target.getFullYear() + n);
    if (Number.isNaN(target.getTime())) return `${text} is too far away for me to work out.`;

    const label = `${amount.toLocaleString("en-US")} ${unit}${amount === 1 ? "" : "s"}`;
    return back
        ? `${label} ago was ${longDate(target)}. (Today is ${longDate(now)}.)`
        : `${label} from today is ${longDate(target)}. (Today is ${longDate(now)}.)`;
}

function dateTimeText({ until, after, on } = {}, now = new Date()) {
    if (after && String(after).trim()) return addToDate(after, now);
    if (on && String(on).trim()) {
        const date = parseTargetDate(on, now);
        return date ? `${String(on).trim()} is a ${date.toLocaleDateString("en-US", { weekday: "long" })} (${longDate(date)}).` : `I couldn't understand the date "${on}". Try a format like 2026-12-25 or 25 December 2026.`;
    }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    let answer = `It's ${time} on ${longDate(now)} (${zone}).`;

    if (until && String(until).trim()) {
        const target = parseTargetDate(until, now);
        if (!target) return `${answer}\nI couldn't understand the date "${until}". Try a format like 2026-12-25 or 25 December.`;
        const days = Math.round((startOfDay(target) - startOfDay(now)) / 86400000);
        const plural = (n) => `${n} day${n === 1 ? "" : "s"}`;
        answer += days === 0 ? `\n${longDate(target)} is today!`
            : days > 0 ? `\n${plural(days)} until ${longDate(target)}.`
            : `\n${longDate(target)} was ${plural(-days)} ago.`;
    }
    return answer;
}
export const dateTime = (args, now = new Date()) => dateTimeText(args, now);
export const dateTimeData = (args = {}, now = new Date()) => ({ date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`, text: dateTimeText(args, now) });


// ---------- remember / recall / forget ----------

const MAX_NOTES = 100;
const MAX_NOTE_CHARS = 300;
const LOOKS_SECRET = /\b(?:sk-[a-z0-9]|gsk_[a-z0-9]|ghp_[a-z0-9]|AKIA[A-Z0-9]|xox[abp]-|AIza[a-z0-9_-])|\b(?:api[ _-]?keys?|passwords?|passwd|secrets?|tokens?)\b/i;

function readNotes() {
    try {
        const data = JSON.parse(readFileSync(config.notesFile, "utf8"));
        return Array.isArray(data) ? data.filter((n) => typeof n?.text === "string") : [];
    } catch {
        return [];
    }
}

async function writeNotes(notes) {
    const temp = `${config.notesFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify(notes, null, 2), { mode: 0o600 });
    await fs.rename(temp, config.notesFile);
}

// The engine puts these in the system prompt, so the model "just knows" them every chat.
export const loadNotes = () => readNotes().slice(-20).map((n) => n.text);

export async function rememberData({ text, replaces } = {}) {
    let note = String(text ?? "").trim().replace(/\s+/g, " ");
    // "my favorite number is 777, tell me the number, forget it..." only the first part is the fact.
    const cut = note.replace(/[,;]?\s+(?:and\s+)?(?:then\s+)?(?:tell me|show me|forget (?:it|that|this)|read (?:it|that|this)|and then)\b.*$/i, "").replace(/[,;.\s]+$/, "");
    if (cut.length >= 3) note = cut;
    if (note.length < 3) throw new Error("Tell me what to remember.");
    if (note.length > MAX_NOTE_CHARS) throw new Error(`That's too long to remember (max ${MAX_NOTE_CHARS} characters).`);
    if (LOOKS_SECRET.test(note)) throw new Error("I don't store passwords or API keys.");

    // "change my favorite fruit to apple": the older notes about the same thing are replaced, not left next to the new one.
    const all = readNotes();
    const topic = keywordsOf(replaces ?? "");
    const notes = topic.length ? all.filter((n) => !topic.every((w) => hasWord(n.text, w))) : all;
    const replaced = all.length - notes.length;
    if (!replaced && notes.some((n) => n.text.toLowerCase() === note.toLowerCase())) return { saved: false, replaced: 0, note, text: `I already have that noted: ${note}` };
    if (notes.length >= MAX_NOTES) throw new Error(`My memory is full (${MAX_NOTES} notes). Ask me to forget some first.`);

    notes.push({ text: note, saved: new Date().toISOString().slice(0, 10) });
    await writeNotes(notes);
    return { saved: true, replaced, note, text: replaced ? `Updated, I'll remember: ${note} (replaced ${replaced} older note${replaced === 1 ? "" : "s"})` : `Got it, I'll remember: ${note}` };
}
export const remember = async (...args) => (await rememberData(...args)).text;


export async function recallData({ query } = {}) {
    let notes = readNotes();
    const words = keywordsOf(query ?? "");
    if (words.length) {
        // Only the notes that are about ALL of it: "favorite fruit" never brings back "favorite color". A long question may miss one word.
        const need = words.length <= 3 ? words.length : Math.ceil(words.length * 0.75);
        const scored = notes.map((n) => ({ n, score: words.filter((w) => hasWord(n.text, w)).length }));
        const best = Math.max(0, ...scored.map((x) => x.score));
        notes = best < need ? [] : scored.filter((x) => x.score === best).map((x) => x.n);
    }
    if (!notes.length) return { count: 0, notes: [], text: words.length ? `I don't have anything saved about "${query}".` : "I haven't been asked to remember anything yet." };
    if (words.length) notes = [...notes].reverse(); // asked about something: the newest note is the current one
    return { count: notes.length, notes: notes.map((n) => n.text), text: `Here's what I remember:\n${notes.map((n, i) => `${i + 1}. ${n.text}`).join("\n")}` };
}
export const recall = async (args) => (await recallData(args)).text;

export async function forgetData({ text } = {}) {
    const target = String(text ?? "").trim().toLowerCase();
    if (!target) throw new Error("Tell me what to forget.");

    const notes = readNotes();
    if (/^(everything|all|all notes|all of it)$/.test(target)) {
        await writeNotes([]);
        return { removed: notes.length, text: notes.length ? `Done, I forgot all ${notes.length} notes.` : "There was nothing to forget." };
    }
    if (/^(?:the\s+)?(?:latest|last|most recent|newest)(?:\s+(?:one|note|value|fact|thing|memory))?(?:\s+only)?$/.test(target)) { // "forget the latest one"
        if (!notes.length) return { removed: 0, text: "There was nothing to forget." };
        await writeNotes(notes.slice(0, -1));
        return { removed: 1, text: `Done, I forgot the latest note: ${notes.at(-1).text}` };
    }
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const words = keywordsOf(target);
    // 1) the exact note, 2) notes containing that phrase, 3) notes containing all its key words.
    let kept = null;
    const exact = notes.filter((n) => n.text.toLowerCase() === target);
    if (exact.length) kept = notes.filter((n) => n.text.toLowerCase() !== target);
    if (!kept) {
        const phrase = new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, "i");
        const hit = notes.filter((n) => phrase.test(n.text));
        if (hit.length) kept = notes.filter((n) => !phrase.test(n.text));
    }
    if (!kept && words.length) {
        const all = notes.filter((n) => words.every((w) => hasWord(n.text, w)));
        if (all.length) kept = notes.filter((n) => !all.includes(n));
    }
    if (!kept || kept.length === notes.length) return { removed: 0, text: `I couldn't find a note matching "${text}".` };
    await writeNotes(kept);
    const removed = notes.length - kept.length;
    return { removed, text: `Forgot ${removed} note${removed === 1 ? "" : "s"} about "${text}".` };
}
export const forget = async (...args) => (await forgetData(...args)).text;


// ---------- search_files ----------

const MAX_SCAN_FILES = 2000;
const MAX_SCAN_BYTES = 200 * 1024;
const MAX_SCAN_MS = 6000;

export async function searchFilesData({ query } = {}) {
    const words = typeof query === "string" ? keywordsOf(query) : [];
    if (!words.length) throw new Error("Give me a word or two to look for.");

    const root = await fs.realpath(path.resolve(config.filesDir));
    const started = Date.now();
    const hits = [];
    let scanned = 0;
    let stoppedEarly = false;

    async function walk(dir, depth) {
        if (depth > 8 || stoppedEarly) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

        for (const entry of entries) {
            if (stoppedEarly) return;
            const full = path.join(dir, entry.name);
            const rel = path.relative(root, full).split(path.sep).join("/");
            if (entry.isSymbolicLink() || SECRET_PATH.test(rel)) continue; // never follow links out, never read secrets

            if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
            if (!entry.isFile()) continue;
            if (++scanned > MAX_SCAN_FILES || Date.now() - started > MAX_SCAN_MS) { stoppedEarly = true; return; }

            if (words.some((w) => entry.name.toLowerCase().includes(w))) hits.push({ file: rel, line: 0, score: 2, text: "(file name matches)" });

            let text;
            try {
                const stat = await fs.stat(full);
                if (stat.size > MAX_SCAN_BYTES) continue;
                const buffer = await fs.readFile(full);
                if (buffer.subarray(0, 8000).includes(0)) continue; // binary
                text = buffer.toString("utf8");
            } catch { continue; }

            text.split(/\r?\n/).forEach((line, i) => {
                const lower = line.toLowerCase();
                const score = words.filter((w) => lower.includes(w)).length;
                if (score > 0) hits.push({ file: rel, line: i + 1, score, text: line.trim().slice(0, 160) });
            });
        }
    }

    await walk(root, 0);
    hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);

    if (!hits.length) return { count: 0, files: [], text: `Nothing in ${root} matched "${query}".${stoppedEarly ? " (I stopped early, the folder is big.)" : ""}` };
    const top = hits.slice(0, 10);
    const lines = top.map((h) => (h.line ? `- ${h.file}:${h.line}: ${h.text}` : `- ${h.file} ${h.text}`));
    return { count: hits.length, files: [...new Set(top.map((h) => h.file))], text: `Found ${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" (showing ${top.length}):\n${lines.join("\n")}${stoppedEarly ? "\n(I stopped early, the folder is big.)" : ""}` };
}
export const searchFiles = async (...args) => (await searchFilesData(...args)).text;


// ---------- research ----------

// Pick the stretch of the page that mentions the question's words the most.
export function bestWindow(text, words, size = 1200) {
    if (text.length <= size) return text;
    const lower = text.toLowerCase();
    let best = { start: 0, score: -1 };
    for (let start = 0; start < text.length - 200; start += 300) {
        const chunk = lower.slice(start, start + size);
        const score = words.reduce((sum, w) => sum + chunk.split(w).length - 1, 0);
        if (score > best.score) best = { start, score };
    }
    const piece = text.slice(best.start, best.start + size).trim();
    return `${best.start > 0 ? "... " : ""}${piece}${best.start + size < text.length ? " ..." : ""}`;
}

// Search, open the best few pages, and hand back the most relevant parts with their sources.
// A page that fails, or has nothing readable on it (many sites that need JavaScript show an empty page), is replaced by
// the next result, so you still get three real sources when they exist. (deps lets tests replace the network.)
const WANT_PAGES = 3;
const MIN_PAGE_CHARS = 200;

export async function research({ question } = {}, deps = {}) {
    const search = deps.search ?? webSearch;
    const read = deps.read ?? readWebpage;
    if (typeof question !== "string" || !question.trim()) throw new Error("A question to research is required.");
    const asked = question.trim();
    const words = keywordsOf(asked);

    let results = await search(asked);
    // Few results: ask again with just the key words, and merge. Different wording finds different pages.
    const short = words.join(" ");
    if (results.length < 5 && short && short.toLowerCase() !== asked.toLowerCase()) {
        try {
            const have = new Set(results.map((r) => r.link));
            results = [...results, ...(await search(short)).filter((r) => !have.has(r.link))];
        } catch { /* the first search is enough */ }
    }

    const seen = new Set();
    const candidates = results.filter((r) => {
        let host;
        try { host = new URL(r.link).hostname; } catch { return false; }
        if (seen.has(host)) return false; // one page per site, for variety
        seen.add(host);
        return true;
    }).slice(0, WANT_PAGES * 2);

    if (!candidates.length) return { question, sources: [], note: "No relevant results were found." };

    const good = [];
    const queue = [...candidates];
    while (good.length < WANT_PAGES && queue.length) {
        const batch = queue.splice(0, WANT_PAGES - good.length);
        const pages = await Promise.allSettled(batch.map((r) => read({ url: r.link })));
        batch.forEach((r, i) => {
            const content = pages[i].status === "fulfilled" ? String(pages[i].value?.content ?? "") : "";
            if (content.trim().length >= MIN_PAGE_CHARS) good.push({ r, excerpt: bestWindow(content, words) });
        });
    }

    const sources = good.map(({ r, excerpt }) => ({ title: r.title, link: r.link, excerpt }));
    // Still short of three: use the search snippets of the pages we couldn't read (marked, so nobody mistakes them for a read page).
    for (const r of candidates) {
        if (sources.length >= WANT_PAGES) break;
        if (!good.some((g) => g.r === r) && r.description) sources.push({ title: r.title, link: r.link, excerpt: r.description, snippetOnly: true });
    }
    return { question, sources };
}

// ---------- convert ----------

// Every unit maps to a factor of its category's base unit. Temperature is handled separately.
const UNIT_TABLE = {
    length: { m: 1, meter: 1, metre: 1, km: 1000, kilometer: 1000, kilometre: 1000, cm: 0.01, centimeter: 0.01, centimetre: 0.01, mm: 0.001, millimeter: 0.001, mi: 1609.344, mile: 1609.344, ft: 0.3048, foot: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254, yd: 0.9144, yard: 0.9144 },
    mass: { kg: 1, kilogram: 1, g: 0.001, gram: 0.001, mg: 1e-6, lb: 0.45359237, pound: 0.45359237, oz: 0.028349523125, ounce: 0.028349523125, t: 1000, tonne: 1000 },
    volume: { l: 1, liter: 1, litre: 1, ml: 0.001, gal: 3.785411784, gallon: 3.785411784, cup: 0.2365882365, tbsp: 0.01478676478, tsp: 0.00492892159 },
    speed: { "m/s": 1, "km/h": 1 / 3.6, kmh: 1 / 3.6, kph: 1 / 3.6, mph: 0.44704, knot: 0.5144444444444444, kn: 0.5144444444444444 },
    data: { byte: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 },
    time: { s: 1, sec: 1, second: 1, min: 60, minute: 60, h: 3600, hr: 3600, hour: 3600, day: 86400, week: 604800 }
};
const TEMPERATURE = { c: "c", celsius: "c", f: "f", fahrenheit: "f", k: "k", kelvin: "k" };

export function findUnit(raw) {
    const name = String(raw ?? "").toLowerCase().replace(/[°\s]/g, "").replace(/^degrees?/, "");
    for (const candidate of [name, name.endsWith("s") ? name.slice(0, -1) : null]) {
        if (!candidate) continue;
        if (Object.hasOwn(TEMPERATURE, candidate)) return { category: "temperature", scale: TEMPERATURE[candidate] };
        for (const [category, units] of Object.entries(UNIT_TABLE)) {
            if (Object.hasOwn(units, candidate)) return { category, factor: units[candidate] };
        }
    }
    return null;
}

export function convertData({ value, from, to } = {}) {
    const amount = Number(String(value ?? "").replace(/,/g, ""));
    if (String(value ?? "").trim() === "" || !Number.isFinite(amount)) throw new Error("Give me a number to convert.");

    const a = findUnit(from);
    const b = findUnit(to);
    if (!a) throw new Error(`I don't know the unit "${from}".`);
    if (!b) throw new Error(`I don't know the unit "${to}".`);
    if (a.category !== b.category) throw new Error(`I can't convert ${a.category} to ${b.category}.`);

    let result;
    if (a.category === "temperature") {
        const celsius = a.scale === "c" ? amount : a.scale === "f" ? (amount - 32) * 5 / 9 : amount - 273.15;
        if (celsius < -273.15) throw new Error("That's below absolute zero.");
        result = b.scale === "c" ? celsius : b.scale === "f" ? celsius * 9 / 5 + 32 : celsius + 273.15;
    } else {
        result = amount * a.factor / b.factor;
    }
    return { value: Number(result.toPrecision(6)), unit: String(to).trim(), text: `${amount} ${String(from).trim()} = ${Number(result.toPrecision(6))} ${String(to).trim()}` };
}
export const convert = (...args) => convertData(...args).text;


// ---------- weather ----------

const WEATHER_CODES = [
    [[0], "clear sky"], [[1], "mostly clear"], [[2], "partly cloudy"], [[3], "overcast"], [[45, 48], "fog"],
    [[51, 53, 55, 56, 57], "drizzle"], [[61, 63, 65, 66, 67], "rain"], [[71, 73, 75, 77], "snow"],
    [[80, 81, 82], "rain showers"], [[85, 86], "snow showers"], [[95, 96, 99], "thunderstorm"]
];
const describeWeather = (code) => WEATHER_CODES.find(([codes]) => codes.includes(code))?.[1] ?? "unknown conditions";

async function fetchJson(url) {
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    } catch (error) {
        throw new Error(error?.name === "TimeoutError" ? "The weather service took too long." : "Couldn't reach the weather service. Check your internet connection.");
    }
    if (!response.ok) throw new Error(`The weather service returned an error (${response.status}).`);
    return response.json();
}

// Current weather from Open-Meteo (free, no key). deps.getJson lets tests replace the network.
const weatherMemo = memoize((args) => fetchWeather(args), { ttlMs: 300000 });
export const weatherData = (args = {}, deps = {}) => (deps.getJson ? fetchWeather(args, deps) : weatherMemo(`${String(args.city ?? "").trim().toLowerCase()}|${args.unit ?? ""}`, args));

async function fetchWeather({ city, unit } = {}, deps = {}) {
    const getJson = deps.getJson ?? fetchJson;
    const place = String(city ?? "").trim();
    if (!place) throw new Error("Tell me which city.");

    const found = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
    const spot = found?.results?.[0];
    if (!spot) throw new Error(`I couldn't find a place called "${place}".`);

    const fahrenheit = /^(f|fahrenheit|farenheit)$/i.test(String(unit ?? "").replace(/[°\s]/g, "")); // the service converts, so it's exact
    const data = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto${fahrenheit ? "&temperature_unit=fahrenheit" : ""}`);
    const now = data?.current;
    const units = data?.current_units ?? {};
    if (!now || typeof now.temperature_2m !== "number") throw new Error("The weather service sent back something I can't read.");

    const name = [spot.name, spot.country].filter(Boolean).join(", ");
    return { place: name, temperature: now.temperature_2m, unit: units.temperature_2m ?? "°C", text: `${name}: ${describeWeather(now.weather_code)}, ${now.temperature_2m}${units.temperature_2m ?? "°C"} (feels like ${now.apparent_temperature}${units.apparent_temperature ?? "°C"}), humidity ${now.relative_humidity_2m}%, wind ${now.wind_speed_10m} ${units.wind_speed_10m ?? "km/h"}.` };
}
export const weather = async (args, deps) => (await weatherData(args, deps)).text;

// ---------- save to the ai-output folder ----------

const OUTPUT_FOLDER = "ai-output";
const MAX_SAVE_BYTES = 100 * 1024;

// The one safe way anything in this project writes a file: a new file with a plain name inside ai-output/.
// It never overwrites (a taken name gets -2, -3...) and never goes anywhere else.
export async function writeOutput(name, content) {
    // the adapters' "cut off" notice is for the person reading the chat, never for a file
    const text = String(content ?? "").replace(/\s*\(The answer was cut off because[^)]*\)\s*/gi, "\n").trim();
    if (!text.trim()) throw new Error("There's nothing to save.");
    if (Buffer.byteLength(text) > MAX_SAVE_BYTES) throw new Error("That's too big to save (max 100 KB).");

    const file = String(name ?? "").trim().replace(/^ai-output[\\/]/, ""); // results say "ai-output/x.txt": that is also a good way to name it
    if (!file || /[\\/]/.test(file) || file.startsWith(".") || /^[a-zA-Z]:/.test(file) || file.includes("\0")) {
        throw new Error("Use a simple file name like report.md (no folders).");
    }
    if (!/\.(md|txt|json|csv)$/i.test(file)) throw new Error("I can only save .md, .txt, .json or .csv files.");
    if (file.length > 100) throw new Error("That file name is too long.");

    const folder = path.resolve(config.filesDir, OUTPUT_FOLDER);
    await fs.mkdir(folder, { recursive: true });
    const realFolder = await fs.realpath(folder);

    const extension = path.extname(file);
    const stem = file.slice(0, file.length - extension.length);
    for (let attempt = 1; attempt <= 99; attempt++) {
        const finalName = attempt === 1 ? file : `${stem}-${attempt}${extension}`;
        try {
            // "wx" means: create it, and fail if anything is already there.
            await fs.writeFile(path.join(realFolder, finalName), text, { flag: "wx", mode: 0o644 });
        } catch (error) {
            if (error.code === "EEXIST") continue;
            throw error;
        }
        const size = Buffer.byteLength(text);
        return { path: finalName, text: `Saved to ${OUTPUT_FOLDER}/${finalName} (${size < 1024 ? `${size} bytes` : `${(size / 1024).toFixed(1)} KB`})` };
    }
    throw new Error("There are too many files with that name already.");
}
export const saveToOutput = async (name, content) => (await writeOutput(name, content)).text;

// A conversation as a Markdown document (for /export).
export function chatToMarkdown(messages, now = new Date()) {
    const lines = ["# L.A.T.E. chat", "", `Saved ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`, ""];
    for (const message of messages) {
        if (message.role === "user") lines.push(`**You:** ${message.content}`, "");
        else if (message.role === "assistant") lines.push(`**AI:** ${message.content}`, "");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

// ---------- wikipedia ----------

async function fetchWiki(url) {
    let response;
    try {
        response = await fetch(url, {
            headers: { "User-Agent": "L.A.T.E./1.0 (https://github.com/ikaushik817-art/local-ai-tool-engine)", Accept: "application/json" },
            signal: AbortSignal.timeout(10000)
        });
    } catch (error) {
        throw new Error(error?.name === "TimeoutError" ? "Wikipedia took too long." : "Couldn't reach Wikipedia. Check your internet connection.");
    }
    if (!response.ok) throw new Error(`Wikipedia returned an error (${response.status}).`);
    return response.json();
}

// A short, reliable summary from Wikipedia. (deps.getJson lets tests replace the network.)
export async function wikipedia({ topic } = {}, deps = {}) {
    const getJson = deps.getJson ?? fetchWiki;
    const term = String(topic ?? "").trim();
    if (!term) throw new Error("Tell me what to look up.");

    const found = await getJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(term)}&limit=1&namespace=0&format=json`);
    const title = found?.[1]?.[0];
    if (!title) throw new Error(`I couldn't find a Wikipedia page for "${term}".`);

    const slug = encodeURIComponent(title.replace(/ /g, "_"));
    const page = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
    const extract = String(page?.extract ?? "").replace(/\s+/g, " ").trim();
    if (!extract) throw new Error(`The Wikipedia page "${title}" has no summary.`);

    const text = extract.length > 900 ? `${extract.slice(0, 900).replace(/\s+\S*$/, "")}...` : extract;
    const note = page.type === "disambiguation" ? " (this name has several meanings, try a more specific one)" : "";
    return `${page.title ?? title}${note}: ${text}\nSource: ${page?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${slug}`}`;
}

// ---------- "...and calculate 15% of it" ----------
// When one question needs a search AND some math on what the search finds, the model only reads the
// number out of the sources. The maths is done by the calculator, and the base number has to really appear
// in what was found, so a made-up figure can't slip through.

const SCALES = { thousand: 1e3, k: 1e3, lakh: 1e5, million: 1e6, mn: 1e6, m: 1e6, crore: 1e7, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12, tn: 1e12 };

// Every number in a text, with "1.4 billion" and "1421 million" both turned into plain numbers.
export function numbersInText(text) {
    const found = [];
    for (const match of String(text ?? "").matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(thousand|lakh|million|mn|crore|billion|bn|trillion|tn|k|m|b)?\b/gi)) {
        const value = Number(match[1].replace(/,/g, "")) * (match[2] ? SCALES[match[2].toLowerCase()] : 1);
        if (Number.isFinite(value)) found.push(value);
    }
    return found;
}

export const baseIsGrounded = (base, ...texts) => Number.isFinite(base)
    && numbersInText(texts.join(" ")).some((n) => Math.abs(n - base) <= Math.abs(base) * 0.005);

export const formatNumber = (n) => Number(n.toPrecision(15)).toLocaleString("en-US", { maximumFractionDigits: 10 });

// Spots the math part of "find X and calculate 15% of it". Returns null for everything else.
export function parseFollowUp(question) {
    const q = String(question ?? "");
    let m = q.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(?:it|that|this|them)\b/i);
    if (m) {
        const percent = m[1];
        return { label: `${percent}% of it`, expression: (base) => `${base} * ${percent} / 100`, line: (base, result) => `${percent}% of ${formatNumber(base)} = ${formatNumber(result)}` };
    }
    m = q.match(/\b(half|double|twice|triple)\s+(?:of\s+)?(?:it|that)\b/i);
    if (m) {
        const word = m[1].toLowerCase();
        const [phrase, operation] = { half: ["half of", "/ 2"], double: ["double", "* 2"], twice: ["double", "* 2"], triple: ["triple", "* 3"] }[word];
        return { label: `${word} of it`, expression: (base) => `${base} ${operation}`, line: (base, result) => `${phrase} ${formatNumber(base)} = ${formatNumber(result)}` };
    }
    return null;
}


// ---------- exact counting and random numbers (models are bad at both) ----------

// Characters, words and lines of a text, or of a file. Exact.
export async function textStatsData({ text, file } = {}) {
    let body = typeof text === "string" ? text : undefined;
    let source = "That text";
    if (file) {
        const read = await readFileText(file);
        body = read.text;
        source = read.file;
    }
    if (body === undefined || body === "") throw new Error("Give me some text (or a file) to count.");

    const characters = [...body].length;
    const noSpaces = [...body.replace(/\s/g, "")].length;
    const words = body.trim() ? body.trim().split(/\s+/).length : 0;
    const lines = body.split(/\r?\n/).length;
    const shown = file ? source : `"${body.length > 40 ? `${body.slice(0, 40)}...` : body}"`;
    const summary = `${shown}: ${characters} character${characters === 1 ? "" : "s"} (${noSpaces} without spaces), ${words} word${words === 1 ? "" : "s"}, ${lines} line${lines === 1 ? "" : "s"}.`;
    return { characters, noSpaces, words, lines, text: summary };
}
export const textStats = async (args) => (await textStatsData(args)).text;

// Real random whole numbers (a model can't be random). Unique by default.
export function randomNumbersData({ count = 1, min = 1, max = 1000000, unique = true } = {}) {
    const n = Number(count), lo = Number(min), hi = Number(max);
    if (![n, lo, hi].every(Number.isInteger) || n < 1 || n > 1000) throw new Error("Ask for 1 to 1000 whole numbers, like: 5 random numbers between 1 and 1000.");
    if (hi < lo || hi - lo > 2 ** 40) throw new Error("That range doesn't work. Try something like 1 to 1000.");
    const wantUnique = unique !== false && String(unique).toLowerCase() !== "false";
    if (wantUnique && hi - lo + 1 < n) throw new Error(`There aren't ${n} different numbers between ${lo} and ${hi}.`);

    const picked = [];
    while (picked.length < n) {
        const value = randomInt(lo, hi + 1);
        if (!wantUnique || !picked.includes(value)) picked.push(value);
    }
    return { numbers: picked, text: `Random number${n === 1 ? "" : "s"} (${lo} to ${hi}${wantUnique && n > 1 ? ", all different" : ""}): ${picked.join(", ")}` };
}
export const randomNumbers = (args) => randomNumbersData(args).text;


// ---------- exact maths over a list of numbers (models are bad at "which is the biggest") ----------

export async function numberStatsData({ numbers, labels, operation = "max", file } = {}) {
    // A file is read in full here. (read_file shows only the start of a long file, which is fine to look at but not to add up.)
    if (file) numbers = (await readFileText(file)).text;
    const tokens = String(numbers ?? "").replace(/(?<=\d),(?=\d{3}(?!\d))/g, "").split(/[\s,;|]+/).filter(Boolean);
    if (!tokens.length) throw new Error("Give me some numbers, like: 12, 7, 30.");
    if (tokens.length > 200000) throw new Error("That is too many numbers to add up here (the limit is 200,000).");
    const values = tokens.map(Number);
    const bad = tokens.find((_, i) => !Number.isFinite(values[i]));
    if (bad !== undefined) throw new Error(`"${bad}" isn't a number, so I can't compare them.`);

    const names = labels ? String(labels).split(/\s*,\s*/).filter(Boolean) : [];
    const name = (i) => (names.length === values.length ? names[i] : `#${i + 1}`);
    // A thousand numbers don't all belong in an answer (or in the model's prompt): show ten, say how many more.
    const SHOWN = 10;
    const all = values.slice(0, SHOWN).map((v, i) => `${name(i)} = ${v}`).join(", ") + (values.length > SHOWN ? `, ... (+${values.length - SHOWN} more)` : "");
    const op = String(operation).toLowerCase();
    // value is the number itself, where says which one it came from, summary is the one-line answer, text adds the list.
    const result = (label, value, where) => {
        const summary = `${label}: ${Array.isArray(value) ? value.join(", ") : value}${where ? ` (${where})` : ""}`;
        return { operation: label.toLowerCase(), value, where, summary, text: `${summary}. All: ${all}` };
    };
    const extreme = (pick, word) => {
        const target = pick(...values);
        return result(word, target, values.map((v, i) => (v === target ? name(i) : null)).filter(Boolean).join(", "));
    };
    if (/^(max|largest|biggest|highest|greatest)$/.test(op)) return extreme(Math.max, "Largest");
    if (/^(min|smallest|lowest|least)$/.test(op)) return extreme(Math.min, "Smallest");
    const sum = values.reduce((a, b) => a + b, 0);
    if (op === "sum" || op === "total") return result("Sum", Number(sum.toPrecision(15)));
    if (/^(avg|average|mean)$/.test(op)) return result("Average", Number((sum / values.length).toPrecision(15)));
    if (op === "count") return result("Count", values.length);
    if (op === "distinct") return result("Distinct", new Set(values).size);
    if (op === "sort") { const sorted = [...values].sort((x, y) => x - y); return { ...result("Sorted", sorted), first: sorted[0], last: sorted.at(-1) }; }
    throw new Error(`I don't know the operation "${operation}". Use max, min, sum, average, count or sort.`);
}
export const numberStats = async (args) => (await numberStatsData(args)).text;

// ---------- append_file: add text to the end of a file that is already in ai-output ----------

// Does this file exist in the output folder? (A name with folders is left for the tools to refuse.)
export async function outputFileExists(name) {
    const file = String(name ?? "").trim().replace(/^ai-output[\\/]/, "");
    if (!file || /[\\/]/.test(file)) return true;
    try { await fs.lstat(path.join(config.filesDir, OUTPUT_FOLDER, file)); return true; } catch { return false; }
}

export async function appendToOutputData(name, content) {
    const text = String(content ?? "");
    if (!text.trim()) throw new Error("There's nothing to add.");
    const file = String(name ?? "").trim().replace(/^ai-output[\\/]/, "");
    if (!file || /[\\/]/.test(file) || file.startsWith(".") || /^[a-zA-Z]:/.test(file) || file.includes("\0")) {
        throw new Error("Use a simple file name like report.md (no folders).");
    }
    if (!/\.(md|txt|json|csv)$/i.test(file)) throw new Error("I can only change .md, .txt, .json or .csv files.");

    const folder = path.resolve(config.filesDir, OUTPUT_FOLDER);
    let realFolder;
    try { realFolder = await fs.realpath(folder); } catch { throw new Error(`There is no ${OUTPUT_FOLDER}/${file} yet. Create it first.`); }
    const target = path.join(realFolder, file);
    let stat;
    try { stat = await fs.lstat(target); } catch { throw new Error(`There is no ${OUTPUT_FOLDER}/${file} yet. Create it first.`); }
    if (!stat.isFile()) throw new Error(`${OUTPUT_FOLDER}/${file} isn't a normal file.`);
    const added = Buffer.byteLength(text);
    if (stat.size + added > MAX_SAVE_BYTES) throw new Error("That file would get too big (max 100 KB).");

    await fs.appendFile(target, text, { mode: 0o644 });
    return { path: file, bytes: added, text: `Added ${added} byte${added === 1 ? "" : "s"} to ${OUTPUT_FOLDER}/${file} (now ${stat.size + added} bytes)` };
}
export const appendToOutput = async (...args) => (await appendToOutputData(...args)).text;



// ---------- text_transform: exact text changes (models drop letters, skip lines and mis-sort) ----------

const TRANSFORMS = {
    uppercase: (t) => t.toUpperCase(),
    lowercase: (t) => t.toLowerCase(),
    title: (t) => t.toLowerCase().replace(/(^|[\s(\-"'])([a-z\u00e0-\u024f])/g, (_, a, b) => a + b.toUpperCase()),
    reverse: (t) => [...t].reverse().join(""),
    reverse_words: (t) => t.split(/\s+/).filter(Boolean).reverse().join(" "),
    sort_lines: (t) => t.split(/\r?\n/).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).join("\n"),
    unique_lines: (t) => [...new Set(t.split(/\r?\n/))].join("\n"),
    number_lines: (t) => t.split(/\r?\n/).map((l, i) => `${i + 1}. ${l}`).join("\n"),
    trim: (t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join("\n"),
    remove_spaces: (t) => t.replace(/\s+/g, "")
};
const TRANSFORM_ALIASES = { upper: "uppercase", capitals: "uppercase", lower: "lowercase", titlecase: "title", reverse_text: "reverse", sort: "sort_lines", dedupe: "unique_lines", unique: "unique_lines", remove_duplicates: "unique_lines", numbered: "number_lines" };

export async function textTransform({ text, file, operation } = {}) {
    const key = String(operation ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const name = TRANSFORMS[key] ? key : TRANSFORM_ALIASES[key];
    if (!name) throw new Error(`I don't know "${operation}". Use: ${Object.keys(TRANSFORMS).join(", ")}.`);
    let body = typeof text === "string" ? text : undefined;
    if (file) body = (await readFileText(file)).text;
    if (body === undefined || body === "") throw new Error("Give me some text (or a file) to change.");
    return TRANSFORMS[name](body);
}


// ---------- compare_text: is this text exactly what it should be? (checking a saved report, a merge, a file that may have changed) ----------

// a and b are texts, or JSON lists of texts (with labels as a JSON list of names): then it says WHICH one differs.
export function compareTextData({ a, b, labels, label, has, missing } = {}) {
    if (a === undefined || (b === undefined && has === undefined)) throw new Error("I need two texts to compare.");
    if (missing) { // which points of b (the original) a (the summary) doesn't cover: a point is covered when most of its words are in the summary
        const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
        const have = words(a);
        const points = String(b).split(/\n+/).map((l) => l.trim()).filter((l) => l.split(/\s+/).length >= 4 && !/^(?:sources?:|[-*]?\s*https?:)/i.test(l));
        const lost = points.filter((p) => { const w = [...words(p)]; return w.length && w.filter((x) => have.has(x)).length / w.length < 0.6; });
        return { equal: !lost.length, missing: lost, count: lost.length, total: points.length, text: lost.length ? `Missing from the summary (${lost.length} of ${points.length} points):\n- ${lost.join("\n- ")}` : `Nothing is missing: all ${points.length} points are covered.` };
    }
    if (has !== undefined) { // "is FIRST in final.txt?": the text must contain it
        const found = String(a).includes(String(has));
        const what = label ? ` (${String(label).trim()})` : "";
        return { equal: found, differences: found ? [] : [`missing "${has}"`], text: found ? `Match${what}: the text contains "${has}".` : `Different${what}: the text doesn't contain "${has}".` };
    }
    const list = (v) => { try { const x = JSON.parse(v); return Array.isArray(x) ? x.map(String) : null; } catch { return null; } };
    const tidy = (s) => String(s).replace(/\r\n/g, "\n").trimEnd();
    const clip = (s) => { const t = String(s); return t.length > 60 ? `${t.slice(0, 60)}...` : t; };
    const quote = (s) => (s === undefined ? "nothing" : `"${clip(s)}"`);
    const what = label ? ` (${String(label).trim()})` : "";
    const [A, B, names] = [list(a), list(b), list(labels) ?? []];
    const [x, y] = A && B ? [A, B] : [[tidy(a)], [tidy(b)]];
    const bad = [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (A && B) { if (tidy(x[i] ?? "") !== tidy(y[i] ?? "")) bad.push(`${names[i] ?? `#${i + 1}`} changed (was "${clip(tidy(x[i] ?? ""))}", now "${clip(tidy(y[i] ?? ""))}")`); continue; }
        const [p, q] = [x[0].split("\n"), y[0].split("\n")];
        for (let n = 0; n < Math.max(p.length, q.length); n++) if (p[n] !== q[n]) { bad.push(`line ${n + 1}: expected ${quote(p[n])} but found ${quote(q[n])}`); break; }
    }
    return { equal: !bad.length, differences: bad, text: bad.length ? `Different${what}: ${bad.slice(0, 5).join("; ")}.` : `Match${what}: ${A && B ? `all ${x.length} texts are` : "the text is"} identical.` };
}
export const compareText = (...args) => compareTextData(...args).text;


// ---------- compare_numbers: are these two numbers the same? (checking one answer against another) ----------

export function compareNumbersData({ a, b, label } = {}) {
    const num = (v, which) => {
        // A tool's answer line ("Largest: 897472 (#4). All: ...") is the number after its label; any other sentence is not a number.
        const text = String(v ?? "").trim();
        const labelled = /^[A-Za-z][A-Za-z ()]{0,30}:\s*(-?\d[\d,]*(?:\.\d+)?)(?=[\s.(]|$)/.exec(text)?.[1];
        const n = Number((labelled ?? text).replace(/(?<=\d),(?=\d{3}(?!\d))/g, "").trim());
        if (!Number.isFinite(n)) throw new Error(`"${v}" isn't a number, so I can't compare ${which}.`);
        return n;
    };
    const x = num(a, "the first one");
    const y = num(b, "the second one");
    const what = label ? ` (${String(label).trim()})` : "";
    // Tiny float noise isn't a difference: 0.1 + 0.2 and 0.3 match.
    const same = Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
    const text = same
        ? `Match${what}: both are ${Number(x.toPrecision(15))}.`
        : `Different${what}: ${Number(x.toPrecision(15))} vs ${Number(y.toPrecision(15))} (difference ${Number(Math.abs(x - y).toPrecision(15))}).`;
    return { equal: same, a: x, b: y, difference: Number(Math.abs(x - y).toPrecision(15)), text };
}
export const compareNumbers = (...args) => compareNumbersData(...args).text;

