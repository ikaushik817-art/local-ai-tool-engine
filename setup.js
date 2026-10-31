#!/usr/bin/env node
// One-command setup:  node setup.js   (or: npm run setup)
// Installs deps, finds your model (Ollama / LM Studio / API key), saves .env, sends a test message.
// Only uses Node built-ins, so it works before `npm install`.
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

export async function detectLocal({ ollamaURL = OLLAMA_URL, lmURL = LMSTUDIO_URL } = {}) {
    const found = { ollama: null, lmstudio: null };
    try {
        const data = await getJson(`${ollamaURL}/api/tags`);
        found.ollama = { baseURL: ollamaURL, models: (data.models ?? []).map((m) => m.name) };
    } catch { /* not running */ }
    try {
        const data = await getJson(`${lmURL}/models`);
        found.lmstudio = { baseURL: lmURL, models: (data.data ?? []).map((m) => m.id) };
    } catch { /* not running */ }
    return found;
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

function run(command, args) {
    return spawnSync(command, args, { cwd: here, stdio: "inherit", shell: isWindows });
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
        const found = await detectLocal();
        const options = [];
        if (found.ollama) options.push({ id: "ollama", label: `Ollama (running, ${found.ollama.models.length} model(s) installed)` });
        if (found.lmstudio) options.push({ id: "lmstudio", label: "LM Studio (server running)" });
        options.push({ id: "api", label: "Use an API key (OpenAI, Groq, OpenRouter, Gemini...)" });

        if (!found.ollama && !found.lmstudio) {
            console.log("No local model found. Install Ollama (https://ollama.com) or start LM Studio's server and re-run this, or just use an API key below.\n");
        }
        if (!interactive && options[0].id === "api") {
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
