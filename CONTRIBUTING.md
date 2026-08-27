# Contributing to Polaris Key

Polaris Key is a **contract-first, five-language** monorepo: one Cloudflare Worker plus SDKs
for Node, Python, Swift, and React, all agreeing on a single frozen wire format. The most
important rule follows from that: **the wire contract is the source of truth, and every
language must verify it identically.** Read `docs/CONCEPTS.md` for canonical terminology
before naming anything.

## Monorepo layout

```
packages/
  shared-protocol/   @polaris-key/protocol     per-service wire types (subpath exports)
  shared-jws/        @polaris-key/jws          frozen EdDSA compact-JWS encode/verify
  shared-catalog/    @polaris-key/catalog      data-driven config catalog + Ajv validation
  shared-manifest/   @polaris-key/manifest     `.pkey/` manifest parsing + validation
  client-core/       @polaris-key/client-core  isomorphic verify/trust/gate/clock floor
  worker/            @polaris-key/worker       the Cloudflare Worker (multi-tenant)
  admin/             @polaris-key/admin        the admin SPA (React + Vite)
  cli/               @polaris-key/cli          the `pkey` CLI (manifests, bundle mint)
  sdk-node/          @polaris-key/node         full client + CLI adapters
  sdk-react/         @polaris-key/react        browser-OIDC + desktop-over-node + login UI
sdks/
  python/            polaris-key (PyPI)        full client + CLI adapters
  swift/             PolarisKey (SwiftPM)      native CryptoKit + SwiftUI login
conformance/         corpus/v2 (one signer's golden vectors) + the Node runner
tools/               sign-corpus.ts · gen-mirrors.ts
products/            per-product data (catalog.json + product.json) + gen-seed
docs/                CONCEPTS · ADOPTER-GUIDE · CONFIG-AUTHORING · RUNBOOK · DEPLOYMENT
                     security/ (threat model, wire contract v3, audit + findings)
```

The JS workspace (`pnpm` + `turbo`) covers `packages/*`, `tools`, `products`, and the Node
conformance runner. Python and Swift are standalone toolchains under `sdks/`.

Inside the Worker, `src/core/` is the always-on substrate and each `src/services/<slug>/` is
one opt-in service (`license`, `config`, `release`, `update`, `identity`). A service may import
`core/`, itself, and shared packages; the only sanctioned cross-service import is
`services/update → services/release`. Anything else goes through a Core-mediated interface —
that boundary is what keeps the modular monolith split-ready. `src/mount.ts` is the composition
root: adding a service is one entry there plus its slug in `router.ts`'s `SERVICE_NAMESPACES`,
and Core never learns the name.

## Setup

```sh
pnpm install                                   # JS workspace (Node 22 — see below)
( cd sdks/python && python3 -m venv .venv && \
  .venv/bin/pip install -e ".[dev]" )          # Python SDK (add ",keyring" for the extra)
# Swift uses the system toolchain (macOS 14+, Swift 6); no install step.
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

pnpm format                      # prettier check over md/json too (format:fix to apply)
```

Or run the whole cross-language suite in one shot:

```sh
pnpm test:all                    # turbo test + Python pytest + Swift swift test
```

## Pre-commit hooks

