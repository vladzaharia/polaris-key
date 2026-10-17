---
title: "Distribution"
description: "How every release of every deliverable reaches devices and channels: the sixth service, its place in the release ← distribution ← update chain, and the descriptor hooks it provides."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 1
---

Distribution answers one question for every product that turns it on: **how does a release reach
devices and channels, and what state is it in there?** [Release](/docs/services/release/) says what
exists; [Update](/docs/services/update/) tells an installed copy what to do next; Distribution sits
between them and owns delivery.

## Choose a channel

A channel is a place a build reaches customers. Declare each one in `.pkey/distribution`. Pick by where your customers install from.

| You want to…                     | Declare                                                | Who installs updates | Read                                                                    |
| -------------------------------- | ------------------------------------------------------ | -------------------- | ----------------------------------------------------------------------- |
| Serve downloads from Polaris Key | `direct` (the default when you declare none)           | the app itself       | [Delivery](/docs/features/ship-builds/channels/delivery/)               |
| Ship on the Apple App Store      | `app-store`, `testflight`                              | the store            | [App Store](/docs/features/ship-builds/channels/app-store/)             |
| Ship on Google Play              | `play`, `play-testing`                                 | the store            | [Google Play](/docs/features/ship-builds/channels/google-play/)         |
| Ship on the Microsoft Store      | `ms-store`                                             | the store            | [Microsoft Store](/docs/features/ship-builds/channels/microsoft-store/) |
| Ship on Steam                    | `steam`                                                | Steam                | [Steam](/docs/features/ship-builds/channels/steam/)                     |
| Offer an install source          | `altstore`, `altstore-pal`, `obtainium`, `fdroid-repo` | the install source   | [Install sources](/docs/features/ship-builds/channels/feeds/)           |
| Push to a storefront from CI     | `itch`, `snap`, `flathub`, `winget`                    | the storefront       | [Storefronts](/docs/features/ship-builds/channels/storefronts/)         |
| Serve Windows App Installer      | `app-installer`                                        | Windows              | [App-updater feeds](/docs/features/ship-builds/updates/updater-feeds/)  |

The channel a build came from also sets what an install may do. See [Channel capabilities](#channel-capabilities).

## The chain: release ← distribution ← update

The release, distribution and update services split everything a product delivers — its app and, later, its content packs —
into three questions:

| Service      | Answers                                                    |
| ------------ | ---------------------------------------------------------- |
| Release      | _what exists?_ — deliverables, releases, builds, artifacts |
| Distribution | _how does it reach devices and channels, and is it there?_ |
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
- **Outlet rollouts and halts**, controlled from CI and the console, and read by the signed
  feed, the app-updater feeds, the storefront feeds and the download page; see
  [Rollouts and halts](/docs/services/distribution/rollouts/).
- **Availability and submissions** per release and channel — reported from CI with
  `pkey distribution report`, written by store connectors, and derived for self-hosted channels —
  and the operator-owned **signing-key inventory**; see
  [Availability, submissions and keys](/docs/services/distribution/availability/).
- **Storefront feeds** per release track — AltStore and SideStore sources, an AltStore PAL source,
  Obtainium configs, an F-Droid repository signed by CI and relayed here, a Scoop manifest and
  Flathub checker JSON; see [Storefront feeds](/docs/services/distribution/feeds/).
- **Package feeds** on the registry host (`https://pkg.plrs.im`) for npm, PyPI, SwiftPM, Maven
  and Gradle, OCI and Godot clients, with one access check before every cached answer; see
  [Package feeds](/docs/services/distribution/package-feeds/).
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
  applied, confirmed, reverted, pack failures, boot rollbacks) counted per release, channel and
  release track; an opt-in, halt-only **auto-halt** on those numbers; and a Sentry alert hook that
  opens halt candidates you confirm. See
  [Update health](/docs/services/distribution/update-health/).
- **The commerce bridge**: App Store, Google Play and Steam purchases of products you map become
  licence flags per deliverable, verified with each store and revoked on refund. See
  [Commerce bridge](/docs/services/distribution/commerce/).
- **A console section**, shown only while Distribution is on: the
  [Matrix](/docs/admin/distribution-matrix/) (releases × channels, with a drawer per cell holding
  its readiness and rollout controls), **Rollouts**, **Outlets & feeds** (capabilities, storefront
  feed URLs and the distribution keys), **Access** (delivery access per deliverable), **Health**
  (the funnel, the auto-halt and the Sentry candidates) and **Outlet credentials**. The
  Release → Distribution → Update chain is shown on **Core → Services**.

