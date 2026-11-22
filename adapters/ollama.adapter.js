import { config } from "../config.js";
import { postJson, postStream, createTokenSink, cleanReply, selectToolWith, sendFitted, TRUNCATED_NOTE } from "./shared.js";

// Options are optional; anything missing falls back to config.js / env vars.
// Pictures: Ollama wants a plain list of base64 strings on the message.
const withImages = (messages) => messages.map((m) => (m.images?.length ? { role: m.role, content: m.content, images: m.images.map((i) => i.base64) } : m));

export function createOllamaAdapter(options = {}) {
    const settings = () => ({
        baseURL: options.baseURL ?? config.baseURL,
        model: options.model ?? config.model,
        timeoutMs: options.timeoutMs ?? config.modelTimeoutMs
    });

    const explain = (error, model) => (error.status === 404 && /model/i.test(error.message)
        ? new Error(`Ollama doesn't have the model "${model}". Run: ollama pull ${model}`)
        : error);

    async function requestOnce(messages, extra = {}, tokens = options.maxTokens ?? config.maxTokens) {
        const { baseURL, model, timeoutMs } = settings();
        const { options: askOptions, ...rest } = extra;

        let data;
        try {
            data = await postJson(`${baseURL}/api/chat`, {
                model,
                messages: withImages(messages),
                stream: false,
                options: { num_predict: tokens, ...askOptions },
                ...rest
            }, { timeoutMs, name: "Ollama" });
        } catch (error) {
            throw explain(error, model);
        }

        const content = data?.message?.content;
        if (typeof content !== "string") {
            throw new Error("Ollama returned an empty or invalid message.");
        }

        return { content: cleanReply(content), truncated: data.done_reason === "length" };
    }

    // Same request, but the words arrive one by one and are passed to onToken as they come.
    async function requestStreamOnce(messages, tokens, onToken) {
        const { baseURL, model, timeoutMs } = settings();
        const sink = createTokenSink(onToken);
        let raw = "";
        let doneReason;

        try {
            await postStream(`${baseURL}/api/chat`, { model, messages: withImages(messages), stream: true, options: { num_predict: tokens } }, {
                idleMs: timeoutMs,
                name: "Ollama",
                onData: (line) => {
                    let data;
                    try { data = JSON.parse(line); } catch { return; }
                    if (data.error) throw new Error(`Ollama error: ${data.error}`);
                    const piece = data.message?.content;
                    if (typeof piece === "string" && piece) { raw += piece; sink.push(piece); }
                    if (data.done) doneReason = data.done_reason;
                }
            });
        } catch (error) {
            throw explain(error, model);
        }
        sink.flush();
        return { content: cleanReply(raw), truncated: doneReason === "length" };
    }

    const request = (messages, extra, tokens) => sendFitted(messages, (m) => requestOnce(m, extra, tokens));
    const requestStream = (messages, tokens, onToken) => sendFitted(messages, (m) => requestStreamOnce(m, tokens, onToken));

    return {
        // Pass { onToken } to get the answer word by word. The returned value is the same either way.
        async generate(messages, { onToken, maxTokens, temperature } = {}) {
            const streaming = typeof onToken === "function";
            const base = maxTokens ?? options.maxTokens ?? config.maxTokens;
            const run = (tokens) => (streaming ? requestStream(messages, tokens, onToken) : request(messages, temperature === undefined ? {} : { options: { temperature, seed: 1 } }, tokens));

            let out = await run(base);
            // "Thinking" models can use up every token before writing the answer. Give them more room once.
            if (!out.content && out.truncated) out = await run(Math.min(base * 4, 8192));

            const { content, truncated } = out;
            const cutOff = Boolean(content && truncated);
            if (cutOff && streaming) { try { onToken(TRUNCATED_NOTE); } catch { /* ignore */ } }
            return { type: "text", content: cutOff ? content + TRUNCATED_NOTE : content };
        },

        async selectTool(messages, tools) {
            const ask = async (msgs) => (await request(msgs, { format: "json", options: { temperature: 0, seed: 1 } })).content;
            return selectToolWith(ask, messages, tools);
        }
    };
}
