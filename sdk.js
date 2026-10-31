import { createModelAdapter } from "./model.js";
import { createMemory } from "./memory.js";
import { createToolEngine } from "./engine/toolEngine.js";
import { createToolRegistry } from "./tools/registry.js";

/**
 * Create an independent AI client.
 *
 * Pass { model } to inject a compatible adapter (useful for testing or custom
 * local model providers), or { provider: "lmstudio" } to pick a registered one.
 * The default comes from AI_PROVIDER (Ollama if not set).
 */
export function createAI({ model, provider } = {}) {
    const tools = createToolRegistry();
    const memory = createMemory(); // each instance keeps its own chat history
    const engine = createToolEngine(model ?? createModelAdapter(provider), tools, { memory });

    return {
        chat(question) {
            return engine.run(question);
        },

        clearHistory() {
            memory.clearMessages();
        },

        registerTool(definition) {
            return tools.registerTool(definition);
        },

        registerTools(definitions) {
            return tools.registerTools(definitions);
        },

        async executeTool(name, args = {}) {
            const tool = tools.getTool(name);
            if (!tool) {
                throw new Error(`Tool "${name}" is not registered.`);
            }
            return await tool.execute(args);
        },

        getTools() {
            return tools.getToolDefinitions();
        }
    };
}

export { registerAdapter } from "./model.js";
