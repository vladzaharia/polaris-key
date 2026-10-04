# P5-06 Kotlin AAR: install source, In-App Updates, PAD, PackageInstaller, Keystore; Godot Android binding

| Field       | Value                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                             |
| Size        | 2–3 engineer-weeks                                                                                                                                                                         |
| Depends on  | [P3-10](P3-10-godot-updater.md), [S-05](S-05-godot-platform-mechanics.md), [S-10](S-10-android-play-installer.md)                                                                          |
| Unblocks | [P5-08](P5-08-platform-pack-transports.md), [P6-02](P6-02-trust-tiers.md), [P6-06](P6-06-kotlin-core-runner.md), [P6-09](P6-09-kotlin-platform-module.md) |
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
- **PAD paths** (S-05 §4.2, emulator with `bundletool --local-testing`): after `fetch` reports
  `COMPLETED`, mount `getPackLocation(<pack>).assetsPath() + "/<pack>.pck"` with
  `ProjectSettings.load_resource_pack`. It is a plain file under
  `/data/data/<pkg>/files/assetpacks/<pack>/<versionCode>/<versionCode>/assets/`
  (`STORAGE_FILES`) and mounted in 2.5–4.4 ms for on-demand and fast-follow packs. Re-read the path
  on every launch (it contains the `versionCode`) and never persist it; treat
  `AssetPackStorageMethod.APK_ASSETS` (value 1) or an empty `assetsPath()` as not available. Install-time packs mount as `res://<path>.pck`. The
  70-line reference plugin is `prototype/platform-mechanics/b_pad/`. Keep a device check on the
  internal test track in the checklist, since Play delivery itself was not exercised.
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

## Plan amendments (S-10)

The spike note [`notes/S-10-android-play-installer.md`](../../notes/S-10-android-play-installer.md) changes this package: its §Recommendation and §Proposed edits for P5-06 override this brief where they differ.

## Corrections from implementation

Recorded by the implementer on 2026-10-03. The code is the fact where this brief and the code
disagree; S-10's §Recommendation and §Proposed edits were followed except where noted.

- **Layout.** One Gradle build at `sdks/kotlin` (Gradle 8.11.1 with a pinned
  `distributionSha256Sum`, AGP 8.6.1, Kotlin 2.1.21, compile SDK 36, min SDK 24, Java 17, version
  catalog `gradle/libs.versions.toml`): `:platform` (the AAR, `explicitApi`), `:godot` (the plugin,
  its project directory is `sdks/godot/native/android`, so there is no second wrapper there: the
  brief's `( cd sdks/godot/native/android && ./gradlew assembleRelease )` is
  `( cd sdks/kotlin && ./gradlew :godot:assembleRelease )`), and `:boundary`, an empty app per
  flavour whose release APK carries both AARs with their dependencies. Coordinates stay
  **proposed** (`im.plrs.key:polaris-key-platform`; the Godot binding's AAR is
  `polaris-key-godot`); nothing is published.
- **Flavour boundary as checked.** `tools/check_flavours.sh` reads the release AARs and the
  `:boundary` APKs: play has no `REQUEST_INSTALL_PACKAGES`, `UPDATE_PACKAGES_WITHOUT_USER_ACTION`,
  `INSTALL_PACKAGES` or `ENFORCE_UPDATE_OWNERSHIP`, no `PackageInstaller.createSession`,
  `openSession`, `commitSessionAfterInstallConstraintsAreMet` or `Session.commit`, no
  `im.plrs.key.platform.direct` class and no install-status receiver; direct has no
  `com.google.android.play` reference and no play class; no AAR declares a permission or carries a
  `.so`. Play Core is `api` (not `implementation`) in the play flavour, because `InAppUpdates`
  takes an `AppUpdateManager`.
- **Plugin surface: one `cmd(json)` method and a polled queue**, not S-10's three plugin signals.
  S-10 measured that `emitSignal` from any thread reaches GDScript on the main thread, so signals
  would work; the poll mirrors P5-05 (one code path, a GDScript fake with the same shapes, results
  matched by `req`, no JNI signal registration). PKeyAndroid emits `update_progress`,
  `update_result`, `pack_progress`, `install_status` and `resumed` itself. The plugin uses only
  `GodotPlugin` members present since 4.2 (`getActivity`, the `onMain*` callbacks); UI work goes
  through a main-looper `Handler` (`runOnUiThread` is deprecated in 4.7). Only the 4.7.2 engine
  was run.
