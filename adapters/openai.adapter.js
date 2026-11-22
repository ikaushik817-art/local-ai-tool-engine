import { config } from "../config.js";
import { postJson, postStream, createTokenSink, cleanReply, selectToolWith, toChatMessages, sendFitted, TRUNCATED_NOTE } from "./shared.js";

// "the local model server" for your own machine, the provider's address for a cloud one (so errors say who complained).
function providerName(baseURL) {
    try {
        const host = new URL(baseURL).hostname;
        return ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"].includes(host) ? "the local model server" : `the model provider (${host})`;
    } catch { return "the local model server"; }
}

// Works with anything that speaks the OpenAI /chat/completions format:
// LM Studio, llama.cpp server, vLLM, Jan, text-generation-webui, Ollama's /v1...
// No API key needed for local servers.
// Some models (gpt-oss on Groq, for one) sometimes try to call a tool even when none were offered,
// and the server answers with an error. One more try with a clear note almost always fixes it.
const TOOL_CALL_ERROR = /tool choice is none|model called a tool|tool_use_failed/i;
const NO_TOOLS_NOTE = { role: "system", content: "There are no tools or functions in this conversation. Never try to call one. Reply with plain text only." };

export function createOpenAIAdapter(options = {}) {
    async function withoutToolCalls(messages, run) {
        try {
            return await run(messages);
        } catch (error) {
            if (!TOOL_CALL_ERROR.test(error.message)) throw error;
            try {
                return await run([NO_TOOLS_NOTE, ...messages]);
            } catch (second) {
                if (!TOOL_CALL_ERROR.test(second.message)) throw second;
                throw new Error("The model keeps trying to call a tool that doesn't exist here. Some models do this. Try another model (run: npm run setup).");
            }
        }
    }

    function prepare(messages, tokens, stream, extra = {}) {
        const settings = config.openai;
        const baseURL = (options.baseURL ?? settings.baseURL).replace(/\/+$/, "");
        const model = options.model ?? settings.model;
        const apiKey = options.apiKey ?? settings.apiKey;

        // Pictures go in as "image_url" parts with the data inside, which is what OpenAI-style servers expect.
        const withParts = toChatMessages(messages).map((m) => (m.images?.length
            ? { role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.base64}` } }))] }
            : m));
        const body = { messages: withParts, max_tokens: tokens, stream, ...extra };
        // Leave the model out and the server uses whatever is loaded.
        if (model) body.model = model;

        return {
            url: `${baseURL}/chat/completions`,
            body,
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            name: options.name ?? providerName(baseURL),
            timeoutMs: options.timeoutMs ?? config.modelTimeoutMs
        };
    }

    // Newer cloud models reject max_tokens and want max_completion_tokens instead.
    const swapTokenParam = (body) => { const { max_tokens, ...rest } = body; return { ...rest, max_completion_tokens: max_tokens }; };
    const wantsSwap = (error) => error.status === 400 && /max_completion_tokens/i.test(error.message);
    const explain = (error) => (error.status === 401 || error.status === 403
        ? new Error("The server rejected the API key. Check OPENAI_API_KEY (run: npm run setup).")
        : error);

    async function requestOnce(messages, tokens = options.maxTokens ?? config.maxTokens, extra = {}) {
        const p = prepare(messages, tokens, false, extra);
        const send = (body) => postJson(p.url, body, { headers: p.headers, timeoutMs: p.timeoutMs, name: p.name });

        let data;
        try {
            try {
                data = await send(p.body);
            } catch (error) {
                if (!wantsSwap(error)) throw error;
                data = await send(swapTokenParam(p.body));
            }
        } catch (error) {
            throw explain(error);
        }

        const choice = data?.choices?.[0];
        if (!choice?.message) throw new Error("The model server returned an empty or invalid message.");
        const content = choice.message.content ?? ""; // reasoning models can leave this empty

        return { content: cleanReply(content), truncated: choice.finish_reason === "length" };
    }

    // Same request, but the words arrive one by one (server-sent events) and go to onToken as they come.
    async function requestStreamOnce(messages, tokens, onToken) {
        const p = prepare(messages, tokens, true);

        const run = async (body) => {
            const sink = createTokenSink(onToken);
            let raw = "";
            let finish;
            await postStream(p.url, body, {
                headers: p.headers,
                idleMs: p.timeoutMs,
                name: p.name,
                onData: (line) => {
                    if (!line.startsWith("data:")) return;
                    const payload = line.slice(5).trim();
                    if (payload === "[DONE]") return;
                    let data;
                    try { data = JSON.parse(payload); } catch { return; }
                    if (data.error) throw new Error(`${p.name} error: ${typeof data.error === "string" ? data.error : (data.error.message ?? "unknown")}`);
                    const choice = data.choices?.[0];
                    const piece = choice?.delta?.content;
                    if (typeof piece === "string" && piece) { raw += piece; sink.push(piece); }
                    if (choice?.finish_reason) finish = choice.finish_reason;
                }
            });
            sink.flush();
            return { content: cleanReply(raw), truncated: finish === "length" };
        };

        try {
            try {
                return await run(p.body);
            } catch (error) {
                if (!wantsSwap(error)) throw error;
                return await run(swapTokenParam(p.body));
            }
        } catch (error) {
            throw explain(error);
        }
    }

    // Everything sent is kept small enough; "too large" and "slow down" answers are handled (see shared.js).
    const request = (messages, tokens, extra) => sendFitted(messages, (m) => requestOnce(m, tokens, extra));
    const requestStream = (messages, tokens, onToken) => sendFitted(messages, (m) => requestStreamOnce(m, tokens, onToken));

    return {
        // Pass { onToken } to get the answer word by word. The returned value is the same either way.
        async generate(messages, { onToken, maxTokens, temperature } = {}) {
            const streaming = typeof onToken === "function";
            const base = maxTokens ?? options.maxTokens ?? config.maxTokens;
            const run = (tokens) => withoutToolCalls(messages, (msgs) => (streaming ? requestStream(msgs, tokens, onToken) : request(msgs, tokens, temperature === undefined ? {} : { temperature })));

            let out = await run(base);
            // Reasoning models (gpt-oss, qwen3...) can spend every token thinking. Give them more room once.
            if (!out.content && out.truncated) out = await run(Math.min(base * 4, 8192));

            const { content, truncated } = out;
            const cutOff = Boolean(content && truncated);
            if (cutOff && streaming) { try { onToken(TRUNCATED_NOTE); } catch { /* ignore */ } }
            return { type: "text", content: cutOff ? content + TRUNCATED_NOTE : content };
        },

        async selectTool(messages, tools) {
            const ask = async (msgs) => (await withoutToolCalls(msgs, (m) => request(m, undefined, { temperature: 0 }))).content;
            return selectToolWith(ask, messages, tools);
        }
    };
}
