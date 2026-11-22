// Runs one eval case in its own empty folder, with its own memory and notes, so cases never affect each other.
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { config } from "../config.js";
import { createMemory } from "../memory.js";
import { createToolRegistry } from "../tools/registry.js";
import { createToolEngine } from "../engine/toolEngine.js";
import { loadNotes } from "../tools/more.js";

// A model that fails on every call: proves what the app can do by itself.
export const deadModel = { async generate() { throw new Error("no model"); }, async selectTool() { throw new Error("no model"); } };

export async function runCase(testCase, { model, timeoutMs = 180000 } = {}) {
    const base = mkdtempSync(path.join(os.tmpdir(), "late-eval-"));
    const root = path.join(base, "work"); // the files folder; its parent is where an escape would land
    mkdirSync(root, { recursive: true });
    const saved = { filesDir: config.filesDir, notesFile: config.notesFile, maxQuestionChars: config.maxQuestionChars };
    config.filesDir = root;
    config.notesFile = path.join(base, "notes.json");
    writeFileSync(config.notesFile, "[]");

    const out = (name) => path.join(root, "ai-output", name);
    const ctx = {
        root,
        read: (name) => { try { return readFileSync(out(name), "utf8"); } catch { return ""; } },
        exists: (name) => existsSync(out(name)),
        escaped: (name) => existsSync(path.join(base, name)) || existsSync(path.join(root, name)),
        notes: () => loadNotes(),
        write: (name, text) => { mkdirSync(path.dirname(out(name)), { recursive: true }); writeFileSync(out(name), text); },
        writeRoot: (name, text) => writeFileSync(path.join(root, name), text)
    };

    const started = Date.now();
    let answer = "";
    let problem = "";
    try {
        await testCase.setup?.(ctx);
        const engine = createToolEngine(model, createToolRegistry(), { memory: createMemory(), confirm: async (r) => (testCase.confirm ? testCase.confirm(r) : "all") });
        const prompts = testCase.longPrompt ? ["x".repeat(config.maxQuestionChars + 1)] : testCase.prompts ?? [testCase.prompt];
        for (const prompt of prompts) {
            answer = await Promise.race([
                engine.run(prompt),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`took longer than ${Math.round(timeoutMs / 1000)}s`)), timeoutMs).unref())
            ]);
        }
        const verdict = await testCase.check({ ...ctx, answer: String(answer) });
        if (verdict !== true) problem = verdict;
    } catch (error) {
        problem = `crashed: ${error.message}`;
    } finally {
        Object.assign(config, saved);
        rmSync(base, { recursive: true, force: true });
    }
    return { id: testCase.id, group: testCase.group, ok: !problem, problem, ms: Date.now() - started, answer: String(answer).slice(0, 400) };
}
