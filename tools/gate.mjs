#!/usr/bin/env node
/**
 * `pnpm gate` (AX-04): the green gate, scoped to what a branch changes. Plain Node ESM with no
 * dependencies, because step 1 is the install and the gate must run before `node_modules` exists.
 *
 *   pnpm gate [dir] [--base <rev>] [--full] [--only <n|id,…>] [--from <n|id>] [--plan]
 *
 * Scope is the one CI scope (tools/ci-scope.mjs over ci-scope.json): the lanes a diff turns on, as
 * ci.yml's `changes` job computes them. By default the gate is scoped; `--full` runs every step.
 * A skipped step keeps its number, so `--only` and `--from` mean the same on every branch.
 * Each step that fails runs once more on its own; the second failure prints the rerun lines.
 *
 * Machine-specific parts are environment hooks, all off by default:
 *   PKEY_GATE_BASE     the base revision (default `main`, then `origin/main`)
 *   PKEY_GATE_HEAVY    a command prefixed to the heavy steps (godot, admin-e2e)
 *   PKEY_GATE_SLOTS    at most this many gates run their test steps at once on the machine
 *   PKEY_TEST_TIMEOUT  the Godot runner's per-step limit (default 900)
 *   VITEST_MAX_WORKERS vitest workers per package (default 4)
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, loadScope, selectLanes } from "./ci-scope.mjs";

const PY = "sdks/python/.venv/bin/python";
const TURBO_TEST = "--filter=!@polaris-key/conformance-browser";

/** `--filter=...[sha]` once the merge base is known and something changed; otherwise nothing. */
const filter = (ctx) =>
  !ctx.full && ctx.mergeBase && ctx.files && ctx.files.length > 0
    ? [`--filter=...[${ctx.mergeBase}]`]
    : [];

/**
 * The gate's steps, in order. `lane` is a ci-scope.json lane (null: always runs). `argv(ctx)` is
 * the scoped command and `argvFull(ctx)` the full one (default: the same); an `argv` that returns
 * null has nothing to do. `cwd` is relative to the root; `pre` runs first; `heavy` steps take the
 * PKEY_GATE_HEAVY prefix; `slot` steps wait for a PKEY_GATE_SLOTS slot; `fullOnly` steps run only
 * with `--full`. The numbers are fixed (gate.sh's, 1-17); new steps are appended.
 */
