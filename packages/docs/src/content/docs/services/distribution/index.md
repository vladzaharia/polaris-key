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

- **All byte delivery.** The installer, the direct download and the build, file and blob routes
  are Distribution routes under `/<product>/distribution/…`, and their older `/release/…`
  spellings (and `/<product>/install.sh`) are permanent aliases. The build, file and blob routes
  also answer on the bytes host. See
  [Byte delivery and delivery access](/docs/services/distribution/delivery/).
- **Delivery access** per deliverable — who may download it — read by the downloads, the
  Sparkle appcast and the customer portal alike.
- **Outlet rollouts and halts**, controlled from CI and the console. Until the signed feed
  carries them, a halt is recorded and shown but does not stop legacy feeds; see
  [Rollouts and halts](/docs/services/distribution/rollouts/).
- **Availability and submissions** per release and outlet — reported from CI with
  `pkey distribution report`, written by store connectors, and derived for self-hosted outlets —
  and the operator-owned **signing-key inventory**; see
  [Availability, submissions and keys](/docs/services/distribution/availability/).
- **Storefront feeds** per channel — AltStore and SideStore sources, an AltStore PAL source,
  Obtainium configs, an F-Droid repository signed by CI and relayed here, a Scoop manifest and
  Flathub checker JSON; see [Storefront feeds](/docs/services/distribution/feeds/).
- **A public download page** per product on the bytes host (`https://dl.plrs.im/<product>`):
  one primary action for the visitor's platform, every other way to get the product with deep
  links and QR codes, every build with its SHA-256, and the signing-key fingerprints. It is
  rendered server-side with no script, sandboxed, and never served on the console host; its model
  is `GET /<product>/distribution/download.json`. See
  [Downloads and app stores](/docs/users/downloads/).
- **A discovery fragment** advertising the canonical byte URLs; `configured` is `true` once the
  product has a release configuration:

  ```json
  {
    "enabled": true,
    "configured": true,
    "endpoints": {
      "download": "https://key.plrs.im/<p>/distribution/dl",
      "install": "https://key.plrs.im/<p>/distribution/install.sh",
      "builds": "https://dl.plrs.im/<p>/distribution/builds/{selector}/{buildId}",
      "blobs": "https://dl.plrs.im/<p>/distribution/blobs/sha256/{sha256}"
    }
  }
  ```

- **Outlets and transports** from the product's optional `.pkey/distribution` file (below),
  applied on every link and resync.
- **Two descriptor hooks** (below): `delivery` and `outletCapabilities`.
- **Update health**: the outcome events devices report after an update (offered, downloaded,
  applied, confirmed, reverted, pack failures, boot rollbacks) counted per release, outlet and
  channel; an opt-in, halt-only **auto-halt** on those numbers; and a Sentry alert hook that
  opens halt candidates you confirm. See
  [Update health](/docs/services/distribution/update-health/).
- **The commerce bridge**: App Store, Google Play and Steam purchases of products you map become
  licence flags per deliverable, verified with each store and revoked on refund. See
  [Commerce bridge](/docs/services/distribution/commerce/).
- **A console section**, shown only while Distribution is on, with an overview of the chain, the
  outlet rollouts and which hook answers for the product, and the
  [distribution matrix](/docs/admin/distribution-matrix/): releases × outlets with pause, resume,
  halt and complete controls, and the **Update health** tab (the funnel, the auto-halt and the
  Sentry candidates).

With Distribution off, a product serves no downloads at all: every byte route and alias answers
not-found.

Because it owns the `distribution` path segment, a manual release channel named
`distribution` loses the short `/<product>/distribution/appcast.xml` alias; its canonical
`/<product>/update/distribution/appcast.xml` keeps working.

## Descriptor hooks

A service may import only Core and itself — `update → release` is the single historical
exception — so services read one another through **descriptor hooks** that Core declares and
gates. Distribution consumes one and provides two:

| Hook                 | Provided by  | Read by            | Answers                                                                                                                                                                |
| -------------------- | ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releaseCatalog`     | Release      | Distribution       | deliverables, releases, builds, artifact records, channel policy, yanks; resolution, the metadata access mode, the installer and GitHub-held bytes for the byte routes |
| `delivery`           | Distribution | Update, the portal | the default transport, availability and submissions, outlet rollouts, delivery access, delivery URLs and the key inventory                                             |
| `outletCapabilities` | Distribution | Update             | what one declared outlet permits: its kind's default, narrowed by an operator                                                                                          |

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

| Kinds                                                         | binaryUpdates | codeUpdates | dataUpdates | channelSwitch | commerce    | downloadedScripts |
| ------------------------------------------------------------- | ------------- | ----------- | ----------- | ------------- | ----------- | ----------------- |
| `direct`                                                      | `self`        | true        | true        | true          | `own`       | true              |
| `app-store`, `testflight`, `play`, `play-testing`, `ms-store` | `store`       | false       | true        | false         | `store-iap` | false             |
| `altstore`, `altstore-pal`, `obtainium`, `fdroid-repo`        | `store`       | false       | true        | false         | `own`       | false             |
| `app-installer`, `winget`, `itch`, `flathub`, `snap`          | `none`        | false       | true        | false         | `own`       | false             |
| `steam`                                                       | `none`        | false       | true        | false         | `steam`     | false             |
| `web`                                                         | `none`        | false       | true        | false         | `own`       | true              |

The table is wire contract v4's (`OUTLET_CAPABILITY_DEFAULTS` in
`@polaris-key/protocol/distribution`, pinned by the corpus's `outlet-matrix.json`); the Worker
imports it, so its defaults and every SDK's are the same table. A client narrows it further per
platform (an iOS `direct` install opens its page rather than updating itself), and the signed
feed can narrow it again; nothing widens it.

**Narrowing** means `binaryUpdates` moves right along `self` > `store` > `none`, a boolean goes
from true to false, and `commerce` becomes `none`. Anything else is refused. The narrowing is
stored on the outlet's row (`capabilities_source = 'admin'`) and survives every resync; revert
hands the outlet back to its kind's default. Reading back clamps too: a stored value wider than
today's default is ignored, so the answer can only ever be narrower than the table.

The kind those defaults are looked up by is guarded as well. An id that is itself a kind cannot
be given another one (`outlet_kind_mismatch`). An existing outlet with a custom id takes a new
kind from a push only when that does not widen the defaults; otherwise it keeps its kind.

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
[Outlet credentials](/docs/admin/secrets-and-keys/#outlet-credentials). The first connector is
the [App Store Connect connector](/docs/services/distribution/app-store-connect/), then the
[Google Play connector](/docs/services/distribution/google-play/) and the read-only
[Microsoft Store connector](/docs/services/distribution/microsoft-store/).

## Vocabulary

Distribution's nouns — **outlet**, **transport**, **availability**, **submission**, **rollout**,
**listing** and **outlet capabilities** — are defined in
[Concepts & terminology](/docs/start/concepts/#distribution-model). "Distribution" names this
service and nothing else.
