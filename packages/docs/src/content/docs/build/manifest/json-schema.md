---
sidebar:
  order: 4
title: "JSON Schema & editor setup"
description: "Machine-readable schemas for the .pkey/ manifest — editor completion, validation, and how the schemas stay honest."
---

The four `.pkey/` files are also validated against machine-readable [JSON
Schema](https://json-schema.org/) documents — one per file, Draft 2020-12 — so an editor can
offer completion and inline errors while you type, before `pkey validate` or a resync ever
runs. They ship inside the `@polaris-key/manifest` npm package:

| File                   | Schema                                |
| ---------------------- | ------------------------------------- |
| `.pkey/product.*`      | `schemas/v1/product.schema.json`      |
| `.pkey/schema.*`       | `schemas/v1/schema.schema.json`       |
| `.pkey/release.*`      | `schemas/v1/release.schema.json`      |
| `.pkey/distribution.*` | `schemas/v1/distribution.schema.json` |

One more schema, `schemas/v1/release-descriptor.schema.json`, describes the **release
descriptor** CI attaches to a release as `pkey-release.json` — not a `.pkey/` file, but the
same package, the same parity rule against its validator (`validateReleaseDescriptor`), and
the same `$id` convention. See
[Artifacts](/docs/services/release/artifacts/#the-release-descriptor).

`@polaris-key/manifest`'s `package.json` lists `schemas` alongside `dist` in its published
`files`, so installing the package for any reason — a direct dependency, or transitively
through `@polaris-key/cli` — puts real files at
`node_modules/@polaris-key/manifest/schemas/v1/*.schema.json`. Nothing needs to be downloaded
separately, and nothing needs network access to resolve.

## `$id` is an identifier, not a locator

Each schema's `$id` is `https://key.plrs.im/docs/schemas/v1/<name>.schema.json` — a real,
browsable copy of the file, mirrored onto this site's `public/schemas/v1/` at build time from
the same source, and served publicly with the developer docs. Still, the `$id` exists for what
JSON Schema uses `$id` for — a stable, canonical name a schema can `$ref` and a human can cite —
and not as something a tool should ever have to fetch. Every real consumer (an editor, `pkey init`'s
scaffold headers, the parity test below) reads the file that ships in the npm package, by
**path**.

## Wiring an editor

**VS Code + the YAML extension** (`redhat.vscode-yaml`) reads two settings,
`json.schemas` and `yaml.schemas`, each mapping a schema file to the glob(s) it applies to.
This repo's own `.vscode/settings.json` wires both for `.pkey/` and for the `products/*`
fixtures that mirror it:

```jsonc
{
  "json.schemas": [
    {
      "fileMatch": ["**/.pkey/product.json", "products/*/product.json"],
      "url": "./packages/shared-manifest/schemas/v1/product.schema.json",
    },
    // …schema.json, release.json, distribution.json follow the same shape
  ],
  "yaml.schemas": {
    "./packages/shared-manifest/schemas/v1/product.schema.json": [
      "**/.pkey/product.yaml",
      "**/.pkey/product.yml",
    ],
    // …schema.{yaml,yml}, release.{yaml,yml}, distribution.{yaml,yml} follow the same shape
  },
}
```

A product repo outside this monorepo wires the same two settings against
`node_modules/@polaris-key/manifest/schemas/v1/<name>.schema.json` instead of a path into this
repo's `packages/`. Any other `yaml-language-server`-backed editor (Neovim, IntelliJ's YAML
plugin, …) reads the same two schema files; only the settings syntax differs.

### The headers `pkey init` emits

Running `pkey init` (`@polaris-key/cli`, `packages/cli/README.md`) scaffolds
`.pkey/product.yaml` and `schema.yaml` (always written, with `entries: []` unless the
`config` module is selected), plus `release.yaml` when `releases` is selected, each opening with a `yaml-language-server` directive that points straight at the
package copy with no editor configuration required at all:

```yaml
# yaml-language-server: $schema=../node_modules/@polaris-key/manifest/schemas/v1/product.schema.json
apiVersion: pkey.dev/v1
product:
  slug: "djdl"
  ...
```

The path climbs one level out of `.pkey/` into `node_modules` — where it resolves as long as
`@polaris-key/manifest` is a dependency of the product repo (directly, or transitively through
`@polaris-key/cli`) — rather than pointing at the gated `$id` URL, for the same reason the VS
Code settings above use a path.

## The parity-test guarantee

`validateManifestDocuments` and `validateIngestDocuments` (the TypeScript validators in
`@polaris-key/manifest`; the second adds the presence rules such as `missing_product`) are
**authoritative**; these schemas exist for editor completion and other machine consumers, and
nothing stops the two from drifting apart on their own. `packages/shared-manifest/test/schema-parity.test.ts`
is the drift gate, and it pins three properties on every CI run:

1. **Valid stays valid.** Every valid fixture — including the real `products/djdl/product.json`
   and `products/djdl/catalog.json` — passes _both_ the TypeScript validator and Ajv against
   the schemas.
2. **Every error code has a case.** A completeness sweep extracts every error code the
   validator's _source_ can emit and asserts a mutation-table entry exists for each one — a new
   validation rule added without a corresponding test case fails CI, not a future bug report.
3. **The schema catches what it claims to.** Each mutation is tagged `schema: "rejects"` (Ajv
   must also reject the mutated document) or `schema: "accepts"` (a validator-only rule — a
   cross-reference like "this tier names an unknown profile" — that JSON Schema's document-local
   validation genuinely cannot express). The `"accepts"` tag is a documented limitation, not a
   silent gap: an editor will not flag that mistake, `pkey validate` and a resync will.

The same suite checks every row of `DEPRECATED_SPELLINGS` (ST-19): the schemas still **accept**
each old spelling but mark its property `"deprecated": true`, with a description that starts
"Deprecated: write …", so an editor strikes it through; the validator warns on it at its own
path; and the parsed value is the one today's precedence picks. See
[Deprecated spellings](/docs/build/manifest/authoring/#deprecated-spellings).

Because of that guarantee, "the schema didn't catch it" is meaningful information on its own —
it means the mistake needs a full `pkey validate` or a push to catch, not that the schema is
merely out of date.
