// Extra built-in tools: datetime, remember/recall/forget, search_files, research.
// Everything is local or free: no API keys, no extra dependencies.
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { webSearch } from "./webSearch.js";
import { readWebpage, SECRET_PATH } from "./extras.js";

const STOP_WORDS = new Set(["the", "and", "for", "are", "was", "were", "what", "where", "when", "who", "how", "why", "which", "this", "that", "with", "from", "about", "have", "has", "does", "did", "can", "you", "your", "any", "all", "some", "tell", "find", "show", "file", "files", "folder", "notes", "mine", "into", "than", "then"]);
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

export function dateTime({ until } = {}, now = new Date()) {
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

export async function remember({ text } = {}) {
    const note = String(text ?? "").trim().replace(/\s+/g, " ");
    if (note.length < 3) throw new Error("Tell me what to remember.");
    if (note.length > MAX_NOTE_CHARS) throw new Error(`That's too long to remember (max ${MAX_NOTE_CHARS} characters).`);
    if (LOOKS_SECRET.test(note)) throw new Error("I don't store passwords or API keys.");

    const notes = readNotes();
    if (notes.some((n) => n.text.toLowerCase() === note.toLowerCase())) return `I already have that noted: ${note}`;
    if (notes.length >= MAX_NOTES) throw new Error(`My memory is full (${MAX_NOTES} notes). Ask me to forget some first.`);

    notes.push({ text: note, saved: new Date().toISOString().slice(0, 10) });
    await writeNotes(notes);
    return `Got it, I'll remember: ${note}`;
}

export async function recall({ query } = {}) {
    let notes = readNotes();
    const words = keywordsOf(query ?? "");
    if (words.length) notes = notes.filter((n) => words.some((w) => n.text.toLowerCase().includes(w)));
    if (!notes.length) return words.length ? `I don't have anything saved about "${query}".` : "I haven't been asked to remember anything yet.";
    return `Here's what I remember:\n${notes.map((n, i) => `${i + 1}. ${n.text}`).join("\n")}`;
}

export async function forget({ text } = {}) {
    const target = String(text ?? "").trim().toLowerCase();
    if (!target) throw new Error("Tell me what to forget.");

    const notes = readNotes();
    if (/^(everything|all|all notes|all of it)$/.test(target)) {
        await writeNotes([]);
        return notes.length ? `Done, I forgot all ${notes.length} notes.` : "There was nothing to forget.";
    }
    const wordMatch = new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const kept = notes.filter((n) => !wordMatch.test(n.text));
    if (kept.length === notes.length) return `I couldn't find a note matching "${text}".`;
    await writeNotes(kept);
    const removed = notes.length - kept.length;
    return `Forgot ${removed} note${removed === 1 ? "" : "s"} about "${text}".`;
}

// ---------- search_files ----------

const MAX_SCAN_FILES = 2000;
const MAX_SCAN_BYTES = 200 * 1024;
const MAX_SCAN_MS = 6000;

export async function searchFiles({ query } = {}) {
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
            const rel = path.relative(root, full);
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

    if (!hits.length) return `Nothing in ${root} matched "${query}".${stoppedEarly ? " (I stopped early, the folder is big.)" : ""}`;
    const top = hits.slice(0, 10);
    const lines = top.map((h) => (h.line ? `- ${h.file}:${h.line}: ${h.text}` : `- ${h.file} ${h.text}`));
    return `Found ${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" (showing ${top.length}):\n${lines.join("\n")}${stoppedEarly ? "\n(I stopped early, the folder is big.)" : ""}`;
}

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
// (deps lets tests replace the network.)
export async function research({ question } = {}, deps = {}) {
    const search = deps.search ?? webSearch;
    const read = deps.read ?? readWebpage;
    if (typeof question !== "string" || !question.trim()) throw new Error("A question to research is required.");

    const results = await search(question.trim());
    const seen = new Set();
    const picks = results.filter((r) => {
        let host;
        try { host = new URL(r.link).hostname; } catch { return false; }
        if (seen.has(host)) return false; // one page per site, for variety
        seen.add(host);
        return true;
    }).slice(0, 3);

    if (!picks.length) return { question, sources: [], note: "No relevant results were found." };

    const words = keywordsOf(question);
    const pages = await Promise.allSettled(picks.map((r) => read({ url: r.link })));
    const sources = picks.map((r, i) => ({
        title: r.title,
        link: r.link,
        excerpt: pages[i].status === "fulfilled" ? bestWindow(pages[i].value.content, words) : r.description // page failed: fall back to the snippet
    }));
    return { question, sources };
}
