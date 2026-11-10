#!/usr/bin/env node
/**
 * The one CI scope (P0-43): which lanes a change needs, and each matrix's pull-request and main
 * shapes, read from tools/ci-scope.json. `.github/workflows/ci.yml`'s `changes` job and `pnpm gate`
 * (tools/gate.mjs) both ask this script, so a lane runs for the same files in CI and in the local gate.
 *
 *   node tools/ci-scope.mjs ci [--event <name>] [--base <rev>] [--head <rev>] [--github-output]
 *       print (or append to $GITHUB_OUTPUT) `<lane>=true|false` for every lane, `full`, `full-run`,
 *       `js-base` and `<matrix>-matrix=<json>` for every matrix. The event defaults to
 *       $GITHUB_EVENT_NAME. Two runs narrow: a pull_request (to the files changed against its base)
 *       and a push to `next` (per lane: to the files changed since THAT lane's newest green
 *       ancestor, see laneBases); both run the floor and latest of each matrix. Every other event
 *       (a push to main, a tag, a dispatch) runs every lane and the full matrices, and so does a
 *       push to `next` whose ancestry, API or diff cannot be read, or a lane with no green ancestor
 *       (the lanes, not the matrices).
 *   node tools/ci-scope.mjs replay [--count <n>] [--head <rev>]
 *       for each of the last <n> (default 70) commits reachable from <rev> (default HEAD), print
 *       how many lanes the change since its first parent turns on (a measurement of the scope
 *       map: a lint-ledger-only commit should print js only).
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

/** The integration branch whose pushes narrow, per lane, to the files changed since its green base. */
export const NEXT_REF = "refs/heads/next";
/** How many commits of HEAD's ancestry are walked for a lane's green base (a bound, not a window). */
export const ANCESTRY_LIMIT = 1000;
/** How many of the newest push runs on `next` are read for their job conclusions. */
export const RUN_LIMIT = 100;

