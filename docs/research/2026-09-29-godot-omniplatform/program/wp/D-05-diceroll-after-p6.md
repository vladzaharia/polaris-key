# D-05 Diceroll: Background Assets, in-app updates and paid packs

| Field       | Value                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | D: Diceroll adoption (vladzaharia/diceroll); stage "After P5–P6"                                                                                                                                                                                                                        |
| Size        | 1–2 engineer-weeks                                                                                                                                                                                                                                                                      |
| Depends on  | [P5-08](P5-08-platform-pack-transports.md), [P6-01](P6-01-commerce-bridge.md)                                                                                                                                                                                                           |
| Unblocks    | none in the graph                                                                                                                                                                                                                                                                       |
| Role        | `pkey-godot-engineer`                                                                                                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                                                                                                      |
| Gates       | `pkey validate` clean; Diceroll's CI; a TestFlight build and a Play internal-track build exercised on devices                                                                                                                                                                           |
| Human input | none in the graph. Needed in practice: an App Store Connect API key for Diceroll's CI (never the Worker's); the App Group and extension App ID; the supporter product in App Store Connect and Play Console; P6-01's notification setup for Diceroll; test devices and sandbox accounts |
| Repo        | `vladzaharia/diceroll`                                                                                                                                                                                                                                                                  |

> **Re-verify first.** Diceroll paths below come from [notes/A4](../../notes/A4-diceroll-mapping.md)
> (Diceroll `4e78bb6`, 2026-09-29) plus what D-01 to D-04 changed. This brief was written without
> access to the Diceroll repository; confirm each path before changing or deleting it.

## Goal

On App Store and TestFlight builds, Diceroll's `compatible` packs arrive as Apple-hosted Background
Assets; Play builds update through Play In-App Updates and, where configured, carry packs through
Play Asset Delivery; store state for Diceroll shows in the console; and the supporter item
(`diceroll.supporter.skins`, entitlement `extras.diceSkins`) sells through In-App Purchase and Play
Billing and becomes a licence entitlement through the commerce bridge.

