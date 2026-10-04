# P6-10 Godot Android binding rebuilt on the Kotlin SDK platform module

| Field       | Value |
| ----------- | ----- |
| Phase       | P6: Commerce, ops, web |
| Size | 1–1.5 engineer-weeks |
| Depends on | [P6-09](P6-09-kotlin-platform-module.md), [P5-08](P5-08-platform-pack-transports.md) |
| Unblocks | [P6-05](P6-05-kotlin-sdk.md) |
| Role | `pkey-godot-engineer` |
| Plan mode   | no |
| Gates       | `ci:android`, headless Godot suites (`native_android`, `update`), `sdks/godot/native/android/export_check.sh`, `sdks/godot/parity.json` unchanged in status |
| Human input | test devices and the Play Console internal test track to re-run the P5-06 owner checklist |
| Repo        | `vladzaharia/polaris-key` |

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

- [ ] `:godot`'s resolved dependency graph contains `:platform` and no other `im.plrs.key` module
      (CI check).
- [ ] `./gradlew :godot:testPlayDebugUnitTest :godot:testDirectDebugUnitTest` and the headless
      Godot `native_android` and `update` suites pass unchanged (shapes preserved).
- [ ] `export_check.sh` passes: three headless exports, flavour refusal on a Play outlet included;
      `tools/check_flavours.sh` passes.
- [ ] The emulator sequence from P5-06 passes again (direct self-update through the driver; play
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
