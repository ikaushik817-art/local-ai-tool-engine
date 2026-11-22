#!/usr/bin/env node
// One-command setup:  node setup.js   (or: npm run setup)
// Installs deps, finds your model (Ollama / LM Studio / API key), saves .env, sends a test message.
// Only uses Node built-ins, so it works before `npm install`.
import { existsSync, writeFileSync, chmodSync, readFileSync, appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, ".env");
const isWindows = process.platform === "win32";

const OLLAMA_URL = "http://localhost:11434";
const LMSTUDIO_URL = "http://localhost:1234/v1";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:3b";

const API_PROVIDERS = [
    { label: "OpenAI", url: "https://api.openai.com/v1" },
    { label: "Groq", url: "https://api.groq.com/openai/v1" },
    { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
    { label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
    { label: "Other (any OpenAI-compatible URL)", url: "" }
];

async function getJson(url, { headers = {}, timeoutMs = 2500 } = {}) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

// Why a server didn't answer, in words a person can act on.
export function whyNoAnswer(error) {
    const code = error?.cause?.code ?? error?.code;
    if (code === "ECONNREFUSED") return "nothing is listening there (the server isn't running)";
    if (error?.name === "TimeoutError" || error?.name === "AbortError") return "no answer in time";
    if (error?.status) return `it answered with HTTP ${error.status}`;
    return error?.message ?? "no answer";
}

// "localhost" can mean IPv6 (::1) while the server only listens on 127.0.0.1 (Ollama does), so try both spellings.
// OLLAMA_HOST (what Ollama itself uses to change its address) is honoured too.
export function candidateURLs(url, extra = []) {
    const list = [url, ...extra.filter(Boolean)];
    if (/\/\/localhost\b/i.test(url)) list.push(url.replace(/\/\/localhost\b/i, "//127.0.0.1"));
    return [...new Set(list.map((u) => u.replace(/\/+$/, "")))];
}
function ollamaHostEnv() {
    const host = process.env.OLLAMA_HOST?.trim();
    if (!host) return null;
    const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`;
    return withScheme.replace(/\/\/0\.0\.0\.0\b/, "//127.0.0.1");
}

export async function detectLocal({ ollamaURL = OLLAMA_URL, lmURL = LMSTUDIO_URL } = {}) {
    const found = { ollama: null, lmstudio: null };
    const tried = [];
    for (const url of candidateURLs(ollamaURL, [ollamaHostEnv()])) {
        try {
            const data = await getJson(`${url}/api/tags`, { timeoutMs: 4000 });
            found.ollama = { baseURL: url, models: (data.models ?? []).map((m) => m.name) };
            break;
        } catch (error) { tried.push({ what: "Ollama", url, reason: whyNoAnswer(error) }); }
    }
    for (const url of candidateURLs(lmURL)) {
        try {
            const data = await getJson(`${url}/models`, { timeoutMs: 4000 });
            found.lmstudio = { baseURL: url, models: (data.data ?? []).map((m) => m.id) };
            break;
        } catch (error) { tried.push({ what: "LM Studio", url, reason: whyNoAnswer(error) }); }
    }
    Object.defineProperty(found, "tried", { value: found.ollama && found.lmstudio ? [] : tried, enumerable: false });
    return found;
}

// Is the Ollama program installed (even if its server isn't running)?
export function ollamaInstalled() {
    try { return spawnSync("ollama", ["--version"], { stdio: "ignore", timeout: 8000 }).status === 0; } catch { return false; } // ollama is a program, not a script: no shell needed
}

// Starts `ollama serve` in the background and waits until it answers.
export async function startOllama({ waitMs = 20000, say = () => {} } = {}) {
    let stopped = null;
    try {
        const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", (error) => { stopped = error.message; });
        child.on("exit", (code) => { stopped = `\`ollama serve\` stopped right away (exit code ${code})`; });
        child.unref();
    } catch (error) { say(`Couldn't start Ollama: ${error.message}`); return null; }
    const until = Date.now() + waitMs;
    for (let seconds = 1; Date.now() < until; seconds++) {
        await new Promise((r) => setTimeout(r, 1000));
        const found = await detectLocal();
        if (found.ollama) return found.ollama;
        if (stopped) { say(`${stopped}.`); return null; }
        if (seconds % 5 === 0) say(`  still waiting for Ollama (${seconds}s)...`);
    }
    return null;
}

// Speech, embedding, image and safety models can't chat.
const NON_CHAT = /embed|whisper|tts|stt|dall|moderation|image|audio|realtime|transcribe|rerank|guard|orpheus|speech|sora/i;
export const isChatModel = (id) => !NON_CHAT.test(id);

// Prefer small/fast chat models, skip the ones that can't chat.
export function pickModel(ids) {
    const chat = ids.filter(isChatModel);
    const pool = chat.length ? chat : ids;
    return pool.find((id) => /mini|instant|flash|haiku|small|lite|\b8b\b|\b3b\b/i.test(id)) ?? pool[0] ?? "";
}