/** `*` is the only wildcard: any run of characters (a matrix name's rendered part). */
export function globMatch(glob, name) {
  const re = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`).test(name);
}

/** The `jobs` group (a lane, `js`, or `always`) a ci.yml job display name belongs to, or null. */
export function groupOfJob(scope, name) {
  for (const [group, globs] of Object.entries(scope.jobs))
    if (globs.some((g) => globMatch(g, name))) return group;
  return null;
}

/** The groups whose green base is tracked: every lane that has jobs in ci.yml, and `js`. */
export function trackedGroups(scope) {
  return Object.entries(scope.jobs)
    .filter(([g, globs]) => g !== "always" && globs.length > 0)
    .map(([g]) => g);
}

/**
 * Which groups were green in one CI run, from its jobs (`{ name, conclusion }`). A group is green
 * when it has jobs and each concluded success, or, for a lane (not `js`, which always runs), when
 * each was skipped and the `changes` job succeeded: the lane was left out because nothing it reads
 * changed since a base on which it was green, so it is green here too. Anything else (a failure, a
 * cancellation, a job that never finished, a group the run has no job for) is not green.
 */
export function greenGroups(scope, jobs) {
  const changesOk = jobs.some(
    (j) =>
      groupOfJob(scope, j.name) === "always" &&
      /^Changes\b/.test(j.name) &&
      j.conclusion === "success",
  );
  const out = {};
  for (const g of trackedGroups(scope)) {
    const mine = jobs.filter((j) => groupOfJob(scope, j.name) === g);
    out[g] =
      mine.length > 0 &&
      (mine.every((j) => j.conclusion === "success") ||
        (g !== "js" &&
          changesOk &&
          mine.every((j) => j.conclusion === "skipped")));
  }
  return out;
}

/**
 * Each tracked group's base: the newest of `commits` (newest first, HEAD excluded) on which the
 * group was green (greenGroups). `jobsOf(sha)` returns that commit's CI run's jobs, or null when it
 * has no run; it is called lazily and the walk stops once every group has a base. A group with no
 * green commit gets null, and then always runs.
 */
export function laneBases(scope, commits, jobsOf) {
  const groups = trackedGroups(scope);
  const bases = Object.fromEntries(groups.map((g) => [g, null]));
  let open = groups.length;
  for (const sha of commits) {
    if (open === 0) break;
    const jobs = jobsOf(sha);
    if (!jobs) continue;
    const green = greenGroups(scope, jobs);
    for (const g of groups)
      if (bases[g] === null && green[g]) {
        bases[g] = sha;
        open -= 1;
      }
  }
  return bases;
}

/** The base a lane is measured against: its own group's, or the js group's for a lane with no ci.yml job. */
const baseGroup = (scope, lane) =>
  (scope.jobs[lane] ?? []).length > 0 ? lane : "js";

/**
 * The `changes` job's outputs: lane flags, `full`, `js-base` and one JSON matrix per matrix.
 * A pull request with known `files` narrows to their lanes and the pull-request matrices; its
 * `js-base` is empty. A push to `next` (`ref` is refs/heads/next) with `push` (`{ bases, files }`:
 * each tracked group's green base and the files changed since it, null when unknown) narrows each
 * lane to the files changed since its own base, on the FULL matrices; a lane without a base, or
 * whose diff is unknown, runs. `js-base` is the js group's base when every file changed since it is
 * under `packages/`, else empty. A push to main, a tag, a manual run and a push to `next` with no
 * `push` or no base at all run every lane and the full matrices. `full` is "false" exactly when
 * lanes are narrowed, which is when `ci-ok` may count a skipped lane as passed. Every push to
 * `next` takes the pull-request matrices (the floor and the latest of each); the full matrices run
 * on main, on a tag and on a dispatch (the nightly, and the run before a tag). `full-run` is "true"
 * only for those.
 */
export function ciOutputs(scope, { event, ref, files, push }) {
  const lanes = Object.keys(scope.lanes);
  const pr = event === "pull_request" && files !== null && files !== undefined;
  const nextPush = event === "push" && ref === NEXT_REF;
  const next = nextPush && !!push && Object.values(push.bases).some(Boolean);
  const on = pr
    ? selectLanes(scope, files)
    : next
      ? Object.fromEntries(
          lanes.map((l) => {
            const g = baseGroup(scope, l);
            const f = push.files[g];
            return [l, !push.bases[g] || !f ? true : selectLanes(scope, f)[l]];
          }),
        )
      : selectLanes(scope, null);
  const out = Object.fromEntries(
    Object.entries(on).map(([l, v]) => [l, String(v)]),
  );
  out.full = String(!(pr || next));
  // A full RUN is one that checks every lane on the full matrices: a push to main, a tag or a
  // dispatch. A push to `next` never is, even when no lane has a base (every lane runs then, on the
  // pull-request matrices), so `require-ci-ok.sh` can tell the run a tag needs from a push.
  out["full-run"] = String(!(pr || nextPush));
  const jsFiles = next ? push.files.js : null;
  out["js-base"] =
    next &&
    push.bases.js &&
    jsFiles &&
    jsFiles.every((f) => f.startsWith("packages/"))
      ? push.bases.js
      : "";
  for (const name of Object.keys(scope.matrices))
    out[`${name}-matrix`] = JSON.stringify(
      matrixFor(scope, name, pr || nextPush),
    );
  return out;
}

/**
 * Every tracked group's green base for `head`, from the GitHub API through `gh` (token: `actions:
 * read`): the ancestry from `git rev-list`, the newest RUN_LIMIT push runs of the CI workflow on
 * `next`, and each consulted run's job conclusions (a lane that passed inside a failed or
 * cancelled run counts). Null when git or the API cannot say; the caller then runs everything.
 */
export function greenBasesOf({
  scope,
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
      String(ANCESTRY_LIMIT + 1),
      head,
    ])
      .split("\n")
      .filter(Boolean)
      .slice(1);
    if (commits.length === 0) return null;
    const runIds = new Map();
    const listed = run("gh", [
      "api",
      `repos/${repo}/actions/workflows/ci.yml/runs?branch=next&event=push&per_page=${RUN_LIMIT}`,
      "--jq",
      '.workflow_runs[] | select(.path == ".github/workflows/ci.yml") | [.head_sha, (.id | tostring)] | @tsv',
    ])
      .split("\n")
      .filter(Boolean);
    for (const line of listed) {
      const [sha, id] = line.split("\t");
      if (sha && id && !runIds.has(sha)) runIds.set(sha, id);
    }
    const jobsOf = (sha) => {
      const id = runIds.get(sha);
      if (!id) return null;
      return run("gh", [
        "api",
        "--paginate",
        `repos/${repo}/actions/runs/${id}/jobs?per_page=100&filter=latest`,
        "--jq",
        '.jobs[] | [.name, (.conclusion // "")] | @tsv',
      ])
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const i = l.lastIndexOf("\t");
          return { name: l.slice(0, i), conclusion: l.slice(i + 1) };
        });
    };
    return laneBases(scope, commits, jobsOf);
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
    let push = null;
    let note = "";
    if (event === "pull_request" && base) files = changedFiles({ base, head });
    else if (event === "push" && ref === NEXT_REF) {
      const repo = arg(rest, "--repo") ?? process.env.GITHUB_REPOSITORY;
      const bases = repo ? greenBasesOf({ scope, repo, head }) : null;
      if (bases) {
        const diffs = new Map();
        const filesOf = (sha) => {
          if (!diffs.has(sha))
            diffs.set(sha, changedFiles({ base: sha, head }));
          return diffs.get(sha);
        };
        push = {
          bases,
          files: Object.fromEntries(
            Object.entries(bases).map(([g, sha]) => [
              g,
              sha ? filesOf(sha) : null,
            ]),
          ),
        };
        note = ` bases ${Object.entries(bases)
          .map(([g, sha]) => `${g}@${sha ? sha.slice(0, 8) : "none"}`)
          .join(" ")}`;
      } else note = " (green bases unreadable)";
    }
    const out = ciOutputs(scope, { event, ref, files, push });
    const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
    if (rest.includes("--github-output")) {
      const file = process.env.GITHUB_OUTPUT;
      if (!file) throw new Error("--github-output needs GITHUB_OUTPUT");
      appendFileSync(file, `${lines.join("\n")}\n`);
    }
    process.stdout.write(
      `${event || "(no event)"}: ${out.full === "true" ? "every lane" : files ? `${files.length} changed file(s)` : "per-lane diffs"}${note}\n${lines.join("\n")}\n`,
    );
    return 0;
  }
  if (cmd === "replay") {
    const count = Number(arg(rest, "--count") ?? 70);
    const head = arg(rest, "--head") ?? "HEAD";
    const shas = git(
      ["rev-list", "--first-parent", "-n", String(count), head],
      process.cwd(),
    )
      .split("\n")
      .filter(Boolean);
    let full = 0;
    for (const sha of shas) {
      const files = changedFiles({ base: `${sha}^`, head: sha });
      const on = Object.entries(selectLanes(scope, files))
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (on.length === Object.keys(scope.lanes).length) full += 1;
      process.stdout.write(
        `${sha.slice(0, 10)} ${files === null ? "?" : files.length} file(s): ${on.length === Object.keys(scope.lanes).length ? "every lane" : on.join(",") || "js only"}\n`,
      );
    }
    process.stdout.write(
      `${full} of ${shas.length} commit(s) turn every lane on\n`,
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
    "usage: ci-scope.mjs ci [--event <name>] [--ref <ref>] [--repo <owner/name>] [--base <rev>] [--head <rev>] [--github-output] | replay [--count <n>] [--head <rev>] | touches <lane> [--base <rev>] [--worktree]",
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
