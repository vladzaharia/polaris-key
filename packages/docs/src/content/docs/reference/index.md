---
title: "Reference"
description: "The generated reference tables — extracted from source on every regeneration, byte-compared in CI, never hand-maintained."
sidebar:
  order: 0
---

Every page in this section is **generated** — `packages/docs/scripts/gen-reference.mjs` reads
the real source (validator code, protocol constants, migrations, the OpenAPI spec, the
conformance corpus, the parity registry and manifests) and a freshness test byte-compares each
committed page against a fresh run, so these tables cannot drift from the code they describe.
Regenerate with `pnpm --filter @polaris-key/docs gen`; never edit them by hand. The settings
reference is the exception to the emitter: `pnpm gen settings` writes it from the settings
registry, and the worker suite byte-compares it. The generators page is written by
`pnpm gen registry-docs` from `tools/generators.ts`.

| Page                                                                  | Extracted from                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Manifest validation codes](/docs/reference/validation-codes/)        | every emit site in `validateManifestDocuments`               |
| [ConfigEntry — the catalog item shape](/docs/reference/config-entry/) | `@polaris-key/catalog`'s types, verbatim                     |
| [Wire error codes](/docs/reference/error-codes/)                      | the protocol taxonomy + the worker's `ErrorCode` map         |
| [Fingerprint constants](/docs/reference/fingerprint-constants/)       | the frozen formulas the corpus pins                          |
| [Public route table](/docs/reference/routes/)                         | the OpenAPI spec (itself coverage-tested against the router) |
| [D1 data model](/docs/reference/data-model/)                          | the migrations, replayed to the live schema                  |
| [Conformance corpus v2](/docs/reference/corpus/)                      | the corpus files themselves                                  |
| [SDK parity matrix](/docs/reference/parity/)                          | the feature registry and every SDK's `parity.json`           |
| [Settings reference](/docs/reference/settings/)                       | the settings registry (`pnpm gen settings`)                  |
| [Generators](/docs/reference/generators/)                             | the generator registry (`pnpm gen registry-docs`)            |
