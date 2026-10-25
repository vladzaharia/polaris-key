#!/usr/bin/env node
/**
 * Run one service's worker tests: `pnpm --filter @polaris-key/worker test:service <slug>`
 * runs `vitest run test/services/<slug>/`. An unknown slug lists tools/services.json and
 * exits 2 (P0-30.6; plans/P0-30-AX-07-slices.md D-P7).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.join(here, "..");
const table = JSON.parse(
  readFileSync(
    path.join(workerRoot, "..", "..", "tools", "services.json"),
    "utf8",
  ),
);
const rows = Array.isArray(table)
  ? table
  : (table.services ?? Object.values(table));
const slugs = rows.map((r) => r.slug);
const slug = process.argv[2];
if (!slug || !slugs.includes(slug)) {
  console.error(
    `test:service: ${slug ? `unknown service "${slug}"` : "missing <slug>"}; one of: ${slugs.join(", ")}`,
  );
  process.exit(2);
}
const r = spawnSync(
  "vitest",
  ["run", `test/services/${slug}/`, ...process.argv.slice(3)],
  { cwd: workerRoot, stdio: "inherit", shell: false, env: process.env },
);
process.exit(r.status ?? 1);
