// `npm start` does everything: install what's missing, add the PDF reader if wanted, then run.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { nodeOk, fingerprint, needsInstall, libraryIsComplete, npmCommand, ensureInstalled, pdfWanted, ensurePdf } from "../launch.js";

const project = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "late-launch-"));
    writeFileSync(path.join(dir, "package.json"), '{"name":"x","dependencies":{"cheerio":"1","expr-eval":"2"}}');
    return dir;
};
const installed = (dir) => {
    for (const m of ["cheerio", "expr-eval"]) {
        mkdirSync(path.join(dir, "node_modules", m), { recursive: true });
        writeFileSync(path.join(dir, "node_modules", m, "package.json"), '{"main":"index.js"}');
        writeFileSync(path.join(dir, "node_modules", m, "index.js"), "");
    }
};
const quiet = () => { const lines = []; return { lines, log: (t) => lines.push(String(t)) }; };

test("node version: 18 and newer are fine, older ones are not", () => {
    assert.equal(nodeOk("18.0.0"), true);
    assert.equal(nodeOk("22.4.1"), true);
    assert.equal(nodeOk("16.20.2"), false);
});

test("a fresh download needs the install, and so does one whose package files changed", () => {
    const dir = project();
    assert.equal(needsInstall(dir), true, "nothing installed");
    installed(dir);
    assert.equal(needsInstall(dir), true, "libraries there, but never marked as installed from these package files");
    writeFileSync(path.join(dir, "node_modules", ".late-installed"), fingerprint(dir));
    assert.equal(needsInstall(dir), false);
    writeFileSync(path.join(dir, "package.json"), '{"name":"x","dependencies":{"cheerio":"1","expr-eval":"2","new-lib":"1"}}');
    assert.equal(needsInstall(dir), true, "an update brought a new library");
});

test("a deleted library brings the install back", () => {
    const dir = project();
    installed(dir);
    writeFileSync(path.join(dir, "node_modules", ".late-installed"), fingerprint(dir));
    assert.equal(needsInstall(dir), false);
    mkdirSync(path.join(dir, "node_modules", "cheerio"), { recursive: true });
    writeFileSync(path.join(dir, "gone"), "");
    assert.equal(needsInstall(dir), false);
    const dir2 = project(); installed(dir2); writeFileSync(path.join(dir2, "node_modules", ".late-installed"), fingerprint(dir2));
    assert.equal(needsInstall(dir2), false);
    writeFileSync(path.join(dir2, "package.json"), "{}");
    assert.equal(needsInstall(dir2), true);
});

test("npm is found the way npm itself tells us, or by name (with a shell on Windows)", () => {
    const viaNpm = npmCommand({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }, "linux");
    assert.equal(viaNpm.cmd, process.execPath);
    assert.deepEqual(viaNpm.args, ["/usr/lib/node_modules/npm/bin/npm-cli.js"]);
    assert.equal(viaNpm.shell, false);
    assert.deepEqual(npmCommand({ npm_execpath: "/x/yarn.js" }, "linux"), { cmd: "npm", args: [], shell: false }, "another tool's path is not used");
    assert.deepEqual(npmCommand({}, "win32"), { cmd: "npm", args: [], shell: true });
});

test("install: runs once, remembers it, and says what to do when it fails", () => {
    const dir = project();
    const calls = [];
    const ok = (args) => { calls.push(args); installed(dir); return { status: 0 }; };
    const a = quiet();
    assert.equal(ensureInstalled({ dir, run: ok, log: a.log }), true);
    assert.deepEqual(calls, [["install", "--omit=dev", "--no-audit", "--no-fund"]]);
    assert.match(a.lines[0], /First run: installing/);
    assert.equal(ensureInstalled({ dir, run: ok, log: a.log }), true);
    assert.equal(calls.length, 1, "second start: nothing to do, and it says nothing");

    const bad = project();
    const b = quiet();
    assert.equal(ensureInstalled({ dir: bad, run: () => ({ status: 1 }), log: b.log }), false);
    assert.match(b.lines.join("\n"), /Check your internet connection, then run `npm start` again/);
    assert.equal(existsSync(path.join(bad, "node_modules", ".late-installed")), false, "a failed install is not remembered");
});

test("pdf reader: only when asked for, only once, and a failure never stops the app", () => {
    const dir = project();
    const calls = [];
    const run = (args) => { calls.push(args); return { status: 0 }; };
    assert.equal(pdfWanted(dir, {}), false);
    assert.equal(ensurePdf({ dir, env: {}, run }), true);
    assert.equal(calls.length, 0, "not asked for: nothing installed");

    writeFileSync(path.join(dir, ".env"), "AI_PROVIDER=ollama\nAI_PDF=on\n");
    assert.equal(pdfWanted(dir, {}), true);
    assert.equal(ensurePdf({ dir, env: {}, run, log: () => {} }), true);
    assert.deepEqual(calls[0], ["install", "pdf-parse@1.1.1", "--no-save", "--no-audit", "--no-fund"]);

    mkdirSync(path.join(dir, "node_modules", "pdf-parse"), { recursive: true });
    ensurePdf({ dir, env: {}, run, log: () => {} });
    assert.equal(calls.length, 1, "already there: not installed again");

    const other = project();
    const q = quiet();
    assert.equal(ensurePdf({ dir: other, env: { AI_PDF: "on" }, run: () => ({ status: 1 }), log: q.log }), false);
    assert.match(q.lines.join("\n"), /Couldn't add the PDF reader. Everything else works/);
    assert.equal(pdfWanted(other, { AI_PDF: "off" }), false);
});

test("an interrupted install (empty folders, a package file with nothing behind it) counts as not installed", () => {
    const dir = project();
    mkdirSync(path.join(dir, "node_modules", "cheerio"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "expr-eval"), { recursive: true });
    assert.equal(libraryIsComplete(dir, "cheerio"), false, "an empty folder");
    writeFileSync(path.join(dir, "node_modules", "cheerio", "package.json"), '{"main":"index.js"}');
    assert.equal(libraryIsComplete(dir, "cheerio"), false, "the package file points at nothing");
    writeFileSync(path.join(dir, "node_modules", "cheerio", "package.json"), "{ half written");
    assert.equal(libraryIsComplete(dir, "cheerio"), false, "a damaged package file");
    writeFileSync(path.join(dir, "node_modules", "cheerio", "package.json"), '{"exports":{".":{"import":"./lib/index.js"}}}');
    mkdirSync(path.join(dir, "node_modules", "cheerio", "lib"));
    writeFileSync(path.join(dir, "node_modules", "cheerio", "lib", "index.js"), "");
    assert.equal(libraryIsComplete(dir, "cheerio"), true, "modern packages that use 'exports'");
    assert.equal(needsInstall(dir), true, "expr-eval is still empty");
});
