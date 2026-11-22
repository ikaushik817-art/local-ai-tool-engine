// Everything about how the terminal chat looks. No dependencies, just ANSI colors.
// Colors and animation switch themselves off when the output isn't a terminal (pipes, files)
// or when NO_COLOR is set, so logs stay clean.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const defaultUnicode = () => process.platform !== "win32"
    || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI === "ON");

const SYMBOLS = {
    unicode: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", arrow: "›", ok: "✓", fail: "✗", step: "→", dot: "·", frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] },
    ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", arrow: ">", ok: "ok", fail: "x", step: "->", dot: "-", frames: ["|", "/", "-", "\\"] }
};

export const visibleLength = (text) => String(text).replace(ANSI, "").length;
const trim = (text, max) => { const t = String(text).replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 3)}...` : t; };

export function createCliUI({ out = process.stdout, color, unicode } = {}) {
    const useColor = color ?? (Boolean(out.isTTY) && !process.env.NO_COLOR);
    const sym = (unicode ?? defaultUnicode()) ? SYMBOLS.unicode : SYMBOLS.ascii;
    const wrap = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
    const c = { bold: wrap("1"), dim: wrap("2"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"), cyan: wrap("36"), gray: wrap("90") };

    function box(lines, { title, tone = "cyan" } = {}) {
        const paint = c[tone] ?? ((t) => t);
        const width = Math.max(...lines.map(visibleLength), title ? visibleLength(title) + 1 : 0);
        const top = title
            ? `${sym.tl}${sym.h} ${title} ${sym.h.repeat(Math.max(0, width + 2 - visibleLength(title) - 3))}${sym.tr}`
            : `${sym.tl}${sym.h.repeat(width + 2)}${sym.tr}`;
        const body = lines.map((line) => `${paint(sym.v)} ${line}${" ".repeat(width - visibleLength(line))} ${paint(sym.v)}`);
        return [paint(top), ...body, paint(`${sym.bl}${sym.h.repeat(width + 2)}${sym.br}`)].join("\n");
    }

    const label = () => `${c.bold(c.green("AI"))} ${c.gray(sym.arrow)} `;
    const prompt = () => `${c.bold(c.cyan("You"))} ${c.gray(sym.arrow)} `;

    function banner({ provider, model, tools }) {
        return [
            "",
            box([
                `${c.bold(c.cyan("L.A.T.E."))}  ${c.gray("Local AI Tool Engine")}`,
                c.gray(`${provider} ${sym.dot} ${model} ${sym.dot} ${tools} tools`)
            ], { tone: "cyan" }),
            c.gray(`  Try: research how react hooks work ${sym.dot} convert 5 km to miles ${sym.dot} /agent <goal> ${sym.dot} /help`),
            ""
        ].join("\n");
    }

    // A one-line summary of a tool's arguments, like "how react hooks work" or "245 * 37".
    const describeArgs = (args) => trim(Object.values(args ?? {}).map((v) => (typeof v === "string" ? `"${trim(v, 50)}"` : JSON.stringify(v))).join(", "), 70);

    // Turns an engine event (step, result, plan) into a line to print, or null for events with nothing to show.
    function step(event) {
        if (event.type === "plan") {
            return [`  ${c.gray("plan")}`, ...String(event.text).split("\n").map((line) => `  ${c.gray(line)}`)].join("\n");
        }
        if (event.type === "step") return `  ${c.cyan(sym.step)} ${c.bold(event.tool)} ${c.gray(describeArgs(event.args))}`;
        if (event.type === "result") return `    ${event.ok ? c.green(sym.ok) : c.red(sym.fail)} ${c.gray(trim(event.summary, 90))}`;
        return null;
    }

    // Light touch on a finished answer: links, bold, and code stand out.
    function format(text) {
        if (!useColor) return String(text);
        let inCode = false;
        return String(text).split("\n").map((line) => {
            if (/^\s*```/.test(line)) { inCode = !inCode; return c.gray(line); }
            if (inCode) return c.yellow(line);
            if (/^Sources:\s*$/.test(line)) return c.bold(line);
            return line
                .replace(/\*\*([^*]+)\*\*/g, (_, bold) => c.bold(bold))
                .replace(/https?:\/\/[^\s)]+/g, (url) => c.cyan(url));
        }).join("\n");
    }

    function approval({ tool, args, preview }) {
        const lines = [`${c.bold(tool)} wants to make a change.`];
        if (preview?.file) {
            lines.push("", `File: ${c.bold(preview.file)}  ${c.gray(`(${preview.bytes} bytes, goes in the ai-output folder)`)}`);
            const shown = String(preview.text ?? "").split("\n").slice(0, 8);
            shown.forEach((line) => lines.push(`  ${c.gray(trim(line, 70))}`));
            if (String(preview.text ?? "").split("\n").length > 8 || preview.bytes > String(preview.text ?? "").length) lines.push(`  ${c.gray("...")}`);
        } else {
            lines.push("", c.gray(describeArgs(args)));
        }
        return box(lines, { title: c.yellow("Permission needed"), tone: "yellow" });
    }

    function help() {
        const rows = [
            ["/agent <goal>", "work through a bigger goal step by step"],
            ["/plan <goal>", "show the steps for a goal without running anything"],
            ["/save [name]", "save the last answer in the ai-output folder"],
            ["/export", "save this whole chat as a Markdown file"],
            ["/tools", "list the tools it can use"],
            ["/clear", "start a new conversation"],
            ["/help", "show this"],
            ["exit", "quit"]
        ];
        return ["", c.bold("Commands"), ...rows.map(([name, text]) => `  ${c.cyan(name.padEnd(15))} ${c.gray(text)}`)].join("\n");
    }

    function tools(list) {
        const rows = [...list].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, description }) => `  ${c.cyan(name.padEnd(14))} ${c.gray(trim(description, 72))}`);
        return ["", c.bold(`${list.length} tools`), ...rows].join("\n");
    }

    // A small animation while waiting. Does nothing when the output isn't a terminal.
    function spinner() {
        let timer = null;
        let frame = 0;
        let text = "thinking";
        const draw = () => out.write(`\r${c.cyan(sym.frames[frame++ % sym.frames.length])} ${c.gray(text)}\x1b[K`);
        return {
            start(next = "thinking") {
                text = next;
                if (!out.isTTY) return;
                draw();
                if (!timer) { timer = setInterval(draw, 80); timer.unref?.(); }
            },
            stop() {
                if (!timer) return;
                clearInterval(timer);
                timer = null;
                out.write("\r\x1b[K");
            },
            get running() { return timer !== null; }
        };
    }

    return { c, sym, box, label, prompt, banner, step, format, approval, help, tools, spinner, color: useColor };
}