`pnpm install` runs the `prepare` script, which sets up [husky](https://typicode.github.io/husky/)
git hooks automatically — no manual step. The committed `.husky/pre-commit` hook runs two
fast, fail-early guards before every commit:

```sh
pnpm gen:corpus -- --check       # conformance drift gate
pnpm typecheck
```

It is intentionally lightweight (the full five-language matrix runs in CI, not locally). For a
trivial or docs-only commit you can skip it with `git commit --no-verify`.

## The contract-first, wave-based development model

Features land in **waves**, each a thin slice through the whole stack so that no language is
ever left behind. The wire format is **frozen** — changing the encoding is a deliberate,
all-languages event, not a side effect. The ordering within a wave is always **contract →
catalog → corpus → SDKs**:

1. **Protocol / wire (`shared-protocol`, `shared-jws`, `client-core`).** If the change touches
   the wire, update the types/encoding here first. Encoding changes are rare and must keep the
   JWS byte-stable (header key order, base64url, raw 32-byte Ed25519 keys — see the root
   `README.md`). Client-side verification, trust merge, the gate and the clock floor live in
   `client-core` and are implemented **once**: Node and React consume them, Python and Swift
   mirror them, and the corpus proves the mirrors agree.
2. **Catalog (`shared-catalog`, `products/<slug>`).** Product config is **data**. Add or
   change `ConfigEntry`s in the product's catalog (`docs/CONFIG-AUTHORING.md`), not in code.
3. **Corpus regen (`pnpm gen:corpus`).** Re-sign the golden vectors so every runner has
   something to verify (below).
4. **SDKs verify against the corpus.** Implement the change in each SDK and prove parity by
   running its conformance runner. A feature is not "done" until all five languages pass.

Because behavior is centralized (e.g. each SDK's CLI has a single command **core** that the
argparse/click/typer or commander/yargs front ends wrap), you change behavior in one place
per language and the front ends follow.

## Adding a feature, keeping five languages in sync

Concretely, to add a config key or a wire-visible capability:

1. **Protocol** — add the field/type in `shared-protocol`, in the service module that owns it
   (`/core`, `/license`, `/config`, `/release`, `/update`, `/trust`); touch `shared-jws` only
   if the encoding changes, and `client-core` if verification or the gate has to understand the
   new field. Keep it backward-tolerant (SDKs ignore unknown fields).
2. **Catalog** — declare the key in the product catalog (`products/<slug>/catalog.json` or the
   product's `.pkey/schema`). Pick `kind` + `managementDefault`; add `ui`/`dependsOn` hints.
3. **Regenerate the corpus** — `pnpm gen:corpus` (re-sign vectors). For products that want
   typed config mirrors, also run `pnpm gen:mirrors -- --catalog <catalog.json> --out-dir <mirror-dir>`
   (TS/Python/Swift mirrors from the catalog).
4. **Implement in each SDK** — Node (`packages/sdk-node`), Python (`sdks/python`), Swift
   (`sdks/swift`), React (`packages/sdk-react`), and the Worker. Mirror the existing surface
   and the layered-config precedence (`enforced|hidden > local > env > remote-default >
fallback`).
5. **Verify parity** — run every conformance runner + the SDK test suites (the green-gate
   commands). Update the relevant README(s) and `docs/`.

## The conformance corpus + drift gate

`conformance/corpus/v2/` is **one signer's** golden output — encoded docs + expected verify
outcomes — that **every** SDK and the Worker verify byte-for-byte. It is how five independent
implementations agree on the wire. Three files, one directory, so a runner can point at
`corpus/v2/` and find everything it needs: `cases.json` (JWS, license/config documents, trust
manifests, clock-floor sequences, offline bundles), `gate-matrix.json`, and
`fingerprint.json`. There is exactly one corpus — v1 was deleted with wire contract v2, so
there is no dual-shape ambiguity for a runner to pick the wrong side of.

- `tools/sign-corpus.ts` (run via `pnpm gen:corpus`) regenerates all three from a fixed keypair
  and a fixed case list, then copies them into `sdks/swift/Tests/PolarisKeyTests/Resources/v2/`
  — the Swift test target cannot reach up the monorepo at test time, so it gets a mirror the
  generator owns rather than a hand-kept translation. `pnpm gen:corpus -- --check` is the
  **drift gate**: it regenerates in memory and fails if any committed file differs, mirror
  included. A red drift job means a wire-affecting change wasn't reflected in the corpus —
  regenerate and commit it in the same PR.
- The Node runner is `conformance/runners/node`; Python and Swift read the corpus from their
  own test suites. All assert byte-identical verify outcomes. Never edit the generated files
  by hand; never weaken a runner to make a change "pass."

## Changesets release flow

JS SDKs are released with **Changesets**; Python (PyPI) and Swift (git tag) release from
their own tags.

1. Add a changeset describing user-facing changes: `pnpm changeset` (pick the affected
   `@polaris-key/*` packages + a semver bump; writes a markdown file under `.changeset/`).
2. On merge to `main`, `.github/workflows/release.yml` opens/maintains a **"Version
   Packages"** PR (`pnpm version-packages` bumps versions + writes changelogs).
3. Merging that PR runs `pnpm changeset publish` to publish the JS SDKs to the registry.

Keep changesets focused: one logical change per changeset, written for consumers (the "why").

## Pull-request checklist

- [ ] Naming matches `docs/CONCEPTS.md` (device not machine, product not app, …).
- [ ] Wire-affecting? Corpus regenerated (`pnpm gen:corpus -- --check` green) + all runners pass.
- [ ] Product config changes are **data** (catalog / `.pkey/`), not hard-coded keys.
- [ ] Behavior changed in the shared core (`client-core`, or the Worker's `src/core/`), not
      duplicated across CLI/UI front ends or reached for across a service boundary.
- [ ] Green gate passes: `pnpm test:all` + `pnpm typecheck` + `pnpm lint` + `pnpm format`.
- [ ] Docs/READMEs updated; a changeset added for any published-package change.
