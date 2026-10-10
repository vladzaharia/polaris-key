---
title: "Platform pack transports"
description: "Shipping content packs through Apple-hosted Background Assets, Play Asset Delivery and Steam depots: pkey transport in CI, the asset-pack id convention, App Store Connect uploads, Gradle modules, SteamPipe builds, and the Godot transports that verify what the platform delivered."
sidebar:
  order: 3.75
---

A store build takes its content through the store's own transport: Apple-hosted Background Assets
on the App Store and TestFlight, Play Asset Delivery on Google Play, depots on Steam. Polaris Key
does not move those bytes. It keeps their **identity**: every payload a store receives carries the
pack's `pkey-marker/1` marker, and on the device the Godot SDK verifies that marker and the bytes
against the signed pack record before anything is mounted. A store's own hashes are never trusted.

You choose the transport per outlet in `.pkey/distribution`:

```yaml
transports:
  packs:
    app-store: apple-ba
    testflight: apple-ba
    play: play-pad
    steam: steam-depot
```

Each step below starts from a pack release you have already published with `out`
([Publishing a pack](/docs/build/ci/#publishing-a-pack)). The step re-reads that cache, checks
every payload against the record it pins, and runs the publish lint again, so a pack with scripts
never reaches a store transport. It then writes the platform's files, puts the marker beside the
payload, and reports the transport's availability to Distribution (`distribution:report`, which
the default CI grant includes). Pass `--no-report` (Action: `transport-report: false`) to write
files only.

## Apple-hosted Background Assets

### The asset-pack id

A live asset-pack version switches **every** installed app version, so a pack gets one asset pack
per content level: `<pack>-c<contentApi>`. App Store Connect accepts only letters, digits and
single hyphens, so every `.` in the pack id becomes `-`: `diceroll.foes` at level 4 is
`diceroll-foes-c4`.

The mapping is lossy (`diceroll.foes` and `diceroll-foes` would share an asset pack), and App
Store Connect never lets you reuse an archived id. So every `apple-ba` pack of the product is mapped
at once, before anything is written or uploaded, and the step fails with a typed error when:

- two packs map to the same asset pack (`asset-pack-id-collision`);
- a mapped id breaks the grammar, for example `x-.foes` becomes `x--foes-c4`
  (`asset-pack-id-invalid`);
- the id is longer than 64 characters with its `-c<contentApi>` suffix
  (`asset-pack-id-too-long`).

These collisions are checked only among the product's current `apple-ba` packs. Across time (a
renamed or removed pack, an asset pack someone created by hand), the guard is
`.pkey/asset-packs.json`, described below.

### Package (macOS runner)

```sh
pkey transport apple-ba package --deliverable diceroll.foes --release 1.4.0 --from pack-cache
```

This writes, under `build/pkey-transport/apple-ba/`:

- `diceroll-foes-c4/Manifest.json`: the asset-pack id, the download policy from the pack's
  `delivery` (`essential` and `prefetch` on first install and on updates, otherwise `onDemand`),
  one file selector and `platforms: ["iOS"]`;
- the payload and its marker under `diceroll-foes-c4/pkey/diceroll-foes-c4/` (every asset pack
  lands in one shared namespace on the device, hence the prefix);
- `diceroll-foes-c4.aar`, from `xcrun ba-package` (Xcode 26 or later);
- `diceroll-foes-c4.inputs.json`: what the archive was built from. `ba-package` stamps the
  packaging time into the archive, so its bytes are never reproducible; the inputs are.

The content level defaults to `.pkey/release`'s `deliverables.app.content.contentApi` (override
it with `--content-api`), and must be inside the pack's `requires.contentApi` range. A pack with
several variants takes `--variant <key>`. Apple's Linux tools are not verified, so run this step on
a macOS runner, or pass `--no-archive` to write the manifest and files only.

### Upload

```sh
pkey transport apple-ba upload --deliverable diceroll.foes --release 1.4.0
```

The upload uses **your CI's own** App Store Connect API key (Developer role or higher), never the
key Polaris Key's connector holds. Set it from secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID` and
`ASC_PRIVATE_KEY` (the `.p8` contents; or `ASC_KEY_PATH`). The app is the `appleId` of your
`apple-ba` outlets (or `ASC_APP_ID`).

The step finds the asset pack by its id, or creates it on the very first upload. It then creates a
version and uploads the manifest and the archive in the parts App Store Connect hands out. The first
upload records the asset pack's resource id in **`.pkey/asset-packs.json`**. Commit that file:
every later upload refuses to proceed when the asset pack found by id is not the recorded one
(`asset-pack-resource-mismatch`), when an asset pack exists that nothing recorded
(`asset-pack-unrecorded`; confirm it is yours, then pass `--expect-resource <id>`), or when the
recorded one has disappeared (`asset-pack-missing`).

The upload also re-hashes the packaged files against what the package step recorded, and with
`--from <cache>` against the signed record (its payload and marker), so nothing edited after
packaging is uploaded.

It reports `processing` on your TestFlight outlets and `pending` on the App Store, with the asset
pack's ids. The [App Store Connect connector](/docs/services/distribution/availability/#outlet-readiness)
then follows the version's states. Two steps stay yours in App Store Connect: submitting the pack
version for external TestFlight review (there is no API for it), and adding it to an App Store
review submission.

