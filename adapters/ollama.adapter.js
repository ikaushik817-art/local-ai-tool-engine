import { config } from "../config.js";
import { postJson, cleanReply, selectToolWith, TRUNCATED_NOTE } from "./shared.js";

// Options are optional; anything missing falls back to config.js / env vars.
export function createOllamaAdapter(options = {}) {
    async function request(messages, extra = {}, tokens = options.maxTokens ?? config.maxTokens) {
        const baseURL = options.baseURL ?? config.baseURL;
        const model = options.model ?? config.model;

        let data;
        try {
            data = await postJson(`${baseURL}/api/chat`, {
                model,
                messages,
                stream: false,
                options: { num_predict: tokens },
                ...extra
            }, {
                timeoutMs: options.timeoutMs ?? config.modelTimeoutMs,
                name: "Ollama"
            });
        } catch (error) {
            if (error.status === 404 && /model/i.test(error.message)) {
                throw new Error(`Ollama doesn't have the model "${model}". Run: ollama pull ${model}`);
            }
            throw error;
        }

        const content = data?.message?.content;
        if (typeof content !== "string") {
            throw new Error("Ollama returned an empty or invalid message.");
        }

        return { content: cleanReply(content), truncated: data.done_reason === "length" };
    }

    return {
        async generate(messages) {
            const base = options.maxTokens ?? config.maxTokens;
            let out = await request(messages, {}, base);
            // "Thinking" models can use up every token before writing the answer. Give them more room once.
            if (!out.content && out.truncated) out = await request(messages, {}, Math.min(base * 4, 8192));
            const { content, truncated } = out;
            return { type: "text", content: content && truncated ? content + TRUNCATED_NOTE : content };
        },

        async selectTool(messages, tools) {
            const ask = async (msgs) => (await request(msgs, { format: "json" })).content;
            return selectToolWith(ask, messages, tools);
        }
    };
}
