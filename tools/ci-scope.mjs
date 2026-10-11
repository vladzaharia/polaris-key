#!/usr/bin/env node
/**
 * The one CI scope (P0-43): which lanes a change needs, and each matrix's pull-request and main
 * shapes, read from tools/ci-scope.json. `.github/workflows/ci.yml`'s `changes` job and the lead's
 * gate.sh both ask this script, so a lane runs for the same files in CI and in the local gate.
 *
 *   node tools/ci-scope.mjs ci [--event <name>] [--base <rev>] [--head <rev>] [--github-output]
 *       print (or append to $GITHUB_OUTPUT) `<lane>=true|false` for every lane, `full`, and
 *       `<matrix>-matrix=<json>` for every matrix. The event defaults to $GITHUB_EVENT_NAME. Only a
 *       pull_request narrows: every other event (a push to main, a manual run) runs every lane and
 *       the full matrices, and so does a pull request whose changed files cannot be read.
 *   node tools/ci-scope.mjs touches <lane> [--base <rev>] [--worktree]
 *       exit 0 when the lane runs for the changes since the merge base with <rev> (default main),
 *       exit 1 when it can be skipped; --worktree adds uncommitted changes (the gate's view). When
 *       the changed files cannot be read, every lane runs.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCOPE_FILE = join(HERE, "ci-scope.json");

export function loadScope(file = SCOPE_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const hits = (prefixes, file) => prefixes.some((p) => file.startsWith(p));

/**
 * `{ lane: boolean }` for a list of changed files (repository-relative, `/`-separated). A shared
 * input turns every lane on. `files === null` means the change set is unknown: every lane runs.
 */
export function selectLanes(scope, files) {
  const lanes = Object.keys(scope.lanes);
  if (files === null || files.some((f) => hits(scope.shared, f)))
    return Object.fromEntries(lanes.map((l) => [l, true]));
  return Object.fromEntries(
    lanes.map((l) => [l, files.some((f) => hits(scope.lanes[l].paths, f))]),
  );
}

/** A matrix's shape for the event: a pull request runs the floor and latest, everything else all. */
export function matrixFor(scope, name, event) {
  const m = scope.matrices[name];
  if (!m) throw new Error(`no matrix "${name}" in ci-scope.json`);
  return event === "pull_request" ? m.pr : m.main;
}

/** The `changes` job's outputs: lane flags, `full`, and one JSON matrix per matrix. */
export function ciOutputs(scope, { event, files }) {
  const narrow = event === "pull_request" && files !== null;
  const lanes = selectLanes(scope, narrow ? files : null);
  const out = Object.fromEntries(
    Object.entries(lanes).map(([l, on]) => [l, String(on)]),
  );
  out.full = String(!narrow);
  for (const name of Object.keys(scope.matrices))
    out[`${name}-matrix`] = JSON.stringify(matrixFor(scope, name, event));
  return out;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Changed files `base...head`, plus uncommitted ones when asked; null when git cannot say. */
export function changedFiles({ base, head = "HEAD", worktree = false }) {
  try {
    const names = new Set(
      git(["diff", "--name-only", `${base}...${head}`]).split("\n"),
    );
    if (worktree)
      for (const f of git(["diff", "--name-only", "HEAD"]).split("\n"))
        names.add(f);
    names.delete("");
    return [...names];
  } catch {
    return null;
  }
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const scope = loadScope();
  if (cmd === "ci") {
    const event = arg(rest, "--event") ?? process.env.GITHUB_EVENT_NAME ?? "";
    const base = arg(rest, "--base");
    const files =
      event === "pull_request" && base
        ? changedFiles({ base, head: arg(rest, "--head") ?? "HEAD" })
        : null;
    const out = ciOutputs(scope, { event, files });
    const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
    if (rest.includes("--github-output")) {
      const file = process.env.GITHUB_OUTPUT;
      if (!file) throw new Error("--github-output needs GITHUB_OUTPUT");
      appendFileSync(file, `${lines.join("\n")}\n`);
    }
    process.stdout.write(
      `${event || "(no event)"}: ${files === null ? "every lane" : `${files.length} changed file(s)`}\n${lines.join("\n")}\n`,
    );
    return 0;
  }
  if (cmd === "touches") {
    const lane = rest[0];
    if (!lane || !(lane in scope.lanes))
      throw new Error(
        `usage: ci-scope.mjs touches <lane> (${Object.keys(scope.lanes).join(", ")})`,
      );
    const files = changedFiles({
      base: arg(rest, "--base") ?? "main",
      worktree: rest.includes("--worktree"),
    });
    return selectLanes(scope, files)[lane] ? 0 : 1;
  }
  throw new Error(
    "usage: ci-scope.mjs ci [--event <name>] [--base <rev>] [--head <rev>] [--github-output] | touches <lane> [--base <rev>] [--worktree]",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(
      `::error::${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exitCode = 2;
  }
}
