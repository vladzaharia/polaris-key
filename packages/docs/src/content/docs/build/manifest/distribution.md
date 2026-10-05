---
sidebar:
  order: 3
title: "Distribution: outlets, transports and listing"
description: "The optional fourth .pkey/ file — where a product is distributed, its store identities, which transport carries each deliverable, and its store listing."
---

`.pkey/release` says **what exists**. The optional fourth file, `.pkey/distribution.{json,yaml,yml}`,
says **how it reaches devices and outlets**: the product's **outlets** with their store
identities, the **transport** each deliverable uses on each outlet, and the store **listing**.
The [Distribution service](/docs/services/distribution/) reads it; nothing else does.

| File             | Base name                      | Required when | Maps to                            |
| ---------------- | ------------------------------ | ------------- | ---------------------------------- |
| **distribution** | `distribution.{json,yaml,yml}` | never         | `dist_outlets` + `dist_transports` |

**No file is fine.** With Distribution enabled and no document, the product has one implicit
outlet, `direct`, served by `pkey-cdn` — so a product that only ships its own downloads needs
nothing here. A document with no `outlets` block means the same; `outlets: {}` declares none.

The document is validated whenever it is present (even with Distribution off), by `pkey
validate` and by every link and resync, with the same 64 KiB and 32-level caps as the other
three files. Errors carry the document name `distribution` and a JSON pointer, for example
`distribution/outlets/itch/gameId`.

## A worked example

Diceroll's distribution, after the omni-platform research's §3.12 sketch:

```yaml
# yaml-language-server: $schema=../node_modules/@polaris-key/manifest/schemas/v1/distribution.schema.json
outlets: # identities only — capabilities are operator-owned
  direct:
    platforms: [macos, windows, linux]
    homebrewCask: diceroll
  app-store:
    appleId: "1234567890"
    bundleId: gg.vlad.diceroll
  testflight:
    bundleId: gg.vlad.diceroll
    publicLink: AbCdEf12 # the join code of https://testflight.apple.com/join/AbCdEf12
  altstore:
    artifact: ipa-sideload # an id in .pkey/release's artifact map
  altstore-beta:
    kind: altstore # an id that is not itself a kind needs one
    artifact: ipa-sideload
    listing: { subtitle: Beta builds }
  play:
    packageName: gg.vlad.diceroll
    tracks: { stable: production, beta: beta }
  obtainium:
    artifact: apk
  steam:
    appId: 480
    branches: { beta: beta }
  itch:
    target: vladzaharia/diceroll
    gameId: 1001
  web: {}
transports:
  default: pkey-cdn
  packs:
    app-store: apple-ba
    play: embedded
    steam: steam-depot
listing:
  name: Diceroll
  subtitle: A cozy dice-rolling roguelite
  tintColor: "#3b1f1f"
```

## Outlets

`outlets` is keyed by **outlet id**: lower-case, starting with a letter, at most 64 characters
(`^[a-z][a-z0-9-]{0,63}$`), at most 32 outlets. Each outlet has a **kind**:

`direct`, `app-store`, `testflight`, `altstore`, `altstore-pal`, `play`, `play-testing`,
`obtainium`, `fdroid-repo`, `ms-store`, `app-installer`, `steam`, `itch`, `flathub`, `snap`,
`winget`, `web`.

An id that is itself a kind may omit `kind` (`steam:` is a `steam` outlet), and an explicit
`kind` there must repeat the id: `app-store: { kind: web }` fails with `outlet_kind_mismatch`.
Any other id needs one — `altstore-beta: { kind: altstore }` — or validation fails with
`unknown_outlet_kind`. An outlet with no identity fields is written `web: {}`.

Because capabilities default per kind, a kind change on an outlet that already exists is applied
only when it does not widen those defaults (for example `web` to `altstore`). A widening change
(`altstore` to `direct`) is held: the outlet keeps its old kind and the rest of the push applies.
Declare a new outlet id for the wider kind, so copies already installed through the old one keep
what they had.

