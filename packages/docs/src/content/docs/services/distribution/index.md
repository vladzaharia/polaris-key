---
title: "Distribution"
description: "How every release of every deliverable reaches devices and outlets: the sixth service, its place in the release ← distribution ← update chain, and the descriptor hooks it provides."
sidebar:
  order: 1
---

Distribution answers one question for every product that turns it on: **how does a release reach
devices and outlets, and what state is it in there?** [Release](/docs/services/release/) says what
exists; [Update](/docs/services/update/) tells an installed copy what to do next; Distribution sits
between them and owns delivery.

## The chain: release ← distribution ← update

The three services split everything a product delivers — its app and, later, its content packs —
into three questions:

| Service      | Answers                                                    |
| ------------ | ---------------------------------------------------------- |
| Release      | _what exists?_ — deliverables, releases, builds, artifacts |
| Distribution | _how does it reach devices and outlets, and is it there?_  |
| Update       | _what should this installed copy do next?_                 |

Enablement follows the chain. Two coherence rules, enforced by the enablement API and by manifest
ingest alike:

- `distribution_requires_release` — Distribution on with Release off. There is nothing to deliver.
- `update_requires_distribution` — Update on with Distribution off. Update's feed would have no
  delivery behind it. Together the two rules imply the retired `update_requires_release`.

The legacy `releases` module name enables all three, so a manifest written before the split keeps
meaning "this product distributes software":

```yaml
# .pkey/product.yaml — either spelling
modules:
  releases: { enabled: true }
# or
modules:
  release: { enabled: true }
  distribution: { enabled: true }
  update: { enabled: true }
```

A manifest that names `release` and `update` without `distribution` is refused with
`update_requires_distribution`. Every product that had Release on when Distribution shipped had it
switched on by a migration, so its stored state keeps serving while its manifest is fixed.

## What it does today

Distribution ships as the foundation the later work builds on. Today it has:

- **No routes.** Every `/<product>/distribution/…` path answers the platform's single not-found
  response, the same answer a disabled service gives. Storefront feeds, byte delivery and the
  download page arrive as routes in later packages.
- **A discovery fragment** that says the service is on but not yet configured:

  ```json
  { "enabled": true, "configured": false, "endpoints": {} }
  ```

- **Outlets and transports** from the product's optional `.pkey/distribution` file (below),
  applied on every link and resync.
- **Two descriptor hooks** (below): `delivery` (the default transport, `pkey-cdn`, and no
  availability records yet) and `outletCapabilities` (what one declared outlet permits).
- **A console section**, shown only while Distribution is on, with an overview of the chain and
  of which hook answers for the product.

Because it now owns the `distribution` path segment, a manual release channel named
`distribution` loses the short `/<product>/distribution/appcast.xml` alias; its canonical
`/<product>/update/distribution/appcast.xml` keeps working.

## Descriptor hooks

A service may import only Core and itself — `update → release` is the single historical
exception — so services read one another through **descriptor hooks** that Core declares and
gates. Distribution consumes one and provides two:

| Hook                 | Provided by  | Read by      | Answers                                                                         |
| -------------------- | ------------ | ------------ | ------------------------------------------------------------------------------- |
| `releaseCatalog`     | Release      | Distribution | deliverables, releases, builds, artifact records, channel policy, yanks         |
| `delivery`           | Distribution | Update       | the default transport and availability; later rollouts, halts and delivery URLs |
| `outletCapabilities` | Distribution | Update       | what one declared outlet permits: its kind's default, narrowed by an operator   |

Every accessor **fails closed**: while the providing service is off for the product it answers
`null`, the provider's code never runs, and the consumer degrades explicitly — Update without a
delivery hook serves no per-outlet state. Hooks are read-only; a cross-service write would be an
import in disguise.

## Outlets and transports

A product declares where it is distributed in `.pkey/distribution` — see
[Distribution: outlets, transports and listing](/docs/build/manifest/distribution/). No file
means one implicit outlet, `direct`, served by `pkey-cdn`. On link and resync, Distribution's
own ingest hook (run by Core, in the same batch as the rest of the ingest, only while
Distribution is on) writes:

