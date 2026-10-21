# @polaris-key/catalog

The Polaris Key config catalog: the data model for a product's config, secret and flag entries, with a dependency-free Draft-07 subset interpreter for their values.

## Install

The `@polaris-key` scope is published only on Polaris Key's own feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/catalog
```

Yarn, Bun and private feeds are on [Install](https://key.plrs.im/docs/build/install/).

## Quick start

`Catalog` wraps a `ProductCatalog` (`schemaVersion` and `entries`). `compileAll()` rejects an entry whose schema the validator will not accept; `validateKeyValue` checks a value for a dotted key.

```ts
import { Catalog } from "@polaris-key/catalog";

const catalog = new Catalog({
  schemaVersion: 1,
  entries: [
    {
      key: "ui.theme",
      kind: "config",
      category: "Interface",
      label: "Theme",
      description: "The color theme.",
      schema: { type: "string", enum: ["light", "dark"] },
    },
  ],
});

catalog.compileAll(); // throws UnsupportedSchemaError on an unsupported fragment

console.log(catalog.validateKeyValue("ui.theme", "dark").ok); // true
const bad = catalog.validateKeyValue("ui.theme", "blue");
if (!bad.ok) console.log(bad.errors);
```

The validator interprets a Draft-07 subset and never generates code, so it runs in Cloudflare Workers. A keyword it does not implement makes the fragment unsupported; it is never ignored. `pattern` matches with a linear-time engine, and `MAX_*` limits bound schema depth and size, work per call and `uniqueItems` scans. Also exported: `prepareSchema`, `validatePrepared`, the cloud-sync helpers (`resolveCollection`, `syncedSettings`, `userSettingIssues`) and the representability checks (`representabilityIssue`).

## Before you start

Authors write the catalog as `.pkey/schema`, not as code; `@polaris-key/manifest` parses and validates that file, and the CLI's `pkey validate` runs it. To read values in an app, use an SDK.

- [Catalog entries in the manifest](https://key.plrs.im/docs/build/manifest/catalog/#entries): entries, kinds, schemas and management state.
- [SDKs](https://key.plrs.im/docs/build/sdks/): one page per language.
- [`@polaris-key/manifest`](https://github.com/vladzaharia/polaris-key/tree/main/packages/shared-manifest#readme)

Depend on this package directly when you load a catalog server-side or in tooling. The Worker, the CLI, the admin console, the Node and React SDKs and `@polaris-key/manifest` do.

## Docs

- [Catalog entries in the manifest](https://key.plrs.im/docs/build/manifest/catalog/#entries)
- [The `.pkey/` manifest](https://key.plrs.im/docs/build/manifest/)
- [Config document](https://key.plrs.im/docs/reference/protocol/config-document/): how values reach a device.
- [Validation codes](https://key.plrs.im/docs/reference/validation-codes/)

## For agents

- [`AGENTS.md`](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md): conventions and commands for working in the repository.
- [This package's source and README](https://github.com/vladzaharia/polaris-key/tree/main/packages/shared-catalog#readme).

## Versions

Every `@polaris-key/*` package publishes at the platform's version, in lockstep with the server. Builds target Node >=22. The package is ESM only and runs in Node, Cloudflare Workers and browsers.

## License

MIT.
