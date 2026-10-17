---
title: "Set up your editor"
description: "Get completion and inline errors for .pkey/ files from the published JSON Schemas."
type: "how-to"
lastReviewed: "2026-10-16"
sidebar:
  order: 6
  label: "Set up your editor"
---

Each `.pkey/` file has a JSON Schema (Draft 2020-12), so an editor can complete fields and flag mistakes before `pkey validate` runs. The schemas ship in the `@polaris-key/manifest` package.

**Requires:** a `.pkey/` directory, and an editor with JSON Schema support. For YAML in VS Code, install the YAML extension (`redhat.vscode-yaml`).

## The schemas

| File                   | Schema                                |
| ---------------------- | ------------------------------------- |
| `.pkey/product.*`      | `schemas/v1/product.schema.json`      |
| `.pkey/schema.*`       | `schemas/v1/schema.schema.json`       |
| `.pkey/release.*`      | `schemas/v1/release.schema.json`      |
| `.pkey/distribution.*` | `schemas/v1/distribution.schema.json` |

A fifth, `schemas/v1/release-descriptor.schema.json`, describes the [release descriptor](/docs/features/ship-builds/releases/artifacts/#the-release-descriptor) CI attaches to a release. It is not a `.pkey/` file.

## Steps

1. **CLI** Scaffold with `pkey init`. Each YAML file it writes opens with a `yaml-language-server` header that points at the package copy, so completion works with no editor setup once `@polaris-key/manifest` is in the repo's `node_modules`, directly or through `@polaris-key/cli`.

   ```yaml title=".pkey/product.yaml"
   # yaml-language-server: $schema=../node_modules/@polaris-key/manifest/schemas/v1/product.schema.json
   ```

   You should see field completion and inline errors when you edit the file.

2. **CLI** If the repo has no `node_modules`, such as a Godot project, write the schemas into a folder and point the header at it.

   ```sh title="Terminal"
   pkey manifest schemas --out .pkey/schemas
   ```

   You should see the five schema files in `.pkey/schemas`. Change the header's path to `schemas/product.schema.json`.

3. **Editor** For JSON files, or to match by path instead of by header, map each schema to its files in VS Code's `json.schemas` and `yaml.schemas` settings.

   ```jsonc title=".vscode/settings.json"
   {
     "json.schemas": [
       {
         "fileMatch": ["**/.pkey/product.json"],
         "url": "./node_modules/@polaris-key/manifest/schemas/v1/product.schema.json",
       },
     ],
     "yaml.schemas": {
       "./node_modules/@polaris-key/manifest/schemas/v1/product.schema.json": [
         "**/.pkey/product.yaml",
         "**/.pkey/product.yml",
       ],
     },
   }
   ```

   Repeat the pair for `schema`, `release` and `distribution`. Other editors backed by `yaml-language-server` read the same schema files; only the settings syntax differs.

   You should see the same completion for `.pkey/product.json` and `.pkey/product.yaml`.

## What the schemas catch

The validator behind `pkey validate`, link and resync is authoritative. The schemas cover what JSON Schema can say about one document. A rule that crosses documents, such as a tier that names an unknown profile, is not in the schema: an editor stays quiet, and `pkey validate` or a resync reports it. A schema that accepts a mistake is information, not a stale schema.

An old spelling of a field is accepted and marked `deprecated`, so the editor strikes it through. [Deprecated spellings](/docs/build/manifest/product/#deprecated-spellings) lists them, and `pkey validate --fix` moves each to its canonical place.

## If it isn't working

- The header path is relative to the file, so a `.pkey/` in a subfolder needs more `../`.
- A schema's `$id` is a name, not an address an editor fetches. Point at the file.
- [Manifest validation codes](/docs/reference/validation-codes/): every error and warning.

## Next steps

- [Register a product from its repo](/docs/build/manifest/register/)
- [The .pkey/ manifest](/docs/build/manifest/)
