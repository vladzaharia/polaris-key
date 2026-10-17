---
title: "Service model internals"
description: "How products.services_json is parsed, written and owned: the strict and fail-safe parser, the manifest read, and the guard that keeps a resync off an operator's change."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 8
---

A product runs some set of services, and exactly one column holds that set: `products.services_json`. Every surface that needs to know whether a service is on reads it, so the discovery document can't advertise a service whose routes answer `404`. The rules a reader of the docs needs are on [How it works](/docs/start/how-it-works/). This page is for the contributor who changes the code behind them.

## The column

The column is a JSON object with an explicit `{ "enabled": boolean }` for every service slug, written in the canonical order of `tools/services.json`. `serializeServices` writes it and `parseServices` reads it, both in `packages/worker/src/core/services.ts`.

```json title="products.services_json"
{
  "license": { "enabled": true },
  "config": { "enabled": true },
  "release": { "enabled": false },
  "distribution": { "enabled": false },
  "update": { "enabled": false },
  "identity": { "enabled": false },
  "sync": { "enabled": false }
}
```

The device registration policy isn't stored. It is derived from the set: `requires-license` while License is on, otherwise `requires-identity` while Identity is on, otherwise `open`. A stored `registration` key from an older writer is still checked against the three policies, then ignored, and `serializeServices` never writes it.

## The parser

`parseServices` runs on every product-scoped request. The column could hold a stale row, a hand edit in the D1 console, or the output of a writer this build has never seen, so the parser is strict and fail-safe at once:

- **Structurally wrong discards the whole record.** Not JSON, not an object, an array, a non-object entry, an `enabled` that isn't a boolean, or a `registration` outside the three policies reads as the defaults. It never merges half a record, because half-honoring a typo turns it into a silently disabled service.
- **An unknown slug with a well-formed value is kept.** A newer build wrote it. It never affects a decision, and `serializeServices` writes it back after the known slugs, sorted by key, so rolling a Worker back neither resets the slugs it knows nor deletes the one it doesn't. A malformed unknown value discards the whole record, and `__proto__` is never a slug.
- **A slug the record omits gets its default.**
- **It never throws.** Hostile database content must not be able to `500` a request.

The defaults are License and Config on, the rest off, not all off. The parser sits in front of routes every existing product already serves, so the safe direction is to behave as the product did before the column existed. An unreadable record therefore lands on `requires-license`, the closed policy.

## The manifest read

`.pkey/product`'s `modules` block is persisted into the column. Three rules govern how it is read:

- Only a literal `true` counts. An entry with `enabled` anything else is off.
- An unknown module name is ignored. A name this build doesn't know isn't a reason to refuse the product.
- No block, or a block where nothing is `enabled: true`, yields the defaults. Writing every entry as `false` produces License and Config, not no services. To run a single service, name that one as `true` and leave the others out.

The pre-suite module names (`licensing`, `releases`, `oidc`, `edgeMint`) are translated to slugs at ingest, and only slugs are stored. The table is on [Write the product manifest](/docs/build/manifest/product/#enabled-services-modules). `releases` brings the whole chain, so a legacy manifest can't trip `distribution_requires_release` or `update_requires_distribution`. A manifest that names `release` and `update` without `distribution` does trip the second one. Migration `0033_distribution_backfill.sql` turned Distribution on for every stored product that had Release on, so such a product keeps serving until its manifest is fixed.

## Who owns the column

`products.services_source` is `manifest` or `admin`. The same pattern guards `fingerprint_policy_source`, `auto_issue_source`, `compat_source` and `release_config.access_source`.

- A resync writes only while the column is `manifest`-owned. The guard is the `UPDATE`'s own `WHERE … = 'manifest'` predicate, not a read followed by a write in the caller, so a push can't undo a toggle made a moment earlier.
- A live edit through the admin API's `/manage/api/products/<slug>/services` (PATCH) claims the column for `admin`. From then on a `.pkey/` push doesn't rewrite it.
- The `/manage/api/products/<slug>/services/revert` route (POST) hands ownership back to `manifest` and does nothing else. The live values stay until the next resync applies the manifest. Re-reading the repo at once would make the operator's escape hatch depend on a GitHub round trip that can fail.

The transition rules, including the cascade when a requirement is turned off, live in `servicesTransitions.ts`.

## If you add a service

[Monorepo layout](/docs/contribute/layout/) has the checklist, starting from a row in `tools/services.json`. The coherence codes come from the `requires` field of that row, so the parser, the manifest validator and the console follow without further edits.

## Next steps

- [How it works](/docs/start/how-it-works/): the rules as a reader sees them.
- [Architecture](/docs/contribute/architecture/): the layers around this column.
