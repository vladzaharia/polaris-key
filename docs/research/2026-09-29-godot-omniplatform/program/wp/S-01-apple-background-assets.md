# S-01 Spike: Apple-hosted Background Assets from a Godot iOS export

| Field       | Value                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                                                                                                                         |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                              |
| Depends on  | none                                                                                                                                                                                                              |
| Unblocks    | [P5-05](P5-05-apple-plugin-package.md)                                                                                                                                                                            |
| Role        | `pkey-spike-runner`                                                                                                                                                                                               |
| Plan mode   | no                                                                                                                                                                                                                |
| Gates       | none beyond `pnpm format` on the files it adds; no product code changes                                                                                                                                           |
| Human input | Apple developer account; TestFlight (an internal tester group); an iOS 26 device. Also needed, not in the graph: a Mac with Xcode 26 or later, and an App Store Connect API key with the Developer role or higher |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                         |

## Goal

A research note, `notes/S-01.md`, answers four questions with evidence from
a real TestFlight install:

1. Can a CI script add an Apple-hosted **Background Download extension** and an **App Group** to
   the Xcode project that Godot's iOS export produces, and does the result pass TestFlight
   processing?
2. Can the Godot app obtain an asset pack through `AssetPackManager` and mount a `.pck` from it
   with `ProjectSettings.load_resource_pack`?
