// A small log file for when something goes wrong. One JSON object per line, no extra dependencies.
// Secrets (API keys, tokens) are blanked out before anything is written. Set AI_LOG=off to turn it off.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { inc } from "./metrics.js";

const LEVELS = { off: 0, error: 1, info: 2, debug: 3 };
const MAX_BYTES = 1024 * 1024; // when the file passes 1 MB it is moved to .1 and a new one starts

// Keys and tokens people paste by mistake. Matches the usual shapes, not just exact keys.
const SECRET_PATTERNS = [
    /\bgsk_[A-Za-z0-9]{16,}/g,                 // Groq
    /\bsk-[A-Za-z0-9_-]{16,}/g,                // OpenAI and friends
    /\bAIza[A-Za-z0-9_-]{20,}/g,               // Google
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,    // any bearer header
    /("?(?:api[_-]?key|token|authorization|password|secret)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi
];

export function redact(value) {
    let text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    for (const pattern of SECRET_PATTERNS) {
        text = text.replace(pattern, (match, prefix) => (typeof prefix === "string" ? `${prefix}[hidden]` : "[hidden]"));
    }
    return text;
}

// Tell a webhook (Slack-style JSON) when something fails, at most once a minute so a failing loop can't flood it.
// Only the event name and the redacted message are sent, never your messages or files.
let lastAlert = 0;
let held = 0;
function alert(event, data) {
    const url = config.errorWebhook;
    if (!url) return;
    const now = Date.now();
    if (now - lastAlert < 60000) { held++; return; }
    const more = held ? ` (+${held} more in the last minute)` : "";
    lastAlert = now;
    held = 0;
    const text = redact(`L.A.T.E. error: ${event}${data?.message ? ` - ${String(data.message).slice(0, 200)}` : ""}${more}`);
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, event }), signal: AbortSignal.timeout(3000) }).catch(() => {});
}
export const resetAlerts = () => { lastAlert = 0; held = 0; };

// A short summary of a log file: what failed, what ran, how slow it was. `npm run logs`.
export function summarize(text) {
    const events = text.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const tools = {};
    const errors = {};
    for (const e of events) {
        if (e.event === "tool" || e.event === "tool_failed") {
            const t = (tools[e.tool] ??= { calls: 0, failed: 0, ms: 0 });
            t.calls++; t.ms += e.ms ?? 0; if (e.event === "tool_failed") t.failed++;
        }
        if (e.level === "error") (errors[e.event] ??= []).push(e);
    }
    const out = [`${events.length} log lines${events.length ? `, ${events[0].time.slice(0, 16)} to ${events[events.length - 1].time.slice(0, 16)}` : ""}`, ""];
    out.push("Tools:");
    for (const [name, t] of Object.entries(tools).sort((a, b) => b[1].calls - a[1].calls)) out.push(`  ${name.padEnd(16)} ${String(t.calls).padStart(5)} calls  ${t.failed} failed  avg ${Math.round(t.ms / t.calls)} ms`);
    if (!Object.keys(tools).length) out.push("  none yet");
    out.push("", "Errors:");
    for (const [name, list] of Object.entries(errors).sort((a, b) => b[1].length - a[1].length)) out.push(`  ${name.padEnd(16)} ${String(list.length).padStart(5)}  last: ${String(list[list.length - 1].message ?? "").slice(0, 100)}`);
    if (!Object.keys(errors).length) out.push("  none");
    return out.join("\n");
}

export function createLogger({ level = config.logLevel, file = config.logFile } = {}) {
    const limit = LEVELS[level] ?? LEVELS.info;
    let broken = false; // a log problem must never break the app, and we don't retry forever

    function write(kind, event, data) {
        inc("late_events_total", { level: kind, event, ...(data?.tool ? { tool: data.tool } : {}) });
        if (kind === "error") alert(event, data);
        if (limit < LEVELS[kind] || broken) return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            try {
                if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
            } catch { /* no file yet */ }
            const line = redact({ time: new Date().toISOString(), level: kind, event, ...data });
            fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
        } catch {
            broken = true;
        }
    }

    return {
        error: (event, data = {}) => write("error", event, data),
        info: (event, data = {}) => write("info", event, data),
        debug: (event, data = {}) => write("debug", event, data)
    };
}

export const log = createLogger();