export function buildEnv({ provider, baseURL, model, apiKey }) {
    const lines = ["# Created by setup.js. Keep this file private (it can hold your API key).", `AI_PROVIDER=${provider}`];
    if (provider === "ollama") {
        lines.push(`OLLAMA_BASE_URL=${baseURL}`, `OLLAMA_MODEL=${model}`);
    } else {
        lines.push(`OPENAI_BASE_URL=${baseURL}`, `OPENAI_MODEL=${model}`);
        if (apiKey) lines.push(`OPENAI_API_KEY=${apiKey}`);
    }
    return `${lines.join("\n")}\n`;
}

// npm is a .cmd file on Windows, so it needs a shell, and with a shell Node wants one command string (not an args array).
// Real programs (ollama, node) don't need one.
function run(command, args) {
    return isWindows && command === "npm"
        ? spawnSync(`npm ${args.join(" ")}`, { cwd: here, stdio: "inherit", shell: true })
        : spawnSync(command, args, { cwd: here, stdio: "inherit" });
}

async function main() {
    const flags = process.argv.slice(2);
    // `npm start` calls this every time; do nothing once already configured.
    if (flags.includes("--if-needed") && (existsSync(envPath) || process.env.AI_PROVIDER)) return;

    if (Number(process.versions.node.split(".")[0]) < 18) {
        console.log("Please install Node.js 18 or newer from https://nodejs.org and run this again.");
        process.exit(1);
    }

    console.log("\nLocal AI Tool setup\n");

    if (!existsSync(path.join(here, "node_modules"))) {
        console.log("Installing dependencies (one time)...");
        if (run("npm", ["install", "--no-audit", "--no-fund"]).status !== 0) {
            console.log("\nnpm install failed. Check your internet connection and run this again.");
            process.exit(1);
        }
    }

    const interactive = Boolean(process.stdin.isTTY);
    // PDFs need one small extra library. Ask once; `npm start` adds it.
    const offerPdf = async () => {
        if (!interactive || /^AI_PDF\s*=\s*on/im.test(readFileSync(envPath, "utf8"))) return;
        const answer = (await ask("Read PDF files too? It adds one small library (about 1 MB). y/n", "y")).toLowerCase();
        if (answer.startsWith("n")) return;
        appendFileSync(envPath, "AI_PDF=on\n");
        console.log("Okay. It will be added when you start.");
    };
    const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    const ask = async (question, fallback = "") => {
        if (!rl) return fallback;
        const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
        return answer || fallback;
    };
    const menu = async (title, labels) => {
        console.log(title);
        labels.forEach((label, i) => console.log(`  ${i + 1}) ${label}`));
        const n = Number(await ask("Pick a number", "1"));
        return Math.min(Math.max(Number.isInteger(n) ? n : 1, 1), labels.length) - 1;
    };

    try {
        if (existsSync(envPath) && interactive) {
            if (!/^y/i.test(await ask("A saved setup already exists. Replace it? (y/N)", "n"))) {
                console.log("Keeping it. Run: npm start");
                return;
            }
        }

        console.log("Looking for a local model...");
        let found = await detectLocal();
        if (!found.ollama && interactive && ollamaInstalled()) {
            const tried = found.tried.filter((t) => t.what === "Ollama");
            console.log("Ollama is installed, but I couldn't reach its server:");
            for (const t of tried) console.log(`  - ${t.url}: ${t.reason}`);
            if (tried.every((t) => /isn't running/.test(t.reason)) && /^y/i.test(await ask("Start it now? (Y/n)", "y"))) {
                console.log("Starting Ollama (this can take a few seconds)...");
                const started = await startOllama({ say: (message) => console.log(message) });
                if (started) found = await detectLocal();
                else console.log("It didn't start in time. Open the Ollama app (or run `ollama serve` in another terminal), then run this again.");
            }
        }
        const options = [];
        if (found.ollama) options.push({ id: "ollama", label: `Ollama (running, ${found.ollama.models.length} model(s) installed)` });
        if (found.lmstudio) options.push({ id: "lmstudio", label: "LM Studio (server running)" });
        options.push({ id: "custom", label: "My local server is at another address (type it)" });
        options.push({ id: "api", label: "Use an API key (OpenAI, Groq, OpenRouter, Gemini...)" });

        if (!found.ollama && !found.lmstudio) {
            console.log("No local model found. What I checked:");
            for (const t of found.tried) console.log(`  - ${t.what} at ${t.url}: ${t.reason}`);
            console.log("Start Ollama (open the app, or run `ollama serve`) or start LM Studio's server (Developer tab, Start Server), then run this again. Or pick another option below.\n");
        }
        if (!interactive && options[0].id === "custom") {
            console.log("Not an interactive terminal and no local model found. Run `npm run setup` in a normal terminal.");
            process.exit(1);
        }

        const choice = options[interactive ? await menu("\nHow do you want to connect?", options.map((o) => o.label)) : 0].id;
        let settings;

        if (choice === "ollama") {
            let models = found.ollama.models;
            if (models.length === 0) {
                console.log(`\nNo models installed yet. Downloading ${DEFAULT_OLLAMA_MODEL} (about 2 GB, one time)...`);
                if (run("ollama", ["pull", DEFAULT_OLLAMA_MODEL]).status !== 0) {
                    console.log(`Couldn't download it. Run "ollama pull ${DEFAULT_OLLAMA_MODEL}" yourself, then run this again.`);
                    process.exit(1);
                }
                models = [DEFAULT_OLLAMA_MODEL];
            }
            const preferred = models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : pickModel(models);
            if (models.length > 1) console.log(`Installed: ${models.join(", ")}`);
            settings = { provider: "ollama", baseURL: found.ollama.baseURL, model: await ask("Model", preferred) };
        } else if (choice === "custom") {
            const raw = (await ask("Address of your server, like http://192.168.1.5:11434 (Ollama) or http://localhost:1234/v1 (LM Studio)")).replace(/\/+$/, "");
            if (!/^https?:\/\//i.test(raw)) { console.log("That doesn't look like an address (it should start with http:// or https://)."); process.exit(1); }
            let kind = null; let ids = [];
            try { ids = ((await getJson(`${raw}/api/tags`, { timeoutMs: 6000 })).models ?? []).map((m) => m.name); kind = "ollama"; } catch { /* not Ollama */ }
            if (!kind) {
                try { ids = ((await getJson(`${raw.endsWith("/v1") ? raw : `${raw}/v1`}/models`, { timeoutMs: 6000 })).data ?? []).map((m) => m.id); kind = "lmstudio"; }
                catch (error) { console.log(`Couldn't reach ${raw}: ${whyNoAnswer(error)}.`); process.exit(1); }
            }
            const base = kind === "ollama" ? raw : (raw.endsWith("/v1") ? raw : `${raw}/v1`);
            settings = { provider: kind, baseURL: base, model: await ask("Model", ids.length ? pickModel(ids) : "") };
        } else if (choice === "lmstudio") {
            const models = found.lmstudio.models;
            if (models.length === 0) console.log("LM Studio is running but no model is loaded. Load one there before chatting.");
            settings = { provider: "lmstudio", baseURL: found.lmstudio.baseURL, model: models.length ? await ask("Model", pickModel(models)) : "" };
        } else {
            const p = API_PROVIDERS[await menu("\nWhich provider?", API_PROVIDERS.map((x) => x.label))];
            const baseURL = (p.url || await ask("Base URL (ends with /v1)")).replace(/\/+$/, "");
            let apiKey = "";
            let models = [];

            for (let attempt = 0; attempt < 3; attempt++) {
                apiKey = await ask(`${p.label} API key`);
                if (!apiKey) { console.log("An API key is needed for this option."); process.exit(1); }
                try {
                    const data = await getJson(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs: 10000 });
                    models = (data.data ?? []).map((m) => String(m.id).replace(/^models\//, ""));
                    break;
                } catch (error) {
                    if (error.status === 401 || error.status === 403) {
                        console.log("That key was rejected. Try again.");
                        if (attempt === 2) process.exit(1);
                    } else {
                        console.log("Couldn't list models from there (that's okay, you can type the model name).");
                        break;
                    }
                }
            }
            models = models.filter(isChatModel);
            if (models.length) console.log(`Chat models: ${models.slice(0, 12).join(", ")}${models.length > 12 ? ", ..." : ""}`);
            let model = await ask("Model name", pickModel(models));
            for (let tries = 0; tries < 2 && model && !isChatModel(model); tries++) {
                console.log(`"${model}" looks like a speech/embedding/safety model, not a chat model.`);
                model = await ask("Pick a chat model", pickModel(models));
            }
            if (!model) { console.log("A model name is needed."); process.exit(1); }
            settings = { provider: "openai", baseURL, model, apiKey };
        }

        writeFileSync(envPath, buildEnv(settings), { mode: 0o600 });
        try { chmodSync(envPath, 0o600); } catch { /* not supported on Windows, fine */ }
        console.log("\nSaved your settings.");

        console.log("Testing the connection (the first reply can take a minute while the model loads)...");
        const { createModelAdapter } = await import("./model.js");
        for (let attempt = 0; ; attempt++) {
            try {
                const adapter = createModelAdapter(settings.provider, settings);
                const reply = await adapter.generate([{ role: "user", content: "Reply with the single word: ready" }]);
                console.log(`Model says: ${String(reply.content).slice(0, 80) || "(empty reply)"}`);
                await offerPdf();
                console.log("\nAll set! Start chatting with:  npm start\n");
                break;
            } catch (error) {
                console.log(`\nTest failed: ${error.message}`);
                // Wrong model for this provider is the common cause, so let them pick another right here.
                if (!interactive || attempt >= 2 || !/model|400|404/i.test(error.message)) {
                    console.log("Your setup is saved. Fix the issue above, then run: npm start   (or npm run setup to change it)\n");
                    break;
                }
                const next = await ask("Try a different model name (Enter to stop)");
                if (!next) { console.log("Setup is saved. Run npm run setup to change it later.\n"); break; }
                settings = { ...settings, model: next };
                writeFileSync(envPath, buildEnv(settings), { mode: 0o600 });
            }
        }
    } finally {
        rl?.close();
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch((error) => {
        console.error(`Setup failed: ${error.message}`);
        process.exit(1);
    });
}
