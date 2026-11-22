import readline from "node:readline/promises";
import { createModelAdapter } from "./model.js";
import { createToolEngine } from "./engine/toolEngine.js";
import { config, activeModelName, modelProfile } from "./config.js";
import { toolRegistry } from "./tools/registry.js";
import { getMessages, clearMessages } from "./memory.js";
import { saveToOutput, chatToMarkdown } from "./tools/more.js";
import { createCliUI } from "./cli-ui.js";

const ui = createCliUI();
const out = process.stdout;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const spin = ui.spinner();

let lastAnswer = "";
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");

// Runs one question (or agent goal) and shows it nicely: live steps, the answer typed out word by word,
// and a question box when a tool wants permission.
async function showWork(runner) {
    let streamed = "";
    let typing = false;

    const onToken = (text) => {
        if (!typing) { spin.stop(); out.write(ui.label()); typing = true; }
        out.write(text);
        streamed += text;
    };
    const onStep = (event) => {
        spin.stop();
        const line = ui.step(event);
        if (line) console.log(line);
        if (event.type === "step") spin.start(`running ${event.tool}`);
        else if (event.type === "result") spin.start("thinking");
    };
    const confirm = async (request) => {
        spin.stop();
        console.log(ui.approval(request));
        const reply = (await rl.question(`${ui.c.yellow("Allow?")} ${ui.c.gray("(y = yes, a = yes to all in this task, anything else = no)")} `)).trim();
        if (/^a(ll)?$/i.test(reply)) return "all";
        return /^y(es)?$/i.test(reply);
    };

    spin.start("thinking");
    let answer;
    try {
        answer = await runner({ onStep, onToken, confirm });
    } finally {
        spin.stop();
    }

    lastAnswer = answer;
    if (!typing) {
        console.log(`${ui.label()}${ui.format(answer)}`);
    } else {
        // The words were already printed as they arrived. Only print what came after (like the sources list).
        const printed = streamed.trimEnd();
        if (answer.startsWith(printed)) console.log(ui.format(answer.slice(printed.length)));
        else console.log(`\n${ui.label()}${ui.format(answer)}`);
    }
}

async function handleCommand(question, engine) {
    const command = question.toLowerCase();
    if (command === "/help") { console.log(ui.help()); return true; }
    if (command === "/tools") { console.log(ui.tools(toolRegistry.getToolDefinitions())); return true; }
    if (command === "/clear") { clearMessages(); lastAnswer = ""; console.log(ui.c.gray("Started a new conversation.")); return true; }

    if (command === "/save" || command.startsWith("/save ")) {
        if (!lastAnswer) { console.log(ui.c.gray("Nothing to save yet. Ask something first.")); return true; }
        const name = question.slice(5).trim() || `answer-${stamp()}.md`;
        console.log(`${ui.c.green(ui.sym.ok)} ${await saveToOutput(name, lastAnswer)}`);
        return true;
    }
    if (command === "/export") {
        if (!getMessages().some((m) => m.role === "user" || m.role === "assistant")) { console.log(ui.c.gray("Nothing to export yet.")); return true; }
        console.log(`${ui.c.green(ui.sym.ok)} ${await saveToOutput(`chat-${stamp()}.md`, chatToMarkdown(getMessages()))}`);
        return true;
    }
    if (/^\/plan\b/i.test(question)) {
        const goal = question.replace(/^\/plan\s*/i, "");
        if (!goal) { console.log(ui.c.gray("Usage: /plan <goal>. Shows the steps without running anything.")); return true; }
        const plan = engine.plan(goal);
        if (!plan.steps.length || !plan.complete) {
            console.log(ui.c.gray(`I can't plan "${goal}" with my rules alone${plan.unmapped.length ? ` (stuck on: ${plan.unmapped.join(" / ")})` : ""}. The model would plan it, or pick tools one at a time.`));
            return true;
        }
        console.log(ui.step({ type: "plan", text: plan.steps.map((s, i) => `${i + 1}. ${s.label}${s.byModel ? " (model writes)" : ""}`).join("\n") }));
        if (plan.needsPermission) console.log(ui.c.gray("  It will ask before saving anything. Nothing has run."));
        return true;
    }
    if (/^\/agent\b/i.test(question)) {
        const goal = question.replace(/^\/agent\s*/i, "");
        if (!goal) {
            console.log(ui.c.gray("Usage: /agent <goal>, for example: /agent research how React hooks work, then search my files for useEffect"));
            return true;
        }
        await showWork((handlers) => engine.agent(goal, handlers).then((result) => result.answer));
        return true;
    }
    return false;
}

async function startChat() {
    const model = createModelAdapter();
    const engine = createToolEngine(model, undefined, { profile: modelProfile(activeModelName()) });
    console.log(ui.banner({ provider: config.provider, model: activeModelName(), tools: toolRegistry.getToolDefinitions().length }));

    try {
        while (true) {
            let input;
            try {
                input = await rl.question(ui.prompt());
            } catch {
                console.log(`\n${ui.c.gray("Goodbye!")}`); // Ctrl+C, Ctrl+D or the input ended
                break;
            }
            const question = input.trim();

            if (!question) continue;
            if (question.toLowerCase() === "exit") {
                console.log(ui.c.gray("Goodbye!"));
                break;
            }

            try {
                if (!(await handleCommand(question, engine))) {
                    await showWork((handlers) => engine.run(question, handlers));
                }
            } catch (error) {
                console.error(`${ui.c.red(ui.sym.fail)} ${error.message}`);
            }
            console.log("");
        }
    } finally {
        rl.close();
    }
}

startChat().catch((error) => {
    console.error(`${ui.c.red("Could not start:")} ${error.message}`);
    rl.close();
    process.exitCode = 1;
});
