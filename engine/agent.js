// Agent mode: keep working on a goal, one tool at a time, until it's done or a limit is hit.
// This file is only the loop. The engine passes in everything it needs (model, tools, memory, safety checks).
import { config } from "../config.js";
import { resultText } from "../memory.js";
import { executePlan, formatReport, planText, describeResult, followRenamedFiles, savedName, rightTool } from "./planner.js";

const AGENT_RULES = `AGENT MODE. The user gave you a goal. Work on it step by step.
- Pick ONE tool that moves the goal forward. Read the results already in this chat first.
- Never repeat a tool call that already ran, unless something was saved or forgotten since (then checking again is fine).
- Files you save go in the ai-output folder. To read one back, use read_file with the name write_file reported.
- Never count characters, make random numbers or do maths in your head: use text_stats, random_numbers, number_stats (largest/smallest/sum/average of a list, with file names) and calculator.
- To save a number you counted, pass the exact number from the tool result as the file content.
- remember: save the fact itself ("my favorite number is 777"), not the whole instruction. recall: pass a few key words as the query. forget: pass the words of the note.
- If write_file says it saved a different name (like test-2.txt), use that name from then on.
- Do the steps in the order the user gave them, and finish every step before choosing "none".`;

const STOP_NOTES = {
    max_steps: "I hit the step limit, so this may be incomplete.",
    repeat: "I stopped because the next step would have repeated the last one.",
    errors: "I stopped because the tools kept failing.",
    timeout: "I stopped because it was taking too long.",
    model: "The model stopped answering after the last step listed here, so anything not listed was not done.",
    blocked: "I stopped because the next step wasn't safe after reading a web page."
};

