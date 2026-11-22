// Every eval case that must work WITHOUT a model runs here, so a broken rule fails `npm test`.
// (Quality cases for a real model are run on purpose with `npm run eval`.)
import test from "node:test";
import assert from "node:assert/strict";
import { cases } from "../evals/cases.js";
import { runCase, deadModel } from "../evals/harness.js";

for (const testCase of cases.filter((c) => !c.needsModel)) {
    test(`eval (no model): ${testCase.group} / ${testCase.id}`, async () => {
        // Random cases run a few times: a rule that only works on lucky numbers is not a rule.
        const times = /random|largest|smallest|sum|average/.test(testCase.id) ? 5 : 1;
        for (let i = 0; i < times; i++) {
            const result = await runCase(testCase, { model: deadModel, timeoutMs: 20000 });
            assert.equal(result.problem, "", `${result.problem}\nanswer: ${result.answer}`);
        }
    });
}
