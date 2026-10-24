#!/usr/bin/env node
/**
 * `pnpm lint:dupes` (P0-46.3): run jscpd (config: .jscpd.json) into a temp dir and hand its JSON
 * report to the lint-debt ledger tools/lint/debt/jscpd.json.
 *
 *   node tools/lint/dupes.mjs check|record
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const mode = process.argv[2];
if (mode !== "check" && mode !== "record") {
  console.error("usage: node tools/lint/dupes.mjs check|record");
  process.exit(2);
}

const out = mkdtempSync(join(tmpdir(), "jscpd-"));
try {
  const bin = join(ROOT, "node_modules", ".bin", "jscpd");
  const r = spawnSync(
    bin,
    ["--config", join(ROOT, ".jscpd.json"), "--output", out, "."],
    {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  if (r.status !== 0) {
    console.error(`jscpd failed (exit ${r.status})`);
    process.exit(2);
  }
  const input = join(out, "jscpd-report.json");
  readFileSync(input);
  const l = spawnSync(
    process.execPath,
    [
      join(HERE, "lint-debt.mjs"),
      mode,
      "--tool",
      "jscpd",
      "--ledger",
      join(HERE, "debt", "jscpd.json"),
      "--input",
      input,
      "--root",
      ROOT,
    ],
    { stdio: "inherit" },
  );
  process.exit(l.status ?? 2);
} finally {
  rmSync(out, { recursive: true, force: true });
}