const short = (value, max = 90) => {
    const text = (resultText(value) ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
};

export function summarize(result) {
    if (Array.isArray(result?.sources)) return `${result.sources.length} sources`;
    if (Array.isArray(result)) return `${result.length} results`;
    if (typeof result?.file === "string" && typeof result?.content === "string") return `${result.file}: ${short(result.content, 60)}`;
    if (typeof result?.folder === "string" && Array.isArray(result?.items)) return `${result.folder}: ${result.items.length} items`;
    return short(result);
}

// A plan we already know (built by rules or checked from the model): run it exactly, no guessing.
export async function runPlanned(goal, steps, { runTool, isBlocked, registry, onStep = () => {}, maxSteps = Math.max(config.maxAgentSteps * 4, 200), timeoutMs = config.agentTimeoutMs, allowedTools, generate = null, onToken = null }) {
    const emit = (event) => { try { onStep(event); } catch { /* a broken callback must not kill the agent */ } };
    emit({ type: "plan", text: planText(steps) });
    const run = await executePlan(steps, { registry, runTool, isBlocked, emit, allowed: Array.isArray(allowedTools) ? new Set(allowedTools) : null, maxSteps, timeoutMs, generate, onToken });
    return {
        answer: formatReport(run),
        stopped: run.stopped === "finished" ? "finished" : run.stopped,
        used: run.used, // for the caller; not part of what is returned to people
        steps: run.used.map((u) => ({ tool: u.tool.name, args: u.args, ok: !u.error, summary: u.error ?? describeResult(u.tool.name, u.args, u.result, 90) }))
    };
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export async function runAgent(goal, {
    model, registry, memory, runTool, isBlocked, finalize, plan,
    onStep = () => {},
    maxSteps = config.maxAgentSteps,
    timeoutMs = config.agentTimeoutMs,
    allowedTools
}) {
    const emit = (event) => { try { onStep(event); } catch { /* a broken callback must not kill the agent */ } };
    const allowed = Array.isArray(allowedTools) ? new Set(allowedTools) : null;
    const definitions = () => registry.getToolDefinitions().filter((d) => !allowed || allowed.has(d.name));

    // A short plan gives small models something to follow. If it fails we just carry on.
    if (plan) {
        const text = await plan(goal, definitions().map((d) => d.name));
        if (text) {
            memory.addMessage("system", `Plan (guidance only, adapt it if the results say otherwise):\n${text.slice(0, 600)}`);
            emit({ type: "plan", text });
        }
    }

    const started = Date.now();
    const seen = new Map(); // call -> did it change something? (a repeated check after a change is fine, a repeated change never is)
    const used = [];
    let stopped = "finished";
    let errorsInARow = 0;
    let repeats = 0;
    const saved = new Map(); // file name asked for -> name really used

    for (let step = 1; ; step++) {
        if (step > maxSteps) { stopped = "max_steps"; break; }
        if (Date.now() - started > timeoutMs) { stopped = "timeout"; break; }

        let action;
        const ask = () => model.selectTool([{ role: "system", content: AGENT_RULES }, ...memory.getMessages()], definitions());
        try {
            try { action = await ask(); } catch { action = await ask(); } // small models break the JSON now and then: one more try
        } catch {
            // Two failures in a row. If nothing ran at all this is a real problem; otherwise finish with what we have.
            if (used.length) stopped = "model";
            break;
        }
        if (action?.type !== "tool_call" || typeof action.tool !== "string" || action.tool === "none") break;

        let tool = registry.getTool(action.tool);
        if (!tool || (allowed && !allowed.has(tool.name))) {
            // Tell the model what exists so it can correct itself.
            memory.addToolResult("agent", { error: `There is no tool called "${action.tool}". Available tools: ${definitions().map((d) => d.name).join(", ")}.` });
            if (++errorsInARow >= 2) { stopped = "errors"; break; }
            continue;
        }

        const args = followRenamedFiles(tool.name, isPlainObject(action.arguments) ? action.arguments : {}, saved);
        if (isBlocked(tool, used, args)) {
            memory.addToolResult(tool.name, { error: "Blocked: this tool can't be used after reading web content in the same task." });
            stopped = "blocked";
            break;
        }
        tool = await rightTool(tool, args, registry);
        const key = `${tool.name}:${JSON.stringify(args)}`;
        if (seen.has(key)) {
            // Say it once, kindly, before giving up: the model may just have lost track.
            memory.addToolResult("agent", { error: `You already ran ${tool.name} with exactly these arguments. Use the earlier result, or pick the next step, or answer with "none" if everything is done.` });
            if (++repeats >= 2) { stopped = "repeat"; break; }
            continue;
        }
        seen.set(key, Boolean(tool.changesState));

        emit({ type: "step", step, tool: tool.name, args });
        try {
            const result = await runTool(tool, args);
            memory.addToolResult(tool.name, result);
            used.push({ tool, args, result });
            if (tool.name === "write_file") saved.set(String(args.path), savedName(result, args));
            errorsInARow = 0;
            if (tool.changesState) for (const [call, changed] of seen) if (!changed) seen.delete(call);
            emit({ type: "result", step, tool: tool.name, ok: true, summary: summarize(result) });
        } catch (error) {
            const hint = /^(?:Missing argument|Invalid arguments)/.test(error.message) ? ` Expected arguments: ${JSON.stringify(tool.parameters)}.` : "";
            memory.addToolResult(tool.name, { error: error.message + hint });
            used.push({ tool, args, error: error.message });
            emit({ type: "result", step, tool: tool.name, ok: false, summary: error.message });
            if (++errorsInARow >= 2) { stopped = "errors"; break; }
        }
    }

    emit({ type: "stop", reason: stopped });
    let answer = await finalize(used);

    // Be honest when we didn't really finish. (A repeat after real results just means the model was done.)
    const mentionStop = stopped !== "finished" && !(stopped === "repeat" && used.some((u) => !u.error));
    if (mentionStop) answer += `\n\n(${STOP_NOTES[stopped]} Steps used: ${used.length}.)`;

    return {
        answer,
        stopped,
        steps: used.map((u) => ({ tool: u.tool.name, args: u.args, ok: !u.error, summary: u.error ?? summarize(u.result) }))
    };
}