### Identity fields per kind

Each kind reads only its own fields; any other key on the entry is ignored. Every field is
optional. A bad value is `invalid_outlet_identity`.

| Kind                       | Fields                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `direct`                   | `platforms` (distinct release platforms), `homebrewCask` (a cask token), `homebrewFormula` (a formula name), `scoop` (`{bin, shortcuts}`) |
| `app-store`                | `appleId` (numeric), `bundleId` (reverse-DNS)                                                                                             |
| `testflight`               | `appleId`, `bundleId`, `publicLink` (the public link's join code)                                                                         |
| `altstore`                 | `artifact`, `bundleId`                                                                                                                    |
| `altstore-pal`             | `artifact`, `bundleId`, `marketplaceId`                                                                                                   |
| `play`, `play-testing`     | `packageName` (Android package), `tracks` (channel → Play track)                                                                          |
| `obtainium`, `fdroid-repo` | `artifact`, `packageName`                                                                                                                 |
| `ms-store`                 | `productId` (12 characters), `packageFamilyName`, `flights` (channel → package flight)                                                    |
| `app-installer`            | `packageFamilyName`, `publisher` (the MSIX Publisher, a certificate subject DN starting `CN=`), `updateSettings`                          |
| `steam`                    | `appId` (numeric), `branches` (channel → Steam branch)                                                                                    |
| `itch`                     | `target` (the butler `user/game` slug), `gameId` (numeric)                                                                                |
| `flathub`                  | `appId` (a Flatpak id such as `gg.vlad.Diceroll`)                                                                                         |
| `snap`                     | `name`, `channels` (channel → snap channel, `[<track>/]<risk>[/<branch>]`)                                                                |
| `winget`                   | `packageIdentifier` (such as `Vlad.Diceroll`)                                                                                             |
| `web`                      | none                                                                                                                                      |

- **`publicLink`** is the code after `/join/` in a public TestFlight link: 1–32 letters and
  digits. The signed update feed turns it into the outlet's `listingUrl`
  (`https://testflight.apple.com/join/<publicLink>`); without it a TestFlight outlet has no
  listing link.
- **`app-installer`** needs both `packageFamilyName` and `publisher` before
  `/update/<channel>/app.appinstaller` answers. `updateSettings` is optional:
  `{hoursBetweenUpdateChecks` (0–255)`, showPrompt, updateBlocksActivation` (needs
  `showPrompt: true`)`, automaticBackgroundTask}`. See
  [MSIX App Installer](/docs/services/update/updater-feeds/#msix-app-installer).
- **Numeric ids** (`appleId`, `steam.appId`, `itch.gameId`) accept a positive integer or a
  string of digits with no leading zero, and are stored as the digit string either way.
- **`appleId` must match the operator's pin.** The App Store Connect connector runs only while
  this `appleId` equals the app id a platform admin pinned on the product's `asc-api-key`
  credential. Changing it stops the connector until they re-pin (see
  [Pinning the app](/docs/services/distribution/app-store-connect/#pinning-the-app)): the
  manifest can describe the app, but not choose which app the operator's key works on.
- **`artifact`** must name an `id` in `.pkey/release`'s `deliverables.app.artifacts` —
  otherwise `unknown_artifact_ref`.
- **`productId` must match the operator's pin.** The Microsoft Store connector runs only while
  this `productId` equals the Store ID a platform admin pinned on the product's
  `ms-partner-center` credential (see
  [Microsoft Store](/docs/services/distribution/microsoft-store/#pinning-the-app)).
- **`flights`** maps a declared channel to a Microsoft Store package flight, named by its
  Partner Center friendly name or its flight id. The non-flighted submission is always the
  `stable` channel, so `flights` names only the others (`{ beta: "Beta testers" }`).
- **`snap.channels`** maps a declared channel to the snap channel `snapcraft upload --release`
  releases to (`{ stable: "latest/stable", beta: "beta" }`). The publish action's allow-list
  admits no other channel, so a snap step for a channel without an entry is refused (see
  [Storefront steps](/docs/build/ci/#storefront-steps-itchio-and-snap)).
- **`tracks`, `branches`, `flights` and `channels`** keys must be declared channels — `stable`,
  `beta`, a manual channel, or one of `deliverables.app.channels` — otherwise
  `unknown_channel_ref`.
- **`packageFamilyName`** is the MSIX `<Name>_<PublisherId>`, the publisher id being 13
  characters. The Microsoft Store and App Installer entries may differ: a Store-signed and a
  self-signed package can have different publisher ids.

Four fields exist only so an installed copy can recognise its own launcher (runtime outlet
detection, notes/S-06 rule 4): `itch.gameId` (the receipt's numeric `game.id` — `target` is
not it), `packageFamilyName`, `direct.homebrewCask`, and `direct.homebrewFormula` (a formula
name such as `diceroll` or `diceroll@2`: lower-case letters, digits, `.`, `@`, `+`, `_` and `-`,
for a command-line build whose executable resolves under `Cellar/<formula>/`).

`direct.scoop` (optional) is what the [Scoop manifest](/docs/services/distribution/feeds/#scoop)
installs: `bin`, a relative path inside the Windows archive or a list of up to 16, which Scoop
shims onto `PATH`; and `shortcuts`, up to 16 Start-menu entries as `[target, name]` pairs. A path
may not climb out of the archive (`..`). A `direct` outlet that declares `platforms` must include
`windows` to carry it. The storefront feeds themselves — AltStore, Obtainium, F-Droid, Scoop,
Flathub — are rendered from these outlets; see
[Storefront feeds](/docs/services/distribution/feeds/).

## Transports

How each deliverable's bytes arrive on each outlet:

| Transport       | Outlet kinds that may carry it |
| --------------- | ------------------------------ |
| `pkey-cdn`      | any                            |
| `embedded`      | any                            |
| `apple-ba`      | `app-store`, `testflight`      |
| `play-pad`      | `play`, `play-testing`         |
| `steam-depot`   | `steam`                        |
| `msix-optional` | `ms-store`, `app-installer`    |
| `flatpak-ext`   | `flathub`                      |
| `web`           | `web`                          |

For each deliverable on each outlet, the first of these that applies wins:

1. `transports.deliverables.<deliverableId>.<outletId>` — a per-deliverable override; the
   deliverable must be declared in `.pkey/release` (`app` always is), or
   `unknown_deliverable_ref`;
2. `transports.packs.<outletId>` — for pack deliverables only;
3. `transports.default` — applies to every outlet, so only `pkey-cdn` or `embedded`;
4. `pkey-cdn`.

A transport map may only name declared outlets (`unknown_outlet_ref`), and only a transport
that outlet's kind can carry (`transport_not_allowed`). The resolved pairs are stored in
`dist_transports`, one row per declared deliverable (the app and every pack) per live outlet.
Polaris Key delivers by `pkey-cdn`, `web` and `embedded`, and tracks the store transports
`apple-ba`, `play-pad` and `steam-depot` through reports
([Platform pack transports](/docs/build/pack-transports/)); any other transport
(`msix-optional`, `flatpak-ext`) is stored and shown "not delivered by Polaris Key", and nothing
is served or derived for it ([Pack transports](/docs/services/distribution/delivery/#pack-transports)).

## Listing

Store-page metadata, every field optional: `name`, `subtitle`, `category`, `developerName`
(one line each, at most 200 characters), `description` (at most 4000, newlines allowed),
`iconUrl`, `headerUrl`, `website` (https URLs), `screenshots` (up to 16 https URLs) and
`tintColor` (`#rrggbb`), plus the two support links the customer portal shows: `supportUrl` (an
https URL) and `supportEmail` (one address, at most 254 characters). An outlet may carry its own
`listing`, merged over the document's for that outlet. A malformed listing is `invalid_listing`.

The **document's** listing (not an outlet's) is also the product's presentation in the customer
portal: `name`, `developerName`, `tintColor`, `website`, the support links, and `iconUrl` and
`headerUrl` as art. The portal never loads that art from the developer's host: it serves it
same-origin through its media proxy (`/media/<product>/icon` and `/media/<product>/header`), which
fetches only from GitHub-hosted URLs (`github.com`, `*.githubusercontent.com`), only PNG, JPEG,
WebP or GIF, and at most 1 MB for the icon and 5 MB for the header. Art hosted anywhere else is
not shown; the portal falls back to the product's initial on its tint.

## Capabilities are not here

What an install from an outlet may do — `binaryUpdates`, `codeUpdates`, `dataUpdates`,
`channelSwitch`, `commerce`, `downloadedScripts` — defaults per outlet kind and is changed only
by an operator, and only to narrow it. A `capabilities` key **anywhere** in the file is an error,
`capabilities_not_manifest_writable`, not silently ignored: a repo must not be able to widen
what an installed copy may do by pushing a line of YAML (the same reasoning that keeps
`requireSparkleSignature` out of `.pkey/release`). See
[Outlet capabilities](/docs/services/distribution/#outlet-capabilities).

## Link and resync

Link and resync read the file with the other three and apply it in the same batch, through
Distribution's own ingest hook, only while Distribution is enabled for the product:

- every declared outlet is upserted into `dist_outlets` — kind, identity and merged listing.
  A row changes (and its `modified_at` moves) only when one of those does, so resyncing the same
  manifest twice is a no-op. An existing outlet's kind changes only when that narrows its
  capability defaults (see above);
- an outlet the file no longer declares gets `removed_at`; its row is never deleted, because
  availability history refers to it. Declaring it again clears `removed_at`;
- `dist_transports` is replaced with the resolved pairs — one per live outlet for each
  deliverable that Release ingests. Pack deliverables are ignored for now, so today that means
  only `app`, and at most 32 rows;
- the operator-owned capability columns are never written.

## Outlet ids for a Godot export

A Godot export plugin cannot read YAML, and `.pkey/` need not sit inside the Godot project, so
the CLI converts the build's outlet into the JSON the export stamps into the build:

```sh
PKEY_OUTLET_IDS="$(pkey distribution outlet-ids --outlet steam)"
```

It prints one compact JSON object, keys sorted, **every value a string**:

| Key               | From                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `steamAppId`      | `steam.appId`                                                                                                                                 |
| `itchGameId`      | `itch.gameId`                                                                                                                                 |
| `flatpakId`       | `flathub.appId`                                                                                                                               |
| `snapName`        | `snap.name`                                                                                                                                   |
| `caskToken`       | `direct.homebrewCask`                                                                                                                         |
| `homebrewFormula` | `direct.homebrewFormula`                                                                                                                      |
| `msixFamilyName`  | the build's own `ms-store` or `app-installer` entry's `packageFamilyName`                                                                     |
| `bundleId`        | the build's own `app-store`, `testflight`, `altstore` or `altstore-pal` entry's `bundleId`, else the first of those entries that declares one |

For each key the build's own entry is used when it has that kind, otherwise the entry whose id
is the kind (`steam`, `itch`, …). A Godot export's own bundle identifier (the preset's
`application/bundle_identifier` or `package/unique_name`) wins over `bundleId`. With no `.pkey/distribution` at all it prints `{}` and exits 0
for any `--outlet`; with a file, the manifest must validate and declare the outlet, or the
command exits non-zero.

## Editor support

`schemas/v1/distribution.schema.json` ships in `@polaris-key/manifest` with the other schemas;
wire it for `**/.pkey/distribution.{json,yaml,yml}` as described in
[JSON Schema & editor setup](/docs/build/manifest/json-schema/). The cross-document checks
(`unknown_artifact_ref`, `unknown_channel_ref`, `unknown_deliverable_ref`, `unknown_outlet_ref`,
and `transport_not_allowed` inside a transport map) are validator-only: an editor will not flag
them, `pkey validate` will.
