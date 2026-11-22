import test from "node:test";
import assert from "node:assert/strict";
import { createCliUI, visibleLength } from "../cli-ui.js";

const fakeOut = (isTTY) => { const writes = []; return { isTTY, writes, write: (t) => writes.push(t) }; };
const plain = createCliUI({ out: fakeOut(false), color: false, unicode: true });
const colored = createCliUI({ out: fakeOut(true), color: true, unicode: true });
const ascii = createCliUI({ out: fakeOut(false), color: false, unicode: false });
const strip = (t) => String(t).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

test("colors: off means plain text, on means escape codes, and codes don't count toward width", () => {
    assert.equal(plain.c.bold("hi"), "hi");
    assert.equal(colored.c.red("hi"), "\x1b[31mhi\x1b[0m");
    assert.equal(visibleLength(colored.c.green("hello")), 5);
    assert.equal(strip(colored.c.cyan("x")), "x");
});

test("colors: a pipe or NO_COLOR switches them off by themselves", () => {
    assert.equal(createCliUI({ out: fakeOut(false) }).color, false, "not a terminal");
    const saved = process.env.NO_COLOR;
    try {
        process.env.NO_COLOR = "1";
        assert.equal(createCliUI({ out: fakeOut(true) }).color, false, "NO_COLOR");
        delete process.env.NO_COLOR;
        assert.equal(createCliUI({ out: fakeOut(true) }).color, true, "a real terminal");
    } finally { if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved; }
});

test("box: every line is exactly as wide as the top, with or without color, titles and ASCII", () => {
    for (const ui of [plain, colored, ascii]) {
        for (const options of [{}, { title: "Permission needed" }, { title: "A much longer title than the content" }]) {
            const lines = ui.box([ui.c.bold("short"), "a longer line of text here", ""], options).split("\n");
            const widths = new Set(lines.map(visibleLength));
            assert.equal(widths.size, 1, `uneven box: ${JSON.stringify(lines.map(visibleLength))}`);
        }
    }
    assert.match(ascii.box(["x"]), /^\+-+\+\n\| x \|\n\+-+\+$/);
    assert.match(plain.box(["a longer line of content"], { title: "Hi" }), /^╭─ Hi ─+╮/);
});

test("banner: shows the provider, model and how many tools", () => {
    const text = strip(colored.banner({ provider: "ollama", model: "qwen2.5:3b", tools: 14 }));
    assert.match(text, /L\.A\.T\.E\./);
    assert.match(text, /ollama · qwen2\.5:3b · 14 tools/);
    assert.match(text, /Try: research/);
});

test("steps: plans, tool calls and results become readable lines; other events print nothing", () => {
    assert.equal(plain.step({ type: "step", step: 1, tool: "research", args: { question: "how react hooks work" } }), '  → research "how react hooks work"');
    assert.equal(plain.step({ type: "step", step: 1, tool: "convert", args: { value: "5", from: "km", to: "mi" } }), '  → convert "5", "km", "mi"');
    assert.equal(plain.step({ type: "step", step: 2, tool: "datetime", args: {} }), "  → datetime ");
    assert.equal(plain.step({ type: "result", ok: true, summary: "3 sources" }), "    ✓ 3 sources");
    assert.equal(plain.step({ type: "result", ok: false, summary: "boom" }), "    ✗ boom");
    assert.equal(ascii.step({ type: "result", ok: true, summary: "fine" }), "    ok fine");
    assert.equal(plain.step({ type: "plan", text: "1. look\n2. answer" }), "  plan\n  1. look\n  2. answer");
    assert.equal(plain.step({ type: "stop", reason: "finished" }), null);
    assert.equal(plain.step({ type: "token", text: "x" }), null);

    const long = plain.step({ type: "result", ok: true, summary: `line one\n${"x".repeat(300)}` });
    assert.ok(long.length < 110 && !long.includes("\n") && long.endsWith("..."), "long, multi-line results are squeezed to one line");
    assert.ok(plain.step({ type: "step", tool: "t", args: { q: "y".repeat(500) } }).length < 110);
});

test("format: links, bold, code and Sources stand out, and plain mode leaves text alone", () => {
    const text = "Use **useEffect** here.\n\n```js\nconst x = 1;\n```\n\nSources:\n- React: https://react.dev/learn";
    assert.equal(plain.format(text), text);
    const out = colored.format(text);
    assert.ok(out.includes("\x1b[1museEffect\x1b[0m"), "bold");
    assert.ok(out.includes("\x1b[33mconst x = 1;\x1b[0m"), "code lines");
    assert.ok(out.includes("\x1b[36mhttps://react.dev/learn\x1b[0m"), "links");
    assert.ok(out.includes("\x1b[1mSources:\x1b[0m"), "sources heading");
    assert.ok(!strip(out).includes("**"), "the asterisks are gone");
});

test("approval box: shows what will be saved, how big, and a preview that stops at 8 lines", () => {
    const preview = { file: "report.md", bytes: 2000, text: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") };
    const text = strip(colored.approval({ tool: "write_file", args: {}, preview }));
    assert.match(text, /Permission needed/);
    assert.match(text, /write_file wants to make a change/);
    assert.match(text, /File: report\.md\s+\(2000 bytes, goes in the ai-output folder\)/);
    assert.match(text, /line 8/);
    assert.ok(!text.includes("line 9"), "only the first 8 lines");
    assert.match(text, /\.\.\./);
    assert.equal(new Set(text.split("\n").map(visibleLength)).size, 1, "still a tidy box");

    const other = strip(plain.approval({ tool: "custom_tool", args: { city: "Delhi" } }));
    assert.match(other, /custom_tool wants to make a change/);
    assert.match(other, /"Delhi"/);
});

test("help and tools lists", () => {
    const help = strip(plain.help());
    for (const word of ["/agent <goal>", "/save [name]", "/export", "/tools", "/clear", "/help", "exit"]) assert.ok(help.includes(word), word);
    const list = strip(plain.tools([{ name: "weather", description: "Current weather." }, { name: "calculator", description: "Math." }]));
    assert.match(list, /2 tools/);
    assert.ok(list.indexOf("calculator") < list.indexOf("weather"), "sorted");
    assert.ok(!/\n\n$/.test(help) && !/\n\n$/.test(list), "no trailing blank line (the chat adds its own)");
});

test("spinner: silent outside a terminal; animates and cleans up inside one", async () => {
    const quiet = fakeOut(false);
    const idle = createCliUI({ out: quiet, color: false }).spinner();
    idle.start("thinking"); idle.stop();
    assert.deepEqual(quiet.writes, []);
    assert.equal(idle.running, false);

    const tty = fakeOut(true);
    const spin = createCliUI({ out: tty, color: false, unicode: true }).spinner();
    spin.stop();
    assert.deepEqual(tty.writes, [], "stopping something that never started writes nothing");

    spin.start("running research");
    assert.equal(spin.running, true);
    assert.match(tty.writes[0], /^\r⠋ running research\x1b\[K$/, "draws immediately");
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.ok(tty.writes.length >= 3, "keeps animating");
    assert.notEqual(tty.writes[1], tty.writes[2], "frames change");

    spin.start("again"); // starting twice doesn't stack timers
    spin.stop();
    assert.equal(tty.writes.at(-1), "\r\x1b[K", "wipes its line");
    assert.equal(spin.running, false);
    const count = tty.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(tty.writes.length, count, "nothing is drawn after stop");
});
