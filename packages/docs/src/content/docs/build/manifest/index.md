---
title: "The .pkey/ manifest"
description: "Up to four files, JSON or YAML, that describe a product as data: the catalog, product metadata, release settings and distribution channels."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 2
  label: "The .pkey/ manifest"
---

A product is data. Everything the control plane needs to run it lives in a `.pkey/` directory in the product's own repo, and the Worker, the console and every SDK read that data. `.pkey/` is the only manifest directory: there is no fallback location and no second copy that could disagree with it.

## The files

| File             | Base name                      | Required when                              | Carries                                                                                         |
| ---------------- | ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **schema**       | `schema.{json,yaml,yml}`       | always (read only while Config is on)      | the config catalog: `{ schemaVersion, entries[] }`                                              |
| **product**      | `product.{json,yaml,yml}`      | always                                     | metadata, enabled services, browser origins, sign-in, profiles, tiers and provisioning hooks    |
| **release**      | `release.{json,yaml,yml}`      | Release is on                              | provider coordinates, tracks, install and appcast settings, deliverables and trusted publishing |
| **distribution** | `distribution.{json,yaml,yml}` | never (absent means one implicit `direct`) | channels and their store identities, transports per deliverable, the store listing              |

The base name picks the file's role. The extension is a format preference, tried in the order `.json`, `.yaml`, `.yml` for each file on its own, so a repo may keep `product.yaml` next to `schema.json`. When more than one extension exists for a file, only the first is read and `pkey validate` says so.

Each file has a page: [product](/docs/build/manifest/product/), [catalog](/docs/build/manifest/catalog/), [release](/docs/build/manifest/release/) and [distribution](/docs/build/manifest/distribution/). To create the files and register the product, see [Register a product from its repo](/docs/build/manifest/register/).

## Services and requirements

`modules` in `.pkey/product` declares which services the product runs. With no `modules` block, or none enabled, a product runs License and Config. A service whose requirement is off is refused at ingest and on a live change as `<service>_requires_<requirement>`. [How it works](/docs/start/how-it-works/#coherence-rules) has the one table of those rules.

The service slugs are `license`, `config`, `release`, `distribution`, `update`, `identity` and `sync`. The old names `licensing`, `releases`, `oidc` and `edgeMint` still parse and warn with `deprecated_spelling`; the [product page](/docs/build/manifest/product/#enabled-services-modules) lists what each maps to.

## Size and depth caps

Manifest ingest runs on a push to a repo the platform doesn't control, so cost is bounded before parsing. Each document is capped at 64 KiB and 32 levels of nesting, and YAML anchor expansion is bounded too. A file over a cap is refused whole, not truncated. Real manifests run about 1.5 KB.

## Resync and operator ownership

The files are a baseline, not the live state. A resync updates product metadata, services, fingerprint and auto-issue policy, catalog shape, sign-in, release settings, profiles, tiers and provisioning, then skips any block an operator has claimed in the console. **Revert to manifest** hands a block back without changing its value; the next resync applies the manifest's. Secrets, per-license and per-device state, and operational overrides live in the platform and are never overwritten.

[The service model](/docs/start/how-it-works/) defines claiming once. [Register a product from its repo](/docs/build/manifest/register/#after-the-first-link) lists what a resync leaves alone.

## Next steps

- [Register a product from its repo](/docs/build/manifest/register/): scaffold, validate and link.
- [Set up your editor](/docs/build/manifest/json-schema/): completion and inline errors.
- [Manifest validation codes](/docs/reference/validation-codes/): every error and warning.