- **`dist_outlets`** — one row per outlet: its kind, normalised identity (`identity_json`) and
  merged listing (`listing_json`). A row changes only when the manifest changes it; an outlet the
  manifest drops gets `removed_at` and is kept, because availability history refers to it.
- **`dist_transports`** — the resolved transport for every declared deliverable on every live
  outlet.

## Outlet capabilities

What an install from an outlet may do. The security-relevant bits — whether it may fetch and
run new code (`codeUpdates`, `downloadedScripts`) or sell things itself (`commerce`) — are
**operator-owned**: they default per outlet kind, an operator may only **narrow** them, and the
manifest cannot express them at all (`capabilities_not_manifest_writable`).

| Kinds                                                                                                        | binaryUpdates | codeUpdates | dataUpdates | channelSwitch | commerce    | downloadedScripts |
| ------------------------------------------------------------------------------------------------------------ | ------------- | ----------- | ----------- | ------------- | ----------- | ----------------- |
| `direct`, `web`                                                                                              | `self`        | true        | true        | true          | `own`       | true              |
| `app-store`, `testflight`, `play`, `play-testing`, `ms-store`                                                | `store`       | false       | true        | false         | `store-iap` | false             |
| `steam`                                                                                                      | `store`       | false       | true        | false         | `steam`     | false             |
| `altstore`, `altstore-pal`, `obtainium`, `fdroid-repo`, `app-installer`, `itch`, `flathub`, `snap`, `winget` | `store`       | false       | true        | false         | `own`       | false             |

The table is the proposed default; once the outlet matrix of the update-manifest design is
approved it becomes the source of truth and this table follows it.

**Narrowing** means `binaryUpdates` moves right along `self` > `store` > `none`, a boolean goes
from true to false, and `commerce` becomes `none`. Anything else is refused. The narrowing is
stored on the outlet's row (`capabilities_source = 'admin'`) and survives every resync; revert
hands the outlet back to its kind's default. Reading back clamps too: a stored value wider than
today's default is ignored, so the answer can only ever be narrower than the table.

The console API (narrative-only, not in the wire spec), every write audited:

| Method | Path                                                                              | Does                                                      |
| ------ | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET`  | `/manage/api/products/<slug>/distribution/outlets`                                | every outlet with identity, capabilities and transports   |
| `PUT`  | `/manage/api/products/<slug>/distribution/outlets/<outletId>/capabilities`        | `{ "capabilities": { … } }` — narrow; a widening is a 422 |
| `POST` | `/manage/api/products/<slug>/distribution/outlets/<outletId>/capabilities/revert` | back to the kind's default                                |

The audit actions are `distribution.outlet.capabilities` and
`distribution.outlet.capabilities.revert`. A removed outlet answers 404 to both writes, and the
`outletCapabilities` hook answers `null` for it.

## Outlet credentials

A store connector signs in to its store with an **outlet credential** — an App Store Connect API
key, the App Store webhook secret, a Google service account or a Partner Center app. Those live
in Core, in their own sealed table, and Distribution is the only service that can open one
(`core/outletCredentials.ts`, held to that by a test); every open is audited. The JWTs and access
tokens a connector mints from them (`core/outletTokens.ts`) are cached, sealed, and keyed by a
non-secret version of the credential, so the cache is checked first and a credential is opened
only when a fresh token is needed. Operators set them on the Secrets tab — see
[Outlet credentials](/docs/admin/secrets-and-keys/#outlet-credentials). No connector uses them
yet; the App Store, Play and Microsoft Store connectors arrive in later packages.

## Vocabulary

Distribution's nouns — **outlet**, **transport**, **availability**, **submission**, **rollout**,
**listing** and **outlet capabilities** — are defined in
[Concepts & terminology](/docs/start/concepts/#distribution-model). "Distribution" names this
service and nothing else.
