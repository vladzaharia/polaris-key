# @polaris-key/manifest

Parse and validate a product's `.pkey/` manifests (`product`, `schema`, `release`, `distribution`), and the JSON Schemas for them, for tooling and servers that read a product repo.

## Install

The `@polaris-key` scope is published only on Polaris Key's own feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/manifest
```

Yarn, Bun and private feeds are on [Install](https://key.plrs.im/docs/build/install/).

## Quick start

`parseManifest` takes the raw text of each `.pkey/` document, keyed by `schema`, `product`, `release` and `distribution` (JSON or YAML). It validates them as ingest does and returns the parsed manifest, or every error found.

```ts
import { readFileSync, existsSync } from "node:fs";
import { MANIFEST_DOCUMENTS, parseManifest } from "@polaris-key/manifest";

const files: Record<string, string> = {};
for (const name of MANIFEST_DOCUMENTS) {
  for (const ext of ["yaml", "yml", "json"]) {
    const path = `.pkey/${name}.${ext}`;
    if (existsSync(path)) {
      files[name] = readFileSync(path, "utf8");
      break;
    }
  }
}

const result = parseManifest(files);
if (!result.ok) {
  for (const message of result.errors) console.error(message);
  process.exit(1);
}
console.log(result.manifest.product.slug);
```

Other validators: `validateManifestDocuments` and `validateIngestDocuments` (which also requires `product` and `schema` to exist) take already-parsed documents and return `{ ok, errors, warnings }`, each message with `file`, `path` (a JSON pointer) and `code`. `validateReleaseDescriptor` checks the `pkey-release.json` that CI attaches to a release.

## Before you start

Most people author `.pkey/` files and never call this package: start with the manifest guide, and run `pkey validate` from the CLI.

- [The `.pkey/` manifest](https://key.plrs.im/docs/build/manifest/)
- [SDKs](https://key.plrs.im/docs/build/sdks/): to use a product's config and license in an app.

Depend on this package directly to validate manifests in your own tooling. The Worker (ingest), the CLI and the admin console do.

### JSON Schemas

The package ships a Draft 2020-12 schema for each document under `schemas/v1/`, for editor completion and inline errors:

| Document             | Schema                                      |
| -------------------- | ------------------------------------------- |
| `.pkey/product`      | `schemas/v1/product.schema.json`            |
| `.pkey/schema`       | `schemas/v1/schema.schema.json`             |
| `.pkey/release`      | `schemas/v1/release.schema.json`            |
| `.pkey/distribution` | `schemas/v1/distribution.schema.json`       |
| `pkey-release.json`  | `schemas/v1/release-descriptor.schema.json` |

After install they sit at `node_modules/@polaris-key/manifest/schemas/v1/`. Each schema's `$id` is also a public copy, for example `https://key.plrs.im/docs/schemas/v1/product.schema.json`. The TypeScript validators are authoritative; a schema cannot express cross-reference rules, so run `pkey validate` as well. [Editor setup](https://key.plrs.im/docs/build/manifest/json-schema/) wires them in.

## Docs

- [The `.pkey/` manifest](https://key.plrs.im/docs/build/manifest/)
- [Product manifest](https://key.plrs.im/docs/build/manifest/#the-files), [catalog entries](https://key.plrs.im/docs/build/manifest/catalog/#entries) and [release deliverables](https://key.plrs.im/docs/build/manifest/release/#release-deliverables-deliverablesapp-and-the-artifact-map); [distribution](https://key.plrs.im/docs/build/manifest/distribution/)
- [JSON Schema and editor setup](https://key.plrs.im/docs/build/manifest/json-schema/)
- [Validation codes](https://key.plrs.im/docs/reference/validation-codes/): every error and warning the validators emit.

## For agents

- [`AGENTS.md`](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md): conventions and commands for working in the repository.
- [This package's source and README](https://github.com/vladzaharia/polaris-key/tree/main/packages/shared-manifest#readme).

## Versions

Every `@polaris-key/*` package publishes at the platform's version, in lockstep with the server. Builds target Node >=22. The package is ESM only and depends on `yaml`, `@polaris-key/catalog` and `@polaris-key/protocol`.

## License

MIT.