With Distribution off, a product serves no downloads at all: every byte route and alias answers
not-found.

Because it owns the `distribution` path segment, a manual release crack named
`distribution` loses the short `/<product>/distribution/appcast.xml` alias; its canonical
`/<product>/update/distribution/appcast.xml` keeps working.

## Descriptor hooks

A service may import only Core and itself — `update → release` is the single historical
exception — so services read one another through **descriptor hooks** that Core declares and
gates. Distribution consumes one and provides two:

| Hook                 | Provided by  | Read by            | Answers                                                                                                                                                                      |
| -------------------- | ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releaseCatalog`     | Release      | Distribution       | deliverables, releases, builds, artifact records, release track policy, yanks; resolution, the metadata access mode, the installer and GitHub-held bytes for the byte routes |
| `delivery`           | Distribution | Update, the portal | the default transport, availability and submissions, channel rollouts, delivery access, delivery URLs and the key inventory                                                  |
| `outletCapabilities` | Distribution | Update             | what one declared channel permits: its kind's default, narrowed by an operator                                                                                               |

Every accessor **fails closed**: while the providing service is off for the product it answers
`null`, the provider's code never runs, and the consumer degrades explicitly — Update without a
delivery hook serves no per-channel state. Hooks are read-only; a cross-service write would be an
import in disguise.

## Channels and transports

A product declares where it is distributed in `.pkey/distribution` — see
[Distribution: channels, transports and listing](/docs/build/manifest/distribution/). No file
means one implicit channel, the Polaris Key channel (`direct`), served by `pkey-cdn`. On link and resync, Distribution's
own ingest hook (run by Core, in the same batch as the rest of the ingest, only while
Distribution is on) writes:

- **`dist_outlets`** — one row per channel: its kind, normalised identity (`identity_json`) and
  merged listing (`listing_json`). A row changes only when the manifest changes it; a channel the
  manifest drops gets `removed_at` and is kept, because availability history refers to it.
- **`dist_transports`** — the resolved transport for every declared deliverable on every live
  channel.

## Channel capabilities

What an install from a channel may do. The security-relevant bits — whether it may fetch and
run new code (`codeUpdates`, `downloadedScripts`) or sell things itself (`commerce`) — are
**operator-owned**: they default per channel kind, an operator may only **narrow** them, and the
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
stored on the channel's row (`capabilities_source = 'admin'`) and survives every resync; revert
hands the channel back to its kind's default. Reading back clamps too: a stored value wider than
today's default is ignored, so the answer can only ever be narrower than the table.

The kind those defaults are looked up by is guarded as well. An id that is itself a kind cannot
be given another one (`outlet_kind_mismatch`). An existing channel with a custom id takes a new
kind from a push only when that does not widen the defaults; otherwise it keeps its kind.

The console API (narrative-only, not in the wire spec), every write audited:

| Method | Path                                                                              | Does                                                      |
| ------ | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET`  | `/manage/api/products/<slug>/distribution/outlets`                                | every channel with identity, capabilities and transports  |
| `PUT`  | `/manage/api/products/<slug>/distribution/outlets/<outletId>/capabilities`        | `{ "capabilities": { … } }` — narrow; a widening is a 422 |
| `POST` | `/manage/api/products/<slug>/distribution/outlets/<outletId>/capabilities/revert` | back to the kind's default                                |

The audit actions are `distribution.outlet.capabilities` and
`distribution.outlet.capabilities.revert`. A removed channel answers 404 to both writes, and the
`outletCapabilities` hook answers `null` for it.

## Channel credentials

