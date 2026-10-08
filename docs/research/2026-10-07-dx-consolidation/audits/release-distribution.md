# Audit: release artifacts, OS/arch gating, distribution channels vs storefronts, parity, console navigation

**Domain.** `packages/worker/src/services/release/*`, `services/distribution/*` (outlets, transports,
availability, rollouts, readiness, storefront feeds, the download page, connectors, the A-18 storefront
runtime, the commerce bridge), `core/storefront/*` (the A-18 adapter layer), hosted assets and mirroring
(HA), deliverable/platform/arch metadata, the console's Release, Distribution and Update sections and their
navigation, the public download page and the portal product page's "Get it".

**Tree read.** `/Users/vlad/Repos/pk-wt/dx-plan` at `38d3acc68` (v0.8.31 plus batch 5). In-flight branches
read where relevant: HA-12 (`/Users/vlad/Repos/pk-wt/HA-12`, presentation in discovery, the one wire event in
this domain, in its lead round) and LX-08 (`/Users/vlad/Repos/pk-wt/LX-08`, licensing expand; no change in
this domain, but commerce grants land on its tables). UK-13 and UK-14 (terminal kits) do not touch this domain.

**Path shorthands.** `W/` = `packages/worker/src/`, `A/` = `packages/admin/src/`, `SM/` =
`packages/shared-manifest/src/`, `SP/` = `packages/shared-protocol/src/`, `C/` = `packages/cli/src/`,
`P/` = `docs/research/2026-09-29-godot-omniplatform/program/`, `N/` = `docs/research/2026-09-29-godot-omniplatform/notes/`.

---

## 1. Summary

Polaris Key's release and distribution engine is deep and mostly right: one release truth store with three
deliverable kinds (`app`, `pack`, `package`), every artifact carrying platform, arch, format, role and
SHA-256; outlets with operator-narrowed capabilities; per-outlet rollouts that mirror store rollouts; eleven
storefront adapters behind one gate, ledger and budget; storefront feeds (AltStore, F-Droid, Obtainium,
Scoop, Flathub); a public download page that already shows the right action per channel; and hosted copies
of every release file (HA-08). The weakness is not capability, it is **shape**: four overloaded words
("storefront", "channel", "feed", "outlet"), a Distribution sidebar of eleven fixed items where one store
lives in up to seven places, no platform gating anywhere in the console, the same store-app identity typed
into three records, two listing truths (the portal shows the manifest's listing while the console edits
another), and an operations surface where only the App Store got a real page.

The fix was already designed on 2026-10-05 (SETUP.md §2, Wave 5: UX-50 to UX-71) and is **neither built nor
in the program backlog** (`P/workpackages.json` has zero `UX-` ids). The owner's 2026-10-07 brief changes one
of its core decisions: SETUP.md D1 made "storefront" mean every place a customer gets the app; the owner now
wants **distribution channel** (artifacts, tracks, rollouts) and **storefront** (prices, territories,
purchases, grants) as separate concepts shown on one combined page when both are on, with **one sidebar
entry per channel**.

**The single most important change:** adopt one **channel catalogue** (one declaration per distribution
channel, extending the A-18 adapter registry with platforms, accepted formats, customer actions, an optional
commerce facet and the automation plan) and one Worker read model that computes the product's platforms,
each channel's scope, fit and state. Every surface (sidebar, channel pages, Publish, the download page, the
portal, the CLI) reads that one model instead of the nine parallel per-store tables it reads today. That
single move delivers gating by what you build, per-channel sidebar entries, the combined channel and
storefront page, auto-enable when credentials exist, and parity, with **no wire change**.

---

## 2. Current state (with file references)

### 2.1 Size

| Area                                                                  | Size                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Worker `services/release`, `services/distribution`, `services/update` | ~98,700 lines (`find …                                                                                                                                                                                                                                                  | xargs wc -l`) |
| Worker `core/storefront/` (A-18 adapter layer, rule tables, ledger)   | ~10,700 lines                                                                                                                                                                                                                                                           |
| Console Release, Distribution, Update, storefront, feeds pages        | ~28,100 lines (`A/console/areas/{distribution,storefronts,feeds,update}`, `A/console/pages/release*`, `platformStores.tsx`)                                                                                                                                             |
| D1 tables in this domain                                              | 26 `dist_*`, 30 `release_*`, 3 `update_*`, `store_operations`, `store_edit_leases`, `storefront_daily`, `storefront_seen`, `hosted_assets`, `outlet_credentials`, `platform_credentials`, `platform_credential_pins`, `registry_*` (some are `_v`/`_f` rebuild shadows) |
| `.pkey/distribution` identity fields                                  | 25 across 17 outlet kinds (`SM/distribution.ts:122-250`)                                                                                                                                                                                                                |
| Publish Action inputs                                                 | 38 (`actions/publish/action.yml`), of which `storefront`, `itch-platform`, `storefront-outlet`, `transport`, `steam-*`, `pad-delivery`, `asc-expect-resource` are per-channel                                                                                           |

### 2.2 Vocabulary actually in use

| Word           | Meanings in the tree today                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **channel**    | (1) release channel `stable`/`beta`/`dev`/`pr-N`/manual, wire (`W/core/channels.ts`, `X-PKey-Channel`, the `channels` entitlement); (2) the owner's "distribution channel"; (3) store-native lanes: snap channels, itch channels (`SM/distribution.ts` `channels`, `target`); (4) pack channels (`content.packChannels`)                                      | `packages/docs/.../start/concepts.md:195`, `:481-482` ("Distinct from a channel")                                                                            |
| **storefront** | (1) A-18's adapter for a store a build is pushed to (`W/core/storefront/adapter.ts:62-75`, 11 ids), which is the owner's "distribution channel"; (2) the S-21 "Polaris Key storefront" (Discover, obtain paths); (3) SETUP.md D1 "every place a customer gets the app"; (4) the owner's 2026-10-07 meaning: commerce (prices, availability, payments, grants) | `adapter.ts`, `N/S-21-polaris-storefront.md` decision 1, `docs/design/SETUP.md:93`                                                                           |
| **feed**       | (1) the signed channel feed `pkey-feed+jws`; (2) updater feeds (Sparkle, WinSparkle, Velopack, `.appinstaller`); (3) storefront feeds (AltStore source, F-Droid repo, Obtainium, Scoop, Flathub checker, `W/services/distribution/feeds/`); (4) package feeds (`pkg.plrs.im`, `W/services/distribution/registry/`)                                            | `A/console/nav.ts:630-631` ("Package feeds", so it does not collide with "Outlets & feeds"); `concepts.md:456` ("Not an outlet … and not a storefront feed") |
| **outlet**     | the wire and manifest identifier for a venue (`SP/distribution.ts:9-27`, `dist_outlets`)                                                                                                                                                                                                                                                                      | console still labels "Outlets & feeds" (`nav.ts:567-575`)                                                                                                    |

The console therefore shows "Channels" (release channels, `nav.ts:488`), "Outlets & feeds", "Storefronts",
"Package feeds", Update "Feed" and "Store connections": six nouns for overlapping things.

### 2.3 Release artifacts and platform metadata

- **Deliverable kinds** `app`, `pack`, `package` (`SM/index.ts:827` `DELIVERABLE_KINDS`). App artifacts are
  declared in `deliverables.app.artifacts[]` with `platform`, `arch`, `format`, `role`, `match`, `embeds`
  (`SM/index.ts:427-443`). Platforms `macos ios android windows linux web` (`SM/index.ts:781`), arches
  `arm64 x86_64 universal armv7 wasm32 any` (`:792`), roles `payload files-index chunk-index chunk-bundle
delta signature checksum` (`:815`). `format` is free text (`ARTIFACT_FORMAT_PATTERN`), not a known table.
- **Hashes.** Every artifact row carries a SHA-256; the CI-signed release record pins it; the public download
  page renders a SHA-256 column and key fingerprints (`W/services/distribution/page/render.ts:456-470`); the
  console release record shows it (`A/console/pages/release/ReleaseRecord.tsx:99`). There is no generated
  checksum file: the legacy `/dl/…?checksum=sha256` only serves a sidecar the developer published
  (`W/services/release/source.ts:18-20`), and `customer.ts` filters sidecars out of downloads
  (`page/customer.ts` `SIDECAR_RE`). MD5 exists only where Maven requires sidecars.
- **Build metadata extracted in CI.** `C/buildMetadata.ts` reads the IPA's `CFBundleIdentifier`, the APK's
  package name, version codes, min OS and signer, and ships them in the descriptor. Polaris Key therefore
  already knows most store identities from the builds themselves.
- **Platforms per deliverable** are computed for the console (`W/services/release/admin.ts:691-769`
  `platformsOf`), but nothing outside the Release pages reads them.
