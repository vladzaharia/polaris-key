# P6-10 Godot Android binding rebuilt on the Kotlin SDK platform module

| Field       | Value                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                      |
| Size        | 1–1.5 engineer-weeks                                                                                                                                        |
| Depends on  | [P6-09](P6-09-kotlin-platform-module.md), [P5-08](P5-08-platform-pack-transports.md)                                                                        |
| Unblocks    | [P6-05](P6-05-kotlin-sdk.md)                                                                                                                                |
| Role        | `pkey-godot-engineer`                                                                                                                                       |
| Plan mode   | no                                                                                                                                                          |
| Gates       | `ci:android`, headless Godot suites (`native_android`, `update`), `sdks/godot/native/android/export_check.sh`, `sdks/godot/parity.json` unchanged in status |
| Human input | test devices and the Play Console internal test track to re-run the P5-06 owner checklist                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                   |

Slice e of [P6-05](P6-05-kotlin-sdk.md).

## Goal

The Godot Android plugin in `sdks/godot/native/android` (P5-06's `:godot`, singleton
`PolarisKeyAndroid`) is rebuilt so that its only dependency on the Kotlin SDK is the platform module
from [P6-09](P6-09-kotlin-platform-module.md): Play, Keystore, `PackageInstaller` and Integrity.
Verification, the licence client, the updater and the pack engine stay in Godot's shared GDScript
core, as they do on every other target. This mirrors Apple, where Godot on iOS uses only Swift's
`PolarisKeyPlatform`. A reviewer can tell it happened when no `:core`, `:license`, `:update`,
`:packs` or `:sdk` classes are in the Godot AAR's dependency graph and the facade behaves exactly as
before.

## Why

- Owner decision 3 (2026-10-04). One implementation of each Android edge serves Godot and the Kotlin
  SDK; Godot keeps its own verified core so a Godot game never carries a second SDK.
- Godot is parity-first and proven by the corpus in GDScript; pulling Kotlin verification in would
  create two verifiers inside one game.

## Read first

- `AGENTS.md`; [P5-06](P5-06-kotlin-aar.md) ("Corrections from implementation": one `cmd(json)`
  method and a polled queue, the export plugin's flavour option and its refusal mechanism, the
  launch work, the update driver), [P5-08](P5-08-platform-pack-transports.md),
  [P6-02](P6-02-trust-tiers.md) and [P6-09](P6-09-kotlin-platform-module.md).
- `sdks/godot/native/android/`, `sdks/godot/addons/polaris_key/native/pkey_android.gd`,
  `android_export_plugin.gd`, `sdks/godot/parity.json`.
- notes/E4 §3.1 (plugin v2 packaging, 16 KB pages) and notes/E2 §A2.

## Scope

**In:**

- Rework `:godot`'s module dependencies so it depends on `:platform` (both flavours) and nothing
  else from the SDK build; add a CI dependency check that fails if any other `im.plrs.key` module
  appears in its graph.
- Keep the plugin surface stable: singleton name `PolarisKeyAndroid`, the `cmd(json)` entry point,
  the polled queue and every result and event shape `PKeyAndroid` and the P3-10 and P5-08 callers
  rely on. Any change to a shape is made in the facade, the plugin and the fake in one commit.
- Expose Play Integrity through the plugin and `PKeyAndroid` if [P6-02](P6-02-trust-tiers.md) has not
  already (its `devices.attest` Godot work consumes it).
- The export plugin keeps its flavour option, env var, manifest entries and the refusal of a
  `direct` build on a Play outlet; the AAR it adds is the platform module's, not a second library.
- `maven-publish` coordinates for the Godot binding AAR (`polaris-key-godot`), local `build/repo`
  only; the Godot addon's own distribution stays on its feed ([F-09](F-09-godot-feed.md)).
- Re-run the P5-06 evidence: unit tests, `export_check.sh`, the emulator sequence; and, by a person,
  the owner checklist rows for the device-dependent behaviour.

**Out** (and where it belongs instead):

- Any verification, licence, update or pack logic in Kotlin for Godot (it stays in GDScript).
- Changes to the platform module's API beyond what [P6-09](P6-09-kotlin-platform-module.md) made.
- The Godot parity rows (unchanged; if a note names the AAR layout, update the note only).

## Design notes

- **Do not duplicate edges.** If `:godot` still contains Keystore, install-source or PackageInstaller
  logic of its own, move it into `:platform` (API additive) and delete the copy.
- **The Godot AAR must stay small.** Assert the dependency set, not just the build.
- **Order.** P5-08 and P6-02 touch the same files; this package runs after both so it rebases onto
  their final shape rather than racing them.

## Steps

1. Dependency rework and the CI check; delete any duplicated edge code.
2. Facade and fake alignment; Integrity passthrough.
3. Export plugin adjustments; `export_check.sh`.
4. Emulator run; owner checklist by a person; update the README layout table.

## Acceptance criteria

- [x] `:godot`'s resolved dependency graph contains `:platform` and no other `im.plrs.key` module
      (CI check).
- [x] `./gradlew :godot:testPlayDebugUnitTest :godot:testDirectDebugUnitTest` and the headless
      Godot `native_android` and `update` suites pass unchanged (shapes preserved).
- [x] `export_check.sh` passes: three headless exports, flavour refusal on a Play outlet included;
      `tools/check_flavours.sh` passes.
- [x] The emulator sequence from P5-06 passes again (direct self-update through the driver; play
      Keystore, In-App Updates `outlet` result, on-demand pack mounted).
