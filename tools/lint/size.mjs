#!/usr/bin/env node
/**
 * `pnpm lint:size` (P0-30.3, D-P4): the 800-line budget for the Worker's source. Lists every tracked
 * `packages/worker/src/**.ts` over 800 lines (generated files, per generated.json, are skipped) as
 * `path<TAB>lines` and hands the list to the lint-debt ledger tools/lint/debt/size.json.
 *
 *   node tools/lint/size.mjs check|record
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { excluded } from "./lint-debt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const LIMIT = 800;
const mode = process.argv[2];
if (mode !== "check" && mode !== "record") {
  console.error("usage: node tools/lint/size.mjs check|record");
  process.exit(2);
}

const ls = spawnSync("git", ["ls-files", "-z", "--", "packages/worker/src"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (ls.status !== 0) {
  console.error(`git ls-files failed (exit ${ls.status})`);
  process.exit(2);
}
const rows = [];
for (const file of ls.stdout.split("\0")) {
  if (!file.endsWith(".ts") || excluded(file)) continue;
  const text = readFileSync(join(ROOT, file), "utf8");
  const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  if (lines > LIMIT) rows.push(`${file}\t${lines}`);
}
rows.sort();

const l = spawnSync(
  process.execPath,
  [
    join(HERE, "lint-debt.mjs"),
    mode,
    "--tool",
    "size",
    "--ledger",
    join(HERE, "debt", "size.json"),
    "--root",
    ROOT,
  ],
  {
    input: rows.join("\n") + (rows.length ? "\n" : ""),
    stdio: ["pipe", "inherit", "inherit"],
  },
);
process.exit(l.status ?? 2);
