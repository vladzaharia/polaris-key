#!/usr/bin/env node
/**
 * Commit-time lint of what is staged (.husky/pre-commit runs it first). Plain Node, no
 * dependencies. It catches the slips that otherwise cost a CI cycle: a prettier diff, a ktlint or
 * detekt finding, ruff E501, a gdlint line length, a swift-format warning. These are the checks
 * `pnpm gate` runs over the whole tree (tools/gate.mjs), narrowed to the staged files:
 *
 *   - prettier --check --ignore-unknown on every staged file (it skips what it does not own);
 *   - for each SDK with staged source files, its `tools/lint.sh check --files <list>`, which lints
 *     only those files and holds them to the same shrink-only ledger (lint-debt.json) as the
 *     whole-tree run, so a staged file with old debt passes and a new finding fails.
 *
 * On failure it prints the exact command that fixes it and exits 1. The linters read the working
 * tree, so a file staged in part is checked as it is on disk.
 *
 *   node tools/lint-staged.mjs [--files <path>...]   (--files replaces `git diff --cached`; for tests)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The SDK lanes: which staged paths a lane lints (the trees its lint.sh reads), the tool its
 * lint.sh needs, and how to fix what it reports.
 */
export const SDKS = [
  {
    id: "python",
    owns: (f) => /^sdks\/python\/.+\.py$/.test(f),
    needs: "sdks/python/.venv/bin/ruff",
    setup:
      'cd sdks/python && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"',
    fix: (files) =>
      `sdks/python/.venv/bin/ruff check --fix ${files.join(" ")}   (E501 and mypy findings are fixed by hand)`,
  },
  {
    id: "kotlin",
    probe: ["java", "-version"],
    setup: "install a JDK 17 and put java on PATH",
    owns: (f) => /^sdks\/kotlin\/.+\/src\/[^/]+\/kotlin\/.+\.kt$/.test(f),
    needs: null,
    fix: (files) =>
      `java -jar sdks/kotlin/build/lint-tools/ktlint-cli-1.8.0-all.jar -F ${files.map((f) => f.replace(/^sdks\/kotlin\//, "sdks/kotlin/")).join(" ")}   (detekt findings are fixed by hand)`,
  },
  {
    id: "godot",
    owns: (f) => /^sdks\/godot\/(addons\/polaris_key|tests)\/.+\.gd$/.test(f),
    needs: null,
    fix: (files) =>
      `sdks/godot/.lint-venv/bin/gdformat ${files.join(" ")}   (line length and naming are fixed by hand)`,
  },
  {
    id: "swift",
    owns: (f) => /^sdks\/swift\/(Sources|Tests)\/.+\.swift$/.test(f),
    needs: null,
    mode: "check-or-skip",
    fix: (files) =>
      `swift format format -i --configuration sdks/swift/.swift-format ${files.join(" ")}`,
  },
];

/** Staged files that exist (added, copied, modified, renamed). */
export function stagedFiles(cwd = ROOT) {
  const r = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git diff --cached failed: ${r.stderr}`);
  return r.stdout.split("\0").filter(Boolean);
}

/** The SDK lanes a set of files needs, each with its files. */
export function lanesFor(files) {
  return SDKS.map((s) => ({ ...s, files: files.filter(s.owns) })).filter(
    (s) => s.files.length > 0,
  );
}

const quote = (f) => (/^[\w./@+-]+$/.test(f) ? f : JSON.stringify(f));

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

function main(argv) {
  const at = argv.indexOf("--files");
  const files = at >= 0 ? argv.slice(at + 1) : stagedFiles();
  if (files.length === 0) return 0;
  const failures = [];

  const p = run("pnpm", [
    "exec",
    "prettier",
    "--check",
    "--ignore-unknown",
    "--log-level",
    "warn",
    ...files,
  ]);
  if (p.status !== 0)
    failures.push(
      `prettier: unformatted files above. Fix with:\n    pnpm exec prettier --write --ignore-unknown ${files.map(quote).join(" ")}`,
    );

  const dir = mkdtempSync(join(tmpdir(), "lint-staged-"));
  try {
    for (const lane of lanesFor(files)) {
      const missing = lane.needs
        ? existsSync(join(ROOT, lane.needs))
          ? null
          : lane.needs
        : lane.probe &&
            spawnSync(lane.probe[0], lane.probe.slice(1), { stdio: "ignore" })
              .status !== 0
          ? lane.probe[0]
          : null;
      if (missing) {
        process.stderr.write(
          `lint-staged: ${lane.id} lint NOT run (${missing} is missing); CI runs it. Set it up: ${lane.setup}\n`,
        );
        continue;
      }
      const list = join(dir, `${lane.id}.txt`);
      writeFileSync(list, `${lane.files.join("\n")}\n`);
      const r = run(`sdks/${lane.id}/tools/lint.sh`, [
        lane.mode ?? "check",
        "--files",
        list,
      ]);
      if (r.status !== 0)
        failures.push(
          `${lane.id}: lint failed above (${lane.files.length} staged file(s)). Fix with:\n    ${lane.fix(lane.files.map(quote))}\n  then re-check: sdks/${lane.id}/tools/lint.sh check`,
        );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(
      `\nlint-staged: ${failures.length} check(s) failed.\n\n${failures.join("\n\n")}\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main(process.argv.slice(2));