**Readiness.** An app release that needs a new content level is not ready on the App Store until
that level's asset pack is approved. `GET …/distribution/asset-packs` in the console API lists
asset packs whose level no channel still uses as retire candidates, with Apple's 200-pack and
200 GB quotas. Archiving cannot be undone, so archive them yourself in App Store Connect.

### Test locally

Serve the archive with `xcrun ba-serve` and point a device's Background Assets URL override at it
(Settings → Developer). The Godot app needs P5-05's Apple plugin and a store export with the
Background Assets extension.

## Play Asset Delivery

```sh
pkey transport play-pad modules --deliverable diceroll.foes --release 1.4.0 \
  --from pack-cache --project android/build
```

Run it after **Install Android Build Template** and before `godot --export-release` of the AAB. In
your Godot Android Gradle build, this:

- writes a `com.android.asset-pack` module named after the pack (`.` and `-` become `_`:
  `diceroll_foes`). Its delivery is `fast-follow` for `essential` and `prefetch` packs, otherwise
  `on-demand` (override it with `--delivery`). Install-time content is Godot's own
  `assetPackInstallTime`, an embedded baseline;
- puts the payload and its marker in `src/main/assets/pkey/`. When the pack varies by texture, the
  default variant goes there (`etc2` when published, or `--default-texture`) and each other variant
  goes in a `pkey#tcf_<format>/` directory, so Play delivers each device one;
- adds `include ':diceroll_foes'` to `settings.gradle` and `":diceroll_foes"` to the app's
  `assetPacks`, plus texture splitting when any directory is targeted. Running it again changes
  nothing.

Play asset packs change only with a new app bundle, so a pack delivered by PAD is **pinned** on
Play. The step reports `pending`. The bundle's own availability (the Play connector, or your
upload's report) moves it on. Test locally with `bundletool build-apks --local-testing`, where
fast-follow behaves like on-demand.

## Steam depots

```sh
pkey transport steam-depot vdf --deliverable diceroll.foes --release 1.4.0 \
  --from pack-cache --depot 481 --channel beta --setlive
steamcmd +login "$STEAM_BUILD_ACCOUNT" +run_app_build build/pkey-transport/steam/app_build_480.vdf +quit
```

This writes a **content-only** SteamPipe build of the pack's depot: `app_build_<app>.vdf` (the app
from your steam outlet's `appId`, a description naming the pack release, the one depot),
`depot_build_<depot>.vdf`, and the depot's content root. That root holds
`pkey_packs/<packId>/` with the payload and its marker. `SetLive` is written only for a named
branch (`--branch`, or `--channel` through the outlet's `branches`). Steam's default branch is
promoted in Steamworks by a person, never from CI. A paid pack is a DLC depot under the base app.
Ownership is checked by the commerce bridge. Your build account and Steam Guard stay in your CI.

## The Action

The `polaris-key/publish` Action runs the same steps with `transport` set. `dir` is the publish
`out` cache, or, for `apple-ba-upload`, the package step's output:

```yaml
- uses: vladzaharia/polaris-key/actions/publish@<commit-sha>
  with:
    product: diceroll
    deliverable: diceroll.foes
    version: 1.4.0
    dir: pack-cache
    transport: apple-ba-package # apple-ba-upload, play-pad-modules, steam-depot-vdf
- uses: vladzaharia/polaris-key/actions/publish@<commit-sha>
  env:
    ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
    ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
    ASC_PRIVATE_KEY: ${{ secrets.ASC_PRIVATE_KEY }}
  with:
    product: diceroll
    deliverable: diceroll.foes
    version: 1.4.0
    dir: build/pkey-transport/apple-ba
    transport: apple-ba-upload
```

The other inputs are `content-api`, `variant`, `transport-out`, `gradle-project`,
`pad-delivery`, `steam-depot`, `steam-branch`, `steam-setlive`, `asc-expect-resource` and
`transport-report`. Inputs that only apply to a publish are refused with `transport`.

## In the game (Godot)

Give each store build the transport its outlet uses, before `PolarisKey.update.packs` starts:

```gdscript
var t := PKeyPackAppleBaTransport.new()   # PKeyPackPlayPadTransport, PKeyPackSteamTransport
t.packs = ["diceroll.foes"]
PolarisKey.update.packs.platform_transport = t
```

At every boot, the transport reads the platform's copy fresh, because platform paths change between
launches and are never stored. The engine then verifies the marker and the bytes like an embedded
baseline. A copy the platform delivered may be a newer release of the pack than the build's pin on
Apple and Steam, where packs float: such a copy counts as current for the pin, so `ensure` does not
fail when Apple has auto-updated an asset pack. On Play the copy must be exactly the pinned release. When a pack
bound to the transport is not current, `ensure` asks the platform for it (Apple's
`ensureLocalAvailability`, Play's fetch, Steam's DLC install), then verifies what arrived. If the
platform holds an older release, or a different one than a decision's exact target, the answer
is `record-mismatch`. If the plugin is missing, the
transport answers `unsupported` and the pack fails with `plan-transport-unsupported`. There is never
a silent fallback to the CDN.

On Play, a large download over a cellular connection may need the player's confirmation. Set
`confirm_hook` on the Play transport to show your own size disclosure first, and return `false` to
cancel. Without a hook, Play's own dialog asks.