- [ ] The P5-06 owner checklist is re-run by a person and recorded in the PR.
- [ ] The green gate passes (`AGENTS.md`) and the `android` CI job is green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :godot:test :godot:assembleRelease && tools/check_flavours.sh )
sdks/godot/native/android/export_check.sh
GODOT_BIN=godot-4.7.2 sdks/godot/tools/run_tests.sh
```

## Hand-off

- A Godot Android binding that is one thin layer over `:platform`, with the same plugin surface.
- The role agent sets `--set P6-10 in-review` when it hands off. After review, the lead adds the last
  commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-10 done`.

## Corrections from implementation

Recorded by the implementer on 2026-10-04. The code is the fact where this brief and the code
disagree.

- **The binding was already platform-only in code; this package makes it provable and published.**
  P5-06 had built `:godot` over `:platform` with no Keystore, install-source, PackageInstaller or
  Play Core logic of its own (`Commands`, `PlayCommands` and `DirectCommands` only parse JSON,
  route threads and call the platform types), and P6-02 had already put Play Integrity through the
  plugin (`integrity_prepare`, `integrity_token`) and `PKeyAndroid`. So step 1 deleted no edge code
  and moved nothing into `:platform` (its API is unchanged), and step 2 changed no plugin, facade or
  fake shape: the singleton, `cmd(json)`, the polled queue and every result and event are as P5-06
  and P6-02 left them.
- **Dependency by per-flavour coordinate.** `:godot` declares `playImplementation`
  `im.plrs.key:polaris-key-platform-play` and `directImplementation`
  `im.plrs.key:polaris-key-platform-direct` (P6-09's coordinates), not `project(":platform")`:
  Gradle 8.11 (pinned to Godot 4.7.2's template) cannot write a POM for a project dependency on a
  project with two publications of different coordinates. The root `sdks/kotlin/build.gradle.kts`
  substitutes both coordinates with the `:platform` project for every project in the build (`:godot`
  and `:boundary`), and variant-aware matching picks the flavour, so the build is unchanged and
  the published metadata names the right flavour.
- **The CI dependency check is a Gradle task**, `:godot:checkPlatformOnly` (part of `check`, and run
  by name in the `android` job): on the eight compile and runtime classpaths of the four variants it
  requires `:platform` (or `polaris-key-platform-<flavour>`) and fails on any other project or
  `im.plrs.key` module, resolved or not. Verified by injecting `project(":core")` into direct and an
  unresolvable `im.plrs.key:polaris-key-license` into play: all eight classpaths were reported.
  `export_check.sh` asserts the same on the exported apps: their only SDK classes are
  `im.plrs.key.godot` and `im.plrs.key.platform`.
- **Publication.** `im.plrs.key:polaris-key-godot-play` and `-direct` (one coordinate per flavour,
  for the same reason as P6-09's platform), AAR, POM, sources jar and module metadata, to
  `sdks/kotlin/build/repo` only. `tools/check_publication.sh` now checks them too: each POM and
  module file names `polaris-key-platform-<same flavour>` at the same version and no other SDK
  module, no Play Core of its own, no signature. `build.sh` publishes both modules, runs that check
  and installs the four AARs **from the local repository** (the file names the export plugin reads
  are unchanged), so an export carries exactly the published artifacts.
- **Bug fixed: a play export did not carry Play Integrity.** `android_export.gd`'s
  `PLAY_DEPENDENCIES` listed only app-update and asset-delivery; P6-02 added
  `com.google.android.play:integrity` to the platform play flavour but not to the export, so on a
  real play export `integrity_*` would have failed to link. The list now has
  `integrity:1.6.0`, `suite_native_android`'s export check expects it (the one GDScript test
  change: the export rule, not a shape), `check_publication.sh` fails when the list and the
  platform play POM differ, and `export_check.sh` asserts the Play Integrity library is in the play
  export.
- **Emulator.** A `DEVICE=emulator-NNNN` serial fails on a private adb server: Godot's Android
  export shuts the adb server down when the editor exits (the server restarts, the emulator is
  briefly missing). `DEVICE=127.0.0.1:<console+1>`, as the P5-06 README shows, reconnects through
  `adb connect` and passes.
- **Not done here (human input).** The P5-06 owner checklist (Play Console internal track, real
  devices) is not run by an agent; acceptance criterion 5 stays open for the person who runs it.
  The `android` CI job's status is known only after a push.

### What was run (2026-10-04, M5 Pro under heavy load, JDK 17.0.20)

- Gradle: `:platform` play 64 and direct 56 unit tests, `:godot` play 20 and direct 15 (debug and
  release variants), all pass; lint for both modules and flavours; `assembleRelease` of
  `:platform`, `:godot` and `:boundary`; `checkModuleBoundaries`, `:platform:checkStandalone`,
  `:godot:checkPlatformOnly`, both local publications; `tools/check_flavours.sh` and
  `tools/check_publication.sh` green.
- Godot (`PKEY_TEST_SUITES=native_android,update,transports`, 471 checks, 0 failed): 4.7.2
  editor (11 s step) and 4.7.2 macOS release template (10 s step), 4.4.1 editor (14 s step). The
  full `ci` selection runs in the green gate.
- `export_check.sh` with `BUNDLETOOL` and an arm64 `google_apis` API 34 emulator: three headless
  Gradle exports (direct v1 15 s, direct v2 11 s, play AAB 14 s on a cold build; 7–8 s warm), the
  direct-on-a-Play-outlet refusal, every preset check; then the device run: direct (Keystore 11 ms,
  public-path 285 ms and wrong-hash 116 ms refusals, the silent v1 → v2 update through
  `PKeyDirectAdapter` → `PKeyApkUpdate` in 592 ms, journaled `success` and `selfUpdated` on the next
  launch) and play (Keystore 13 ms, In-App Updates `outlet`, the on-demand pack NOT_INSTALLED →
  fetched → mounted in 2.3 ms).