- **Ingest paths.** GitHub release sync (`sync.ts`, `github.ts`, `githubApp.ts`), CI descriptor publish
  (`publish.ts`, `descriptor.ts`), native package publish (`packages/native/*`), pack ingest (`packs/ingest.ts`).
- **Mirroring (HA-08, done).** Every GitHub-only or external app file gets a verified R2 copy; `serveArtifact`
  ranks `r2` first (`W/services/release/mirror.ts:1-30`). The portal still prefers GitHub's
  `browser_download_url`, which 404s for private repos, until **HA-09** (todo).
- **Feed retention exists.** `release.packages.prunePrereleases` prunes `X-main.N` / `X.devN` once `X` is
  stable (`W/services/release/packages/prune.ts:1-60`, `settings.ts:103-142`), off by default for tenants,
  always on for the system product. The owner's "clean up in-progress builds" item is already built.

### 2.4 Distribution core

- **Outlets** (`W/services/distribution/outlets.ts`): `.pkey/distribution` owns `kind`, identity and listing;
  the operator owns capability narrowing (`setCapabilityOverride`). 17 kinds (`SP/distribution.ts:9-27`),
  each with a platform list `OUTLET_PLATFORMS` (`SP/distribution.ts:105-125`, wire, used by the outlet matrix
  corpus and the signed feed's composition, `W/services/update/compose.ts:200`).
- **No `homebrew`, `scoop`, `npm` or `pypi` outlet kind.** Homebrew and Scoop ride on the `direct` outlet's
  identity (`homebrewCask`, `homebrewTap`, `scoop`, `scoopBucket`, `SM/distribution.ts:170-200`); package
  feeds are not outlets at all (`concepts.md:452-456`).
- **`direct` without `platforms` means five platforms** (`readiness.ts:206-213` `outletPlatformsOf`), which is
  why the djdl manifest must say `platforms: [macos]` (`SM/test/fixtures/djdl/distribution.yaml`).
- **Transports** (`outlets.ts:178-206`): `pkey-cdn`, `web`, `embedded`, `apple-ba`, `play-pad`,
  `steam-depot` supported; `msix-optional`, `flatpak-ext` stored but unsupported (SP-29, SP-30 todo).
- **Availability, readiness, holds** (`availability.ts`, `readiness.ts`): derived for self-hosted outlets,
  reported for stores; a release missing required packs is held on outlets Polaris Key controls.
- **Rollouts** (`rollouts.ts:1-45`): one row per (outlet, channel), verbs set, pause, resume, halt,
  complete; store rollouts are **mirrored** rows that refuse direct edits (`rollout_mirrored`); store verbs
  are separate connector controls (`StoreControls.tsx:1-15`).
- **Settings** (`W/services/distribution/settings.ts`): `distribution.access`, `distribution.capabilities`,
  `distribution.outlets`, `distribution.transports`, `distribution.commerce`.

### 2.5 The A-18 adapter layer ("storefronts", which are the owner's distribution channels)

- `W/core/storefront/adapter.ts`: `StorefrontAdapter` with 19 operations (`STOREFRONT_OPS`, `:77-100`) that mix
  distribution (`identifiers`, `createApp`, `uploadBuild`, `testers`, `submit`, `release`, `rollout`,
  `status`) and commerce (`pricing`, `iap`); a `Support` per op; a gate, never-list, CI allow-list, PR plane,
  listing profile and typed confirmation per store. Registry of **11** (`:182-194`): app-store, google-play,
  microsoft-store, itch, snap, steam, winget, homebrew, scoop, flathub, polaris-key.
- **The adapter declares no platforms and no accepted formats** (interface `:136-180`). AltStore, AltStore
  PAL, F-Droid, Obtainium, App Installer and Web have outlet kinds and feeds but no adapter.
- Planes: Worker API (ASC, Play, Microsoft Store, Steam reads/branches), CI (`ciPlane.ts`: itch `butler`,
  `snapcraft`), PR (`prPlane.ts`: winget, Homebrew tap, Scoop bucket, Flathub), first-party (`firstParty.ts`).
- CLI: `pkey storefront <id> <cmd>` per store (`C/storefronts/*`, `C/index.ts:498`); the Action runs one store
  per step through its `storefront` input (`C/action.ts:62-75` `ACTION_STOREFRONT_STEPS`). There is no
  "run every declared channel" step (SETUP's `pkey storefronts sync`, UX-56, unbuilt).
- **Nothing runs when a release arrives** for API stores: TestFlight distribution, Play internal track and
  submission preparation are all operator-started (no trigger in `services/` or `core/`; SETUP D35/D36 unbuilt).

### 2.6 Commerce pieces (all inside the Distribution service today)

- **Store commerce bridge (P6-01)**: `W/services/distribution/commerce/` (App Store, Play, Steam purchases →
  licence flags), "hidden unless set up" (`commerce/index.ts:1-30`). Its settings repeat the store app's
  identity: `appStore: { bundleId, appAppleId }`, `play: { packageName }`, `steam: { appId }`
  (`commerce/settings.ts:9-11`).
- **Console Commerce page** = App Store in-app purchases only (`A/console/areas/distribution/CommercePage.tsx:1-20`).
- **Polaris Key storefront (S-21, PS-\*)**: listing state, audience, obtain paths in `portal_product_settings`
  (`W/core/storefront/polarisKeyListing.ts`), the console panel `PolarisKeyPanel.tsx` (PS-06, in review).
- **Polaris Key commerce (S-22, CM-\*)**: Stripe merchant, offers, checkout, all todo, phase "deferred until
  the owner's go"; planned under `W/services/distribution/commerce/checkout/`.

### 2.7 Listing and presentation: four stores of one product's presentation

| Store                                                                                              | Written by                                  | Read by                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist_listing` (one JSON blob, `0063`)                                                             | manifest ingest only (`outlets.ts:126-146`) | **the portal** (`W/services/identity/portal/media.ts:37`, `library.ts:142`, `store/obtain.ts:517`, `store/panelStatus.ts:162`, through `delivery().listing()`, `delivery.ts:132` → `outlets.ts:214`) |
| `dist_listings`, `dist_listing_locales`, `_assets`, `_release_notes`, `_overrides` (A-18b, `0065`) | console Listing editor, imports             | store pushes (A-18e/f/m), fit report                                                                                                                                                                 |
| `dist_outlets.listing_json` (per outlet merged copy)                                               | manifest ingest                             | storefront feeds, download page                                                                                                                                                                      |
| `hosted_assets` slots + `.pkey/product presentation` (HA-04/06)                                    | manifest, console Presentation page         | image host, portal art, (HA-12) discovery                                                                                                                                                            |

An operator who edits the description in Distribution → Listing changes what the App Store gets, **not**
what the customer portal shows. Four console homes edit parts of it: Core → Presentation
(`A/console/pages/core/Presentation.tsx`), Distribution → Listing (`areas/storefronts/ListingPage.tsx`), the
Polaris Key panel, and (planned) ST-13's settings-hub copy.

### 2.8 Credentials

`outlet_credentials` (product keys, P5-01, `W/core/outletCredentials.ts`), `platform_credentials` +
`platform_credential_pins` (team keys and the one app each product may act on, A-16,
`W/core/platformCredentials.ts:1-50`). Console homes: Distribution → Outlet credentials
(`CredentialsPage.tsx`, which also carries the Play and Microsoft connector cards), Platform → Store
connections (`A/console/pages/platformStores.tsx`, 1,789 lines), and Keys & secrets. SETUP D23 decided
"one home per credential"; unbuilt. UX-69 (live key check on paste) is done.

### 2.9 Console navigation today

`A/console/nav.ts` sections (product scope):

| Section                   | Items                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core (`:247-340`)         | Overview, Services, Devices, Users, **Presentation** (HA-06), Keys & secrets, Activity, Settings                                                                                                                                                                                        |
| Release (`:464-538`)      | Releases, **Channels** (release channels), Deliverables, Compatibility, (Update simulator, hidden), Content keys                                                                                                                                                                        |
| Distribution (`:540-671`) | **Matrix** (`:548`), Rollouts (`:558`), **Outlets & feeds** (`:567`), **Storefronts** (`:578`), **Listing** (`:592`), **App Store** (`:602`), **Commerce** (`:612`), **Access** (`:621`), Package feeds (`:632`, the only `requires`), Health (`:653`), **Outlet credentials** (`:662`) |
| Update (`:673-688`)       | Feed                                                                                                                                                                                                                                                                                    |
| Platform group            | Settings, Deployment, Operations, **Store connections**, **Package feeds**, Override migration                                                                                                                                                                                          |

Observations:

- Eleven fixed Distribution items; `NavRequirement` has one value, `"packageFeeds"` (`nav.ts:185`), so **App
  Store and Commerce show for a Linux-only or Windows-only product**.
- **Matrix** is still a nav item with shortcut `m` although UX-31 made it a Rollouts view
  (`areas/distribution/MatrixPage.tsx:1-5`).
- **Only the App Store has a page** (`AppStorePage.tsx`, 1,830 lines). Google Play and the Microsoft Store
  appear as connector cards on Outlet credentials and as verbs in the matrix cell drawer; Steam inside the
  Storefronts flow. There is no parity of console surface between stores.
- The A-18j Storefronts page is a tile grid plus a seven-step multi-store flow (`StorefrontsPage.tsx:62-90`);
  only `polaris-key` has its own page (`STORE_PANELS`, `:57-63`).
- Update → Feed shows every updater endpoint whatever the product ships (`A/console/areas/update/FeedPage.tsx`
  has no platform read at all).
- Labels for the same stores are kept in at least nine tables: `A/lib/labels.ts:102`,
  `A/console/areas/storefronts/data.ts:108`, `A/console/pages/platformStores.tsx:113`,
  `A/console/areas/distribution/format.ts`, `A/portal/model/library.ts:314`,
  `W/admin/handlers/platformStoreConnections.ts:137`, `W/services/identity/licenseChoice.ts:196`,
  `W/services/distribution/page/model.ts:555`, `W/core/storefront/listingProfiles.ts:115`.

### 2.10 Customer surfaces

- **Public download page** (`W/services/distribution/page/model.ts`, P2b-06): 16 action kinds (`ActionKind`,
  `:93-112`) including `homebrew`, `scoop`, `winget`, `altstore`, `sidestore`, `obtainium`, `fdroid`, store
  links, per-platform priority (`:381-388`), SHA-256 per file and key fingerprints. This is already close to
  the owner's "customers see whatever the channel needs".
- **Portal "Get it"** (`A/portal/components/product/GetItPanel.tsx`, reading `customerDownloads`,
  `W/services/distribution/page/customer.ts`): store links only for `STORE_KINDS` (8 kinds,
  `customer.ts:242`; `model.ts:369-378`). **No Homebrew, Scoop, AltStore, F-Droid or Obtainium** for a signed-in
  owner, although a stranger on the download page sees them. PX-09 (todo) completes the panel but its design
  (PORTAL.md §4.20, "Also yours on") lists store pills only.
- **Package feeds** for customers: `PackageAccessCard.tsx` (setup snippets, registry tokens, F-21).

### 2.11 Specs in flight for this domain

- **SETUP.md §2** (2026-10-05): one catalogue, one page per storefront, scoping by platforms (D3, D4),
  artifact fit, a state machine, Publish everywhere (D10), automation pass (D26-D48). Packages UX-50 to UX-71
  (EXPERIENCE.md:1505-1528). Only **UX-59** (SDK quick start) and **UX-69** (live key check) are merged; the
  storefront ones (UX-52 to UX-58, UX-68, UX-70, UX-71) are unbuilt and unregistered in the backlog.
- **EXPERIENCE.md:159** plans Distribution as five items; **SETUP.md §2.2** as four; the code has eleven; the
  owner now asks for one entry per channel.

---

## 3. Problems (ranked)

| #   | Problem                                                                                                                                                                                                                                                                               | Evidence                                                                                                       | Impact      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | **Vocabulary collision, and the owner's model inverts the current one.** "Storefront" in code and SETUP.md means the distribution channel; the owner now uses it for commerce. "Channel" means release channels in the console. "Feed" has four meanings.                             | §2.2; `adapter.ts:62-100` mixes `uploadBuild`/`rollout` with `pricing`/`iap`; `nav.ts:630-631`; SETUP.md:93 D1 | high        |
| 2   | **No gating by what the product builds, anywhere in the console.** Adapters have no platforms; App Store and Commerce nav items have no requirement; the Update feed page shows Sparkle to a Windows app; `intendedPlatforms` does not exist (`grep` finds nothing).                  | `adapter.ts:136-180`; `nav.ts:185, 602-620`; `update/FeedPage.tsx`; SETUP.md §0 finding 3                      | high        |
| 3   | **The designed fix is not schedulable.** SETUP.md's Wave 5 is unbuilt and absent from `P/workpackages.json`; the lead cannot dispatch what is not in the backlog.                                                                                                                     | `python3 … [w for w in wps if w['id'].startswith('UX')]` → `[]`                                                | high        |
| 4   | **One store, up to seven homes; eleven fixed Distribution items; no per-store parity in the console.** App Store has a 1,830-line page, Play and Microsoft only connector cards, Steam only a flow.                                                                                   | §2.9; SETUP.md §0 finding 4                                                                                    | high        |
| 5   | **Two listing truths.** The portal shows the manifest-only `dist_listing`; the console's Listing editor writes `dist_listings*`; Presentation and the Polaris Key panel edit other parts; ST-13 would add a fourth home.                                                              | §2.7                                                                                                           | high        |
| 6   | **The same store-app identity in three records**: manifest outlet identity, platform credential pin, commerce settings. Setting up the App Store channel and then selling on it means entering the app twice: exactly the owner's complaint.                                          | `SM/distribution.ts:234`; `platformCredentials.ts:25-31`; `commerce/settings.ts:9-11`                          | medium-high |
| 7   | **Operations parity gaps.** "Halt everywhere" skips mirrored store rollouts with "Halt it in Google Play" although Play halt is API-backed; no Publish everywhere; nothing happens automatically when a release arrives for API stores; each CI/PR channel needs its own Action step. | `RolloutDialogs.tsx:593-598`; `C/action.ts:62-75`; §2.5                                                        | medium      |
| 8   | **Customer surfaces diverge.** A signed-in owner sees fewer channels in the portal than a stranger sees on the download page.                                                                                                                                                         | `customer.ts:242` vs `model.ts:93-112`                                                                         | medium      |
| 9   | **Nine parallel per-store tables** (labels, kinds, priorities, credential slots), each edited by hand when a store is added.                                                                                                                                                          | §2.9 last bullet; `page/model.ts:369-388`; `feeds/select.ts`; `HOLDABLE_OUTLET_KINDS`                          | medium      |
| 10  | **Three service switches for one pipeline.** Byte serving moved to Distribution (P2b-04, `source.ts:6`), so Release without Distribution cannot serve a download; Update needs Distribution.                                                                                          | `tools/services.json` rows; `concepts.md:107`                                                                  | medium      |
| 11  | **Credentials in three homes** (Outlet credentials, Store connections, Keys & secrets); Play and Microsoft controls live on a credentials page.                                                                                                                                       | §2.8; `StoreControls.tsx:8-11`                                                                                 | medium      |
| 12  | **The manifest asks for identities Polaris Key can derive.** 25 identity fields; bundle id and package name are already extracted from builds; App ids are listed by team keys; `direct.platforms` must be typed to avoid a five-platform default.                                    | `SM/distribution.ts:122-250`; `C/buildMetadata.ts:1-20`; `readiness.ts:206`                                    | low-medium  |
| 13  | **Centralized registries (npmjs, PyPI, crates.io) are not channels**; NuGet absent (F-32 optional).                                                                                                                                                                                   | no `registry.npmjs.org` publish path in `C/` or `actions/`                                                     | low         |
| 14  | **Homebrew is cask-only**, so a CLI on macOS or Linux gets no formula (`homebrewFormula` is detection-only).                                                                                                                                                                          | `core/storefront/stores/homebrew.ts:1-12`; SETUP.md D5                                                         | low         |
| 15  | **No generated checksum file per release**; only a developer-published sidecar is served.                                                                                                                                                                                             | `source.ts:18-20`                                                                                              | low         |

---

## 4. Owner brief: item-by-item stance

| #   | Owner item                                                                                                                               | Stance                              | Reason and how                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Release delivers applications, content packs, packages and hashes                                                                        | **adopt** (exists)                  | `app`, `pack`, `package` deliverables exist (`SM/index.ts:827`); SHA-256 on every artifact and in every signed record. Add a generated `SHA256SUMS` per release (DC-15).                                                                                                                                                                                                                                                            |
| R1a | MD5 hashes                                                                                                                               | **push back**                       | MD5 is collision-broken and adds nothing a SHA-256 does not; offering it invites people to verify with it. Keep SHA-256 (Maven's MD5/SHA-1 sidecars stay because Maven needs them).                                                                                                                                                                                                                                                 |
| R2  | Content restricted to an OS or arch; console and customer UI reflect it                                                                  | **adopt**                           | The data exists (artifact map, published builds, `OUTLET_PLATFORMS`). One computed `productPlatforms` (DC-03) gates the console; the customer side already scopes by builds and gets one shared action model (DC-09).                                                                                                                                                                                                               |
| R3  | No macOS channels or storefronts without a macOS build                                                                                   | **adopt, with an escape hatch**     | Out-of-scope channels are absent from nav, catalogue, Publish and palette (SETUP D4). "Planned platforms" (`distribution.intendedPlatforms`) lets a developer set up a store before the first build. A channel already declared stays visible with an attention line.                                                                                                                                                               |
| C1  | Channel list: Polaris Key, Steam, App Store, TestFlight, Play, itch.io, NuGet/WinGet, Homebrew, package feeds (internal and centralized) | **adapt**                           | All but NuGet and centralized registries exist. **TestFlight is a track of the App Store channel**, not a channel (SETUP D7). **NuGet is a .NET library registry, not an app channel**: push back for apps; F-32 stays optional, tied to X-01. **Homebrew** gets formula generation for CLI archives on macOS and Linux (DC-14). **Centralized registries** become CI-plane channels for package deliverables (DC-13).              |
| C2  | Separate distribution channel (artifacts) from commerce storefront (prices, availability, payments)                                      | **adopt; revises SETUP.md D1**      | One channel = delivery facet (always) + optional commerce facet (the storefront). The A-18 op set splits into the two facets in the catalogue (DC-02); code module names stay (renaming `core/storefront/` is churn with no user value).                                                                                                                                                                                            |
| C3  | Not set up → step-by-step; set up → status and what is published                                                                         | **adopt**                           | SETUP.md §2.8 (wizard until first live version, then status page), built as DC-05 and DC-06.                                                                                                                                                                                                                                                                                                                                        |
| C4  | A channel that also sets up its storefront activates it too; consolidate shared settings                                                 | **adopt**                           | One store-app binding per store (the platform pin) feeds outlet identity checks and commerce settings (DC-11). When the channel's credential also covers commerce (Play service account, Steam publisher key, Apple team keys), the commerce facet is "live" for a free app with no step, and "available" to sell with prefilled fields.                                                                                            |
| C5  | Gate channels and storefronts by the type of application                                                                                 | **adapt**                           | Gate by computed facts (platforms, artifact formats, deliverable kinds), never by a declared "app type": no new knob, and the facts cannot drift from the builds. A library product sees package channels only; a CLI tarball makes Homebrew-formula fit; an `.aab` makes Google Play fit.                                                                                                                                          |
| C6  | Automate: enable on the spot after confirmation when requirements exist                                                                  | **adopt**                           | New channel state `available`: every requirement is met (a team key that already sees an app matching the build's bundle id, a macOS `.dmg` for Homebrew with a writable tap, a Windows `.zip` for Scoop). One confirmation runs the setup plan (DC-06, SETUP D34). Implied channels (Polaris Key, Scoop) need no confirmation at all (D26).                                                                                        |
| C6a | New releases sent to distribution channels automatically                                                                                 | **adapt**                           | Automatic for CI, PR and feed channels and for every store's testing tracks (SETUP D36). **Production store submission stays one typed click**, prepared in advance (D31, D35, S-15 §6.4): an automatic submission to Apple or Google is a security and reputational decision the owner's own deny-by-default rules reserve. Offer a per-channel "auto-submit to review" only as a later, owner-approved, security-reviewed option. |
| C7  | Not automatable → step-by-step instructions                                                                                              | **adopt**                           | Human steps only (D32, D33), each with deep links and copy cards from `core/storefront/deeplinks.ts`; A-18k verifies the guessed deep links.                                                                                                                                                                                                                                                                                        |
| C8  | Customers see what each channel needs; several channels per product                                                                      | **adopt**                           | One `customerChannelActions` model (DC-09) feeds the download page, the portal (PX-09) and the React download surface (SP-12): download, store link, install command, source link plus QR, package-feed setup.                                                                                                                                                                                                                      |
| C9  | A sidebar entry per channel, under a sub-section; only relevant and available channels                                                   | **adopt, adapted**                  | Distribution → **Channels** sub-heading lists channels that are live, setting up or `available`; the rest of the in-scope catalogue sits behind **Add channel**. Out-of-scope ones never appear. Showing every possible in-scope channel would make a cross-platform game's sidebar 15 items long.                                                                                                                                  |
| C10 | Combined page when a channel includes a storefront; each side shows a wizard when off                                                    | **adopt**                           | One channel page; the Distribution entry opens its Status tab, the Commerce entry opens its Selling tab; an off facet's tab is its wizard.                                                                                                                                                                                                                                                                                          |
| P1  | Parity: one source of truth that updates all channels at once                                                                            | **adopt**                           | Shared listing (A-18b, made the only truth by DC-10), one store-app binding (DC-11), one Publish (DC-07).                                                                                                                                                                                                                                                                                                                           |
| P2  | Deprecate and push releases, rollouts, across channels                                                                                   | **adapt**                           | One verb façade (roll out, pause, resume, halt, complete, roll back, withdraw) that dispatches to Polaris Key's rows or the store connector, and says why where a store has no API. **Withdraw** is a plan, never a delete: Polaris Key yanks, package feeds deprecate, Play halts, App Store "remove from sale" stays typed, Homebrew gets a revert PR (DC-07).                                                                    |
| P3  | Common base plus per-channel data                                                                                                        | **adopt** (exists in part)          | The listing model already has per-store overrides (`dist_listing_overrides`) and projections with a fit report; the catalogue adds per-channel identity and release extras (Steam depots, ASC export compliance, Play update priority) as channel-specific sections.                                                                                                                                                                |
| G1  | Use platform-level credentials to enable a channel or storefront without steps                                                           | **adopt**                           | Platform team keys already list every app (`platformCredentials.ts:12-16`); DC-06 matches them to build identities and offers "Found Tonebox in your App Store Connect team. Connect?" (a platform admin's one click; D12 keeps team-key writes with platform admins).                                                                                                                                                              |
| G2  | Degrade gracefully: pages show whatever enabled sources provide                                                                          | **adopt**                           | The channel page is facet-aware; the Selling tab reads only enabled commerce sources; the portal shows store links even with commerce off.                                                                                                                                                                                                                                                                                          |
| F1  | Feeds behind licensed tokens ("I believe they're all public")                                                                            | **out of domain, premise outdated** | `pkeyr_` registry tokens, licence-bound and owner-bound, with a per-feed access mode, exist (F-20, F-21, `concepts.md` "registry token"). The real gap is an account-wide token across products (feeds auditor).                                                                                                                                                                                                                    |
| F2  | Clean up `-main.N` builds                                                                                                                | **out of domain, built**            | `release.packages.prunePrereleases` (prune.ts). Recommend default-on for tenant products (feeds auditor).                                                                                                                                                                                                                                                                                                                           |
| M1  | Managed updates, stable/beta/dev                                                                                                         | **cross-domain**                    | Naming only here: release channels become **Update channels** in the UI (DC-01).                                                                                                                                                                                                                                                                                                                                                    |

---

## 5. Target design

### 5.1 One vocabulary (UI word vs unchanged identifier)

| Concept                                                                                               | UI word                                                              | Identifier (unchanged, wire or code)                                            |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A place a build reaches people, with its tracks, rollouts and listing                                 | **Distribution channel** ("channel" inside the Distribution section) | outlet (`dist_outlets`, `.pkey/distribution outlets`), A-18 adapter id          |
| The selling and granting side of a channel: prices, territories, products, purchases, refunds, grants | **Storefront**                                                       | commerce bridge, `dist_store_products`, CM merchant, S-21 `polaris-key` listing |
| `stable`, `beta`, `dev`, manual                                                                       | **Update channel**                                                   | `channel` (`release_channels`, `X-PKey-Channel`, the `channels` entitlement)    |
| TestFlight groups, Play tracks, Steam branches, snap channels, Microsoft flights, itch channels       | **Track**                                                            | identity maps `tracks`, `branches`, `channels`, `flights`, `target`             |
| AltStore source, F-Droid repo, Obtainium, Scoop manifest, Flathub checker                             | **Install source** (part of its channel)                             | storefront feeds (`distribution/feeds/`)                                        |
| npm, PyPI, … on `pkg.plrs.im`                                                                         | **Package feed**                                                     | registry                                                                        |
| Signed feed and Sparkle/WinSparkle/Velopack/App Installer                                             | **Update feed**                                                      | channel feed, updater feeds                                                     |

Glossary (`concepts.md`, AGENTS rule 4) gains these, SETUP.md D1 is amended, and "outlet" and "storefront
feed" leave every console string. This is DC-01, docs only.

### 5.2 One channel catalogue

Extend the A-18 registry (`W/core/storefront/adapter.ts`) into the catalogue SETUP.md §2.3 sketched, with the
owner's two facets. Worker-internal plain data; the CLI copy stays generated (`pnpm gen:storefront-ci`).

```ts
interface ChannelEntry {
  id: ChannelId; // "polaris-key", "app-store", "homebrew", "npm", …
  label: string; // the ONE label every surface uses
  family:
    | "built-in"
    | "app-store"
    | "package-manager"
    | "sideload"
    | "web"
    | "package-registry";
  plane: "first-party" | "api" | "ci" | "pr" | "feed" | "link";
  outletKinds: readonly OutletKind[]; // [] for package registries (no device outlet)
  deliverableKinds: readonly ("app" | "pack" | "package")[];
  platforms: readonly Platform[]; // its OWN list, subset of OUTLET_PLATFORMS[outletKinds]
  formats: Partial<Record<Platform, readonly string[]>>; // fit
  identity: Record<
    string,
    { from: "build" | "team-key" | "listing" | "manifest" }
  >;
  customer: {
    action: "download" | "store-link" | "command" | "source" | "package-setup";
    render: string;
  };
  credential: {
    team?: string;
    product?: string;
    ci?: readonly string[];
  } | null;
  verbs: Partial<
    Record<
      | "publish"
      | "rollout"
      | "pause"
      | "resume"
      | "halt"
      | "complete"
      | "withdraw",
      Support
    >
  >;
  commerce: null | {
    ops: readonly (
      | "products"
      | "pricing"
      | "territories"
      | "ownership"
      | "refunds"
      | "subscriptions"
    )[];
    sharesCredential: boolean; // the channel's credential also serves commerce
    bridge: "appStore" | "play" | "steam" | "polaris-key";
  };
  auto: readonly AutoAction[]; // SETUP §2.3
  human: readonly HumanStep[];
  adapter: StorefrontAdapter | null;
}
```

- **18 entries**: SETUP's 17 (`polaris-key`, `app-store`, `google-play`, `microsoft-store`, `steam`, `itch`,
  `snap`, `flathub`, `homebrew`, `scoop`, `winget`, `altstore`, `altstore-pal`, `fdroid`, `obtainium`,
  `app-installer`, `web`) plus **`packages`** (the product's package feeds on `pkg.plrs.im`, scoped by
  deliverable kind), then DC-13's `npmjs`, `pypi`, `crates-io`.
- **Every per-store table derives from it**: labels (the nine tables of §2.9), `STORE_KINDS`, `PRIORITY` and
  `ActionKind` of the download page, the portal's store labels, `HOLDABLE_OUTLET_KINDS`, Store connections'
  cards. The console never hard-codes a store again; it renders the read model.
- **Wire tables stay where they are** (`OUTLET_KINDS`, `OUTLET_PLATFORMS`, `OUTLET_CAPABILITY_DEFAULTS` in
  `@polaris-key/protocol`); the conformance suite asserts each entry's `platforms` is a subset of its outlet
  kinds' (no wire change, no new outlet kind).

### 5.3 Facts computed once: the read model

One Worker read (extending A-18j's `GET /manage/api/products/<p>/distribution/storefronts`, renamed to
`…/distribution/channels` with the old path aliased; OpenAPI and `routeCoverage`, rule 10):

- `productPlatforms[]` with a source each: `builds` (artifact map and published builds), `outlet` (explicit
  `direct.platforms` only), `detected` (repository, SETUP D45), `planned` (`distribution.intendedPlatforms`,
  a new S-18 registry key, product scope, console-owned).
- `formats` per platform and `deliverableKinds` present.
- Per channel: `scope` (in or out), `fit[]` (SETUP §2.5), **delivery state** and **commerce state**, each one of
  `unavailable · available · not_set_up · setting_up · live · attention · not_using` (`available` is new: every
  requirement met, one confirmation away), `tracks[]` with the version live per track, `install` (the customer
  action), `connection` (credential health).
- The **product summary** that the console shell already loads (`AppShell.tsx:181` reads `packageFeeds` from
  it) carries a compact `channels: [{id, label, delivery, commerce}]` for the sidebar and palette, so the nav
  needs no second request.
- A **manifest warning** (validator, rule 9 mutation-table entry, `schema: "accepts"`): an outlet whose
  platforms have no build in the artifact map, "app-store declared but no ios or macos build". Warning only.

### 5.4 Console information architecture

Product sidebar after the change (Distribution and the new Commerce section; Release relabels one item):

```text
Release            Releases · Deliverables · Update channels · Compatibility
Distribution       Overview · Rollouts · Health
  Channels         Polaris Key · App Store · Homebrew · Steam · + Add channel
Commerce           Overview (CM-12, later)                       [shown when License is on and a storefront is in scope]
  Storefronts      Polaris Key · App Store · Steam
```

- **Distribution → Overview** is SETUP's catalogue (§2.7): scope chips ("macOS · iOS · from your builds"),
  live rows with the version per track and the install hint, setting-up cards, `available` cards with
  **Enable**, the remaining in-scope catalogue collapsed under **Add channel**, and **Publish 2.4.0** as the
  primary when a newer release is not everywhere.
- **Rollouts** keeps UX-31's List · Matrix · Readiness. **Health** unchanged (its thresholds move to the hub,
  EXPERIENCE C29).
- **Channel entries** are dynamic: live, setting up or `available`, in-scope only, Polaris Key first, then by
  the catalogue ranking. A `packages` entry appears when the product declares package deliverables.
- **Commerce → Storefronts** lists channels whose commerce facet is live, setting up or `available`. Its entry
  routes to the **same page** with the Selling tab.
- **Retired items** (8): Matrix (Rollouts view), Outlets & feeds (each channel's Setup → Technical), Storefronts
  tile grid (Overview), Listing (Core → Listing, §5.7), App Store (the App Store channel page), Commerce (the
  Commerce section), Access (settings hub, EXPERIENCE C9), Outlet credentials (channel Connection plus Keys &
  secrets read-out; team keys stay in Platform → Store connections).
- **Routes**: `#/p/<slug>/distribution/channels/<id>[/<tab>]` and `#/p/<slug>/commerce/storefronts/<id>`
  (same component, `facet=commerce`). `LEGACY_REDIRECTS` (`A/console/routes.ts:81`) maps every retired path:
  `distribution/matrix` → `distribution/rollouts?view=matrix`; `distribution/outlets[?outlet=x]` → the channel
  owning outlet `x`, Setup tab; `distribution/storefronts[/<id>]` → Overview or `channels/<id>`;
  `distribution/app-store[?step]` → `channels/app-store/releases[?step]`; `distribution/commerce` →
  `commerce/storefronts/app-store`; `distribution/credentials` → `distribution?view=connections`;
  `distribution/listing` → `listing`.
- `NavRequirement` becomes data-driven (`channels` from the summary) instead of one hard-coded flag
  (`nav.ts:185`); the docsLinks gate covers the new page ids.

### 5.5 The channel page (one page, two facets)

`#/p/<slug>/distribution/channels/<id>`, a record page with tabs:

| Tab          | Delivery facet                                                                                                                                                                                                                                      | Commerce facet                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**   | Live per platform and track, in review, rollout percentage, install action, last store read                                                                                                                                                         | Selling summary line when live ("Free · 3 in-app purchases on sale")                                                                                                      |
| **Releases** | This channel's matrix column, Publish per row, channel extras (ASC export compliance, Play update priority, Steam depots and branch)                                                                                                                | none                                                                                                                                                                      |
| **Listing**  | The shared listing projected to this store, fit report, overrides, Push listing                                                                                                                                                                     | none                                                                                                                                                                      |
| **Selling**  | none                                                                                                                                                                                                                                                | Products and mappings (today's CommercePage for Apple; Play and Steam mappings), prices, territories, ownership checks, refunds; CM's merchant and offers for Polaris Key |
| **Setup**    | Wizard checklist (read-only once live), connection (Re-check, Replace key), "How it gets there" (the verbs and planes from the catalogue), Technical (outlet ids, identity fields as fields, transports, capability narrowing, install-source URLs) | Commerce settings that are not shared (sandbox acceptance, RTDN audience)                                                                                                 |

- A facet that is off shows its **wizard** in its own tabs; the other facet's tabs are unaffected (owner rule).
- **Parity of surface**: Google Play, Microsoft Store and Steam get the same tabs the App Store has, reusing
  `StoreControls.tsx` and the connector cards, which leave the credentials page.
- The Polaris Key channel page is PS-06's panel (Discover → Selling tab: listing, audience, ways to add, Who can
  see this?), the download page, the updater endpoints for shipped platforms only, and "Also installs through
  Homebrew and Scoop" (SETUP §2.10).

### 5.6 Setup, automation and auto-activation

- **Wizard = human steps only** (SETUP §2.8.1: Connect, In the vendor console, Merge, Go live), with the
  **Polaris Key does this** list run by the setup runner (UX-68).
- **`available` detection** (new): the Worker matches build identities (IPA bundle id, AAB package name, MSIX
  family name, from `builds[].metadata`) and the product's name against the apps each platform team key lists;
  a macOS `.dmg` plus a GitHub App with Contents write makes Homebrew available; a Windows `.zip` makes Scoop
  live outright. The card says what was found and **Enable** runs the plan after one confirmation.
- **Commerce auto-activation**: when the channel's credential also serves commerce (`sharesCredential`), the
  commerce facet takes its identity from the store-app binding (§5.8) and becomes `live` for a free app with no
  mappings (nothing can be granted without a mapping, so this is safe) and `available` for selling.
- **Repository changes** arrive in one standing setup pull request (UX-70, owner action: GitHub App write
  permissions); without write, one command (`pkey channel add …`, DC-08).
- **CI**: one Action step `channels: auto` (`pkey storefronts sync`) runs every declared CI and PR channel and
  every transport step the manifest implies; the per-store inputs (`storefront`, `itch-platform`,
  `storefront-outlet`) are deprecated with a warning for one minor, then removed.

### 5.7 One listing truth

- The A-18b model (`dist_listings*`) becomes the only presentation truth for the portal, the download page,
  Discover and every store. `.pkey/distribution listing` and `.pkey/product presentation` are import sources
  (they already are for A-18b), with S-18's claim model (a console edit claims the field; Revert returns it).
- The portal and `delivery().listing()` read the model, falling back to `dist_listing` during a dual-read
  window; `dist_listing` is then retired (DC-10).
- Console: **Core → Listing** (renamed from Presentation, absorbing Distribution → Listing): text per locale,
  images (hosted slots), release notes, fit report, per-store overrides, hosting quotas. It works with
  Distribution off, because the portal's Library needs art either way. Each channel's Listing tab is the same
  editor scoped to that store. ST-13's hub copy is dropped (a third home).

### 5.8 One store-app binding

The platform pin (`platform_credential_pins`) is the binding: written by a platform admin, one product per app.
The commerce bridge's `bundleId` / `appAppleId` / `packageName` / `appId` default from it; the manifest's
outlet identity is checked against it (a mismatch is an attention item, not a silent override); the console's
commerce form shows them as derived values with **Change**. Product-key products (no team key) keep their
explicit fields. No manifest field ever reaches commerce (the bridge's security rule holds: the pin is
platform-admin-written, the same trust as today's commerce settings writer).

### 5.9 Parity: one release, every channel

- **Publish everywhere** (UX-58): one dialog per release from the release record, the Overview header and each
  channel; done rows for CI, PR, feed channels and testing tracks; one typed confirmation for store submissions,
  validated per store through `confirm.ts`.
- **Verb façade**: `POST …/releases/<id>/rollout {verb, channels[]}` dispatches each channel to
  `dist_rollouts` or to the connector control the catalogue's `verbs` names; an unsupported verb answers with the
  deep link and the reason. **Halt everywhere** then halts Play staged rollouts and pauses Apple phased release
  instead of saying "Halt it in Google Play" (`RolloutDialogs.tsx:598`).
- **Withdraw** (yank) shows a per-channel plan: Polaris Key yanks (Release), package feeds deprecate or yank,
  Play halts, App Store remove-from-sale (typed), Steam branch revert, Homebrew/Scoop revert PR, install sources
  drop it on the next render. Never-delete rules (`NeverList`) are unchanged.
- **Release notes** are one per-locale source (`dist_listing_release_notes`) pushed everywhere; already modelled.

### 5.10 Customer side

`customerChannelActions(product, platform, viewer)` (DC-09) built from the catalogue and the channel states:
download (Polaris Key, with the hosted copy and ticket, HA-09), store link and deep link, install command
(Homebrew, Scoop, winget, Flathub, Snap), install source link and QR (AltStore, SideStore, PAL, F-Droid,
Obtainium), package-feed setup with the registry line and token entry. The public page (`page/model.ts`), the
portal (`page/customer.ts`, PX-09) and the React download surface (SP-12) read it; the portal shows every
applicable channel per platform, owned ones first.

### 5.11 Artifacts and hashes

- Keep the three deliverable kinds. Add a **known-format table** (extension → platform, installer kind,
  channels that accept it) in `@polaris-key/manifest` for fit; `format` stays free text for anything unknown.
- **`SHA256SUMS`** per release generated from `release_artifacts` on the bytes host
  (`dl.plrs.im/<p>/<version>/SHA256SUMS`), linked from the download page, the portal and the channel's Releases
  tab. It is a convenience view of hashes the signed release record already pins; no new signed document.
- Mirroring stays default-on (HA-08); HA-09 makes the portal prefer the mirror.

### 5.12 Service switches (UI only)

Show two switches: **Releases & downloads** (writes `release` and `distribution` together) and **In-app
updates** (`update`, which turns the first on, as UX-22 already does). Slugs, namespaces and coherence codes are
unchanged, so nothing reaches `tools/services.json` consumers or the SDKs. Existing products with Release on
and Distribution off are listed, not migrated silently (turning Distribution on can publish a public download
page).

---

## 6. Surface-area reduction

| Before                                                                                                                       | After                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Distribution sidebar: 11 fixed items (`nav.ts:540-671`)                                                                      | 3 fixed (Overview, Rollouts, Health) + one entry per live, setting-up or available channel                            |
| A store in up to 7 homes (Storefronts, Listing, App Store, Commerce, Outlets & feeds, Outlet credentials, Store connections) | One channel page; team keys stay in Platform → Store connections                                                      |
| Commerce: one Apple-only page under Distribution                                                                             | A Commerce section whose storefront entries open the same channel pages                                               |
| 6 nouns in the console (Channels, Outlets & feeds, Storefronts, Package feeds, Feed, Store connections)                      | Update channels, Channels, Storefronts, Package feeds, Store connections; "outlet" and "storefront feed" leave the UI |
| ~9 per-store label and kind tables                                                                                           | 1 channel catalogue                                                                                                   |
| 4 presentation stores read by different surfaces; 4 console homes                                                            | 1 listing model; Core → Listing plus a per-channel tab; ST-13's hub copy dropped                                      |
| Store-app identity in 3 records                                                                                              | 1 binding (the pin) with derived values                                                                               |
| 3 credential homes                                                                                                           | 2 (platform team keys; channel Connection), with a read-only list in Keys & secrets                                   |
| 3 service switches for one pipeline                                                                                          | 2 UI switches (wire unchanged)                                                                                        |
| Action: one step per CI/PR store plus per-transport inputs                                                                   | `channels: auto`                                                                                                      |
| 25 manifest identity fields typed by hand                                                                                    | Most derived (DC-16); the manifest pins only what it wants to                                                         |
| A-18j's 7-step multi-store flow plus the App Store's 7-step Distribute flow                                                  | Per-channel wizard (≤ 4 human steps) plus one Publish dialog                                                          |

New knobs added: `distribution.intendedPlatforms` (replaces asking per store) and a per-channel "Send every
release to testers" switch (default on, SETUP D36). Nothing else.

---

## 7. Automation and onboarding

1. **Scope without asking**: platforms from builds, then the repository (Godot `export_presets.cfg`, Xcode,
   Gradle, Tauri/Electron targets), then "What do you ship?" chips only when neither answers (SETUP D45). The new
   product wizard (UX-73) writes the same key.
2. **Available, then one click**: team keys that already see a matching app, a writable tap, a Windows zip.
3. **Implied channels are live with no step**: Polaris Key from the first release on `direct`; Scoop from the
   first Windows `.zip` (D26).
4. **Identifiers derived, never asked** (D44): bundle id and package name from build metadata, App ids from team
   keys, cask token from the product slug, Flathub id from the bundle id; shown with **Change**.
5. **Credentials checked on paste** (UX-69, done) and CI secrets written through the GitHub App (D41).
6. **One setup pull request** for every repository change, one workflow step for every CI/PR channel.
7. **Every release prepared everywhere**: testing tracks filled, store versions created, builds attached,
   notes and listing pushed; production is one typed click in Publish.
8. **In-app docs**: each catalogue entry carries its "Needs you" text, deep links and copy cards; each channel's
   Setup tab explains "How it gets there"; the generated docs reference gains one page per channel
   (`/docs/channels/<id>/`) from the catalogue, so docs cannot drift from behaviour.
9. **Example code**: the customer action renderers (`brew install --cask …`, `scoop install <url>`, the npm
   `.npmrc` line) are the same functions the portal and the console's install hints use (`renderFeedSetup`
   already exists for package feeds).

---

## 8. Migration, data and risk

| Change                                     | Data and migration                                                                                                                                                                                                                          | Risk and mitigation                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel catalogue (DC-02)                  | none; code only                                                                                                                                                                                                                             | A missed consumer keeps an old label: the conformance suite asserts no store label literal outside the catalogue (grep test, like `outletCredentialReach.test.ts`).                                                                                                   |
| Read model and `intendedPlatforms` (DC-03) | one S-18 registry entry (`pnpm gen:settings`, rule 3)                                                                                                                                                                                       | `direct` without `platforms` must never widen scope: only explicit `direct.platforms` counts (SETUP K1). The signed feed's own use of `OUTLET_PLATFORMS` is untouched.                                                                                                |
| IA and redirects (DC-04)                   | none                                                                                                                                                                                                                                        | Bookmarks and docs links: every old path in `LEGACY_REDIRECTS` with a route test; the docsLinks gate; palette registry; console Linux screenshot baselines re-recorded once.                                                                                          |
| Listing truth (DC-10)                      | backfill migration: import `dist_listing` into `dist_listings*` (source `import`) for products whose model is empty; dual-read in `delivery().listing()`; later drop `dist_listing` (number assigned by the lead, `00XX_listing_truth.sql`) | The portal's media proxy reads only GitHub-hosted URLs today (`media.ts` rule 2); the model's images come from hosted assets (HA-07), so the proxy path shrinks. The SSRF rules stay. A console edit now changes what customers see: say so in the Listing page copy. |
| Store-app binding (DC-11)                  | none (defaults computed on read); optional cleanup of redundant commerce fields later                                                                                                                                                       | A pin changed by a platform admin re-targets commerce claims: same trust boundary as today's commerce settings; audit row `commerce.binding.derived`.                                                                                                                 |
| Commerce auto-activation                   | none                                                                                                                                                                                                                                        | A claim can grant only a mapped product (`dist_store_products`), so "live with no mappings" grants nothing. Sandbox and test purchases stay refused by default.                                                                                                       |
| `available` and Enable (DC-06)             | `setup_state` (UX-51)                                                                                                                                                                                                                       | Team-key writes stay platform-admin (D12); the runner never passes `typedConfirmation` (D34, test).                                                                                                                                                                   |
| Publish everywhere and verb façade (DC-07) | none                                                                                                                                                                                                                                        | Security review (batch typed phrase valid only for the listed stores); each store write still goes through its gate, ledger and budget.                                                                                                                               |
| `channels: auto` (DC-08)                   | none                                                                                                                                                                                                                                        | Old inputs keep working for one minor with a deprecation warning; `pnpm gen:storefront-ci -- --check` and `bundle:action -- --check` gates.                                                                                                                           |
| Service switches (DC-12)                   | none                                                                                                                                                                                                                                        | Release-only products are reported, not migrated; turning Distribution on shows what becomes public.                                                                                                                                                                  |
| Public registries (DC-13)                  | none in D1; CI secrets only                                                                                                                                                                                                                 | Trusted publishing (npm provenance, PyPI OIDC) preferred over stored tokens; never publish a name the product's namespace does not own (dependency confusion). Security review.                                                                                       |
| Derived identities (DC-16)                 | `dist_outlets.identity_json` keeps the manifest's; derived values in a new column or row source `derived`                                                                                                                                   | Validator and schema change (rule 9, mutation table); plan mode because it changes `.pkey/distribution` semantics that the CLI, Action and editors read.                                                                                                              |

**Wire.** No package here changes a signed document, `client-core`, the corpus or `PROTOCOL_VERSION`. HA-12
(already approved through HA-11, in its lead round) is the one wire event in this domain. Explicitly avoided:
new outlet kinds (`homebrew`, `npm`, `epic`), widening `OUTLET_PLATFORMS.itch` to Android or web; each would be
plan mode and an all-SDK event (S-15 decision 8).

---

## 9. Backlog changes

| id     | action  | target                          | note                                                                                                                                                                                            |
| ------ | ------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-52  | merge   | DC-02                           | Catalogue declaration, widened with the owner's commerce facet, customer actions and deliverable kinds. Register in `workpackages.json` (it exists only in EXPERIENCE.md).                      |
| UX-53  | merge   | DC-03                           | Read model and scope, plus the `available` state and the nav summary.                                                                                                                           |
| UX-54  | merge   | DC-04                           | IA revised: per-channel sidebar entries and a Commerce section instead of SETUP's four fixed items.                                                                                             |
| UX-55  | merge   | DC-06                           | Wizard steps, human only, per facet.                                                                                                                                                            |
| UX-56  | merge   | DC-08                           | `renderOutletBlock`, `pkey channel add`, `pkey storefronts sync`, Action `channels: auto`.                                                                                                      |
| UX-57  | merge   | DC-05                           | Channel page and status, with the Selling tab and Play/Microsoft/Steam parity.                                                                                                                  |
| UX-58  | merge   | DC-07                           | Publish everywhere plus the verb façade and withdraw plan.                                                                                                                                      |
| UX-68  | merge   | DC-06                           | Setup runner, plus team-key matching and commerce auto-activation.                                                                                                                              |
| UX-64  | edit    | DC-03                           | Update feed endpoints scoped to shipped platforms; reads DC-03's facts instead of its own.                                                                                                      |
| UX-70  | keep    | UX-70                           | Register in the backlog; depends on the owner's GitHub App permission change (D38).                                                                                                             |
| UX-71  | keep    | UX-71                           | Register; security review stays.                                                                                                                                                                |
| UX-26  | edit    | UX-26                           | "Update feed rename" becomes "Channels → Update channels" (DC-01 vocabulary).                                                                                                                   |
| UX-32  | drop    | none                            | Already superseded by SETUP.md §2.14.                                                                                                                                                           |
| ST-12  | edit    | DC-05                           | Store credential editors go to the channel page's Connection section, not the settings hub.                                                                                                     |
| ST-13  | merge   | DC-10                           | Listing has one home (Core → Listing) plus per-channel tabs; a hub copy would be a third home.                                                                                                  |
| ST-27  | keep    | ST-27                           | Alerts for store connections and auto-halt are still needed.                                                                                                                                    |
| PS-05  | keep    | PS-05                           | In review.                                                                                                                                                                                      |
| PS-05b | keep    | PS-05b                          | Library entry downloads; reads DC-09 when it lands.                                                                                                                                             |
| PS-06  | edit    | DC-05                           | In review: lands as is; DC-05 re-homes it as the Polaris Key channel page's Selling tab with a redirect from `distribution/storefronts/polaris-key`.                                            |
| PS-07  | edit    | PS-07                           | Generalise `store_owned` to the catalogue's commerce `ownership` op (Steam first, then Apple and Play through the bridge's bindings); ownership loss and refunds revoke through LX-12's states. |
| PS-08  | reorder | later                           | Optional; waits for I-22.                                                                                                                                                                       |
| PS-09  | merge   | licensing auto-mint (LX domain) | An email-domain rule is one more rule type of the owner's "mint for everyone / by OIDC group" policy, not a storefront path.                                                                    |
| PS-11  | edit    | PS-11                           | Close-out also lands the DC-01 glossary for "storefront" and "distribution channel".                                                                                                            |
| PX-09  | edit    | PX-09                           | Depends on DC-09: every channel action per platform (commands, install sources, package-feed setup), not store pills only; HA-09 first.                                                         |
| HA-09  | reorder | before PX-09                    | Small, unblocks private-repo downloads in the portal.                                                                                                                                           |
| HA-10  | keep    | HA-10                           | In review; quotas and the hosting switch are real bounds.                                                                                                                                       |
| HA-12  | keep    | HA-12                           | In its lead round; the domain's only wire event, already through plan mode (HA-11).                                                                                                             |
| HA-13  | keep    | HA-13                           | SDKs read presentation.                                                                                                                                                                         |
| HA-14  | keep    | HA-14                           | Godot reads presentation.                                                                                                                                                                       |
| HA-15  | edit    | HA-15                           | Close-out documents the single listing truth (DC-10) instead of the manifest blob.                                                                                                              |
| HA-16  | reorder | later                           | Optional release-note images; after DC-10.                                                                                                                                                      |
| HA-17  | reorder | later                           | Optional store video; becomes a listing slot when a channel requires it (Steam trailer).                                                                                                        |
| A-18k  | keep    | A-18k                           | Blocked on the owner's credentials; add to the owner-steps checklist; its deep-link fixes feed DC-06.                                                                                           |
| P6-04  | reorder | later                           | Hosted web builds; the `web` channel stays link-only until then.                                                                                                                                |
| F-32   | reorder | later                           | NuGet only with X-01; not an app channel.                                                                                                                                                       |
| SP-12  | edit    | SP-12                           | The React `distribution` model reads DC-09's customer actions.                                                                                                                                  |
| SP-29  | keep    | SP-29                           | MSIX and Flatpak transports.                                                                                                                                                                    |
| SP-30  | reorder | later                           | Godot MSIX/Flatpak after SP-29 proves out.                                                                                                                                                      |
| CM-03  | edit    | CM-03                           | The merchant is the Polaris Key storefront's commerce facet setup; it appears under Commerce → Storefronts → Polaris Key.                                                                       |
| CM-12  | edit    | CM-12                           | Console Commerce is DC-04's Commerce section; storefront entries open DC-05's page, Selling tab.                                                                                                |
| CM-16  | keep    | CM-16                           | Storefront integration of offers.                                                                                                                                                               |
| CM-18  | reorder | later                           | Regional link-out programmes, owner decision pending.                                                                                                                                           |
| D-03   | edit    | D-03                            | Diceroll publishes with `channels: auto` once DC-08 lands.                                                                                                                                      |

---

## 10. New work packages

| Id    | Title                                                                               | Scope                                                                                                                                                                                                                                                                                                                    | Deps                       | Plan mode |
| ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------- |
| DC-01 | Vocabulary: distribution channel, storefront, update channel, track, install source | Glossary entries (`concepts.md`, rule 4), SETUP.md D1 amendment, ADMIN.md and EXPERIENCE.md pointer blocks, console copy rules ("outlet" and "storefront feed" leave the UI). Docs only.                                                                                                                                 | none                       | no        |
| DC-02 | One channel catalogue                                                               | Extend `W/core/storefront/adapter.ts` into `ChannelEntry` (18 entries, facets, platforms, formats, customer actions, verbs, auto/human); migrate the nine label/kind tables; conformance additions (platforms ⊆ `OUTLET_PLATFORMS`, no store label literal outside the catalogue); `gen:storefront-ci` regenerated.      | DC-01                      | no        |
| DC-03 | Product facts and the channel read model                                            | `productPlatforms` with sources, `distribution.intendedPlatforms` registry key, known-format table and fit, delivery and commerce state machines with `available`, the `…/distribution/channels` read (OpenAPI, routeCoverage), the product summary's `channels[]`, the outlet-without-build validator warning (rule 9). | DC-02                      | no        |
| DC-04 | Console IA: per-channel entries and a Commerce section                              | `nav.ts` data-driven channel entries under Distribution → Channels and Commerce → Storefronts; Overview (catalogue); retire eight items with `LEGACY_REDIRECTS`; palette and docsLinks; route tests; baselines.                                                                                                          | DC-03, DC-05               | no        |
| DC-05 | The channel page                                                                    | Tabs Status, Releases, Listing, Selling, Setup; facet-aware; App Store page and Commerce page re-homed; Play, Microsoft Store and Steam reach the same tabs (StoreControls and connector cards moved off Outlet credentials); PS-06's panel as Polaris Key's Selling tab; Connections view.                              | DC-03, UX-31               | no        |
| DC-06 | Channel setup: wizard, runner, available and auto-activation                        | Human-step wizards per facet (UX-55), the setup runner (UX-68), team-key app matching to build identities, Enable after one confirmation, commerce facet auto-activation from shared credentials.                                                                                                                        | DC-05, UX-50, UX-51, DC-11 | no        |
| DC-07 | Publish everywhere and the verb façade                                              | One Publish dialog and route per release (UX-58); `rollout {verb, channels[]}` dispatch to own rows or connector controls; Halt everywhere includes store halts; Withdraw plan per channel; batch typed confirmation. Security review.                                                                                   | DC-05                      | no        |
| DC-08 | One CI step for every channel                                                       | `pkey storefronts sync`, `pkey channel add`, `renderOutletBlock` (UX-56); Action `channels: auto` covering CI/PR channels and implied transport steps; deprecate `storefront`, `itch-platform`, `storefront-outlet`; Action bundle regenerated.                                                                          | DC-02                      | no        |
| DC-09 | Customer channel actions                                                            | One `customerChannelActions` model from the catalogue for `page/model.ts`, `page/customer.ts` and SP-12; package-feed setup included; PX-09 and PS-05b consume it.                                                                                                                                                       | DC-02                      | no        |
| DC-10 | One listing truth                                                                   | Portal, download page and Discover read the A-18b model with a dual-read fallback; backfill from `dist_listing`; Core → Listing (Presentation plus Distribution → Listing); per-channel Listing tab; retire `dist_listing` in a contract step.                                                                           | DC-01                      | no        |
| DC-11 | One store-app binding                                                               | Commerce settings and outlet identity checks derive from `platform_credential_pins`; mismatch attention item; prefilled console fields; product-key products unchanged.                                                                                                                                                  | DC-02                      | no        |
| DC-12 | Two service switches in the UI                                                      | "Releases & downloads" writes `release` + `distribution`; "In-app updates" writes `update`; report of release-only products; no `services.json` or SDK change.                                                                                                                                                           | none                       | no        |
| DC-13 | Public registry channels                                                            | npmjs (provenance), PyPI (trusted publishing), crates.io as CI-plane catalogue entries for package deliverables, with namespace checks; console and portal show "Also on npmjs". Security review.                                                                                                                        | DC-02, DC-08               | no        |
| DC-14 | Homebrew formula for CLI archives                                                   | Generate `Formula/<name>.rb` for macOS and Linux CLI tarballs in A-18i's PR plane beside the cask; the Homebrew channel's platforms widen to Linux only when a formula fits.                                                                                                                                             | DC-02                      | no        |
| DC-15 | Generated `SHA256SUMS`                                                              | Per-release checksum file on the bytes host from `release_artifacts`; links from the download page, portal and channel Releases tab; MD5 documented as refused.                                                                                                                                                          | none                       | no        |
| DC-16 | Derived identities and a short `.pkey/distribution`                                 | Identities from build metadata and team keys stored with source `derived`; the manifest may list channel ids only (`outlets: [app-store, homebrew]`) and pin what it wants; validator, schema, mutation table (rule 9), authoring docs and the `authoring-pkey-manifests` skill.                                         | DC-02, DC-03, DC-11        | yes       |

Sequencing: DC-01 → DC-02 → (DC-03, DC-08, DC-09, DC-11 in parallel) → DC-05 → DC-04 and DC-06 → DC-07;
DC-10, DC-12, DC-15 any time; DC-13, DC-14 after DC-08; DC-16 last.

---

## 11. Quick wins

1. **Gate App Store and Commerce nav items** on the product's outlet kinds: add an `outlets` fact to the
   product summary and a `requires: "outlet:app-store"` form to `NavRequirement` (`nav.ts:185`, `:602-620`).
2. **Drop the Matrix nav item** (`nav.ts:548-556`); `distribution/matrix` already redirects to the Rollouts view.
3. **Halt everywhere halts Play** through its connector control instead of "Halt it in Google Play"
   (`RolloutDialogs.tsx:593-598`); Apple phased release pauses likewise.
4. **Update → Feed shows only shipped platforms' endpoints**, using `platformsOf` from `release/admin.ts:691`.
5. **Portal shows every channel**: widen `customerDownloads`' `STORE_KINDS` filter (`customer.ts:242`) to the
   download page's action kinds so Homebrew, Scoop and install sources appear for owners.
6. **HA-09** (portal prefers the mirrored R2 copy).
7. **Prefill commerce settings** (`bundleId`, `packageName`, `appId`) from the pin in the console form.
8. **Rename "Channels" to "Update channels"** in `nav.ts:488` and "Outlets & feeds" to "Channel setup" until
   DC-04 retires it.
9. **Register SETUP.md Wave 5** in `workpackages.json` so the lead can schedule it.
10. **Turn `release.packages.prunePrereleases` on by default** for tenant products (feeds auditor's call).

---

## 12. Cross-domain dependencies

- **Commerce** (CM-\*, P6-01, LX-11, LX-12): owns the Selling tab's content, territories, refunds and
  subscriptions; this domain provides the channel page, the facet model and the store-app binding (DC-11).
  Commerce should not need a new service slug: a registry feature flag gates the Commerce section, avoiding
  `gen:services` and SDK churn. CM is "deferred until the owner's go", but the store bridge and Apple IAP pages
  are live now and move into the Commerce section regardless.
- **Licensing** (LX-\*): PS-09 merges into auto-mint rules; update channels (`beta`, `dev`) are granted by tiers;
  store purchases land on LX-08's grants and holders (LX-08 changes nothing in this domain).
- **Package feeds and access tokens**: account-wide registry tokens (owner's "Access Tokens"); the `packages`
  channel entry and DC-13's public registries; prune default.
- **Managed updates**: Update → Feed folds into the hub (settings) and the Polaris Key channel page (endpoints,
  shipped platforms only); "Update channels" naming; promote and demote live in Release.
- **Products and onboarding**: the New Product wizard (UX-73/74) asks planned platforms into
  `distribution.intendedPlatforms`; the "Integration" section links each channel's wizard; DC-12's switches sit
  on the Services page.
- **Settings architecture** (ST-\*): ST-12 and ST-13 edits; Access and auto-halt thresholds in the hub; new keys
  through `pnpm gen:settings`.
- **Identity and portal** (PX-_, PS-_): PX-09 and PS-05b consume DC-09; Discover's listing reads DC-10's model.
- **Packs and non-application artifacts**: transports (SP-28 to SP-30), Background Assets readiness; the
  catalogue's `deliverableKinds` includes `pack` for channels with a pack transport.
- **RBAC**: team-credential writes stay platform-admin (D12); per-product roles (ST-22) later decide who may run
  a channel's wizard and who may sell.
- **Wire and SDKs**: none from this domain beyond HA-12/HA-13/HA-14, already scheduled.
