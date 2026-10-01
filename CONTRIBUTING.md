# Contributing to Polaris Key

Polaris Key is a **contract-first, five-language** monorepo: one Cloudflare Worker plus SDKs
for Node, Python, Swift, and React, all agreeing on a single frozen wire format. The most
important rule follows from that: **the wire contract is the source of truth, and every
language must verify it identically.** Read the canonical glossary —
`packages/docs/src/content/docs/start/concepts.md`, served at `/docs/start/concepts/` — for
terminology before naming anything.

## Setup

```sh
pnpm install                                   # JS workspace (Node 22 — see below)
( cd sdks/python && python3 -m venv .venv && \
  .venv/bin/pip install -e ".[dev]" )          # Python SDK (add ",keyring" for the extra)
# Swift uses the system toolchain (macOS 14+, Swift 6); no install step.
# Godot: Godot 4.4+ on PATH, or set GODOT_BIN (sdks/godot/README.md); no install step.
```

**Use Node 22.** `engines` pins `>=22` and CI runs 22, but the constraint is sharper than that:
the worker suite drives D1 through the native `better-sqlite3`, which does not build on a newer
Node major — the whole worker package then fails to collect rather than failing a test. If your
default is newer, prefix commands: `mise exec node@22 -- pnpm test`.

## The green-gate commands

Run these before opening a PR — they are what CI runs (`.github/workflows/ci.yml`), plus
`pnpm format`, which CI does not run because `pnpm lint` already covers the source files:

```sh
pnpm build                       # build all JS packages (turbo)
pnpm gen:corpus -- --check       # conformance drift gate (must regenerate in place)
pnpm gen:transcripts -- --check  # HTTP-transcript drift gate (re-records through the Worker router)
pnpm gen:services -- --check     # service-table drift gate (tools/services.json → every language)
pnpm gen:constants -- --check    # SDK-constants drift gate (error codes, headers, enums, feature ids)
pnpm --filter @polaris-key/cli bundle:action -- --check  # Action-bundle drift gate (after pnpm build)
pnpm parity:check                # every SDK's parity.json agrees with the feature registry
pnpm typecheck
pnpm test                        # all JS/TS suites (worker, SDKs, admin, conformance, shared)
pnpm lint                        # per-package prettier check
pnpm --filter @polaris-key/admin build

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

## Pre-commit hooks

`pnpm install` runs the `prepare` script, which sets up [husky](https://typicode.github.io/husky/)
git hooks automatically — no manual step. The committed `.husky/pre-commit` hook runs three
fast, fail-early guards before every commit:

```sh
pnpm gen:corpus -- --check       # conformance drift gate
pnpm gen:services -- --check     # service-table drift gate
pnpm typecheck
```

It is intentionally lightweight (the full five-language matrix runs in CI, not locally). For a
trivial or docs-only commit you can skip it with `git commit --no-verify`.

## More on the docs site

This file covers what you need to get a change past the gate. The rest — the full monorepo map
and the Worker's internal boundaries, the contract-first wave model and its drift gates, the
conformance corpus, and how releases actually ship — lives on the docs site's Contribute
section, gated to platform admins (sign in at `/manage`; see the [README](README.md#documentation)):

- [Setup](https://key.plrs.im/docs/contribute/setup/) — this page's content, with more
  toolchain detail.
- [Monorepo layout](https://key.plrs.im/docs/contribute/layout/) — the full map, the Worker's
  `core/` + `services/<slug>/` split, `boundaries.test.ts`, and `mount.ts` as the composition
  root.
- [The contract-first wave model](https://key.plrs.im/docs/contribute/waves/) — contract →
  catalog → corpus → SDKs, the five-language walkthrough for a wire-visible field, and the full
  drift-gate inventory.
- [The conformance corpus](https://key.plrs.im/docs/contribute/corpus/) — the generator, the
  language runners, the generator-owned mirrors (Swift, Godot), and how to add a case.
- [Releasing](https://key.plrs.im/docs/contribute/releasing/) — the Changesets flow, the
  Python/Swift tag releases, and how the worker deploys.

## Pull-request checklist

- [ ] Green gate passes, including the workerd smoke job (`test:workerd`), not just `pnpm test`.
- [ ] Wire-affecting? Corpus regenerated (`pnpm gen:corpus -- --check` green) — never hand-edited.
- [ ] New manifest validation rule? Add its entry to the schema-parity mutation table.
- [ ] New route? Added to the OpenAPI spec and the route-coverage table.
- [ ] Reference sources changed (migrations, routes, protocol constants)? Regenerate docs:
      `pnpm --filter @polaris-key/docs gen`.
- [ ] Naming matches the canonical glossary (`/docs/start/concepts/`).
