---
title: "The contract-first wave model"
description: "Contract before catalog before corpus before SDKs, a five-language walkthrough for a wire-visible field, and the full drift-gate inventory."
sidebar:
  order: 4
  label: "Waves"
---

Features land in **waves**, each a thin slice through the whole stack so that no language is
ever left behind. The wire format is **frozen** — changing the encoding is a deliberate,
all-languages event, not a side effect of shipping a feature. Within a wave, the ordering is
always the same: **contract → catalog → corpus → SDKs.**

## The four steps

1. **Protocol / wire** (`shared-protocol`, `shared-jws`, `client-core`). If the change touches
   the wire, update the types and encoding here first. Encoding changes are rare and must keep
   the JWS byte-stable — protected-header key order, the base64url alphabet, raw 32-byte
   Ed25519 keys. Verification, trust merge, the gate, and the clock floor live in `client-core`
   and are implemented **once**: Node and React consume them directly, Python and Swift mirror
   them, and the corpus proves the mirrors agree.
2. **Catalog** (`shared-catalog`, `products/<slug>`). Product config is **data**. Add or change
   `ConfigEntry`s in the product's catalog, not in code — see
   [ConfigEntry — the catalog item shape](/docs/reference/config-entry/) for the field
   reference.
3. **Corpus regen** (`pnpm gen:corpus`). Re-sign the golden vectors so every runner has
   something new to verify against — see [The conformance corpus](/docs/contribute/corpus/).
4. **SDKs verify against the corpus.** Implement the change in each SDK and prove parity by
   running its conformance runner. A feature is not "done" until all five languages pass.

Because behavior is centralized — each SDK's CLI has a single **core** command that the
argparse/click/typer or commander/yargs front end wraps — a behavior change happens in one
place per language, and the front ends follow without their own copy of the logic.

## Adding a wire-visible field, in five languages

Concretely, to add a config key or any wire-visible capability:

1. **Protocol** — add the field or type in `shared-protocol`, in the service module that owns
   it (`core`, `license`, `config`, `release`, `update`, `trust`). Touch `shared-jws` only if
   the encoding itself changes, and `client-core` if verification or the gate has to understand
   the new field. Keep it backward-tolerant: SDKs ignore unknown fields.
2. **Catalog** — declare the key in the product catalog (`products/<slug>/catalog.json` or the
   product's `.pkey/schema`). Pick a `kind` and a `managementDefault`; add `ui`/`dependsOn`
   hints as needed.
3. **Regenerate the corpus** — `pnpm gen:corpus` re-signs the vectors. For products that want
   typed config mirrors, also run
   `pnpm gen:mirrors -- --catalog <catalog.json> --out-dir <mirror-dir>` (TS/Python/Swift
   mirrors generated from the catalog).
4. **Implement in each SDK** — Node (`packages/sdk-node`), Python (`sdks/python`), Swift
   (`sdks/swift`), React (`packages/sdk-react`), and the Worker. Mirror the existing surface and
   the layered-config precedence: `enforced|hidden` beats `local`, which beats `env`, which
   beats `remote-default`, which beats `fallback`.
5. **Verify parity** — run every conformance runner plus the SDK test suites, i.e. the
   green-gate commands in [Setup](/docs/contribute/setup/). Update the relevant READMEs and
   docs pages.

## The drift-gate inventory

Six automated gates keep generated and hand-written material from silently disagreeing. All six
run as ordinary test suites — nothing here is a separate CI concept, just `pnpm test` (and, for
two of them, a prior `pnpm build`) catching a specific class of staleness.

| Gate                          | Command                                                                  | What it catches                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conformance corpus            | `pnpm gen:corpus -- --check`                                             | A wire-affecting change not reflected in `conformance/corpus/v2/{cases.json,gate-matrix.json,fingerprint.json}` or the Swift test-resource mirror. Regenerates in memory; fails on any committed-file difference.                                                                                             |
| Schema ↔ validator parity     | `pnpm test` — `packages/shared-manifest/test/schema-parity.test.ts`      | The published JSON Schemas (`schemas/v1/*.schema.json`) drifting from `validateManifestDocuments` — a valid fixture rejected by one side, or a new validator error code with no mutation-table entry.                                                                                                         |
| Route coverage                | `pnpm test` — `packages/worker/test/routeCoverage.test.ts`               | A router route with no OpenAPI entry, a spec path with no router route, or an unclassified new `Route` kind — checked in all three directions.                                                                                                                                                                |
| Docs CSP parity               | `pnpm build && pnpm test` — `packages/worker/test/docsCspParity.test.ts` | The committed `docsCsp.generated.ts` hash set going stale against a fresh sweep of the built docs HTML — e.g. a Starlight upgrade adding a new inline `<script>` or `<style>`. Skips cleanly when `packages/docs/dist` is absent; always live in CI, since the docs build runs before the worker tests there. |
| Generated-reference freshness | `pnpm test` — `packages/docs/test/generated.test.ts`                     | A hand edit to a generated `reference/*.mdx` page, or a source change (a new validation code, migration, route, or protocol constant) without regenerating via `pnpm --filter @polaris-key/docs gen`.                                                                                                         |
| Docs-slugs link gate          | `pnpm build && pnpm test` — `packages/worker/test/docsLinks.test.ts`     | A console help link (`route.ts`'s nav `docs` fields, or `docsLinks.ts`'s `DOCS_LINKS`) pointing at a page that no longer exists, or a link that isn't an absolute, trailing-slash `/docs/…` path. Same skip/CI-live behavior as the CSP gate.                                                                 |

The last two both read the built site's slug manifest (`packages/docs/dist/docs-slugs.json`,
written at the end of `pnpm --filter @polaris-key/docs build`), so a docs-only checkout with no
prior build sees them skip rather than fail — they are not silently disabled, just not yet
meaningful to run.