A store connector signs in to its store with an **channel credential** — an App Store Connect API
key, the App Store webhook secret, a Google service account or a Partner Center app. Those live
in Core, in their own sealed table, and Distribution is the only service that can open one
(`core/outletCredentials.ts`, held to that by a test); every open is audited. The JWTs and access
tokens a connector mints from them (`core/outletTokens.ts`) are cached, sealed, and keyed by a
non-secret version of the credential, so the cache is checked first and a credential is opened
only when a fresh token is needed. Operators set them in **Distribution → Outlet credentials** — see
[Channel credentials](/docs/admin/secrets-and-keys/#outlet-credentials). The first connector is
the [App Store Connect connector](/docs/services/distribution/app-store-connect/), then the
[Google Play connector](/docs/services/distribution/google-play/) and the read-only
[Microsoft Store connector](/docs/services/distribution/microsoft-store/).

## The shared listing

A product's store listing is kept once, in Distribution, and projected to every store's limits:
see [Storefront listing](/docs/admin/storefront-listing/). The AltStore and Obtainium feeds read it,
falling back to `.pkey/distribution` `listing` field by field.

## Vocabulary

Distribution's nouns — **channel**, **transport**, **availability**, **submission**, **rollout**,
**listing** and **channel capabilities** — are defined in
[Concepts & terminology](/docs/start/concepts/#distribution-model). "Distribution" names this
service and nothing else.

## Store channels

Store rules (App Store Review Guideline 3.1.1, Google Play payments) do not let an app sold
through the store unlock features with a licence key bought elsewhere, or link out to buy one.
The channel a build came from decides it, and every SDK resolves the channel the same way (the
build stamp, then attested and declared signals; `outlet-matrix.json`).

## Decide from the channel's `commerce` capability

| `commerce`  | Channel kinds                                                 | Key entry and "Buy" links                            |
| ----------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `store-iap` | `app-store`, `testflight`, `play`, `play-testing`, `ms-store` | hide                                                 |
| `steam`     | `steam`                                                       | hide outside purchase links; keys only through Steam |
| `own`       | `direct`, `itch`, `flathub`, `snap`, `winget`, `web`, …       | show                                                 |
| `none`      | `unknown`                                                     | show key entry; no store purchase                    |

```ts
import { effectiveCapabilities } from "@polaris-key/client-core/decide";

const outlet = client.update.outlet; // resolved from the build stamp and signals
const caps = outlet
  ? effectiveCapabilities(outlet.kind, {
      platform: "macos",
      subkind: outlet.subkind,
    })
  : null;
const showKeyEntry =
  caps === null || (caps.commerce !== "store-iap" && caps.commerce !== "steam");
```

Godot exposes the same table as `PKeyDecision.effective_capabilities(kind, {platform = ..., subkind = ...})`,
with the channel from `PolarisKey.update.outlet()`. Stamp the channel at export (`pkey` CI or the
Godot export plugin), so a store build never relies on run-time detection alone.

The UI kits do not hide key entry on these channels. Pass the decision to the activation screen yourself. Purchases on a store channel go
through the store and the [commerce claim](/docs/services/distribution/commerce/).

## Distribution matrix

**Distribution → Rollouts**, in its **Matrix** view, shows a deliverable's most recent releases
(twenty by default, fifty at most) against every channel the product declares in
`.pkey/distribution`. The matrix is not a sidebar item of its own: its old address and the `g m`
shortcut open that view. Each cell answers one
question about one release on one channel, and opens a drawer with everything else.

## The toolbar

- **Deliverable**: the app, or any pack. A pack's matrix has no readiness.
- **Release track**: every release track, or one.
- **View** changes only what each cell summarises:

  | View         | The cell shows                                                    |
  | ------------ | ----------------------------------------------------------------- |
  | Availability | the availability, plus the rollout percentage or a readiness hold |
  | Rollouts     | the rollout state and percentage, or nothing                      |
  | Readiness    | Ready, Held with the number of blockers, Not ready or Pending     |

- **Rows**: 20 or 50. When the matrix is full, a note says it shows the newest releases only.

All of these, and the open cell, are in the page's URL
(`#/p/<slug>/distribution/matrix?deliverable=textures&view=readiness&cell=<release>:<outlet>`),
so a link reopens exactly what you were looking at. The grid is one tab stop: arrow keys move
between cells and Enter opens one. Below 768 px wide each release is a card listing its channels;
**View as grid** brings the grid back.

## The cell drawer

- **Availability**: the best state any build is in on that channel (`live`, `approved`,
  `in-review`, `processing`, `pending`, `rejected` or `removed`), then each build's record with
  where it came from and since when. A self-hosted channel (direct downloads, AltStore, Obtainium,
  the F-Droid repository) is `live` once Polaris Key holds the build's bytes, with no report
  needed ("Derived: Polaris Key serves these bytes"). A store channel shows only what CI
  (`distribution:report`) or a store connector reported. A yanked release derives nothing; a
  stored report on it stays visible.
- **Submission**: the store review state, when it was submitted and when it was reviewed.
- **Readiness** (app releases): whether the release's packs are ready on this channel, each blocker
  linked to its pack release, and whether Polaris Key holds the release there until they are; see
  [Channel readiness](/docs/services/distribution/availability/#channel-readiness). **Override…**
  releases a hold and needs a reason, which is audited; **Clear override** computes the hold
  again. **Refresh readiness** in the page header recomputes every release and says how many
  changed.
- **Rollouts**: one block per release track, with the percentage as a meter and only the moves the
  rollout's state allows:

  | From       | Allowed                                   |
  | ---------- | ----------------------------------------- |
  | `active`   | Pause, Halt, Complete, Set percentage     |
  | `paused`   | Resume, Halt, Set percentage              |
  | `halted`   | Resume                                    |
  | `complete` | none: publish a newer release and roll it |

  **Set percentage…** offers 1, 5, 10, 25, 50 and 100 % or any value. Devices are bucketed by a
  stable hash, so raising the percentage only adds devices. **Start rollout…** (in the drawer and
  the page header) picks the deliverable, channel, release track, release and the first percentage.

Pause and resume ask for a confirmation that lists what changes; halt and complete are marked as
the stronger actions and their confirm button repeats the verb ("Halt 2.4.0"). Every control calls
the same rollout route CI uses (`distribution:rollout`), is audited under your name in
**Activity**, and is refused if the rollout moved to another release since the page loaded — the
dialog then stays open and says so.

A rollout **mirrored** from a store connector (an App Store phased release, a Play staged
rollout) is read-only and names the store that owns it. When that store's connector is
configured, **Store controls** under it send the store's own verbs: App Store Connect's phased
release pause, resume and release to everyone; Google Play's rollout share, halt, resume and
complete. The connector brings the new state back into the cell.

## What a pause or halt reaches

A pause or halt stops offering the release on that channel in the signed release track feed, the
app-updater feeds (the Sparkle appcast, `/update/version` and the rest), the storefront feeds
(AltStore, F-Droid, Scoop) and the public [download page](/docs/users/downloads/), which list
the previous release instead. Moving download URLs apply yanks and pins, not holds: to take a
release off every surface, yank it or pin the release track under **Release → Releases**. See
[Rollouts and halts](/docs/services/distribution/rollouts/).

## The other Distribution pages

- **Rollouts** lists every rollout of the product, halted ones first, with its release, channel,
  release track, percentage, state, source and who changed it when. Filter by state and channel; each
  row's menu has the same moves as the drawer, and **Open in matrix** opens its cell.
- **Outlets & feeds** lists the declared channels with their kind, transports and capabilities.
  A channel's drawer shows its identity, its capabilities against its kind's default, and, for
  AltStore, AltStore PAL, Obtainium, the F-Droid repository, Scoop (the Polaris Key channel, `direct`) and
  Flathub, the public [feed URL](/docs/services/distribution/feeds/) of each release track with a copy
  button. **Narrow capabilities…** can only narrow below the kind's default; **Revert to
  manifest** (from the source badge) restores it. Below the channels, **Distribution keys** is the
  signing-key inventory: add, edit or remove an entry, and add or dismiss a key CI reported that
  matches none.
- **Access** sets who may download each deliverable: the app and each pack, each saved on its own;
  see [Delivery access](/docs/services/distribution/delivery/).
- **Health** is [update health](/docs/services/distribution/update-health/): the funnel per
  rollout, the auto-halt and the Sentry halt candidates.
- **Outlet credentials** holds the store keys the connectors use and the Sentry integration
  secret; see [Channel credentials](/docs/admin/secrets-and-keys/#outlet-credentials). Its
  **Store connectors** cards show each connector's state, which key it uses (the product's own or
  the platform's team key, see [Store connections](/docs/admin/store-connections/)) and its
  configuration actions: App Store Connect **Release this version**, **TestFlight public link**
  and **Webhook setup**; Google Play **Update priority** and **Settings**. **Release this
  version** cannot be undone, so it asks you to type the app's name exactly as App Store Connect
  shows it; the Worker checks the name against App Store Connect before it releases.

The release × channel readiness also appears on **Release → Compatibility**.
