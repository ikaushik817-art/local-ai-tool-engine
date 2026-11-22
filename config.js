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
    autoAgent: !/^(off|0|false|no)$/i.test(process.env.AI_AUTO_AGENT ?? ""), // multi-step requests switch to agent mode by themselves
    maxAgentSteps: num(process.env.AI_MAX_AGENT_STEPS, 15), // agent mode: tools per goal
    agentTimeoutMs: num(process.env.AI_AGENT_TIMEOUT_MS, 300000),
    requestTimeoutMs: num(process.env.AI_TIMEOUT_MS, 60000),
    modelTimeoutMs: num(process.env.AI_MODEL_TIMEOUT_MS, 120000),
    maxTokens: num(process.env.AI_MAX_TOKENS, 1024),
    notesFile: process.env.AI_NOTES_FILE || path.join(path.dirname(ENV_FILE), ".ai-memory.json"), // what "remember" saves
    uiPort: num(process.env.AI_UI_PORT, 3737),
    uiHost: process.env.AI_UI_HOST || "127.0.0.1", // leave it alone unless you run in Docker (see SECURITY.md)
    filesDir: process.env.AI_FILES_DIR || process.cwd(), // read_file stays inside this folder
    maxHistoryMessages: 40,
    // Cloud models limit how much you can send per minute (Groq's free tier: 8000 tokens). What is sent is kept under this many
    // characters (about 4 per token); if the provider still says "too large", it is cut down further and tried again.
    maxPromptChars: num(process.env.AI_MAX_PROMPT_CHARS, 20000),
    rateLimitMaxWaitMs: num(process.env.AI_RATE_LIMIT_MAX_WAIT_MS, 40000), // a "try again in 20s" from the provider is waited out, up to this long

    // Running it for real
    logLevel: /^(off|error|info|debug)$/i.test(process.env.AI_LOG ?? "") ? process.env.AI_LOG.toLowerCase() : "info",
    logFile: process.env.AI_LOG_FILE || path.join(path.dirname(ENV_FILE), "logs", "late.log"),
    keepHistory: /^(on|1|true|yes)$/i.test(process.env.AI_KEEP_HISTORY ?? ""), // terminal chat remembers the conversation after you quit
    historyFile: process.env.AI_HISTORY_FILE || path.join(path.dirname(ENV_FILE), ".ai-history.json"),
    maxQuestionChars: num(process.env.AI_MAX_QUESTION_CHARS, 8000),
    rateLimitPerMinute: num(process.env.AI_RATE_LIMIT, 30), // web UI: chat messages per minute

    // Watching it (all optional)
    metricsToken: process.env.AI_METRICS_TOKEN || "", // set it to turn on /api/metrics
    errorWebhook: process.env.AI_ERROR_WEBHOOK || "", // a URL that gets a short message when something fails (Slack-style JSON)

    // Web search: DuckDuckGo needs no key but can break. These are steadier. First one that is set up is tried first.
    searchProvider: (process.env.AI_SEARCH_PROVIDER || "auto").toLowerCase(), // auto | duckduckgo | brave | tavily | searxng
    braveKey: process.env.BRAVE_API_KEY || "",
    tavilyKey: process.env.TAVILY_API_KEY || "",
    searxngUrl: process.env.SEARXNG_URL || "",
    braveUrl: process.env.BRAVE_API_URL || "https://api.search.brave.com/res/v1/web/search", // only change these for a proxy or a test
    tavilyUrl: process.env.TAVILY_API_URL || "https://api.tavily.com/search"
};

// How much a model is trusted with, from its name ("qwen2.5:3b", "gpt-oss:20b"). A small one gets less to read and no planning to
// do (the rules plan, it only writes); every other model, and any name that says no size, is treated as a large one.
export function modelProfile(name = "") {
    const size = Number(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*b\b/i.exec(String(name))?.[1]);
    const small = (size > 0 && size <= 8) || /\b(?:mini|tiny|nano)\b/i.test(String(name));
    return { small, materialChars: small ? 4000 : 8000, historyMessages: small ? 16 : 40, modelPlan: !small };
}

// The model name to show people, whichever provider is in use.
export const activeModelName = () => (config.provider === "ollama" ? config.model : (config.openai.model || "whatever is loaded"));
