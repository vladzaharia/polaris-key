#!/usr/bin/env node
/**
 * The one CI scope (P0-43): which lanes a change needs, and each matrix's pull-request and main
 * shapes, read from tools/ci-scope.json. `.github/workflows/ci.yml`'s `changes` job and `pnpm gate`
 * (tools/gate.mjs) both ask this script, so a lane runs for the same files in CI and in the local gate.
 *
 *   node tools/ci-scope.mjs ci [--event <name>] [--base <rev>] [--head <rev>] [--github-output]
 *       print (or append to $GITHUB_OUTPUT) `<lane>=true|false` for every lane, `full`, and
 *       `<matrix>-matrix=<json>` for every matrix. The event defaults to $GITHUB_EVENT_NAME. Two
 *       runs narrow: a pull_request (to the files changed against its base, on the floor and latest
 *       of each matrix) and a push to `next` (to the files changed since its newest green ancestor,
 *       see findGreenAncestor, on the FULL matrices). Every other event (a push to main, a tag, a
 *       manual run) runs every lane and the full matrices, and so does a narrowing run whose changed
 *       files cannot be read (no green ancestor within the lookback, an unreadable diff or API).
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

/** A matrix's shape: a narrowed run takes the floor and the latest, every other run the full set. */
export function matrixFor(scope, name, narrow) {
  const m = scope.matrices[name];
  if (!m) throw new Error(`no matrix "${name}" in ci-scope.json`);
  return narrow ? m.pr : m.main;
}

/** The integration branch whose pushes narrow to the files changed since a green ancestor. */
export const NEXT_REF = "refs/heads/next";
/** How many commits before HEAD a green ancestor is looked for on `next`. */
export const ANCESTOR_LOOKBACK = 30;

/**
 * The `changes` job's outputs: lane flags, `full`, and one JSON matrix per matrix. `files` is the
 * change set the run narrows to, or null when it is unknown. A pull request with known files
 * narrows to their lanes and the pull-request matrices. A push to `next` (`ref` is refs/heads/next)
 * with known files, that is, with a green ancestor found, narrows to their lanes on the FULL
 * matrices. A push to main, a tag, a manual run and any run whose changes could not be read run
 * every lane and the full matrices. `full` is "false" exactly when lanes are narrowed, which is
 * when `ci-ok` may count a skipped lane as passed.
 */
export function ciOutputs(scope, { event, ref, files }) {
  const pr = event === "pull_request" && files !== null;
  const next = event === "push" && ref === NEXT_REF && files !== null;
  const narrow = pr || next;
  const lanes = selectLanes(scope, narrow ? files : null);
  const out = Object.fromEntries(
    Object.entries(lanes).map(([l, on]) => [l, String(on)]),
  );
  out.full = String(!narrow);
  for (const name of Object.keys(scope.matrices))
    out[`${name}-matrix`] = JSON.stringify(matrixFor(scope, name, pr));
  return out;
}

/**
 * The newest of `commits` (newest first, HEAD excluded) whose CI run concluded success. `greenShas`
 * is the set of head SHAs of the CI workflow's successful push runs on `next`; a workflow run is
 * successful only when its `CI OK` job is, so membership is the "CI OK success" test. Null when
 * none is green.
 */
export function findGreenAncestor(commits, greenShas) {
  const green = new Set(greenShas);
  return commits.find((c) => green.has(c)) ?? null;
}

/**
 * The newest ancestor of `head` (within ANCESTOR_LOOKBACK commits) on which the CI workflow's push
 * run on `next` succeeded, found with the GitHub API through `gh` (token: `actions: read`). Null
 * when there is none, or when git or the API cannot say; the caller then runs everything.
 */
export function greenAncestorOf({
  repo,
  head = "HEAD",
  cwd = process.cwd(),
  run = (cmd, args) =>
    execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
}) {
  try {
    const commits = run("git", [
      "rev-list",
      "-n",
      String(ANCESTOR_LOOKBACK + 1),
      head,
    ])
      .split("\n")
      .filter(Boolean)
      .slice(1);
    if (commits.length === 0) return null;
    const runs = run("gh", [
      "api",
      `repos/${repo}/actions/workflows/ci.yml/runs?branch=next&event=push&status=success&per_page=100`,
      "--jq",
      '.workflow_runs[] | select(.path == ".github/workflows/ci.yml" and .conclusion == "success") | .head_sha',
    ])
      .split("\n")
      .filter(Boolean);
    return findGreenAncestor(commits, runs);
  } catch {
    return null;
  }
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Changed files `base...head`, plus uncommitted ones when asked; null when git cannot say. Both
 * sides of a rename count (`--no-renames`: git's default lists only the new path, so a file moved
 * out of a lane's tree would leave that lane unchecked), and `-z` keeps a path with non-ASCII
 * characters from arriving C-quoted, which no lane prefix would match.
 */
export function changedFiles({
  base,
  head = "HEAD",
  worktree = false,
  cwd = process.cwd(),
}) {
  const diff = ["diff", "--name-only", "--no-renames", "-z"];
  try {
    const files = new Set(git([...diff, `${base}...${head}`], cwd).split("\0"));
    if (worktree)
      for (const f of git([...diff, "HEAD"], cwd).split("\0")) files.add(f);
    files.delete("");
    return [...files];
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
    const ref = arg(rest, "--ref") ?? process.env.GITHUB_REF ?? "";
    const head = arg(rest, "--head") ?? "HEAD";
    let files = null;
    let note = "";
    if (event === "pull_request" && base) files = changedFiles({ base, head });
    else if (event === "push" && ref === NEXT_REF) {
      const repo = arg(rest, "--repo") ?? process.env.GITHUB_REPOSITORY;
      const ancestor = repo ? greenAncestorOf({ repo, head }) : null;
      if (ancestor) files = changedFiles({ base: ancestor, head });
      note = ancestor
        ? ` since green ${ancestor.slice(0, 12)}`
        : " (no green ancestor)";
    }
    const out = ciOutputs(scope, { event, ref, files });
    const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
    if (rest.includes("--github-output")) {
      const file = process.env.GITHUB_OUTPUT;
      if (!file) throw new Error("--github-output needs GITHUB_OUTPUT");
      appendFileSync(file, `${lines.join("\n")}\n`);
    }
    process.stdout.write(
      `${event || "(no event)"}: ${files === null ? "every lane" : `${files.length} changed file(s)`}${note}\n${lines.join("\n")}\n`,
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
    "usage: ci-scope.mjs ci [--event <name>] [--ref <ref>] [--repo <owner/name>] [--base <rev>] [--head <rev>] [--github-output] | touches <lane> [--base <rev>] [--worktree]",
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