- **Keystore.** `SecureStore` keeps the blobs itself (`noBackupFilesDir/pkey/<product>/keystore/`)
  rather than in `user://`, adds an AAD binding each blob to its product and account, and handles
  a missing or invalidated key by dropping the blobs and answering `reset` (S-10 rec. 7). The
  Godot `core.store` work moved here from P5-05: `PKeyKeystoreStore`, picked by default on Android
  with the plugin, mirrors P5-05's `PKeyKeychainStore` (migration, `keyring-error`, no token
  file). `core.store` stays **planned, unowned** in the Godot manifest: Android and iOS have
  platform stores, but no work package owns a desktop keyring and the registry allows no desktop
  N/A, so it cannot be `implemented`; leaving it planned on P5-06 would break `parity:check` rule 4
  once P5-06 is done.
- **PackageInstaller verification is stricter than S-10's probe:** the expected SHA-256 is
  required (`hash_required`), the file must be in the app's private storage (`path_not_private`,
  canonical path), an expected versionCode may be given (`version_mismatch`), and the bytes are
  hashed again while streaming into the session (`hash_changed` aborts it). No
  `setRequestUpdateOwnership`, no `setPackageSource` (S-10 §3). Gentle constraints are an option
  (`when_backgrounded`, API 34+); `checkInstallConstraints` is wrapped and answers null.
  Robolectric's `SessionInfo` does not echo the session params, so the unit test records them
  through `applied`; the emulator run is the proof that the silent path works.
- **Update driver.** P3-10 is done, so the In-App Updates path landed here, in
  `distribution/outlets/play.gd` (S-10's table; `play-testing` now extends the play adapter). The
  "no update in the decision, priority ≥ 4" column of S-10's table is not wired (an adapter only
  acts on a decision that has an action).
