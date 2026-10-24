# Contributing to Polaris Key

Polaris Key is a **contract-first, seven-language** monorepo: one Cloudflare Worker plus SDKs
for Node, React, Python, Swift, Godot and Kotlin, all agreeing on a single frozen wire format. The most
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
# Godot: Godot 4.4+ on PATH, or set GODOT_BIN (sdks/godot/CONTRIBUTING.md); no install step.
# Kotlin: JDK 17 (the Gradle wrapper fetches the rest); the Android modules also need an Android
# SDK (sdks/kotlin/README.md), which -Ppkey.jvmOnly=true skips.
```

**Use Node 22.** `engines` pins `>=22` and CI runs 22, but the constraint is sharper than that:
the worker suite drives D1 through the native `better-sqlite3`, which does not build on a newer
Node major — the whole worker package then fails to collect rather than failing a test. If your
default is newer, prefix commands: `mise exec node@22 -- pnpm test`.

## The green-gate commands

Run the gate before opening a PR:

```sh
pnpm gate            # scoped to the lanes your diff turns on (what a PR needs)
pnpm gate --full     # every step, every lane
pnpm gate --plan     # print the steps without running them
```

[`AGENTS.md`](AGENTS.md#the-green-gate) lists the steps. One of them is the drift gate, `pnpm gen --check`. A failed step reruns on
its own once; resume with `pnpm gate --only <n>` or `--from <n>`. CI runs every lane on `main`,
plus the browser runners, the UI kits and the Kotlin suites (`pnpm test:browser`,
`pnpm ui:lint`, `pnpm ui:report`, `./gradlew -Ppkey.jvmOnly=true …test` in `sdks/kotlin`).
`pnpm test:all` runs the cross-language suites in one shot.

## Pre-commit hooks

`pnpm install` runs the `prepare` script, which sets up [husky](https://typicode.github.io/husky/)
git hooks automatically — no manual step. The committed `.husky/pre-commit` hook runs two
fast, fail-early guards before every commit:

```sh
pnpm gen --fast --check   # the cheap generators: corpus, service table, generators page
pnpm typecheck
```

It is intentionally lightweight (the full six-language matrix runs in CI, not locally). For a
trivial or docs-only commit you can skip it with `git commit --no-verify`.

## More on the docs site

This file covers what you need to get a change past the gate. The rest — the full monorepo map
and the Worker's internal boundaries, the contract-first wave model and its drift gates, the
conformance corpus, and how releases actually ship — lives on the docs site's Contribute
section, gated to platform admins (sign in at `/manage`; see the [README](README.md#documentation)):

- [Setup](https://key.plrs.im/docs/contribute/setup/) — this page's content, with more
  toolchain detail.
- [Monorepo layout](https://key.plrs.im/docs/contribute/layout/) — the full map, the Worker's
  layers (`platform/`, `core/`, `services/<slug>/`, `console/`), `boundaries.test.ts`, and `mount.ts` as the composition
  root.
- [The contract-first wave model](https://key.plrs.im/docs/contribute/waves/) — contract →
  catalog → corpus → SDKs, the six-language walkthrough for a wire-visible field, and the full
  drift-gate inventory.
- [The conformance corpus](https://key.plrs.im/docs/contribute/corpus/) — the generator, the
  language runners, the generator-owned Godot mirror (Swift reads the corpus in place), and how to add a case.
- [Releasing](https://key.plrs.im/docs/contribute/releasing/) — every SDK published to its feed
  automatically, in lockstep with the server (each push to `main`, each `v*` tag), and how the
  worker deploys.

## Pull-request checklist

- [ ] Green gate passes, including the workerd smoke job (`test:workerd`), not just `pnpm test`.
- [ ] Wire-affecting? Corpus regenerated (`pnpm gen corpus --check` green) — never hand-edited.
- [ ] New manifest validation rule? Add its entry to the schema-parity mutation table.
- [ ] New route? Added to the OpenAPI spec and the route-coverage table.
- [ ] Reference sources changed (migrations, routes, protocol constants)? Regenerate docs:
      `pnpm --filter @polaris-key/docs gen`.
- [ ] Naming matches the canonical glossary (`/docs/start/concepts/`).
