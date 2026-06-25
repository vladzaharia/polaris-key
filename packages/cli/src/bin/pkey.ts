#!/usr/bin/env node
import { runPkey } from "../index.js";

const code = await runPkey(process.argv.slice(2));
process.exitCode = code;
