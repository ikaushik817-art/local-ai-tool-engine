import { config } from "./config.js";
import { createOllamaAdapter } from "./adapters/ollama.adapter.js";
import { createOpenAIAdapter } from "./adapters/openai.adapter.js";

// The engine uses this common interface, not provider-specific API details.
// An adapter is just a function that returns { generate(messages), selectTool(messages, tools) }.
const adapters = {
    ollama: createOllamaAdapter,
    lmstudio: createOpenAIAdapter,
    openai: createOpenAIAdapter,
    "openai-compatible": createOpenAIAdapter
};

// Add your own provider without touching the engine. Returns an undo function.
export function registerAdapter(name, factory) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(name)) {
        throw new Error("Adapter name must be lowercase letters, numbers, dashes or underscores.");
    }
    if (typeof factory !== "function") {
        throw new Error(`Adapter "${name}" must be a function that returns an adapter.`);
    }
    if (adapters[name]) {
        throw new Error(`Adapter "${name}" is already registered.`);
    }

    adapters[name] = factory;
    return () => {
        if (adapters[name] === factory) delete adapters[name];
    };
}

export function createModelAdapter(name = config.provider, options) {
    const createAdapter = adapters[name];

    if (!createAdapter) {
        throw new Error(
            `Unsupported AI provider "${name}". ` +
            `Available providers: ${Object.keys(adapters).join(", ")}`
        );
    }

    return createAdapter(options);
}
