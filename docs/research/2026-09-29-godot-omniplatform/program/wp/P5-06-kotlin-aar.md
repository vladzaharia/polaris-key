# P5-06 Kotlin AAR: install source, In-App Updates, PAD, PackageInstaller, Keystore; Godot Android binding

| Field       | Value                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                             |
| Size        | 2–3 engineer-weeks                                                                                                                                                                         |
| Depends on  | [P3-10](P3-10-godot-updater.md), [S-05](S-05-godot-platform-mechanics.md)                                                                                                                  |
| Unblocks    | [P5-08](P5-08-platform-pack-transports.md), [P6-02](P6-02-trust-tiers.md), [P6-05](P6-05-kotlin-sdk.md)                                                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                         |
| Gates       | `ci:android` (a new Gradle job: JDK 17, Android SDK, unit tests, both flavours); `parity.json` for Godot                                                                                   |
| Human input | a Play Console app with an internal test track (and internal app sharing) for In-App Updates and Play Asset Delivery checks; test devices (Android 12+ and 14+ for PackageInstaller rules) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                  |

## Goal

A pure-Kotlin Android library (AAR), the shared Android backend for Godot now and the Kotlin SDK,
Unity and MAUI later, wraps install-source detection, Play In-App Updates, Play Asset Delivery,
`PackageInstaller` self-update for direct builds, and Android Keystore storage. It ships in two
flavours so a Play build never contains self-update code. A Godot Android plugin (v2) binds it, and
a GDScript facade with stubs gives every other platform a typed "unsupported" result.

## Why

