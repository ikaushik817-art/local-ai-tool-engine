import { config } from "../config.js";
import { postJson, cleanReply, selectToolWith, toChatMessages, TRUNCATED_NOTE } from "./shared.js";

// Works with anything that speaks the OpenAI /chat/completions format:
// LM Studio, llama.cpp server, vLLM, Jan, text-generation-webui, Ollama's /v1...
// No API key needed for local servers.
export function createOpenAIAdapter(options = {}) {
    async function request(messages, tokens = options.maxTokens ?? config.maxTokens) {
        const settings = config.openai;
        const baseURL = (options.baseURL ?? settings.baseURL).replace(/\/+$/, "");
        const model = options.model ?? settings.model;
        const apiKey = options.apiKey ?? settings.apiKey;

        const body = {
            messages: toChatMessages(messages),
            max_tokens: tokens,
            stream: false
        };
        // Leave the model out and the server uses whatever is loaded.
        if (model) body.model = model;

        const send = (payload) => postJson(`${baseURL}/chat/completions`, payload, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            timeoutMs: options.timeoutMs ?? config.modelTimeoutMs,
            name: options.name ?? "the model server"
        });

        let data;
        try {
            data = await send(body);
        } catch (error) {
            // Newer cloud models reject max_tokens and want max_completion_tokens instead.
            if (error.status === 400 && /max_completion_tokens/i.test(error.message)) {
                const { max_tokens, ...rest } = body;
                data = await send({ ...rest, max_completion_tokens: max_tokens });
            } else if (error.status === 401 || error.status === 403) {
                throw new Error("The server rejected the API key. Check OPENAI_API_KEY (run: npm run setup).");
            } else {
                throw error;
            }
        }

        const choice = data?.choices?.[0];
        if (!choice?.message) throw new Error("The model server returned an empty or invalid message.");
        const content = choice.message.content ?? ""; // reasoning models can leave this empty

        return { content: cleanReply(content), truncated: choice.finish_reason === "length" };
    }

    return {
        async generate(messages) {
            const base = options.maxTokens ?? config.maxTokens;
            let out = await request(messages, base);
            // Reasoning models (gpt-oss, qwen3...) can spend every token thinking. Give them more room once.
            if (!out.content && out.truncated) out = await request(messages, Math.min(base * 4, 8192));
            const { content, truncated } = out;
            return { type: "text", content: content && truncated ? content + TRUNCATED_NOTE : content };
        },

        async selectTool(messages, tools) {
            const ask = async (msgs) => (await request(msgs)).content;
            return selectToolWith(ask, messages, tools);
        }
    };
}
