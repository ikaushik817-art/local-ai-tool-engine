#!/usr/bin/env node
// `npm start` (and `npm run ui`) land here. One command gets everything ready, then runs:
//   1. checks Node,   2. installs what's missing (first run, or after an update),
//   3. adds the PDF reader if you said yes in setup,   4. asks which model to use (first run only),   5. starts.
// It only uses Node's own tools, so it works on a fresh download before anything is installed.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PDF_PACKAGE = "pdf-parse@1.1.1";

export const nodeOk = (version = process.versions.node) => Number(String(version).split(".")[0]) >= 18;

// A fingerprint of the package files. When an update brings a new library it changes, and we install again.
export function fingerprint(dir = here) {
    const hash = createHash("sha256");
    for (const file of ["package.json", "package-lock.json"]) {
        try { hash.update(readFileSync(path.join(dir, file))); } catch { /* the lock file may be missing */ }
    }
    return hash.digest("hex");
}

// A folder named "cheerio" isn't enough (an interrupted install leaves empty or half-written ones): its package file must be
// there and must point at a file that exists.
export function libraryIsComplete(dir, name) {
    const root = path.join(dir, "node_modules", name);
    try {
        const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
        const targets = [];
        const collect = (v) => { if (typeof v === "string") targets.push(v); else if (v && typeof v === "object") Object.values(v).forEach(collect); };
        collect(pkg.main); collect(pkg.module); collect(pkg.exports);
        if (!targets.length) targets.push("index.js");
        return targets.some((t) => existsSync(path.join(root, t)));
    } catch { return false; }
}

export function needsInstall(dir = here) {
    const modules = path.join(dir, "node_modules");
    if (!libraryIsComplete(dir, "cheerio") || !libraryIsComplete(dir, "expr-eval")) return true;
    try { return readFileSync(path.join(modules, ".late-installed"), "utf8") !== fingerprint(dir); } catch { return true; }
}

// When `npm start` runs us, npm tells us where it lives, which works on every system. Otherwise ask the system for "npm".
export function npmCommand(env = process.env, platform = process.platform) {
    const cli = env.npm_execpath;
    if (cli && /npm-cli\.[cm]?js$/i.test(cli)) return { cmd: process.execPath, args: [cli], shell: false };
    return { cmd: "npm", args: [], shell: platform === "win32" }; // Windows needs a shell to find npm.cmd
}

const runNpm = (args, dir = here) => {
    const npm = npmCommand();
    return npm.shell
        ? spawnSync([npm.cmd, ...npm.args, ...args].join(" "), { cwd: dir, stdio: "inherit", shell: true })
        : spawnSync(npm.cmd, [...npm.args, ...args], { cwd: dir, stdio: "inherit" });
};

export function ensureInstalled({ dir = here, run = (args) => runNpm(args, dir), log = console.log } = {}) {
    if (!needsInstall(dir)) return true;
    log("First run: installing what it needs (one time, about a minute)...\n");
    const result = run(["install", "--omit=dev", "--no-audit", "--no-fund"]);
    if (result.status !== 0) {
        log("\nThe install didn't finish. Check your internet connection, then run `npm start` again.");
        return false;
    }
    try {
        mkdirSync(path.join(dir, "node_modules"), { recursive: true });
        writeFileSync(path.join(dir, "node_modules", ".late-installed"), fingerprint(dir));
    } catch { /* worst case: it checks again next time */ }
    return true;
}

export function pdfWanted(dir = here, env = process.env) {
    if (/^(on|1|true|yes)$/i.test(env.AI_PDF ?? "")) return true;
    try { return /^AI_PDF\s*=\s*(on|1|true|yes)\s*$/im.test(readFileSync(path.join(dir, ".env"), "utf8")); } catch { return false; }
}

// The PDF reader is a separate small library, added only if you asked for it. Never stops the app if it fails.
export function ensurePdf({ dir = here, env = process.env, run = (args) => runNpm(args, dir), log = console.log } = {}) {
    if (!pdfWanted(dir, env) || existsSync(path.join(dir, "node_modules", "pdf-parse"))) return true;
    log("Adding the PDF reader (one time)...\n");
    const result = run(["install", PDF_PACKAGE, "--no-save", "--no-audit", "--no-fund"]);
    if (result.status !== 0) {
        log("Couldn't add the PDF reader. Everything else works. Try later: npm install pdf-parse@1.1.1");
        return false;
    }
    return true;
}

function main() {
    const flags = process.argv.slice(2);
    if (!nodeOk()) {
        console.log(`This needs Node.js 18 or newer (you have ${process.versions.node}). Get it from https://nodejs.org and run this again.`);
        process.exit(1);
    }
    if (!ensureInstalled()) process.exit(1);
    ensurePdf();

    const node = (script, args = []) => spawnSync(process.execPath, [path.join(here, script), ...args], { cwd: here, stdio: "inherit" });
    const setup = node("setup.js", flags.includes("--setup") ? [] : ["--if-needed"]); // asks about your model, first run only
    if (setup.status !== 0) process.exit(setup.status ?? 1);
    ensurePdf(); // setup may have just asked about PDFs
    if (flags.includes("--setup")) return;

    const run = node(flags.includes("--ui") ? "server.js" : "index.js");
    process.exit(run.status ?? 0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
