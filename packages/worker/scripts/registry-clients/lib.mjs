/** Shared helpers for the registry-client harness (F-02). */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The worker package's directory (where wrangler.toml is). */
export const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The local wrangler binary. */
export const WRANGLER = join(WORKER, "node_modules", ".bin", "wrangler");

/** The workspace's tsx (a client seed imports the Worker's TypeScript sources). */
export const TSX = join(WORKER, "..", "..", "node_modules", ".bin", "tsx");

/** Run a wrangler command in the worker directory, non-interactively, inheriting output. */
export function wrangler(args) {
  execFileSync(WRANGLER, args, {
    cwd: WORKER,
    stdio: "inherit",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
}

/** The value after `name` in argv, or undefined. */
export function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Every value after each `name` in argv. */
export function argValues(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1] !== undefined)
      out.push(process.argv[i + 1]);
  });
  return out;
}