export const STEPS = [
  {
    n: 1,
    id: "install",
    title: "Install",
    lane: null,
    argv: () => ["pnpm", "install", "--frozen-lockfile"],
  },
  {
    n: 2,
    id: "build",
    title: "Build",
    lane: null,
    argv: (c) => ["pnpm", "exec", "turbo", "run", "build", ...filter(c)],
    argvFull: () => ["pnpm", "build"],
  },
  {
    n: 3,
    id: "docs-build",
    title: "Docs site build, from clean",
    lane: "docs",
    // Astro's render cache can replay pages naming a stale stylesheet.
    pre: (root) => {
      for (const d of [
        "packages/docs/.astro",
        "packages/docs/node_modules/.astro",
      ])
        rmSync(join(root, d), { recursive: true, force: true });
    },
    argv: () => [
      "pnpm",
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=@polaris-key/docs",
      "--force",
    ],
  },
  {
    n: 4,
    id: "gen",
    title: "Generator drift gate",
    lane: null,
    argv: (c) =>
      c.mergeBase && c.files
        ? ["pnpm", "gen", "--changed", "--check", "--base", c.mergeBase]
        : ["pnpm", "gen", "--check"],
    argvFull: () => ["pnpm", "gen", "--check"],
  },
  {
    n: 5,
    id: "typecheck",
    title: "Typecheck",
    lane: null,
    argv: (c) => ["pnpm", "exec", "turbo", "run", "typecheck", ...filter(c)],
  },
  {
    n: 6,
    id: "test",
    title: "JS/TS test suites (turbo)",
    lane: null,
    slot: true,
    argv: (c) => [
      "pnpm",
      "turbo",
      "run",
      "test",
      "--concurrency=4",
      TURBO_TEST,
      ...filter(c),
    ],
  },
  {
    n: 7,
    id: "lint",
    title: "Prettier on the changed files",
    lane: null,
    argv: (c) =>
      c.mergeBase && c.files
        ? c.existing.length > 0
          ? [
              "pnpm",
              "exec",
              "prettier",
              "--check",
              "--ignore-unknown",
              ...c.existing,
            ]
          : null
        : ["pnpm", "lint"],
    argvFull: () => ["pnpm", "lint"],
  },
  {
    n: 8,
    id: "admin-build",
    title: "Admin SPA build",
    lane: "workerd",
    argv: () => ["pnpm", "--filter", "@polaris-key/admin", "build"],
  },
  {
    n: 9,
    id: "assemble",
    title: "Worker assets assemble",
    lane: "workerd",
    argv: () => ["pnpm", "--filter", "@polaris-key/worker", "assemble"],
  },
  {
    n: 10,
    id: "check-links",
    title: "Docs link and anchor integrity",
    lane: "docs",
    argv: () => ["pnpm", "--filter", "@polaris-key/docs", "check:links"],
  },
  {
    n: 11,
    id: "workerd-typecheck",
    title: "Worker typecheck for workerd",
    lane: "workerd",
    argv: () => [
      "pnpm",
      "--filter",
      "@polaris-key/worker",
      "typecheck:workerd",
    ],
  },
  {
    n: 12,
    id: "workerd-test",
    title: "Worker tests in workerd",
    lane: "workerd",
    argv: () => ["pnpm", "--filter", "@polaris-key/worker", "test:workerd"],
  },
  {
    n: 13,
    id: "python",
    title: "Python SDK tests",
    lane: "python",
    // A fresh worktree has no venv; make one instead of failing the gate.
    pre: (root, run) => {
      if (existsSync(join(root, PY))) return;
      run(["python3", "-m", "venv", "sdks/python/.venv"]);
      run([PY, "-m", "pip", "-q", "install", "-e", "sdks/python[dev,keyring]"]);
    },
    argv: () => [PY, "-m", "pytest", "-q", "sdks/python"],
  },
  {
    n: 14,
    id: "swift",
    title: "Swift SDK tests",
    lane: "swift-floor",
    cwd: "sdks/swift",
    argv: () => ["swift", "test"],
  },
  {
    n: 15,
    id: "godot",
    title: "Godot SDK tests",
    lane: "godot",
    heavy: true,
    argv: () => ["sdks/godot/tools/run_tests.sh"],
  },
  {
    n: 16,
    id: "format",
    title: "Prettier over md/json too",
    lane: null,
    fullOnly: true,
    argv: () => ["pnpm", "format"],
  },
  {
    n: 17,
    id: "admin-e2e",
    title: "Console and portal e2e",
    lane: "console",
    heavy: true,
    argv: () => ["pnpm", "--filter", "@polaris-key/admin", "test:e2e"],
  },
  // P0-46: the lint lanes, each against its committed ledger (lint-debt.json).
  {
    n: 18,
    id: "lint-ts",
    title: "TypeScript lint: knip and duplicate code",
    lane: null,
    argv: () => ["bash", "-c", "pnpm lint:knip && pnpm lint:dupes"],
  },
  {
    n: 19,
    id: "lint-python",
    title: "Python lint: ruff and mypy",
    lane: "python",
    argv: () => ["sdks/python/tools/lint.sh", "check"],
  },
  {
    n: 20,
    id: "lint-swift",
    title: "Swift lint: swift-format (Swift 6.3 only)",
    lane: "swift-floor",
    // swift-format is the toolchain's, pinned to 6.3: the script exits 2 on any other toolchain, which
    // is not a finding. Skip with a note locally; CI selects Xcode 26.6 and runs it for real.
    argv: () => [
      "bash",
      "-c",
      'sdks/swift/tools/lint.sh check; rc=$?; if [ "$rc" -eq 2 ]; then echo "lint-swift skipped: needs the Swift 6.3 toolchain (sdks/swift/tools/select-xcode-26.sh); CI runs it."; exit 0; fi; exit "$rc"',
    ],
  },
  {
    n: 21,
    id: "lint-kotlin",
    title: "Kotlin lint: ktlint and detekt",
    lane: "kotlin",
    heavy: true,
    argv: () => ["sdks/kotlin/tools/lint.sh", "check"],
  },
  {
    n: 22,
    id: "lint-godot",
    title: "Godot lint: gdlint",
    lane: "godot",
    argv: () => ["sdks/godot/tools/lint.sh", "check"],
  },
];

/** Lanes some step runs locally; every other lane that is on is left to CI. */
export const LOCAL_LANES = [
  ...new Set(STEPS.map((s) => s.lane).filter(Boolean)),
];

/** Parse the command line. Throws on an unknown flag or step. */
export function parseFlags(argv, env = {}) {
  const f = {
    dir: undefined,
    base: env.PKEY_GATE_BASE || undefined,
    full: false,
    only: [],
    from: undefined,
    plan: false,
    help: false,
  };
  const args = argv.filter((a) => a !== "--");
  const value = (i, name) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--"))
      throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--full") f.full = true;
    else if (a === "--plan" || a === "--dry-run") f.plan = true;
    else if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--base") f.base = value(i++, a);
    else if (a === "--only")
      f.only.push(...value(i++, a).split(",").filter(Boolean).map(stepNumber));
    else if (a === "--from") f.from = stepNumber(value(i++, a));
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (f.dir === undefined && i === 0) f.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return f;
}

