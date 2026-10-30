---
title: "Choose a channel"
description: "Pick where a build reaches customers, then follow the page for that channel."
type: "reference"
lastReviewed: "2026-10-28"
sidebar:
  order: 1
---

Pick where your customers install from. Declare each channel in `.pkey/distribution`; a build reaches customers through the channels you declare.

| You want to…                                                                                  | Declare                                                  | Who installs updates         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| [Serve downloads from Polaris Key](/docs/features/ship-builds/channels/delivery/)             | `direct` (the default when you declare none)             | the app itself               |
| [Ship on the Apple App Store](/docs/features/ship-builds/channels/app-store/)                 | `app-store`, `testflight`                                | the store                    |
| [Ship on Google Play](/docs/features/ship-builds/channels/google-play/)                       | `play`, `play-testing`                                   | the store                    |
| [Ship on the Microsoft Store](/docs/features/ship-builds/channels/microsoft-store/)           | `ms-store`                                               | the store                    |
| [Ship on Steam](/docs/features/ship-builds/channels/steam/)                                   | `steam`                                                  | Steam                        |
| [Offer an install source](/docs/features/ship-builds/channels/feeds/)                         | `altstore`, `altstore-pal`, `obtainium`, `fdroid-repo`   | the install source           |
| [Publish from CI](#channels-that-run-in-ci)                                                   | `itch`, `snap`, `homebrew`, `scoop`, `winget`, `flathub` | the store or package manager |
| [Serve Windows App Installer](/docs/features/ship-builds/updates/updater-feeds/)              | `app-installer`                                          | Windows                      |
| [Serve a web build](/docs/features/ship-builds/channels/delivery/#web-deltas-the-payload-url) | `web`                                                    | the app itself               |

The channel a build came from also sets what an install may do. See [Channel capabilities](#channel-capabilities). The [distribution matrix](/docs/features/ship-builds/channels/distribution-matrix/) shows every release on every channel.

[Release](/docs/features/ship-builds/releases/) says what exists; [Update](/docs/features/ship-builds/updates/) tells an installed copy what to do next; Distribution sits between them and owns delivery.

## Which channels a product sees

The console shows a product only the channels it can use. A channel is in scope when its platforms and deliverable kinds meet the product's. The full catalogue is on [Channels](/docs/reference/channels/).

A product's platforms come from, firmest first:

1. its **builds**: the newest non-yanked app release on each release channel;
2. the artifacts `.pkey/release` **declares** in `deliverables.app.artifacts`, published or not;
3. a `direct` channel that names its platforms;
4. the platforms planned in `distribution.intendedPlatforms`, before any build exists.

Each platform carries the CPU architectures and file formats it ships. Architecture is a fact beside the OS: an arm64-only Windows build offers no x64 download and no x64 winget installer, and the Mac App Store takes only a `universal` or `arm64` macOS build.

A Windows-only product sees no Apple channel in the console, the portal or `pkey validate`. A product with no platform facts yet hides nothing.

A channel the product declared stays listed even when out of scope, with an **Out of scope** pill. A direct link to a hidden channel opens a page that says so.

Each channel in scope has one of four states:

| State        | Means                                                                                |
| ------------ | ------------------------------------------------------------------------------------ |
| `not_set_up` | Nothing declared yet. It offers **one click** when the credentials are already held. |
| `ready`      | Set up, with a fitting build, not yet live.                                          |
| `live`       | Customers can get a build through it.                                                |
| `attention`  | A build exists but none fits, or a credential is expiring.                           |

**Not using** is a choice you record in Core's setup: that channel stops asking for setup. **Setting up** is not a state; it is progress shown while a run is under way.

The read model is `GET /manage/api/products/<slug>/distribution/channels`, the same data the product summary carries as `platforms` and `channels`. A credential appears in it only as a yes or no, never as a key or an id.

## The chain: release ← distribution ← update

The release, distribution and update services split everything a product delivers — its app and and its content packs —
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

```yaml title="Excerpt of .pkey/product"
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
`update_requires_distribution`.

## What Distribution does

- **All byte delivery.** The installer, the direct download and the build, file and blob routes
  are Distribution routes under `/<product>/distribution/…`, and their older `/release/…`
  spellings (and `/<product>/install.sh`) are permanent aliases. The build, file and blob routes
  also answer on the bytes host. See
  [Byte delivery and delivery access](/docs/features/ship-builds/channels/delivery/).
- **Delivery access** per deliverable — who may download it — read by the downloads, the
  Sparkle appcast and Polaris Locker alike.
- **Outlet rollouts and halts**, controlled from CI and the console, and read by the signed
  feed, the app-updater feeds, the storefront feeds and the download page; see
  [Rollouts and halts](/docs/features/ship-builds/channels/rollouts/#what-a-halt-reaches).
- **Availability and submissions** per release and channel — reported from CI with
  `pkey distribution report`, written by store connectors, and derived for self-hosted channels —
  and the operator-owned **signing-key inventory**; see
  [Availability, submissions and keys](/docs/features/ship-builds/channels/availability/).
- **Storefront feeds** per release track — AltStore and SideStore sources, an AltStore PAL source,
  Obtainium configs, an F-Droid repository signed by CI and relayed here, a Scoop manifest and
  Flathub checker JSON; see [Storefront feeds](/docs/features/ship-builds/channels/feeds/).
- **Package feeds** on the registry host (`https://pkg.plrs.im`) for npm, PyPI, SwiftPM, Maven
  and Gradle, OCI and Godot clients, with one access check before every cached answer; see
  [Package feeds](/docs/features/ship-builds/packages/).
- **A public download page** per product on the bytes host (`https://dl.plrs.im/<product>`):
  one primary action for the visitor's platform, every other way to get the product with deep
  links and QR codes, every build with its SHA-256, and the signing-key fingerprints. It is
  rendered server-side with no script, sandboxed, and never served on the console host; its model
  is `GET /<product>/distribution/download.json`. See
  [Downloads and app stores](/docs/help/download/).
- **A discovery fragment** advertising the canonical byte URLs; `configured` is `true` once the
  product has a release configuration:

  ```json title="Response"
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
  [Update health](/docs/features/ship-builds/channels/update-health/).
- **The commerce bridge**: App Store, Google Play and Steam purchases of products you map become
  license flags per deliverable, verified with each store and revoked on refund. See
  [Commerce bridge](/docs/features/commerce/).
- **A console section**, shown only while Distribution is on: the
  [Matrix](/docs/features/ship-builds/channels/) (releases × channels, with a drawer per cell holding
  its readiness and rollout controls), **Rollouts**, **Channel setup** (capabilities, storefront
  feed URLs and, per channel, its own page), **Access** (delivery access per deliverable), **Health**
  (the funnel, the auto-halt and the Sentry candidates) and **Credentials**. The
  Release → Distribution → Update chain is shown on **Core → Services**.

With Distribution off, a product serves no downloads at all: every byte route and alias answers
not-found.

Because it owns the `distribution` path segment, a manual release crack named
`distribution` loses the short `/<product>/distribution/appcast.xml` alias; its canonical
`/<product>/update/distribution/appcast.xml` keeps working.

## Channels and transports

A product declares where it is distributed in `.pkey/distribution` — see
[Distribution: channels, transports and listing](/docs/build/manifest/distribution/). No file
means one implicit channel, the Polaris Key channel (`direct`), served by `pkey-cdn`. On link and resync, Distribution's
own ingest hook (run by Core, in the same batch as the rest of the ingest, only while
Distribution is on) writes:

- **`dist_outlets`** — one row per channel: its kind, normalized identity (`identity_json`) and
  merged listing (`listing_json`). A row changes only when the manifest changes it; a channel the
  manifest drops gets `removed_at` and is kept, because availability history refers to it.
- **`dist_transports`** — the resolved transport for every declared deliverable on every live
  channel.

## Channels that run in CI

These channels are written by a tool or a pull request, not by Polaris Key's own calls. Declare each with `pkey channel add <id> [--field name=value]` (it writes `.pkey/distribution` and validates it first), put its secret in the publish step's environment, and the Action's `channels: auto` runs `pkey channel sync` after an app `release publish`. A channel whose secret is unset is skipped, naming the variable. `--dry-run` (or the Action's `dry-run`) prints the plan and runs nothing.

| Channel                                                   | Declare                                            | Secret                        | What sync runs                             |
| --------------------------------------------------------- | -------------------------------------------------- | ----------------------------- | ------------------------------------------ |
| [itch.io](/docs/features/ship-builds/channels/itch/)      | `target`                                           | `BUTLER_API_KEY`              | `butler push` per platform build in `dir`  |
| [Snap Store](/docs/features/ship-builds/channels/snap/)   | `name`, `channels`                                 | `SNAPCRAFT_STORE_CREDENTIALS` | `snapcraft upload` of the `.snap` in `dir` |
| [Homebrew](/docs/features/ship-builds/channels/homebrew/) | `homebrewTap`, `homebrewCask` or `homebrewFormula` | `PKEY_PR_TOKEN`               | a pull request to your tap                 |
| [Scoop](/docs/features/ship-builds/channels/scoop/)       | `scoopBucket`                                      | `PKEY_PR_TOKEN`               | a pull request to your bucket              |
| [winget](/docs/features/ship-builds/channels/winget/)     | `packageIdentifier`                                | `PKEY_PR_TOKEN`               | a pull request to `microsoft/winget-pkgs`  |
| [Flathub](/docs/features/ship-builds/channels/flathub/)   | `appId`                                            | `PKEY_PR_TOKEN`               | a pull request to `flathub/<appId>`        |

The F-Droid repository is also built in CI, from the APKs in `dir`: see [Install sources](/docs/features/ship-builds/channels/feeds/#the-f-droid-repository). Which channels run in CI is the `ci` and `pr` plane on [Channels](/docs/reference/channels/).

```yaml title=".github/workflows/release.yml"
- uses: vladzaharia/polaris-key/actions/publish@<sha>
  with:
    args: --tag ${{ github.ref_name }} --channel beta --dir dist
  env:
    BUTLER_API_KEY: ${{ secrets.BUTLER_API_KEY }}
    PKEY_PR_TOKEN: ${{ secrets.PKEY_PR_TOKEN }}
```

Keep each store's secret in its own GitHub environment, with required reviewers for the jobs that release to production. The steps only run commands the store's CI allow-list admits (`pkey storefront allow-list` prints them), and each is reported into the store's ledger beside the console's. See [Publishing from CI](/docs/features/ship-builds/ci/) for the token exchange.

### Pull-request channels

Homebrew, Scoop, winget and Flathub share these rules. `PKEY_PR_TOKEN` is a CI secret and never reaches Polaris Key; the step never merges, closes or deletes anything and never force-pushes.

- **One pull request per version.** If one for the package and version is already open or merged, the step records it and opens nothing, so re-running a job never opens a second one.
- **Dry run.** `pkey storefront <store> pr --dry-run` prints the plan; with `--out <dir>` it also writes the generated files. It needs no token.
- **Status.** `pkey storefront <store> status` reads the pull request back; the console's ledger shows its state and review labels.
- **Options sync does not take** (`--portable`, `--command`, `--app`, `--license`) go on the store's own command: the Action's `command: storefront <store> pr`.

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
the default is ignored, so the answer can only ever be narrower than the table.

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

## The channel page

Every channel has one page in the console: **Ship builds → Channel setup**, then the channel. Its
tabs show only what applies to the channel:

- **Status**: delivery state, what needs attention, platforms.
- **Releases**: the channel's releases and rollouts. On App Store it also holds the
  [Distribute flow](/docs/features/ship-builds/channels/app-store-distribute/).
- **Listing**: the store listing and its fit, for stores that take one.
- **Sales**: purchases and the product map, for stores that sell.
- **Setup**: the store keys and, where the store has a connector, its controls.

The Docs button opens the channel's own page below, or this page for a channel without one
(AltStore, F-Droid, Obtainium, TestFlight, web, app installer, Play testing and AltStore PAL).

## Channel credentials

A store connector signs in to its store with an **channel credential** — an App Store Connect API
key, the App Store webhook secret, a Google service account or a Partner Center app. Those live
in Core, in their own sealed table, and Distribution is the only service that can open one
(`core/outletCredentials.ts`, held to that by a test); every open is audited. The JWTs and access
tokens a connector mints from them (`core/outletTokens.ts`) are cached, sealed, and keyed by a
non-secret version of the credential, so the cache is checked first and a credential is opened
only when a fresh token is needed. Operators set a store's keys on its channel page, **Setup** tab (**Ship builds → Channel setup**); keys that belong to no channel stay on **Ship builds → Credentials**. See
Channel credentials (platform admins). The first connector is
the [App Store Connect connector](/docs/features/ship-builds/channels/app-store/), then the
[Google Play connector](/docs/features/ship-builds/channels/google-play/) and the read-only
[Microsoft Store connector](/docs/features/ship-builds/channels/microsoft-store/).

## The shared listing

A product's store listing is kept once, in Distribution, and projected to every store's limits:
see [Storefront listing](/docs/features/ship-builds/channels/polaris-key/). The AltStore and Obtainium feeds read it,
falling back to `.pkey/distribution` `listing` field by field.

## Store channels

Store rules (App Store Review Guideline 3.1.1, Google Play payments) do not let an app sold
through the store unlock features with a license key bought elsewhere, or link out to buy one.
The channel a build came from decides it, and every SDK resolves the channel the same way (the
build stamp, then attested and declared signals; `outlet-matrix.json`).

## Decide from the channel's `commerce` capability

| `commerce`  | Channel kinds                                                 | Key entry and "Buy" links                            |
| ----------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `store-iap` | `app-store`, `testflight`, `play`, `play-testing`, `ms-store` | hide                                                 |
| `steam`     | `steam`                                                       | hide outside purchase links; keys only through Steam |
| `own`       | `direct`, `itch`, `flathub`, `snap`, `winget`, `web`, …       | show                                                 |
| `none`      | `unknown`                                                     | show key entry; no store purchase                    |

```ts title="TypeScript"
import { effectiveCapabilities } from "@polaris-key/client-core";
import type { PolarisKeyClient } from "@polaris-key/node";

export function showKeyEntry(client: PolarisKeyClient): boolean {
  const outlet = client.update.outlet; // resolved from the build stamp and signals
  const caps = outlet
    ? effectiveCapabilities(outlet.kind, {
        platform: "macos",
        subkind: outlet.subkind,
      })
    : null;
  return (
    caps === null ||
    (caps.commerce !== "store-iap" && caps.commerce !== "steam")
  );
}
```

Godot exposes the same table as `PKeyDecision.effective_capabilities(kind, {platform = ..., subkind = ...})`,
with the channel from `PolarisKey.update.outlet()`. Stamp the channel at export (`pkey` CI or the
Godot export plugin), so a store build never relies on run-time detection alone.

The UI kits do not hide key entry on these channels. Pass the decision to the activation screen yourself. Purchases on a store channel go
through the store and the [commerce claim](/docs/features/commerce/).

## What a pause or halt reaches

A pause or halt stops offering the release on that channel in the signed release track feed, the
app-updater feeds (the Sparkle appcast, `/update/version` and the rest), the storefront feeds
(AltStore, F-Droid, Scoop) and the public [download page](/docs/help/download/), which list
the previous release instead. Moving download URLs apply yanks and pins, not holds: to take a
release off every surface, yank it or pin the release track under **Ship builds → Releases**. See
[Rollouts and halts](/docs/features/ship-builds/channels/rollouts/#what-a-halt-reaches).

## The other Distribution pages

- **Rollouts** lists every rollout of the product, halted ones first, with its release, channel,
  release track, percentage, state, source and who changed it when. Filter by state and channel; each
  row's menu has the same moves as the drawer, and **Open in matrix** opens its cell.
- **Channel setup** lists the declared channels with their kind, transports and capabilities.
  A channel's drawer shows its identity, its capabilities against its kind's default, and, for
  AltStore, AltStore PAL, Obtainium, the F-Droid repository, Scoop (the Polaris Key channel, `direct`) and
  Flathub, the public [feed URL](/docs/features/ship-builds/channels/feeds/) of each release track with a copy
  button. **Narrow what it allows…** can only narrow below the kind's default; **Revert to
  manifest** (from the source badge) restores it. Below the channels, **Distribution keys** is the
  signing-key inventory: add, edit or remove an entry, and add or dismiss a key CI reported that
  matches none.
- **Access** sets who may download each deliverable: the app and each pack, each saved on its own;
  see [Delivery access](/docs/features/ship-builds/channels/delivery/).
- **Health** is [update health](/docs/features/ship-builds/channels/update-health/): the funnel per
  rollout, the auto-halt and the Sentry halt candidates.
- **Credentials** holds the keys that belong to no channel, such as the Sentry integration
  secret; each store's own keys are on its channel page, **Setup** tab; see Channel credentials (platform admins). Its
  **Store connectors** cards show each connector's state, which key it uses (the product's own or
  the platform's team key, see Store connections) and its
  configuration actions: App Store Connect **Release this version**, **TestFlight public link**
  and **Webhook setup**; Google Play **Update priority** and **Settings**. **Release this
  version** cannot be undone, so it asks you to type the app's name exactly as App Store Connect
  shows it; the Worker checks the name against App Store Connect before it releases.

The release × channel readiness also appears on **Ship builds → Compatibility**.
