---
title: "Set up the repo"
description: "Install the JS workspace, the Python SDK, and the Swift, Godot and Kotlin toolchains, then run the green gate before opening a PR."
sidebar:
  order: 2
type: "how-to"
lastReviewed: "2026-10-16"
---

Several toolchains, one repo. The JS workspace (`pnpm` + `turbo`) covers `packages/*`, `tools`,
`products`, and the Node conformance runner; Python, Swift, Godot and Kotlin are standalone
toolchains under `sdks/`, installed separately.

## Steps

1. Install the JS workspace, then the Python SDK. Swift, Godot and Kotlin use the toolchains on your machine.
2. Use Node 22 for every JS command.
3. Run the green gate before you open a PR.
4. Optional: generate fixture SQL for a product in `products/`.

## 1. Install

```sh
pnpm install                                   # JS workspace (Node 22 — see below)
( cd sdks/python && python3 -m venv .venv && \
  .venv/bin/pip install -e ".[dev]" )          # Python SDK (add ",keyring" for the extra)
# Swift uses the system toolchain (macOS 14+, Swift 6); no install step.
# Godot: Godot 4.4+ on PATH, or set GODOT_BIN (sdks/godot/CONTRIBUTING.md); no install step.
# Kotlin: JDK 17 (the Gradle wrapper fetches the rest); the Android modules also need an
# Android SDK, which -Ppkey.jvmOnly=true skips.
```

## 2. Node must be 22

`engines` pins `>=22` and CI runs 22, but the constraint is sharper than a version range: the
worker suite drives D1 through the native `better-sqlite3`, which does not build against a
newer Node major. When that happens the whole worker package fails to **collect** rather than
failing a test — every worker suite reports as missing, which reads like an unrelated breakage
rather than a toolchain mismatch. If your default Node is newer, prefix every command:

```sh
mise exec node@22 -- pnpm test
```

## 3. The green-gate commands

Run the gate before opening a PR:

```sh
pnpm gate            # scoped to the lanes your diff turns on (what a PR needs)
pnpm gate --full     # every step, every lane
pnpm gate --plan     # print the steps without running them
```

`AGENTS.md` in the repository lists the steps. One of them is the drift gate, `pnpm gen --check`. A failed step reruns on
its own once; resume with `pnpm gate --only <n>` or `--from <n>`. CI runs every lane on `main`,
plus the browser runners, the UI kits and the Kotlin suites (`pnpm test:browser`,
`pnpm ui:lint`, `pnpm ui:report`, `./gradlew -Ppkey.jvmOnly=true …test` in `sdks/kotlin`).
`pnpm test:all` runs the cross-language suites in one shot.

The Godot runner needs an editor binary and exits 2 without one; it never skips. CI runs it on
the 4.7.2 editor, on an exported pack under the official 4.7.2 Linux release template, and on
the 4.4.1 editor (the floor).

`pnpm build` does not typecheck the Worker — esbuild strips types on the way through — so
`pnpm typecheck` is never redundant with it, even though both build.

## Which lanes CI runs

`tools/ci-scope.json` is the one map of lanes to paths and to the `ci.yml` jobs each lane owns
(`jobs`); the `changes` job of `ci.yml` and `pnpm gate` both read it through
`tools/ci-scope.mjs`. A change under a `shared` path (the contract, the shared packages,
`ci.yml` and its actions, the scope map and the generator registry) runs every lane. A generator
or a lint ledger on its own is not shared: its outputs land in the lanes' directories, and the
always-on `js` jobs check the drift.

| Run                             | Lanes                                                     | Matrices                 |
| ------------------------------- | --------------------------------------------------------- | ------------------------ |
| pull request                    | the lanes the changed files touch                         | the floor and the latest |
| push to `next`                  | each lane: the files changed since its own green ancestor | full                     |
| push to `main`, tag, manual run | every lane                                                | full                     |

A push to `next` tracks green per lane. For each lane it walks HEAD's ancestry, newest first,
over the CI workflow's push runs on `next`, and takes the newest commit on which every job of the
lane concluded success (job conclusions, so a lane that passed inside a failed or canceled run
counts). That commit is the lane's base. The lane runs when a file changed since _its_ base is
one of its paths or a `shared` input, and always when it has no base. A fix push after a red
Python job therefore runs Python again and skips the lanes that were already green. When the
ancestry, the diff or the GitHub API cannot be read, every lane runs. The static checks (`js`)
and `CI OK` always run.

The `js-worker`, `js-admin` and `js-rest` test jobs also narrow: when every file changed since
the `js` base is under `packages/`, they run turbo for the changed packages and their dependents
only (`tools/ci-js-affected.mjs`), plus the Worker whenever `docs`, `admin` or `elements`
changed, because its tests read their files; any other change, such as a root file, `sdks/` or
`conformance/`, runs everything.

A narrowed run's `CI OK` means: every lane touched since its own base passed on this run, and
every other lane was green at its base. `CI OK` counts a skipped lane as passed only on a
narrowed run, which is sound because a lane is skipped only when it was green at its base; on a
full run a skipped job fails it. `deploy.yml`, `publish-sdks.yml` and `promote.yml` rely on
`CI OK` (`tools/require-ci-ok.sh`), and a narrowed `CI OK` on `next` is the same proof.

## Pre-commit hooks

`pnpm install` runs the `prepare` script, which sets up [husky](https://typicode.github.io/husky/)
git hooks automatically — no manual step. The committed `.husky/pre-commit` hook runs two
fast, fail-early guards before every commit:

```sh
node tools/lint-staged.mjs  # the staged files: prettier, and each SDK's own linter
pnpm gen --fast --check     # the cheap generators: corpus, service table, generators page
pnpm typecheck
```

`tools/lint-staged.mjs` runs `prettier --check` on the staged files and, for each SDK with staged
source, `sdks/<sdk>/tools/lint.sh check --files <list>` (ruff and mypy, ktlint and detekt,
gdlint, swift-format). It holds them to the same ledger as `pnpm gate`, so a file with old debt
passes and a new finding fails. A failure prints the command that fixes it. A linter whose tool
is not installed (no `sdks/python/.venv`, no JDK) says so and does not run; CI runs it. Swift
lints only on the 6.3 toolchain, as in the gate.

It is intentionally lightweight — the full cross-language matrix runs in CI, not locally. For a
trivial or docs-only commit you can skip it with `git commit --no-verify`.

## Lint debt

Each language's lint ledger (`lint-debt.json` in its lane) holds the findings that existed when the lane was adopted, and only shrinks.
A new finding, or a recorded one the tool no longer reports, fails the lane's `tools/lint.sh check`, locally in `pnpm gate` and in CI.
Fix a finding, then re-record the ledger with `<lane script> record`, for example `sdks/python/tools/lint.sh record`. TypeScript has no `lint.sh`: `pnpm lint:ts` checks it, and `pnpm lint:knip:record`, `node tools/lint/dupes.mjs record` and `pnpm lint:size:record` (the 800-line budget for `packages/worker/src`) re-record.
Tool versions are pinned (the Swift lane to the 6.3 toolchain), and an upgrade is its own PR.

## 4. Fixture SQL for a product

For local fixtures, generate SQL from a product's files in `products/<slug>/`. This is a fixture tool only: it can't mint a sealed signing key or store product secret values, so a live product is registered through the console ([Register a product from its repo](/docs/build/manifest/register/)).

```sh title="Terminal"
pnpm --silent --filter @polaris-key/products gen-seed djdl > products/djdl/seed.sql
```

`--silent` keeps pnpm's banner off stdout, where it would become the first lines of the SQL.
