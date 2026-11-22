import { calculate } from "./calculator.js";
import { webSearch } from "./webSearch.js";
import { readFile, readFiles, readWebpage } from "./extras.js";
import { dateTimeData, rememberData, recallData, forgetData, searchFilesData, research, convertData, weatherData, writeOutput, wikipedia, textStatsData, randomNumbersData, numberStatsData, compareNumbersData, compareTextData, appendToOutputData, textTransform } from "./more.js";

export function createToolRegistry({ includeBuiltins = true } = {}) {
    const tools = new Map();

    function registerTool({
        name,
        description = "",
        parameters = {},
        execute,
        returnDirect = false,
        needsApproval = false,
        changesState = false,
        preview
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
        // needsApproval: true -> the user is asked before it runs. preview(args) shows them what will happen.
        const tool = { name, description, parameters, execute, returnDirect: Boolean(returnDirect), needsApproval: Boolean(needsApproval), changesState: Boolean(changesState || needsApproval), preview };
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
            parameters: { until: "string (optional): days until a date like 2026-12-25 or 25 December", after: "string (optional): a date after or before today, like 10000 days or 3 weeks ago", on: "string (optional): the weekday of a date like 25 December 2026" },
            returnDirect: true,
            execute: (args) => dateTimeData(args)
        });

        registerTool({
            name: "read_files",
            description: "Read every text file in a folder at once (default: the ai-output folder), one line per file. Use to compare or find something across many files.",
            parameters: { folder: "string (optional): folder name, default ai-output" },
            execute: readFiles
        });

        registerTool({
            name: "text_stats",
            description: "Exact number of characters, words and lines in a text or a file. Use for any counting, never count yourself.",
            parameters: { text: "string (optional): the text to count", file: "string (optional): a file to count instead" },
            returnDirect: true,
            execute: textStatsData
        });

        registerTool({
            name: "random_numbers",
            description: "Real random whole numbers (all different by default). Use whenever random numbers are needed.",
            parameters: { count: "number (optional): how many, default 1", min: "number (optional): lowest, default 1", max: "number (optional): highest, default 1000000" },
            returnDirect: true,
            execute: randomNumbersData
        });

        registerTool({
            name: "write_file",
            description: "Save text as a new file in the ai-output folder (.md, .txt, .json or .csv). The user is asked for permission first.",
            parameters: { path: "string: a simple file name like report.md", content: "string: the text to save" },
            returnDirect: true,
            needsApproval: true,
            preview: ({ path, content }) => ({ file: String(path ?? ""), bytes: Buffer.byteLength(String(content ?? "")), text: String(content ?? "").slice(0, 500) }),
            execute: ({ path, content }) => writeOutput(path, content)
        });

        registerTool({
            name: "append_file",
            description: "Add text to the end of a file already in the ai-output folder (use the name write_file reported). The user is asked for permission first.",
            parameters: { path: "string: the file name, like notes.txt", content: "string: the text to add" },
            returnDirect: true,
            needsApproval: true,
            preview: ({ path, content }) => ({ file: String(path ?? ""), bytes: Buffer.byteLength(String(content ?? "")), text: String(content ?? "").slice(0, 500) }),
            execute: ({ path, content }) => appendToOutputData(path, content)
        });

        registerTool({
            name: "number_stats",
            description: "Exact maths on a list of numbers: largest, smallest, sum, average, count or sort. Says which label (like a file name) has the largest. Never compare numbers yourself.",
            parameters: { numbers: "string (optional): numbers separated by commas", file: "string (optional): a file full of numbers, read in full, instead of typing them", labels: "string (optional): a name for each number, separated by commas, in the same order", operation: "string (optional): max, min, sum, average, count or sort. Default max" },
            returnDirect: true,
            execute: numberStatsData
        });

        registerTool({
            name: "compare_text",
            description: "Checks whether two texts are exactly the same (a saved report against what it should say) and shows the first difference. Never compare texts yourself.",
            parameters: { a: "string: the first text (or a JSON list of texts)", b: "string (optional): the second text (or a JSON list); leave it out when using has", has: "string (optional): a word or sentence the first text must contain", missing: "string (optional): \"true\" to list the points of the second text (the original) that the first text (a summary) does not cover", labels: "string (optional): a JSON list of names, one per text of a list", label: "string (optional): what is being compared" },
            returnDirect: true,
            execute: compareTextData
        });

        registerTool({
            name: "compare_numbers",
            description: "Checks whether two numbers are the same (for example a result against a formula) and says the difference. Never compare numbers yourself.",
            parameters: { a: "string: the first number", b: "string: the second number", label: "string (optional): what is being compared" },
            returnDirect: true,
            execute: compareNumbersData
        });

        registerTool({
            name: "text_transform",
            description: "Exact text changes: uppercase, lowercase, title, reverse, reverse_words, sort_lines, unique_lines, number_lines, trim, remove_spaces. Returns only the changed text. Never do these yourself.",
            parameters: { operation: "string: uppercase, lowercase, title, reverse, reverse_words, sort_lines, unique_lines, number_lines, trim or remove_spaces", text: "string (optional): the text to change", file: "string (optional): a file to change instead" },
            returnDirect: true,
            execute: textTransform
        });

        registerTool({
            name: "wikipedia",
            description: "Get a short, reliable summary of a topic from Wikipedia.",
            parameters: { topic: "string: what to look up" },
            returnDirect: true,
            execute: (args) => wikipedia(args)
        });

        registerTool({
            name: "convert",
            description: "Convert between units exactly: length, weight, volume, speed, temperature, data size, time.",
            parameters: { value: "number: the amount", from: "string: unit to convert from, like km", to: "string: unit to convert to, like miles" },
            returnDirect: true,
            execute: convertData
        });

        registerTool({
            name: "weather",
            description: "Current weather in a city.",
            parameters: { city: "string: the city name", unit: "string (optional): celsius or fahrenheit" },
            returnDirect: true,
            execute: (args) => weatherData(args)
        });

        registerTool({
            name: "remember",
            description: "Save a fact the user wants remembered for future chats.",
            parameters: { text: "string: the fact to remember", replaces: "string (optional): what the fact is about, when it replaces an older note about the same thing (\"favorite fruit\")" },
            returnDirect: true,
            changesState: true,
            execute: rememberData
        });

        registerTool({
            name: "recall",
            description: "List what the user asked to be remembered, optionally filtered by a word.",
            parameters: { query: "string (optional): word to filter by" },
            returnDirect: true,
            execute: recallData
        });

        registerTool({
            name: "forget",
            description: "Delete remembered notes that contain some text, or everything.",
            parameters: { text: "string: part of the note to delete, or 'everything'" },
            returnDirect: true,
            changesState: true,
            execute: forgetData
        });

        registerTool({
            name: "search_files",
            description: "Search inside the user's files (names and contents) for words. Use for 'where is X in my files'.",
            parameters: { query: "string: words to look for" },
            returnDirect: true,
            execute: searchFilesData
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
