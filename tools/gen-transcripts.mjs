#!/usr/bin/env node
// Generate the HTTP transcripts (P1b-03, PARITY §4.2).
//
//   pnpm gen:transcripts             # record every scenario and write the files
//   pnpm gen:transcripts -- --check  # record in memory; exit 1 if any file is stale
//
// The recording lives in the Worker's test suite, not here: the scenarios drive the REAL router
// with the Worker's own test database, KV and rate-limiter mocks, and they assert the server's
// behaviour as they record. This wrapper only runs that one test file, with or without
// `PKEY_WRITE_TRANSCRIPTS=1`:
//
//   conformance/transcripts/<id>.json                          the canonical files
//   sdks/swift/Tests/PolarisKeyTests/Resources/transcripts/    the generator-owned Swift mirror
//
// Without the flag the test compares instead of writing, which is also what the ordinary
// `pnpm --filter @polaris-key/worker test` run does — so a Worker change that alters a recorded
// response fails the Worker suite and this check alike.
//
// The Worker suite imports the workspace packages' built output, so run `pnpm build` first on a
// fresh checkout (CI and the green gate already do).

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const env = { ...process.env };
if (check) delete env.PKEY_WRITE_TRANSCRIPTS;
else env.PKEY_WRITE_TRANSCRIPTS = "1";

const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@polaris-key/worker",
    "exec",
    "vitest",
    "run",
    "test/transcripts.test.ts",
  ],
  { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  if (check)
    console.error(
      "gen:transcripts --check: stale transcripts — run `pnpm gen:transcripts` and commit the result",
    );
  process.exit(result.status ?? 1);
}
console.log(
  check
    ? "gen:transcripts --check: every transcript is fresh"
    : "gen:transcripts: wrote conformance/transcripts and the Swift mirror",
);
