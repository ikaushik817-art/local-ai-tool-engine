#!/usr/bin/env node
// How good is MY model with L.A.T.E.?   npm run eval
//   --fake        no model at all (only the cases that must work without one)
//   --network     also run the cases that need the internet
//   --only=id     run one case (or several, comma separated)
//   --repeat=3    run each model case 3 times (models are not the same every time)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModelAdapter } from "../model.js";
import { config, activeModelName } from "../config.js";
import { cases } from "./cases.js";
import { runCase, deadModel } from "./harness.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const fake = flag("fake");
const only = value("only")?.split(",");
const repeat = Math.max(1, Number(value("repeat")) || 1);

const model = fake ? deadModel : createModelAdapter();
const chosen = cases.filter((c) => (only ? only.includes(c.id) : true) && (!fake || !c.needsModel) && (flag("network") || !c.network));
const label = fake ? "no model" : `${config.provider} / ${activeModelName()}`;
console.log(`L.A.T.E. eval: ${chosen.length} cases, ${label}\n`);

const results = [];
for (const testCase of chosen) {
    const times = testCase.needsModel ? repeat : 1;
    for (let i = 0; i < times; i++) {
        const r = await runCase(testCase, { model });
        results.push(r);
        console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.group.padEnd(8)} ${r.id}${times > 1 ? ` #${i + 1}` : ""}  ${(r.ms / 1000).toFixed(1)}s${r.ok ? "" : `\n      ${r.problem}\n      answer: ${r.answer.replace(/\s+/g, " ").slice(0, 160)}`}`);
    }
}

const groups = [...new Set(results.map((r) => r.group))];
const rate = (list) => (list.length ? Math.round((list.filter((r) => r.ok).length / list.length) * 100) : 100);
const solid = results.filter((r) => !cases.find((c) => c.id === r.id).needsModel);
const quality = results.filter((r) => cases.find((c) => c.id === r.id).needsModel);

console.log("\nScore by group:");
for (const g of groups) console.log(`  ${g.padEnd(8)} ${rate(results.filter((r) => r.group === g))}%`);
console.log(`\nMust-work cases (no model needed): ${solid.filter((r) => r.ok).length}/${solid.length}`);
if (quality.length) console.log(`Model quality cases:               ${quality.filter((r) => r.ok).length}/${quality.length}  (${rate(quality)}%)`);

const report = [`# Eval report`, ``, `Model: ${label}`, `Date: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, ``,
    `| Case | Group | Result | Time | Problem |`, `| --- | --- | --- | --- | --- |`,
    ...results.map((r) => `| ${r.id} | ${r.group} | ${r.ok ? "pass" : "FAIL"} | ${(r.ms / 1000).toFixed(1)}s | ${r.problem.replace(/\|/g, "/")} |`), ``,
    `Must-work: ${solid.filter((r) => r.ok).length}/${solid.length}. Model quality: ${quality.filter((r) => r.ok).length}/${quality.length}.`].join("\n");
writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "last-report.md"), report);
console.log("\nFull report: evals/last-report.md");
process.exit(solid.every((r) => r.ok) ? 0 : 1);
