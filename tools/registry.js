import { calculate } from "./calculator.js";
import { webSearch } from "./webSearch.js";
import { readFile, readWebpage } from "./extras.js";
import { dateTime, remember, recall, forget, searchFiles, research } from "./more.js";

export function createToolRegistry({ includeBuiltins = true } = {}) {
    const tools = new Map();

    function registerTool({
        name,
        description = "",
        parameters = {},
        execute,
        returnDirect = false
    }) {
        if (
            typeof name !== "string" ||
            !/^[a-z][a-z0-9_]{1,40}$/.test(name)
        ) {
            throw new Error(
                "Tool name must be 2–41 characters: lowercase letters, numbers, underscores."
            );
        }

        if (typeof description !== "string") {
            throw new Error(`Tool "${name}" description must be a string.`);
        }

        if (
            !parameters ||
            typeof parameters !== "object" ||
            Array.isArray(parameters)
        ) {
            throw new Error(`Tool "${name}" parameters must be an object.`);
        }

        if (typeof execute !== "function") {
            throw new Error(`Tool "${name}" must provide an execute function.`);
        }

        if (tools.has(name)) {
            throw new Error(`Tool "${name}" is already registered.`);
        }

        // returnDirect: true -> the tool's output is the final answer (skips the model).
        const tool = { name, description, parameters, execute, returnDirect: Boolean(returnDirect) };
        tools.set(name, tool);

        // Only remove this exact registration; don't delete a later replacement.
        return () => {
            if (tools.get(name) === tool) tools.delete(name);
        };
    }

    function registerTools(definitions) {
        if (!Array.isArray(definitions)) {
            throw new Error("registerTools() expects an array.");
        }

        const unregisterCallbacks = [];
        try {
            for (const definition of definitions) {
                unregisterCallbacks.push(registerTool(definition));
            }
        } catch (error) {
            for (const unregister of unregisterCallbacks.reverse()) unregister();
            throw error;
        }

        let active = true;
        return () => {
            if (!active) return;
            active = false;
            for (const unregister of unregisterCallbacks.reverse()) unregister();
        };
    }

    function getTool(name) {
        return tools.get(name);
    }

    function hasTool(name) {
        return tools.has(name);
    }

    function getToolDefinitions() {
        return [...tools.values()].map(({ name, description, parameters }) => ({
            name,
            description,
            parameters
        }));
    }

    if (includeBuiltins) {
        registerTool({
            name: "web_search",
            description: "Search the public web for current or externally verifiable information.",
            parameters: { query: "string: search query" },
            execute: ({ query }) => webSearch(query)
        });

        registerTool({
            name: "calculator",
            description: "Evaluate a mathematical expression accurately.",
            parameters: { expression: "string: valid mathematical expression" },
            execute: ({ expression }) => calculate(expression)
        });

        registerTool({
            name: "read_file",
            description: "Read a text file, or list a folder, from the user's computer (inside the allowed folder only).",
            parameters: { path: "string: file or folder path, e.g. notes.txt or src/" },
            execute: readFile
        });

        registerTool({
            name: "read_webpage",
            description: "Open a web page and read its text. Use when the user gives a link or you need the full page, not just search snippets.",
            parameters: { url: "string: full http(s) URL" },
            execute: readWebpage
        });

        registerTool({
            name: "research",
            description: "Look something up properly: searches the web, opens the best pages and returns the most relevant parts with sources. Use for questions that need real detail.",
            parameters: { question: "string: what to research" },
            execute: (args) => research(args)
        });

        registerTool({
            name: "datetime",
            description: "Exact current date and time, and days until a date.",
            parameters: { until: "string (optional): a date like 2026-12-25 or 25 December" },
            returnDirect: true,
            execute: (args) => dateTime(args)
        });

        registerTool({
            name: "remember",
            description: "Save a fact the user wants remembered for future chats.",
            parameters: { text: "string: the fact to remember" },
            returnDirect: true,
            execute: remember
        });

        registerTool({
            name: "recall",
            description: "List what the user asked to be remembered, optionally filtered by a word.",
            parameters: { query: "string (optional): word to filter by" },
            returnDirect: true,
            execute: recall
        });

        registerTool({
            name: "forget",
            description: "Delete remembered notes that contain some text, or everything.",
            parameters: { text: "string: part of the note to delete, or 'everything'" },
            returnDirect: true,
            execute: forget
        });

        registerTool({
            name: "search_files",
            description: "Search inside the user's files (names and contents) for words. Use for 'where is X in my files'.",
            parameters: { query: "string: words to look for" },
            returnDirect: true,
            execute: searchFiles
        });
    }

    return { registerTool, registerTools, getTool, hasTool, getToolDefinitions };
}

// Default registry preserves the original direct-import API.
const defaultRegistry = createToolRegistry();

export const registerTool = (...args) => defaultRegistry.registerTool(...args);
export const registerTools = (...args) => defaultRegistry.registerTools(...args);
export const getTool = (...args) => defaultRegistry.getTool(...args);
export const hasTool = (...args) => defaultRegistry.hasTool(...args);
export const getToolDefinitions = (...args) => defaultRegistry.getToolDefinitions(...args);
export { defaultRegistry as toolRegistry };
