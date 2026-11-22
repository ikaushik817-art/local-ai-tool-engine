import { createModelAdapter } from "./model.js";
import { createMemory } from "./memory.js";
import { modelProfile, activeModelName } from "./config.js";
import { createToolEngine } from "./engine/toolEngine.js";
import { createToolRegistry } from "./tools/registry.js";

/**
 * Create an independent AI client.
 *
 * Pass { model } to inject a compatible adapter (useful for testing or custom
 * local model providers), or { provider: "lmstudio" } to pick a registered one.
 * The default comes from AI_PROVIDER (Ollama if not set).
 */
export function createAI({ model, provider, confirm, historyFile } = {}) {
    const tools = createToolRegistry();
    const profile = modelProfile(activeModelName());
    const memory = createMemory({ ...(historyFile ? { file: historyFile } : {}), max: profile.historyMessages }); // each instance keeps its own chat history
    const engine = createToolEngine(model ?? createModelAdapter(provider), tools, { memory, confirm, profile });

    return {
        // Options: { onStep(event), onToken(text), confirm(request) }:
        // watch tools run, get the answer word by word, and answer "may I?" questions (see write_file).
        chat(question, options) {
            return engine.run(question, options);
        },

        // Agent mode: give it a goal, it works through several steps. Returns { answer, steps, stopped }.
        // Options: { maxSteps, timeoutMs, allowedTools: ["research"], plan: false, onStep(event) }
        agent(goal, options) {
            return engine.agent(goal, options);
        },

        // Dry run: { complete, steps: [{ label, tool, byModel }], unmapped, needsPermission }.
        // Shows what the rules would do with a goal, without running anything. If `complete` is false,
        // the model plans or picks tools as it goes.
        plan(goal) {
            return engine.plan(goal);
        },

        // The conversation so far: [{ role: "user" | "assistant", content }].
        getHistory() {
            return memory.getMessages().filter((m) => m.role === "user" || m.role === "assistant");
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