- **Direct path (lead decision, after the first review).** On Android `native_bridge_name()` is
  `apk` (`distribution/outlets/apk.gd`, `PKeyApkBridge`), available only on a direct-flavour build
  with the plugin, so `binary {method: native}` is offered there when the game lists `native` in
  `update_methods`. `PKeyDirectAdapter.apply` routes it to `PKeyUpdater.install_apk(check)`
  (`updater/apk_update.gd`, `PKeyApkUpdate`): download through `PKeyDownload` (discovery's
  builds URL, Range resume) into `user://pkey/<product>/updates/apk/` (the app's files directory),
  check the size and SHA-256 of the build's one `payload` artifact in the verified record, call
  `apk_install` (no extra Android prompt is requested: the player chose to update; Android still
  prompts when it requires it), queue `update_downloaded`, delete the copy once the session holds
  it. The link is opened only when the plugin answers unsupported; a download, hash or plugin
  refusal is reported as a failure. **Gap:** the signed record carries no Android versionCode
  (`builds[].buildNumber` is a free string, not defined as one), so no expected versionCode is
  passed; the plugin still refuses a versionCode that is not above the installed one. No wire
  change was made. The emulator run now installs v2 through the adapter (below).
- **Launch work** runs when `PKeyAndroid.shared()` enters the tree (PKeyCore creates it through the
  store selection on Android), not from `polaris_key.gd`: read and clear the last journaled
  install status, abandon stale sessions.
- **Export plugin.** A second `EditorExportPlugin` (`native/android_export_plugin.gd`, registered
  by `plugin.gd`) rather than more code in the build-stamp plugin. Option
  `polaris_key/android_flavor` = `play` (default) / `direct` / `none`, env `PKEY_ANDROID_FLAVOR`.
  It carries nothing (and warns) without the Gradle build or the AARs, and warns on a Play outlet
  with `direct` or an F-Droid outlet with `play`. Direct presets get exactly two manifest entries
  (no `ENFORCE_UPDATE_OWNERSHIP`, S-10).
- **Errors.** `platform-error` (client, core) is added here too; P5-05 adds the same code. The
  description names both plugins, so the two entries differ only in wording and merge to one.
- **CI.** The `android` job runs JDK 17 (`actions/setup-java`), `sdkmanager` for
  `platforms;android-36` and `build-tools;36.1.0`, both flavours' unit tests for both modules,
  lint, `assembleRelease`, the boundary check and the facade's headless suites
  (`native_android,update`). No emulator job: `sdks/godot/native/android/export_check.sh` is the
  local device check (below).

- **Review fixes.** A leftover `update.apk` (a silent commit can kill the game before the copy is
  deleted) is removed at every launch by `PKeyUpdater.attach` (`PKeyApkUpdate.cleanup`; a `.part`
  is kept for resume). An `apk_install` that times out is `timeout` with reason `outcome-unknown`
  and keeps the copy (the worker may still be streaming; the journal has the outcome next launch).
  The direct flavour on a `play` or `play-testing` outlet is an export ERROR: Godot gives an export
  plugin no way to stop an export (option warnings are only shown, `can_export` keeps the preset
  valid), so the plugin adds no AAR and no permission, logs the error, and makes the Gradle build
  fail through an unresolvable coordinate that names the reason
  (`polaris-key.export-refused:direct-flavour-on-a-play-outlet:0`); `export_check.sh` proves the
  export fails. `SecureStore` maps a `ProviderException` to reason `keystore-provider`. The
  `android` CI job validates the Gradle wrapper (`gradle/actions/wrapper-validation`, SHA-pinned).

### What was run (2026-10-03, M5 Pro, JDK 17.0.20, Godot 4.7.2)

- Gradle unit tests: `:platform` play 41, direct 49; `:godot` play 18, direct 15; all pass.
  Lint clean for both modules and flavours.
- `export_check.sh`: three headless Gradle exports (9–16 s each), every preset check green.
- Emulator (arm64 `google_apis` API 34, no Play Store): the direct sequence (Keystore round trip
  9 ms, software `securityLevel` 0; public-path and wrong-hash refusals; a real silent v1 → v2
  self-update, `apk_install` 471 ms; the next launch reads `success` and `selfUpdated`, installer =
  initiator = the game, `packageSource` 0) and the play sequence (Keystore; In-App Updates
  `outlet` for a non-Play install; an on-demand pack under `--local-testing` fetched, located and
  mounted in 1.8 ms). Android 15/16 images were not run for this package (S-10 ran 14 and 16).
- After the direct-path wiring, the same emulator run installs v2 THROUGH THE UPDATE DRIVER:
  `PKeyDirectAdapter.apply` on a `binary {method: native}` decision with a record listing v2's
  payload (size, SHA-256) → `PKeyApkUpdate`: download of the 75 MB APK from a loopback server (adb
  reverse) into `user://`, verified, `apk_install`, committed with no prompt, 1.2 s in all; the
  next launch reads `success` and `selfUpdated`. The probe host stands in for `PKeyUpdater`
  (`install_apk`'s body with the probe's URL and record), because a configured PKeyCore needs a
  server. The probe preset needs `permissions/internet=true` (Godot's Android default is off).

### Owner checklist (needs a Play Console app and devices; nothing here was run)

S-10 §Hand-off rows 1–11 replace step 7. Build the probe (`export_check.sh`, or a game with the
plugin) signed with the upload key; two internal-track uploads (vN, and vN+1 with
`inAppUpdatePriority` set through P5-03) carrying a fast-follow and an on-demand pack (P5-08's
module generation, or `export_check.sh`'s `probeod` method).

| #   | Run                                                              | Record                                                                                                                          |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Install vN from the internal track; publish vN+1 with priority 4 | `update_check()`: availability, allowed types, priority, stalenessDays; how long until Play offers it                           |
| 2   | Flexible flow to the end                                         | `update_progress` statuses and bytes, `update_result`, whether `update_complete()` restarts the game                            |
| 3   | Immediate flow; background the app mid-download, return          | resume behaviour (the play adapter re-starts the immediate flow), result codes                                                  |
| 4   | Same from internal app sharing                                   | availability and errors (`-10`?)                                                                                                |
| 5   | Fresh internal-track install with a fast-follow pack             | status at first launch, storage method, path, mount                                                                             |
| 6   | On-demand pack over 200 MB on mobile data                        | `WAITING_FOR_WIFI` / `REQUIRES_USER_CONFIRMATION`, `pack_confirm()` result                                                      |
| 7   | Update the app with changed packs                                | pack states and paths after the update                                                                                          |
| 8   | Internal-track install: `install_source()`                       | installer and initiator `com.android.vending`, **initiatorCertSha256** (for outlet-matrix.json), `packageSource`, `updateOwner` |
| 9   | Direct APK from a browser on Android 14+, then `apk_install`     | prompt or silent; installer afterwards                                                                                          |
| 10  | Direct APK on Android 12 or 13 and on 15                         | the same, and the target-SDK floor for silent updates                                                                           |
| 11  | `keystore_info()` on the device                                  | `securityLevel` (TEE 1 / StrongBox 2), StrongBox; the Console's foreground-service (`dataSync`) declaration                     |

The person who runs it records the results in the PR (acceptance criterion 5).