/** A step number from `3` or an id (`docs-build`). */
export function stepNumber(s) {
  const step = STEPS.find((x) => String(x.n) === s || x.id === s);
  if (!step)
    throw new Error(
      `unknown step "${s}" (${STEPS.map((x) => `${x.n}=${x.id}`).join(", ")})`,
    );
  return step.n;
}

/**
 * Which steps run for a set of changed files. `files` is the changed paths, or null when they
 * cannot be read (every lane runs, as in CI). Returns `{steps: [{...step, run, reason}], lanes}`.
 */
export function plan(files, flags = {}, scope = loadScope()) {
  const lanes = selectLanes(scope, flags.full ? null : files);
  const only = flags.only ?? [];
  const steps = STEPS.map((s) => {
    let run = true;
    let reason = s.lane ? `${s.lane} lane` : "always";
    if (s.fullOnly && !flags.full) {
      run = false;
      reason = "only with --full (prettier already checked the changed files)";
    } else if (s.lane && !flags.full && !lanes[s.lane]) {
      run = false;
      reason = `branch does not touch the ${s.lane} lane`;
    } else if (flags.full) reason = "--full";
    if (run && only.length > 0 && !only.includes(s.n)) {
      run = false;
      reason = "not in --only";
    } else if (run && only.length === 0 && flags.from && s.n < flags.from) {
      run = false;
      reason = `before --from ${flags.from}`;
    }
    return { ...s, run, reason };
  });
  return { steps, lanes };
}

/** Lanes that are on but have no local step: what CI also runs. */
export function ciAlsoRuns(lanes) {
  return Object.keys(lanes).filter((l) => lanes[l] && !LOCAL_LANES.includes(l));
}

/** The command for a step, with the heavy prefix applied. null: nothing to do. */
export function commandFor(step, ctx, env = {}) {
  const argv = ctx.full && step.argvFull ? step.argvFull(ctx) : step.argv(ctx);
  if (!argv) return null;
  const heavy = step.heavy && env.PKEY_GATE_HEAVY?.trim();
  return heavy ? [...heavy.split(/\s+/), ...argv] : argv;
}

