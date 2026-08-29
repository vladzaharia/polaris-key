---
sidebar:
  order: 3
title: "JSON Schema & editor setup"
description: "Machine-readable schemas for the .pkey/ manifest — editor completion, validation, and how the schemas stay honest."
---

The three `.pkey/` files are also validated against machine-readable [JSON
Schema](https://json-schema.org/) documents — one per file, Draft 2020-12 — so an editor can
offer completion and inline errors while you type, before `pkey validate` or a resync ever
runs. They ship inside the `@polaris-key/manifest` npm package:

| File              | Schema                           |
| ----------------- | -------------------------------- |
| `.pkey/product.*` | `schemas/v1/product.schema.json` |
| `.pkey/schema.*`  | `schemas/v1/schema.schema.json`  |
| `.pkey/release.*` | `schemas/v1/release.schema.json` |

`@polaris-key/manifest`'s `package.json` lists `schemas` alongside `dist` in its published
`files`, so installing the package for any reason — a direct dependency, or transitively
through `@polaris-key/cli` — puts real files at
`node_modules/@polaris-key/manifest/schemas/v1/*.schema.json`. Nothing needs to be downloaded
separately, and nothing needs network access to resolve.

## `$id` is an identifier, not a locator

Each schema's `$id` is `https://key.plrs.im/docs/schemas/v1/<name>.schema.json` — a real,
browsable copy of the file, mirrored onto this site's `public/schemas/v1/` at build time from
the same source. But `key.plrs.im/docs` sits behind the platform-admin session gate
(`packages/worker/src/docs.ts`); there is no public docs origin. An editor's JSON Schema
resolver cannot authenticate through that gate, so the `$id` exists for what JSON Schema uses
`$id` for — a stable, canonical name a schema can `$ref` and a human can cite — and not as
something a tool should ever try to fetch. Every real consumer (an editor, `pkey init`'s
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
    // …schema.json, release.json follow the same shape
  ],
  "yaml.schemas": {
    "./packages/shared-manifest/schemas/v1/product.schema.json": [
      "**/.pkey/product.yaml",
      "**/.pkey/product.yml",
    ],
    // …schema.{yaml,yml}, release.{yaml,yml} follow the same shape
  },
}
```

A product repo outside this monorepo wires the same two settings against
`node_modules/@polaris-key/manifest/schemas/v1/<name>.schema.json` instead of a path into this
repo's `packages/`. Any other `yaml-language-server`-backed editor (Neovim, IntelliJ's YAML
plugin, …) reads the same two schema files; only the settings syntax differs.

### The headers `pkey init` emits

Running `pkey init` (`@polaris-key/cli`, `packages/cli/README.md`) scaffolds
`.pkey/product.yaml`, and `schema.yaml`/`release.yaml` when those services are
selected, each opening with a `yaml-language-server` directive that points straight at the
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

`validateManifestDocuments` (the TypeScript validator in `@polaris-key/manifest`) is
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

Because of that guarantee, "the schema didn't catch it" is meaningful information on its own —
it means the mistake needs a full `pkey validate` or a push to catch, not that the schema is
merely out of date.
