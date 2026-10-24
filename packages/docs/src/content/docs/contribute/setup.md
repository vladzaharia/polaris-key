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

## Pre-commit hooks

`pnpm install` runs the `prepare` script, which sets up [husky](https://typicode.github.io/husky/)
git hooks automatically — no manual step. The committed `.husky/pre-commit` hook runs two
fast, fail-early guards before every commit:

```sh
pnpm gen --fast --check   # the cheap generators: corpus, service table, generators page
pnpm typecheck
```

It is intentionally lightweight — the full cross-language matrix runs in CI, not locally. For a
trivial or docs-only commit you can skip it with `git commit --no-verify`.

## Lint debt

Each language's lint ledger (`lint-debt.json` in its lane) holds the findings that existed when the lane was adopted, and only shrinks.
A new finding, or a recorded one the tool no longer reports, fails the lane's `tools/lint.sh check`, locally in `pnpm gate` and in CI.
Fix a finding, then re-record the ledger with `<lane script> record`, for example `sdks/python/tools/lint.sh record`.
Tool versions are pinned (the Swift lane to the 6.3 toolchain), and an upgrade is its own PR.

## 4. Fixture SQL for a product

For local fixtures, generate SQL from a product's files in `products/<slug>/`. This is a fixture tool only: it can't mint a sealed signing key or store product secret values, so a live product is registered through the console ([Register a product from its repo](/docs/build/manifest/register/)).

```sh title="Terminal"
pnpm --silent --filter @polaris-key/products gen-seed djdl > products/djdl/seed.sql
```

`--silent` keeps pnpm's banner off stdout, where it would become the first lines of the SQL.