const FAIL_LINES = /FAIL|✗|×|Error:|AssertionError|failed \(|error:/;

/**
 * Run the planned steps. `io` is `{run(argv, {cwd}) -> {status, output}, log(line), slots}`, so a
 * test can fake the commands. Returns the exit code; each failing step is retried once on its own.
 */
export function runSteps(planned, ctx, io, env = {}) {
  let slotHeld = false;
  try {
    for (const step of planned) {
      if (!step.run) {
        io.log(`=== [${step.n}] ${step.id} skipped (${step.reason})`);
        continue;
      }
      if (step.slot && !slotHeld && io.acquire) {
        io.acquire();
        slotHeld = true;
      }
      io.log(`=== [${step.n}] ${step.id}: ${step.title}`);
      step.pre?.(ctx.root, (argv) => io.run(argv, { cwd: ctx.root }));
      const argv = commandFor(step, ctx, env);
      if (!argv) {
        io.log(`    nothing to check`);
        continue;
      }
      const opts = { cwd: step.cwd ? join(ctx.root, step.cwd) : ctx.root };
      let r = io.run(argv, opts);
      if (r.status === 0) continue;
      io.log(
        `--- [${step.n}] failed; retrying once on its own. First attempt's failures:`,
      );
      for (const l of r.output
        .split("\n")
        .filter((l) => FAIL_LINES.test(l) && !/^\s*✓/.test(l))
        .slice(0, 20))
        io.log(`    ${l}`);
      r = io.run(argv, opts);
      if (r.status === 0) {
        io.log(`--- [${step.n}] passed on retry (likely timing)`);
        continue;
      }
      for (const l of r.output.split("\n").slice(-60)) io.log(l);
      const fl = ctx.full ? " --full" : "";
      io.log(`FAILED: [${step.n}] ${step.id}: ${argv.join(" ")}`);
      io.log(
        `Fix it, then rerun just this step:   pnpm gate${fl} --only ${step.n}`,
      );
      io.log(
        `...or continue from it:              pnpm gate${fl} --from ${step.n}`,
      );
      return 1;
    }
    return 0;
  } finally {
    if (slotHeld) io.release?.();
  }
}

// ── the real runner ───────────────────────────────────────────────────────────────────────────

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The merge base of HEAD with `base` (default `main`, then `origin/main`), or null. */
export function mergeBaseOf(root, base) {
  for (const b of base ? [base] : ["main", "origin/main"]) {
    const sha = git(["merge-base", "HEAD", b], root);
    if (sha) return sha;
  }
  return null;
}

/** Changed files since the merge base, uncommitted and untracked included; null when unknown. */
export function changedSince(root, mergeBase) {
  if (!mergeBase) return null;
  const files = changedFiles({ base: mergeBase, worktree: true, cwd: root });
  if (!files) return null;
  const untracked = git(["ls-files", "--others", "--exclude-standard"], root);
  return [
    ...new Set([
      ...files,
      ...(untracked ? untracked.split("\n").filter(Boolean) : []),
    ]),
  ];
}

/** A mkdir-lock slot pool under the OS temp dir, reclaiming a dead holder's slot. */
export function slotPool(max, dir = join(tmpdir(), "pk-gate-slots")) {
  let held = null;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  return {
    acquire() {
      mkdirSync(dir, { recursive: true });
      for (;;) {
        for (let i = 1; i <= max; i++) {
          const slot = join(dir, String(i));
          try {
            mkdirSync(slot);
            writeFileSync(join(slot, "pid"), String(process.pid));
            held = slot;
            return;
          } catch {
            let pid = NaN;
            try {
              pid = Number(readFileSync(join(slot, "pid"), "utf8"));
            } catch {
              /* the holder may not have written its pid yet */
            }
            if (Number.isFinite(pid) && !alive(pid))
              rmSync(slot, { recursive: true, force: true });
          }
        }
        spawnSync("sleep", ["5"]);
      }
    },
    release() {
      if (held) rmSync(held, { recursive: true, force: true });
      held = null;
    },
  };
}

const HELP = `usage: pnpm gate [dir] [--base <rev>] [--full] [--only <n|id,…>] [--from <n|id>] [--plan]
  --base <rev>   diff against the merge base with <rev> (default main, then origin/main; PKEY_GATE_BASE)
  --full         run every step, as CI does on main
  --only <list>  run just these steps (numbers or ids)
  --from <step>  skip the steps before this one
  --plan         print the numbered steps with run or skip and the reason, then exit 0
steps:\n${STEPS.map((s) => `  ${String(s.n).padStart(2)} ${s.id.padEnd(18)} ${s.lane ?? "always"}`).join("\n")}`;

export function main(argv, env = process.env) {
  const flags = parseFlags(argv, env);
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  const rootAbs = resolve(process.cwd(), flags.dir ?? ".");
  const mergeBase = flags.full ? null : mergeBaseOf(rootAbs, flags.base);
  const files = flags.full ? null : changedSince(rootAbs, mergeBase);
  const existing = (files ?? []).filter((f) => existsSync(join(rootAbs, f)));
  const { steps, lanes } = plan(files, flags);
  const ctx = { root: rootAbs, mergeBase, files, existing, full: flags.full };
  const scopeLine = flags.full
    ? "scope: full"
    : files === null
      ? "scope: changed files unknown, every lane runs"
      : `scope: ${files.length} changed file(s) since ${mergeBase.slice(0, 9)}`;
  console.log(scopeLine);
  const ciRest = ciAlsoRuns(
    flags.full ? selectLanes(loadScope(), null) : lanes,
  );
  const tail = () =>
    console.log(
      ciRest.length > 0
        ? `CI also runs: ${ciRest.join(", ")} (no local step)`
        : "CI also runs: nothing beyond these steps",
    );
  if (flags.plan) {
    for (const s of steps)
      console.log(
        `${String(s.n).padStart(2)}. ${s.id.padEnd(18)} ${s.run ? "run " : "skip"}  ${s.reason}`,
      );
    tail();
    return 0;
  }
  const childEnv = {
    ...env,
    PKEY_TEST_TIMEOUT: env.PKEY_TEST_TIMEOUT || "900",
    VITEST_MAX_WORKERS: env.VITEST_MAX_WORKERS || "4",
  };
  const slots =
    Number(env.PKEY_GATE_SLOTS) > 0
      ? slotPool(Number(env.PKEY_GATE_SLOTS))
      : null;
  const onExit = () => slots?.release();
  process.on("SIGINT", () => (onExit(), process.exit(130)));
  process.on("SIGTERM", () => (onExit(), process.exit(143)));
  const io = {
    log: (l) => console.log(l),
    run: (argv, { cwd }) => {
      const r = spawnSync(argv[0], argv.slice(1), {
        cwd,
        env: childEnv,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
      });
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `Error: ${r.error.message}\n` : ""}`;
      return { status: r.status ?? 1, output };
    },
    acquire: slots?.acquire,
    release: slots?.release,
  };
  const code = runSteps(steps, ctx, io, env);
  if (code === 0) console.log(`GATE GREEN (${scopeLine})`);
  tail();
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(
      `gate: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exitCode = 2;
  }
}