3. Are asset-pack version updates differential on the wire ([CONTENT §17](../../CONTENT.md#17-open-questions-and-spikes) Q1)?
4. How long does each asset-pack state take, and which ASC states and webhook events appear?

The note ends with a go/no-go for the Background Assets part of P5-05 and the exact patch recipe
P5-05 should turn into a product.

## Why

Background Assets is the App Store pack transport (`apple-ba`) in the design
([README §4.1](../../README.md#41-ios-and-ipados), [CONTENT §7](../../CONTENT.md#7-transports)).
Decision 12 ships Diceroll's iOS v1 as a full IPA and adopts Background Assets later, "when content
drops between app versions matter" ([README §11](../../README.md#11-decisions-needed)). [README §12](../../README.md#12-risks-and-open-questions)
names the risk: the extension target and App Group cannot be added by Godot's iOS export or its
`.gdip` plugin system, so CI must patch the exported project. Nobody has tried it
([notes/E1 §E8](../../notes/E1-apple.md#e8-how-the-godot-game-consumes-packs) item 4). Whether updates
are differential decides whether iOS needs Polaris Key's own patch strategies on top of `apple-ba`;
CONTENT §7 currently says "no documented differential; plan for whole-pack". P5-05 depends on this
spike.

## Read first

- `AGENTS.md` and `.claude/agents/pkey-spike-runner.md`.
- [README §4.1](../../README.md#41-ios-and-ipados), [§5.10](../../README.md#510-native-plugins-optional-each-behind-a-gdscript-interface-with-stubs), [§11](../../README.md#11-decisions-needed) decision 12, [§12](../../README.md#12-risks-and-open-questions).
- [CONTENT §6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet) (the `contentApi` goes into the asset-pack id), [§7](../../CONTENT.md#7-transports), [§17](../../CONTENT.md#17-open-questions-and-spikes) Q1 and Q9.
- [notes/E1 §E](../../notes/E1-apple.md#e-deep-dive-scope-addition-apple-background-assets-as-of-os-26-and-27) (E1–E8: modes, `ba-package`, Info.plist keys, runtime API, ASC upload endpoints, states) and [§A1](../../notes/E1-apple.md#a1-app-store-connect-api-from-a-server-cloudflare-worker) (JWT, webhook event list).
- [notes/E9 §7.1](../../notes/E9-runtime-building-blocks.md#71-apple-background-assets), [notes/E8 §6](../../notes/E8-content-delivery.md#6-open-questions-to-verify-before-building) Q1.
- [notes/A6](../../notes/A6-godot-patching.md) TL;DR, for the v1/v2 pack pair and its baseline sizes.
- Code to reuse: [`prototype/README.md`](../../prototype/README.md); `prototype/patching/tools/`
  (`gen_project.py` and `make_v2.py` build the realistic 36 MiB v1/v2 pair, `pck.py` reads PCKs).

## Scope

**In:**

- A throwaway Godot 4.7.x project under `prototype/apple-ba/` with a data-only test pack.
- A re-runnable patch script (Ruby `xcodeproj`, XcodeGen or Tuist; pick one and say why) that adds
  to the exported `.xcodeproj`: the Background Download extension target (Apple-Hosted, Managed:
  `StoreDownloaderExtension`), its Info.plist and entitlements, the App Group on both targets, and
  the app's keys `BAAppGroupID`, `BAHasManagedAssetPacks` and `BAUsesAppleHosting`
  ([notes/E1 §E3](../../notes/E1-apple.md#e3-infoplist-keys-and-entitlements)).
- A minimal native shim that calls `AssetPackManager.shared.ensureLocalAvailability(of:)` and
  `url(for:)` and hands the path to GDScript.
- Two asset-pack versions built with `xcrun ba-package` (and with Apple's Linux tools, if they can
  be obtained), uploaded through the ASC API: `POST /v1/backgroundAssets` →
  `/v1/backgroundAssetVersions` → `/v1/backgroundAssetUploadFiles`, then the `PUT` parts and
  `PATCH … {uploaded: true}` ([notes/E1 §E5](../../notes/E1-apple.md#e5-uploading-versioning-review-and-testflight-server-side-automation)).
- The measurements in Steps 3–6.

**Out** (and where it belongs instead):

- Turning the shim into the Apple plugin package, plus StoreKit, `AppDistributor` and Keychain (→ P5-05).
- Handling ASC webhooks and states in the Worker (→ P5-02).
- The CI pack-upload step in Polaris Key's publish flow and the `apple-ba` transport wiring (→ P5-08).
- The self-hosted _managed_ protocol, which is undocumented (→ not planned; `pkey-cdn` serves
  non-store outlets).
- Any change in Diceroll (→ D-05).

## Design notes

- **Source of truth for the extension target:** generate a throwaway Xcode project from Apple's
  "Background Download" extension template (Apple-Hosted, Managed) and copy its build settings,
  Info.plist and entitlements. notes/E1 did not verify the exact keys the template writes.
- **Keep the patch additive and separate.** The sideload IPA must ship with no extension, because
  each extension costs a free Apple ID one of its App IDs ([README §4.1](../../README.md#41-ios-and-ipados)).
  Prove that the unpatched export still builds.
- **Shim shape.** Prefer a small GDExtension xcframework through the C interface, which is the
  shape P5-05 will use (README §5.10; notes/A5 confirms iOS GDExtensions work on 4.7). If that
  does not build inside the time box, a Swift snippet injected by the patch that writes the
  resolved path to a temporary file is acceptable **for measurement only**; say so in the note.
- Resolve `url(for:)` fresh on every launch, off the main thread, and never persist it
  ([notes/E1 §E4](../../notes/E1-apple.md#e4-runtime-api-swift-objective-c-mirrors-via-baassetpackmanager)).
- **Pack contents:** data only (no `.gd`), unique path prefixes (the system merges packs into one
  namespace), and a `.pkey/pack.json` marker at the root ([CONTENT §7](../../CONTENT.md#7-transports),
  layering rule).
- **Baseline for the differential question:** use A6's v1/v2 pair. For that pair, full zstd is
  9.8 MB, a native delta 602 KB and file-aware chunking 985 KB. Record the `.aar` sizes too.
- **Asset-pack ids:** the design puts `contentApi` into the id (`foes.c3`, CONTENT §6.6). Record
  the allowed character set and length, and whether a dot is accepted.
- **Measuring bytes on the wire:** attach the device to the Mac, use `rvictl -s <UDID>` and capture
  on `rvi0` during the update; cross-check with the `statusUpdates` progress totals and the
  Settings storage figure.
- Keep the API key, team id and Apple ids out of the repo and the note; use placeholders.

## Steps

1. With the human: create the app record, the two App IDs (app and extension), the App Group and
   provisioning; add an internal TestFlight group.
2. Build the minimal project, export for iOS (Xcode project only), write the patch script, build,
   sign, upload and install from TestFlight. Log every failure and its fix.
3. Build v1 of the pack, upload it through the API, and poll `BackgroundAssetVersionState` and the
   internal beta release until ready. Optionally point an ASC webhook at a throwaway endpoint and
   record the `BACKGROUND_ASSET_VERSION_*` events.
4. On the device, record for `essential`, `prefetch` and `onDemand` policies: when bytes arrive,
   `ensureLocalAvailability` latency, the resolved path, the `load_resource_pack` result and mount
   time, and whether `contents(at:)` can read the marker of a prefetch pack before
   `ensureLocalAvailability` returns ([notes/E8 §6](../../notes/E8-content-delivery.md#6-open-questions-to-verify-before-building) Q1).
5. Upload v2, trigger `checkForUpdates()`, and measure bytes on the wire and time. Repeat once with
   a larger change.
6. Submit v2 for external beta review and record its duration and states (a partial answer to
   CONTENT §17 Q9).
7. If it costs minutes, record `AppDistributor.current` on this TestFlight install for S-06.
8. Write the note and `prototype/apple-ba/README.md`.

## Acceptance criteria

- [ ] `notes/S-01.md` exists with the notes' provenance blockquote, the
      question, a short answer, method, environment (Godot, Xcode, iOS versions; device model),
      results with raw numbers, recommendation, affected briefs and sources, using the evidence
      tags [V], [M], [S], [I].
- [ ] The note answers yes or no, with evidence, for: extension added by script; TestFlight
      processing passes; pack downloads on device; `load_resource_pack` mounts it.
- [ ] A table gives v1→v2 bytes on the wire against the full `.aar` size and A6's 602 KB / 985 KB /
      9.8 MB, and states whether updates are differential.
- [ ] A timeline table covers upload → processing → ready for internal testing → external review.
- [ ] `prototype/apple-ba/` holds the patch script and shim with a README; the script re-runs on a
      clean export, and the unpatched export still builds.
- [ ] The recommendation names the patch tool, the shim shape and the asset-pack id rules for P5-05,
      and proposes (does not apply) edits to README §4.1 and §12 and to CONTENT §7's `apple-ba` row.
- [ ] No credentials, team ids or personal data in any committed file.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm format
# On the Mac: re-run the patch on a fresh export, then build, as prototype/apple-ba/README.md says.
```

## Hand-off

P5-05 receives the patch recipe (it wires it as a per-preset post-export step that sideload IPAs
skip), the asset-pack id rules, and the shim's lessons for its `PolarisKeyApple` class and signals:
`pack_progress(id, bytes, total)`, `pack_ready(id, path)` and `pack_failed(id, err)`. P5-02 gets the
observed state machine and event names; P5-08 gets the upload procedure and timings; CONTENT §7
and the planner's `platform` strategy get the differential answer. If the answer is no-go, the
note must say what `apple-ba` falls back to (`pkey-cdn` with a background `URLSession` in P5-05).
Set the status with `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set S-01 done`
in the PR that adds the note.
