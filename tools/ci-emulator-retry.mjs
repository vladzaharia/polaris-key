#!/usr/bin/env node
/**
 * Decide whether a failed emulator attempt gets a second one (ci.yml, job kotlin-emulator).
 *
 * Only a known infrastructure failure is retried: the emulator never booted, the APK could not be
 * installed, or adb lost the device. A test that ran and failed is a real failure and gets no retry.
 *
 *   node tools/ci-emulator-retry.mjs <attempt-log> [--github-output]
 *       prints `retry=true|false`; --github-output appends it to $GITHUB_OUTPUT.
 *
 * The attempt log is written by tools/ci-emulator-run.sh, which runs inside the emulator action. If
 * the log does not exist the script never started, so the emulator itself failed to boot.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Output of an emulator or adb failure that is not about the code under test. */
export const INFRA_SIGNATURE =
  /INSTALL_FAILED|install-write|could not connect to TCP port|device offline|emulator: ERROR/;

/** @param {string | null} log the attempt's output, or null when the run script never started */
export function shouldRetry(log) {
  if (log === null) return true;
  return INFRA_SIGNATURE.test(log);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error(
      "usage: ci-emulator-retry.mjs <attempt-log> [--github-output]",
    );
    process.exit(2);
  }
  const line = `retry=${shouldRetry(existsSync(file) ? readFileSync(file, "utf8") : null)}`;
  console.log(line);
  if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}
