#!/usr/bin/env node
/**
 * Does a package's JS test job have anything to do? `js-worker` and `js-admin` ask this before
 * they build and test (ci.yml); `js-rest` asks for its turbo filters. The base is the `changes`
 * job's `js-base`: a pull request's merge base, or on a push to `next` the js group's green
 * ancestor, set only when every file changed since it lies under packages/. With a base, the
 * package runs when turbo's `...[base]` selection (the changed packages and their dependents, as
 * `pnpm gate` selects them) contains it, or contains a package listed for it in EXTRA_INPUTS; with
 * no base, everything runs.
 *
 *   node tools/ci-js-affected.mjs <package> [--base <sha>] [--github-output]
 *       prints `affected=true|false`; appends it to $GITHUB_OUTPUT with --github-output. The base
 *       defaults to $JS_BASE. Any error (turbo failing, unreadable output) answers true.
 *   node tools/ci-js-affected.mjs --filters [--base <sha>]
 *       prints the turbo `--filter=` arguments that select the same packages (one line); nothing
 *       with no base or when turbo cannot say, which leaves the caller's own filters to run all.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The packages `--filter` matched in `turbo run test --dry=json` output (it may print log lines
 * first): `packages`, which leaves out the packages that are only built as a dependency of one.
 */
export function packagesOf(dryRunText) {
  const json = JSON.parse(dryRunText.slice(dryRunText.indexOf("{")));
  return new Set(json.packages ?? (json.tasks ?? []).map((t) => t.package));
}

/**
 * Packages a package reads from disk (its tests, scripts or sources open a sibling package's files
 * by relative path) without depending on it in the workspace graph, so turbo's `...[base]` cannot
 * see the edge: a change to a listed package also selects the reading one. The Worker, for one,
 * reads packages/docs/dist (the slug manifest, the built site's CSP hashes, the search index),
 * packages/admin/dist and packages/admin/src. tools/ci-scope.test.ts scans every package for such
 * reads and fails on one neither package.json (directly or through other packages) nor this table
 * covers. (Reads that leave packages/: products/, sdks/, conformance/, which a js base never narrows.)
 *
 * What that scan cannot see, and so must be added here by hand: a path built from variables; a read
 * from a file outside src/, test/, tests/ and scripts/ or from a .css, .astro or .mdx file; and an edge
 * that exists only at run time, such as a test that drives a binary another package builds (the React
 * live suite runs against `pkey dev`, which the CLI builds from the Worker's sources).
 */
export const EXTRA_INPUTS = {
  "@polaris-key/admin": ["@polaris-key/docs", "@polaris-key/worker"],
  "@polaris-key/brand": ["@polaris-key/node"],
  "@polaris-key/cli": ["@polaris-key/docs", "@polaris-key/worker"],
  "@polaris-key/docs": [
    "@polaris-key/admin",
    "@polaris-key/agent-kit",
    "@polaris-key/cli",
    "@polaris-key/manifest",
    "@polaris-key/ui-qa",
    "@polaris-key/worker",
  ],
  "@polaris-key/elements": ["@polaris-key/ui-qa"],
  "@polaris-key/manifest": ["@polaris-key/admin", "@polaris-key/cli"],
  "@polaris-key/node": ["@polaris-key/admin", "@polaris-key/ui-qa"],
  "@polaris-key/react": ["@polaris-key/cli", "@polaris-key/worker"],
  "@polaris-key/ui-core": [
    "@polaris-key/docs",
    "@polaris-key/node",
    "@polaris-key/react",
  ],
  "@polaris-key/ui-qa": [
    "@polaris-key/brand",
    "@polaris-key/client-core",
    "@polaris-key/docs",
    "@polaris-key/elements",
    "@polaris-key/node",
    "@polaris-key/react",
    "@polaris-key/ui-core",
  ],
  "@polaris-key/worker": ["@polaris-key/admin", "@polaris-key/docs"],
};

/**
 * The packages with tests to run for `...[base]`: turbo's selection plus every reader of one of them.
 * One step only, on purpose: these reads are of sources and built output, so a reader's tests depend
 * on what it reads, not on what that package reads in turn. (Followed to a fixed point the table is
 * connected enough that nearly any change would select every package.)
 */
export function selectedPackages(base, run = turbo) {
  const selected = packagesOf(
    run(["run", "test", "--dry=json", `--filter=...[${base}]`]),
  );
  const readers = Object.entries(EXTRA_INPUTS)
    .filter(([, reads]) => reads.some((p) => selected.has(p)))
    .map(([reader]) => reader);
  return new Set([...selected, ...readers]);
}

function turbo(args) {
  return execFileSync("pnpm", ["exec", "turbo", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

const cannotSay = (base, e) =>
  process.stderr.write(
    `ci-js-affected: turbo could not select against ${base}, running the suite: ${String(e?.message ?? e).split("\n")[0]}\n`,
  );

/** True when `pkg` is selected by `...[base]` (or reads a selected package), or when there is no base or turbo cannot say. */
export function affected(pkg, base, run = turbo) {
  if (!base) return true;
  try {
    return selectedPackages(base, run).has(pkg);
  } catch (e) {
    cannotSay(base, e);
    return true;
  }
}

/**
 * The turbo filter arguments that select `selectedPackages(base)`: one `--filter=<name>` each, or
 * `...[base]` alone when it selects nothing. Empty (so the caller's other filters run everything)
 * with no base or when turbo cannot say.
 */
export function filters(base, run = turbo) {
  if (!base) return [];
  try {
    const names = [...selectedPackages(base, run)].sort();
    return names.length > 0
      ? names.map((n) => `--filter=${n}`)
      : [`--filter=...[${base}]`];
  } catch (e) {
    cannotSay(base, e);
    return [];
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--base");
  const base = i >= 0 ? argv[i + 1] : process.env.JS_BASE;
  if (argv.includes("--filters")) {
    process.stdout.write(`${filters(base).join(" ")}\n`);
    process.exit(0);
  }
  const pkg = argv.find(
    (a, n) => !a.startsWith("--") && argv[n - 1] !== "--base",
  );
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
