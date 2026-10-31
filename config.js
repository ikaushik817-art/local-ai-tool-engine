import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tiny .env reader (no dependency). Real environment variables always win.
export function parseEnv(text) {
    const values = {};
    for (const line of String(text).split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || line.trim().startsWith("#")) continue;
        values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return values;
}

export const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
try {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(ENV_FILE, "utf8")))) {
        if (process.env[key] === undefined) process.env[key] = value;
    }
} catch { /* no .env yet, that's fine */ }

const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
    provider: process.env.AI_PROVIDER || "ollama",
    baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "qwen2.5:3b",

    // For LM Studio, llama.cpp server, vLLM, Jan... (AI_PROVIDER=lmstudio)
    openai: {
        baseURL: process.env.OPENAI_BASE_URL || "http://localhost:1234/v1",
        model: process.env.OPENAI_MODEL || "",
        apiKey: process.env.OPENAI_API_KEY || ""
    },

    maxToolCalls: num(process.env.AI_MAX_TOOL_CALLS, 5),
    requestTimeoutMs: num(process.env.AI_TIMEOUT_MS, 60000),
    modelTimeoutMs: num(process.env.AI_MODEL_TIMEOUT_MS, 120000),
    maxTokens: num(process.env.AI_MAX_TOKENS, 1024),
    notesFile: process.env.AI_NOTES_FILE || path.join(path.dirname(ENV_FILE), ".ai-memory.json"), // what "remember" saves
    filesDir: process.env.AI_FILES_DIR || process.cwd(), // read_file stays inside this folder
    maxHistoryMessages: 40
};
