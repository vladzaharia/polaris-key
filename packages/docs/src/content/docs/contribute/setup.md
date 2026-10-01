---
title: "Setup"
description: "Install the JS workspace, the Python SDK, and the Swift and Godot toolchains, then run the green gate before opening a PR."
sidebar:
  order: 2
---

Several toolchains, one repo. The JS workspace (`pnpm` + `turbo`) covers `packages/*`, `tools`,
`products`, and the Node conformance runner; Python, Swift and Godot are standalone toolchains
under `sdks/`, installed separately.

## Install

```sh
pnpm install                                   # JS workspace (Node 22 — see below)
( cd sdks/python && python3 -m venv .venv && \
  .venv/bin/pip install -e ".[dev]" )          # Python SDK (add ",keyring" for the extra)
# Swift uses the system toolchain (macOS 14+, Swift 6); no install step.
# Godot: Godot 4.4+ on PATH, or set GODOT_BIN (sdks/godot/README.md); no install step.
```

## Node must be 22

`engines` pins `>=22` and CI runs 22, but the constraint is sharper than a version range: the
worker suite drives D1 through the native `better-sqlite3`, which does not build against a
newer Node major. When that happens the whole worker package fails to **collect** rather than
failing a test — every worker suite reports as missing, which reads like an unrelated breakage
rather than a toolchain mismatch. If your default Node is newer, prefix every command:

```sh
mise exec node@22 -- pnpm test
```

## The green-gate commands

Run these before opening a PR — they are what CI runs (`.github/workflows/ci.yml`), plus
`pnpm format`, which CI does not run because `pnpm lint` already covers the source files:

```sh
pnpm build                       # build all JS packages (turbo)
pnpm gen:corpus -- --check       # conformance drift gate (must regenerate in place)
pnpm gen:transcripts -- --check  # HTTP-transcript drift gate (re-records through the Worker router)
pnpm gen:services -- --check     # service-table drift gate (tools/services.json → every language)
pnpm parity:check                # every SDK's parity.json agrees with the feature registry
pnpm typecheck
pnpm test                        # all JS/TS suites (worker, SDKs, admin, conformance, shared)
pnpm lint                        # per-package prettier check
pnpm --filter @polaris-key/admin build
pnpm --filter @polaris-key/worker assemble  # admin + docs built into the worker's [assets] root
pnpm --filter @polaris-key/docs check:links # internal link + anchor integrity on the built site

# The workerd smoke job. Node permits the runtime code generation workerd forbids, so a green
# `pnpm test` cannot prove the Worker runs in the runtime it ships to.
pnpm --filter @polaris-key/worker typecheck:workerd
pnpm --filter @polaris-key/worker test:workerd

( cd sdks/python && .venv/bin/python -m pytest -q )   # Python (ubuntu + macOS in CI)
( cd sdks/swift && swift build && swift test )        # Swift
sdks/godot/tools/run_tests.sh    # Godot (set GODOT_TEMPLATE to add the exported-pack run)

pnpm format                      # prettier check over md/json too (format:fix to apply)
```

Or run the whole cross-language suite in one shot:

```sh
pnpm test:all                    # turbo test + Python pytest + Swift swift test + Godot runner
```

The Godot runner needs an editor binary and exits 2 without one; it never skips. CI runs it on
the 4.7.2 editor, on an exported pack under the official 4.7.2 Linux release template, and on
the 4.4.1 editor (the floor).

`pnpm build` does not typecheck the Worker — esbuild strips types on the way through — so
`pnpm typecheck` is never redundant with it, even though both are "just building."

## Pre-commit hooks

`pnpm install` runs the `prepare` script, which sets up [husky](https://typicode.github.io/husky/)
git hooks automatically — no manual step. The committed `.husky/pre-commit` hook runs three
fast, fail-early guards before every commit:

```sh
pnpm gen:corpus -- --check       # conformance drift gate
pnpm gen:services -- --check     # service-table drift gate
pnpm typecheck
```

It is intentionally lightweight — the full cross-language matrix runs in CI, not locally. For a
trivial or docs-only commit you can skip it with `git commit --no-verify`.
