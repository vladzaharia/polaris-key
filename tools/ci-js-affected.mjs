#!/usr/bin/env node
/**
 * Does a package's JS test job have anything to do? `js-worker` and `js-admin` ask this before
 * they build and test (ci.yml). With a JS base (the `changes` job's `js-base`: the js group's green
 * ancestor, set only when every file changed since it lies under packages/), the package runs when
 * turbo's `...[base]` selection (the changed packages and their dependents, as `pnpm gate` selects
 * them) contains it; with no base, everything runs.
 *
 *   node tools/ci-js-affected.mjs <package> [--base <sha>] [--github-output]
 *       prints `affected=true|false`; appends it to $GITHUB_OUTPUT with --github-output. The base
 *       defaults to $JS_BASE. Any error (turbo failing, unreadable output) answers true.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The package names in `turbo run test --dry=json` output (it may print log lines first). */
export function packagesOf(dryRunText) {
  const json = JSON.parse(dryRunText.slice(dryRunText.indexOf("{")));
  return new Set((json.tasks ?? []).map((t) => t.package));
}

/**
 * Packages a package's tests read from disk without depending on them in the workspace graph, so
 * turbo's `...[base]` cannot see the edge: the Worker's tests read packages/docs/dist (the slug
 * manifest, the built site's CSP hashes, the search index), packages/admin/dist and
 * packages/admin/src (the help-link tables, the SPA shells' CSP hashes) and packages/elements. A
 * change to one of them selects the Worker. (Other reads leave packages/: products/, sdks/,
 * conformance/, which js-base never narrows.)
 */
export const EXTRA_INPUTS = {
  "@polaris-key/worker": [
    "@polaris-key/docs",
    "@polaris-key/admin",
    "@polaris-key/elements",
  ],
};

/** True when `pkg` is selected by `...[base]`, or when there is no base or turbo cannot say. */
export function affected(
  pkg,
  base,
  run = (args) =>
    execFileSync("pnpm", ["exec", "turbo", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }),
) {
  if (!base) return true;
  try {
    const selected = packagesOf(
      run(["run", "test", "--dry=json", `--filter=...[${base}]`]),
    );
    return [pkg, ...(EXTRA_INPUTS[pkg] ?? [])].some((p) => selected.has(p));
  } catch (e) {
    process.stderr.write(
      `ci-js-affected: turbo could not select against ${base}, running the suite: ${String(e?.message ?? e).split("\n")[0]}\n`,
    );
    return true;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const pkg = argv.find((a) => !a.startsWith("--"));
  const i = argv.indexOf("--base");
  const base = i >= 0 ? argv[i + 1] : process.env.JS_BASE;
  if (!pkg) {
    process.stderr.write(
      "usage: ci-js-affected.mjs <package> [--base <sha>]\n",
    );
    process.exit(2);
  }
  const line = `affected=${affected(pkg, base)}`;
  if (argv.includes("--github-output") && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  process.stdout.write(`${line}\n`);
}
