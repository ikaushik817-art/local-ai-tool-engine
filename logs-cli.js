#!/usr/bin/env node
// npm run logs: what ran, what failed, how slow.
import fs from "node:fs";
import { config } from "./config.js";
import { summarize } from "./logger.js";

let text = "";
for (const file of [`${config.logFile}.1`, config.logFile]) { try { text += fs.readFileSync(file, "utf8"); } catch { /* not there */ } }
console.log(text ? summarize(text) : `No log yet (looked for ${config.logFile}).`);