**Diceroll deletes at this step** ([README §13](../../README.md#13-diceroll-adoption-path)): its
remaining store-prompt code, meaning whatever game-side path still opens a store listing URL for
updates (for example the banner's UPDATE action or a `stores` map), in favour of the SDK's
`PKeyUpdatePrompt` driven by In-App Updates on Play and the store sheet on iOS.

**Diceroll keeps:** CI export, signing, notarisation and store uploads (the vendor CLIs and actions:
TestFlight upload, Play upload, butler, Steam deploy).

## Why

This is the report's last Diceroll step: Background Assets packs on iOS and in-app updates on Play
([README §10](../../README.md#10-roadmap-and-effort) P5), and paid packs on stores (P6). Store policy
requires store commerce for digital unlocks (App Store 3.1.1, Play Payments), and on iOS an item
bought elsewhere unlocks only if it is also sold as an In-App Purchase (3.1.3(b))
([README §3.10](../../README.md#310-commerce-and-entitlements)). It also closes a gap D-01 left:
TestFlight and App Store installs can be told apart only at run time, through `AppDistributor`
(P5-05).

## Read first

- In the Polaris Key repo: `AGENTS.md`; the hand-offs of P5-08 (the `pkey transport …` commands and
  Action inputs, the asset-pack id `<pack>.c<contentApi>`), P5-05 (`PolarisKeyApple`, the per-preset
  Xcode patch that sideload IPAs skip), P5-06 (`PKeyAndroid`, In-App Updates, PAD), P6-01
  (`PolarisKey.commerce.get_binding()`, `PolarisKey.commerce.claim(store, payload)`) and S-01's note.
- S-07's note, rows 6, 8 and 9 (App Review clauses, Play fee programmes, Billing Library deadlines).
- Research: [README §3.10](../../README.md#310-commerce-and-entitlements), [§4.1](../../README.md#41-ios-and-ipados), [§4.2](../../README.md#42-android), [§11](../../README.md#11-decisions-needed) decisions 8 and 12; [CONTENT §6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet), [§6.7](../../CONTENT.md#67-lifecycle-implications) items 1, 7 and 9, [§15](../../CONTENT.md#15-diceroll-mapping).

## Scope

**In:**

- `.pkey/distribution` transports: `app-store: apple-ba` for `compatible` packs; `play: embedded` or
  `play-pad`, chosen per pack; `steam: steam-depot` if the Steam depots are set up
  ([README §3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative)).
- `release.yml`: P5-08's steps (`pkey transport apple-ba package` and `upload`, `play-pad modules`,
  `steam-depot vdf`) after the existing exports, with CI's own App Store Connect key.
- The Apple plugin (P5-05) in iOS exports, with the Background Assets extension and App Group added
  only to the signed store IPA; the sideload IPA keeps no extension (each costs a free Apple ID one
  of its App IDs, [README §4.1](../../README.md#41-ios-and-ipados)).
- The Android AAR (P5-06) in the Play flavour: In-App Updates (flexible or immediate by the priority
  the Play connector sets) and PAD packs; the direct flavour is unchanged.
- The supporter item: products in App Store Connect and Play Console mapped to
  `diceroll.supporter.skins`; purchase through StoreKit 2 and `godot-google-play-billing`, passing
  the licence's binding UUID from `PolarisKey.commerce.get_binding()` as Apple's
  `appAccountToken` and Play's `obfuscatedAccountId`; `PolarisKey.commerce.claim` after purchase; a
  restore action; the pack unlocked by `PolarisKey.license.is_entitled("extras.diceSkins")`.
- Outlet detection through `AppDistributor` replaces the stamp for TestFlight versus App Store.

**Out** (and where it belongs instead):

- The connectors and the bridge themselves (→ P5-02, P5-03, P6-01); the native plugins (→ P5-05, P5-06).
- Steam DLC ownership, unless P6-01 shipped it and a Steam DLC app exists (then it is in scope).
- Microsoft Store (Diceroll does not ship there).

## Design notes

- **Asset-pack ids carry the content level** (`foes.c1`), because a live asset-pack version switches
  every installed app version ([CONTENT §6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet)).
  Distribution holds an app release on the App Store until its level's packs are approved, and old
  levels' packs must be retired within the 200-pack and 200 GB quotas.
- **Store builds still embed the baseline** of every required pack, so an install or update is
  playable offline; `apple-ba` only replaces the updates above the baseline
  ([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications) item 1). Decision 12's full-IPA v1 is
  the starting point, not something to undo.
- **On Play, PAD pins:** a pack in PAD changes only with a new app bundle, so choose `play-pad` only
  for packs that need not float, and keep floating packs on `pkey-cdn` if policy allows.
- **Data only on store builds** (App Review 2.5.2, Play Device and Network Abuse); disclose download
  size before a first-launch download (4.2.3(ii)).
- **Entitlements are per deliverable,** not per version: buying the skins entitles every compatible
  release of that pack ([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications) item 9).
- Follow S-01's findings for the Xcode patch and S-07's for the Billing Library version that
  `godot-google-play-billing` must bundle.

## Steps

1. Re-verify paths; with the human, set up the App Group, extension App ID, CI's ASC key and the
   store products.
2. Add the transports to `.pkey/distribution`; resync; add P5-08's CI steps.
3. Integrate the Apple plugin and the Android AAR; switch update prompts to the SDK; delete the
   game-side store-prompt code.
4. Integrate purchases and restore with `PolarisKey.commerce`.
5. Test on TestFlight and the Play internal track; publish a `compatible` pack update and watch it
   arrive through `apple-ba`.

## Acceptance criteria

- [ ] A TestFlight install receives a new `compatible` pack version through Background Assets and
      mounts it at the next boot; the console shows its asset-pack state.
- [ ] The sideload IPA builds without the extension and still runs.
- [ ] A Play internal-track build shows a flexible update, and an immediate one when the priority is
      high.
- [ ] A sandbox purchase on iOS and a test purchase on Play each unlock the skins through the
      entitlement; restore works after a reinstall.
- [ ] TestFlight and App Store installs report different outlets.
- [ ] The PR lists the deleted store-prompt code; Diceroll's CI is green.

## Verify

```sh
# In the Diceroll repository:
pkey validate
pkey transport apple-ba package --deliverable diceroll.foes --release <version>   # P5-08's command
# Diceroll's test suites, as ci.yml runs them; then the device checks above
```

## Hand-off

This completes Diceroll's adoption path. Remaining game-side code is the content registry, visuals,
saves and CI export and upload steps. The lead sets
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set D-05 done` in the Polaris
Key repo when the Diceroll PR merges.