- Android install source (`com.android.vending`, `org.fdroid.fdroid`, `dev.imranr.obtainium`, …)
  decides the outlet ([§5.5](../../README.md#55-distribution-layer-one-build-any-outlet)). Godot
  can already read it without the AAR, through `AndroidRuntime` and `JavaClassWrapper`, including
  the initiator's signing-certificate digest ([notes/S-06](../../notes/S-06-outlet-signals.md) §7,
  measured on 4.7.2). The AAR wraps the same reads for the Kotlin SDK; Godot's detection does not
  depend on it. A `com.android.vending` claim is trusted (`attested`) only when that digest
  equals the Play Store's, which S-06 could not record (no Play-enabled emulator image), so the
  device checklist records it.
- On Play, updates go through In-App Updates keyed on the priority P5-03 sets; direct APKs update
  through a verified `PackageInstaller` session; Play policy forbids self-update and
  `REQUEST_INSTALL_PACKAGES` in Play builds ([§4.2](../../README.md#42-android), notes/E2 §A2, §B2).
- Play Asset Delivery fast-follow and on-demand packs need the Play Core asset-delivery library;
  Godot only does a single install-time pack natively (notes/E2 §A3).
- PARITY builds the Android edges once as a shared backend
  ([PARITY §1](../../PARITY.md#1-sdks-runtimes-and-shared-native-backends)); decision 10 in
  [§11](../../README.md#11-decisions-needed) makes this AAR the Godot Android backend either way.

## Read first

- `AGENTS.md`; P3-10's GDScript outlet-adapter and native-hook interfaces.
- notes/E2 §A2 (In-App Updates, Godot plugin v2, `JavaClassWrapper`), §A3 (PAD modes, runtime API,
  Godot status), §B2 (`PackageInstaller`, update ownership, install constraints), §E1–§E2, §E7.
- notes/E4 §3.1 (plugin v2 packaging, export-plugin hooks, 16 KB pages), notes/E9 §7.2 and the
  `KA` row of §9 (flavours, `zstd-jni`).
- [PARITY §2.2](../../PARITY.md#22-typed-unsupported-here), [§5.5](../../PARITY.md#55-release-and-update)
  (`update.driver`, `outlet.detect`) and [§5.6](../../PARITY.md#56-packs) (`packs.transport.play`).

## Scope

**In:**

- A Gradle project at `sdks/kotlin/` with one module now, `platform` (proposed Maven coordinates
  `im.plrs.key:polaris-key-platform`; confirm in the PR). Flavours:
  - `play`: install source, In-App Updates (`com.google.android.play:app-update`), PAD
    (`com.google.android.play:asset-delivery` 2.3.0), Keystore. No `PackageInstaller` code, no
    install permissions.
  - `direct`: install source, `PackageInstaller`, Keystore. No Play Core libraries.
- Install source: `getInstallSourceInfo` (API 30+) with the `getInstallerPackageName` fallback,
  returning the raw installing and initiating package names, the initiator's signing-certificate
  SHA-256 (`getInitiatingPackageSigningInfo`), `getPackageSource` (API 33+) and
  `getUpdateOwnerPackageName` (API 34+). S-06 measured that the installing package alone is
  forgeable (`adb install -i com.android.vending` records Play, with the shell as initiator).
- In-App Updates: availability, allowed types, `updatePriority`, `clientVersionStalenessDays`,
  flexible and immediate flows, install-state progress, `completeUpdate`.
- PAD: `fetch`, states (including `WAITING_FOR_WIFI` and `REQUIRES_USER_CONFIRMATION` with
  `showConfirmationDialog`), `getPackLocation` absolute paths, `requestRemovePack`, `cancel`.
- `PackageInstaller` (direct): download to app-private storage is the caller's; this verifies the
  APK's SHA-256, signing certificate (equal to the installed one) and higher `versionCode`, then
  commits a session; uses `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` on API 31+,
  `setRequestUpdateOwnership(true)` on first install (API 34), and install constraints where
  available.
- Keystore: an AES-GCM key in `AndroidKeyStore` wrapping small secrets (the device token).
- The Godot plugin: sources in `sdks/godot/native/android/`, a `GodotPlugin` subclass exposing
  `@UsedByGodot` methods and signals, singleton name `PolarisKeyAndroid`; its `EditorExportPlugin`
  adds the right flavour's AAR and dependencies per preset and, for direct presets only, the
  manifest entries `REQUEST_INSTALL_PACKAGES`, `UPDATE_PACKAGES_WITHOUT_USER_ACTION` and
  `ENFORCE_UPDATE_OWNERSHIP`.
- A GDScript facade `addons/polaris_key/native/pkey_android.gd` (`PKeyAndroid`) returning
  `Unsupported` (reason `runtime` off Android, `dependency` when the singleton is missing, `outlet`
  for In-App Updates on a non-Play install or `PackageInstaller` on a Play build).
- A `ci:android` job in `.github/workflows/`: unit tests and `assembleRelease` for both flavours,
  and the facade's stub tests headless.

**Out** (and where it belongs instead):

- Generating PAD asset-pack Gradle modules for packs, the `play-pad` transport adapter, and marker
  verification (→ [P5-08](P5-08-platform-pack-transports.md)).
- Play Integrity (→ [P6-02](P6-02-trust-tiers.md), added to this AAR); Play Billing (reuse
  `godot-google-play-billing`; the server side is [P6-01](P6-01-commerce-bridge.md)).
- Mapping installer names to outlets (→ P3-11, `outlet-matrix.json`); the update decision and the
  outlet adapters (→ [P3-10](P3-10-godot-updater.md)).
- The Kotlin SDK proper: core, licence, config, corpus runner (→ [P6-05](P6-05-kotlin-sdk.md)).

## Design notes

- **Flavours are a policy boundary.** A Play build must contain no self-update path and no
  `REQUEST_INSTALL_PACKAGES`. Test it by inspecting the merged manifest and the dex of the `play`
  release build.
- **Pure Kotlin.** No native code now, so no NDK; if a later dependency brings `.so` files
  (`zstd-jni`), they must be 16 KB page aligned (NDK r28+, notes/E4 §2.1).
- **Godot plugin v2** needs Godot 4.2+ with the Gradle build enabled (notes/E4 §3.1). `JavaClassWrapper`
  could reach some calls from GDScript, but activity-result flows and receivers argue for the plugin
  (notes/E2 §A2).
- **Staged rollouts.** In-App Updates availability is per device and staged-rollout aware, so the
  server's "latest" is advisory on Play (notes/E2 §A2). The facade reports what Play says.
- **PAD paths.** Loading a `.pck` from `getPackLocation(...).assetsPath()` is unverified (notes/E2
  §G). S-05 hands this package the PAD mounting rule; if it has not run, add a device check for it
  to the checklist.
- **Existing plugins** (`dcryptoniun/Godot-Android-InAppUpdate`, `icecube092/GodotInAppUpdate`) are
  small and single-maintainer; read them, do not depend on them.
- **What can be built before a human supplies anything:** everything behind interfaces, tested with
  Robolectric and Play Core's `FakeAppUpdateManager`, a fake asset-pack manager, and a
  `PackageInstaller` fake; `bundletool build-apks --local-testing` on an emulator covers PAD
  locally. Real In-App Updates and PAD updates need the internal test track.

## Steps

1. `sdks/kotlin/` Gradle skeleton, flavours, CI job.
2. Install source, Keystore, In-App Updates with fakes and tests.
3. PAD wrapper with fakes; local-testing run on an emulator.
4. `PackageInstaller` (direct) with verification tests (wrong hash, wrong signer, lower
   `versionCode` all refused).
5. Godot plugin, export plugin, GDScript facade and stub tests.
6. `parity.json` for the Godot SDK (`outlet.detect` signals, `update.driver` on Android,
   `core.store` on Android, `packs.transport.play` client).
7. Device checklist (human): internal-track update offered with priority; flexible update completes;
   a fast-follow pack arrives and mounts; a direct APK self-updates without a prompt on Android 14;
   an internal-track install reports installer and initiator `com.android.vending`, and the
   initiator's certificate SHA-256 (record it for `outlet-matrix.json`; notes/S-06 §7).

## Acceptance criteria

- [ ] `./gradlew :platform:testPlayDebugUnitTest :platform:testDirectDebugUnitTest` covers each
      component, including every refusal case in `PackageInstaller` verification.
- [ ] The `play` release AAR's merged manifest has no install permission and its classes include
      no `PackageInstaller` use; the `direct` AAR has no Play Core classes.
- [ ] Headless Godot tests show `PKeyAndroid` returns `Unsupported` with the right reason in each
      case listed above.
- [ ] A direct export preset gets the three manifest entries; a Play preset gets none.
- [ ] The device checklist is recorded in the PR by the person who ran it.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).
- [ ] The green gate passes (`AGENTS.md`) and the new `ci:android` job is green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :platform:test :platform:assembleRelease )
( cd sdks/godot/native/android && ./gradlew assembleRelease )   # proposed layout
GODOT_BIN=godot-4.7.2 sdks/godot/tools/run_tests.sh   # P1-01's runner; add suite_native_android to the ci set
```

## Hand-off

- The `platform` AAR (both flavours) and its Kotlin API: the base P6-05 grows into the Kotlin SDK,
  and the place P6-02 adds Play Integrity.
- `PKeyAndroid` and its signals; P5-08's `content/transports/play_pad.gd` and P3-10's
  `distribution/outlets/play.gd` and `apk.gd` call it.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P5-06 done`.
