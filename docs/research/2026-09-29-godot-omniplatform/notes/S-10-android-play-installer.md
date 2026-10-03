> Research note for [Godot on Polaris Key](../README.md), 2026-10-03. Spike S-10 of the
> [execution program](../program/wp/S-10-android-play-installer.md). It unblocks
> [P5-06](../program/wp/P5-06-kotlin-aar.md). It was run on one Mac with the Android SDK and two
> arm64 emulators. No Play Console account, upload or real signing key was used: every APK and
> bundle is signed with a throwaway keystore made for this spike. Every claim carries an evidence
> class (below). The probe code is in
> [`S-10-android-play-installer/`](S-10-android-play-installer/README.md). It builds on
> [S-06](S-06-outlet-signals.md) §7 (install source on the emulator, the stub Play Store) and
> [S-05](S-05-godot-platform-mechanics.md) §4.2 (PAD paths and mounts), and does not repeat them.

# S-10: Play In-App Updates, Play Asset Delivery, PackageInstaller and the Godot Android binding

Evidence classes:

- **[M]**: measured on this Mac or on the emulator with real tools, where the emulator runs the
  real Android platform code (PackageInstaller, Keystore, PackageManager, Godot).
- **[E]**: emulated. A stand-in for Google Play: Play Core's `FakeAppUpdateManager`, or
  `bundletool build-apks --local-testing`, which serves asset packs from the device's own storage.
- **[D]**: documented. Read raw from a primary source: the Play Core 2.x AARs (`javap`), the
  Godot 4.7.2 extension API dump and build template, or bundletool.
- **[U]**: unmeasured, because it needs a Play install (internal test track or internal app
  sharing) or a physical device.

**[I]** marks an inference drawn from the above.

## Question

The brief asks six things:

1. **In-App Updates** with `FakeAppUpdateManager`: the flexible and immediate flows, the states
   P5-06 must map to Polaris Key's update decision, and what only a real Play install shows.
2. **Play Asset Delivery** with `--local-testing`: install-time, fast-follow and on-demand packs
   from an `.aab`, the `AssetPackManager` states, and how Godot mounts a delivered `.pck`.
3. **PackageInstaller sessions** for direct APK updates: permissions, user-action prompts, commit
   results, and the Android 14/15 rules (update ownership, `setRequestUpdateOwnership`).
4. **Install source and Keystore**: `getInstallSourceInfo` on the emulator (cross-check S-06) and
   a device id or licence token in Android Keystore.
5. **The Godot binding**: a Godot 4 Android plugin (v2, AAR) exposing these to GDScript, its
   threading, and how CI builds it.
6. What must still be measured with a real Play install.

## Short answer

| #   | Question                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                | Label                |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1a  | In-App Updates flows                 | **Both flows run through `FakeAppUpdateManager` inside a Godot export.** Flexible reports `PENDING → DOWNLOADING → DOWNLOADED → INSTALLING → INSTALLED` (1, 2, 11, 3, 4) through the listener; immediate reports **no listener events at all**, and a half-finished immediate update reads back as `DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS` (3). The same flow passes as a Robolectric unit test (9.3 s) [E]          | emulated             |
| 1b  | The real manager without Play        | `getAppUpdateInfo` fails with an **obfuscated internal exception** ("Failed to bind to the service."), **not** an `InstallException` with a code, on both emulators (their `com.android.vending` is a stub) [M]. The facade must map any failure to "In-App Updates unavailable" and fall back to the listing link                                                                                                    | measured             |
| 1c  | Only on a real Play install          | Real availability, staged-rollout gating, `updatePriority` and `clientVersionStalenessDays` values, the Play UI, the activity result codes, `completeUpdate()` restarting the app [U]                                                                                                                                                                                                                                 | unmeasured           |
| 2a  | PAD states and paths                 | On-demand and fast-follow packs go `NOT_INSTALLED (8) → PENDING → DOWNLOADING → TRANSFERRING (0 %, then 100 %) → COMPLETED` in 54–193 ms for 5–20 MB, report through the listener only (the `fetch` task returns `PENDING`), and land as plain files under `files/assetpacks/<pack>/<versionCode>/<versionCode>/assets` (`STORAGE_FILES`); they mount in 0.4–4.4 ms [E]. This confirms S-05 §4.2 on Android 14 and 16 | emulated             |
| 2b  | PAD error paths                      | **One unknown pack name fails the whole `fetch` or `getPackStates` batch.** The install-time pack has no state and a location with `APK_ASSETS` (1) and a null path. `showConfirmationDialog` answers error −14 ("not installed by Play"), so `WAITING_FOR_WIFI` and `REQUIRES_USER_CONFIRMATION` cannot be produced locally, and a `cancel` arrives too late on local storage [E]                                    | emulated             |
| 3a  | Silent self-update                   | **Works on Android 14 and 16 with no prompt**, even when `adb` made the first install, if (a) the user allowed "install unknown apps" for the game, (b) the game declares `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, and (c) no other installer owns the updates. Without (a) or (b), or with (c), the commit returns `STATUS_PENDING_USER_ACTION` [M]                                                                    | measured             |
| 3b  | Process lifecycle                    | The update kills the game. `STATUS_SUCCESS` reaches the manifest-declared receiver 0.5–1.3 s after `commit`, in a **new background process of the new version with no Godot running**; nothing relaunches the game [M]                                                                                                                                                                                                | measured             |
| 3c  | Update ownership                     | `setRequestUpdateOwnership(true)` on an **update** does nothing (owner stays null) [M]; ownership can only be claimed at first install, which a self-updater never does (notes/E2 §B2) [S]. A Play-owned install asks "Update this app from S10 probe? This app normally receives updates from …"; accepting installs and **clears** the owner [M]                                                                    | measured             |
| 3d  | Gentle install constraints (API 34+) | `commitSessionAfterInstallConstraintsAreMet(GENTLE_UPDATE)` waits while the game is in the foreground and installs about 2 s after it goes to the background [M]. `checkInstallConstraints` throws `SecurityException` until the game is the installer of record [M]                                                                                                                                                  | measured             |
| 3e  | Verification                         | Hash mismatch, a different signer and a non-higher versionCode are all refused before a session is opened, in 71–166 ms for a 74 MB APK [M]                                                                                                                                                                                                                                                                           | measured             |
| 4a  | Install source                       | The Kotlin reader returns what S-06's GDScript reader did. **New:** after a self-update the installer and the initiator are the game itself, the initiator's signer is the game's own certificate, and `packageSource` is 0 [M]                                                                                                                                                                                       | measured             |
| 4b  | Keystore                             | An AES-256-GCM key in AndroidKeyStore wraps a token in 5–14 ms (first use), unwraps in 2–4 ms, and **survives both self-updates** [M]. On the emulator the key is software-backed (`securityLevel` 0) and StrongBox is unavailable [M]                                                                                                                                                                                | measured; device [U] |
| 5a  | The binding                          | A v2 plugin AAR (30 KB play, 29 KB direct) plus a 44-line `EditorExportPlugin` works headless: a per-preset option picks the flavour, `_get_android_libraries`, `_get_android_dependencies` and `_get_android_manifest_element_contents` deliver the AAR, the Play Core coordinates and (direct only) the permissions. Export takes 6–14 s per variant [M]                                                            | measured             |
| 5b  | Threading                            | `@UsedByGodot` methods run on Godot's **render thread** (`GLThread NN`), not Android's main thread. `emitSignal` from a worker, the UI or the render thread always reaches the GDScript handler **on Godot's main thread, on the next frame** (3.5–16.6 ms) [M]                                                                                                                                                       | measured             |
| 5c  | Traps                                | A plugin method named `call` is shadowed by `Object.call` in GDScript and silently returns `null` [M]. Play Core's own dependencies read `PackageInstaller.getAllSessions`, so "no PackageInstaller in the Play build" must be checked as "no session creation" [M]. `asset-delivery` 2.3.0 merges `FOREGROUND_SERVICE_DATA_SYNC` and WorkManager's permissions into the Play build [M]                               | measured             |
| 6   | Needs a Play install                 | 11 rows, in §Hand-off                                                                                                                                                                                                                                                                                                                                                                                                 | unmeasured           |

**Go for P5-06**, with the recipe in §Recommendation. Nothing measured here blocks the brief.
Five findings change it: the self-update needs no installer-of-record bootstrap but cannot claim
update ownership, the success arrives in a process without Godot, `checkInstallConstraints` needs
a guard, a failed In-App Updates bind is not an `InstallException`, and PAD batches fail as a
whole. The proposed edits are in §Proposed edits.

## Environment

| Item             | Value                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host             | Apple M5 Pro, 64 GB, macOS 27.0 (26A428), arm64. Shared with other agents: one emulator at a time, 3 vCPU and 3 GB                                                                                                                                                                                         |
| JDK              | Temurin 21.0.12.1+1 (`mise install java@temurin-21`), used for Gradle, bundletool and Godot's Gradle export. JDK 17 (the brief's CI choice) was not run                                                                                                                                                    |
| Android SDK      | platform `android-36`, build-tools 36.1.0, cmdline-tools `latest` (avdmanager), emulator 37.1.11.0 (build 15917651)                                                                                                                                                                                        |
| Emulator, API 34 | AVD `s10-api34`: `google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.050/12077443`, `google_apis` arm64-v8a, SwiftShader GPU                                                                                                                                                                                  |
| Emulator, API 36 | AVD `s10-api36`: `…:16/BE4B.251210.005/14574095` (Android 16, the image S-06 used), same settings                                                                                                                                                                                                          |
| Play on the AVDs | No Play Store. `com.android.vending` is the "license checker" stub that S-06 §7 identified                                                                                                                                                                                                                 |
| Godot            | 4.7.2-stable official (`ed1daf0bf`), self-contained editor copy, official export templates. The Gradle build template (`android_source.zip`): AGP 8.6.1, Gradle 8.11.1, Kotlin 2.1.21, compile and target SDK 36, min SDK 24, Java 17 bytecode                                                             |
| Plugin build     | The same AGP, Kotlin and Gradle; `compileOnly org.godotengine:godot:4.7.2.stable` (Maven Central); `com.google.android.play:app-update:2.1.0`, `asset-delivery:2.3.0` (pulls `core-common` 2.0.4, `androidx.work:work-runtime` 2.9.1); Robolectric 4.14.1, JUnit 4.13.2. Latest versions on 2026-10-03 [D] |
| bundletool       | 1.18.3 (`bundletool-all-1.18.3.jar`, SHA-256 `a099cfa1…028e29`)                                                                                                                                                                                                                                            |
| Signing          | Throwaway RSA-2048 keystores `s10` (certificate SHA-256 `b258a7ba…9f11bd`) and `s10other`, generated by `build.sh`                                                                                                                                                                                         |
| Packages         | `org.polariskey.s10` (play flavour, AAB), `org.polariskey.s10d` (direct flavour, APK versionCodes 1, 2, 3)                                                                                                                                                                                                 |
| Network / region | Local only, apart from Maven and bundletool downloads. No Google Play traffic                                                                                                                                                                                                                              |

### API surface read from the AARs [D]

`javap` on `app-update-2.1.0.aar` and `asset-delivery-2.3.0.aar`:

- `InstallStatus`: `UNKNOWN 0, PENDING 1, DOWNLOADING 2, INSTALLING 3, INSTALLED 4, FAILED 5,
CANCELED 6, REQUIRES_UI_INTENT 10, DOWNLOADED 11`. `UpdateAvailability`: `UNKNOWN 0,
UPDATE_NOT_AVAILABLE 1, UPDATE_AVAILABLE 2, DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS 3`.
  `InstallErrorCode`: `-2` unknown, `-3` API not available, `-4` invalid request, `-5` install
  unavailable, `-6` install not allowed, `-7` download not present, `-9` Play Store not found,
  `-10` app not owned, `-100` internal. `ActivityResult.RESULT_IN_APP_UPDATE_FAILED = 1`.
- `FakeAppUpdateManager(Context)` is in `com.google.android.play.core.appupdate.testing` (in the
  main AAR): `setUpdateAvailable(versionCode[, type])`, `setUpdateNotAvailable`,
  `setUpdatePriority`, `setClientVersionStalenessDays`, `setTotalBytesToDownload`,
  `setBytesDownloaded`, `setInstallErrorCode`, `userAcceptsUpdate`, `userRejectsUpdate`,
  `userCancelsDownload`, `downloadStarts/Completes/Fails`, `installCompletes/Fails`, and the
  `isConfirmationDialogVisible`, `isImmediateFlowVisible`, `isInstallSplashScreenVisible`
  observers. `startUpdateFlowForResult(info, Activity, AppUpdateOptions, requestCode)` is there,
  so no `ActivityResultLauncher` is needed.
- `AssetPackStatus`: `UNKNOWN 0, PENDING 1, DOWNLOADING 2, TRANSFERRING 3, COMPLETED 4, FAILED 5,
CANCELED 6, WAITING_FOR_WIFI 7, NOT_INSTALLED 8, REQUIRES_USER_CONFIRMATION 9`.
  `AssetPackErrorCode` adds `-14 CONFIRMATION_NOT_REQUIRED` and `-15 UNRECOGNIZED_INSTALLATION`
  to the documented set. **There is no fake asset-pack manager in 2.3.0**; `AssetPackManager` is
  an interface, so a fake is a small class P5-06 writes.
- `asset-delivery`'s own manifest declares `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`
  (for `ExtractionForegroundService`, `foregroundServiceType="dataSync"`) and an exported
  `SessionStateBroadcastReceiver` guarded by `INSTALL_PACKAGES`.

## Method

One probe app, two flavours, driven by JSON plans (the code is in
[`S-10-android-play-installer/`](S-10-android-play-installer/README.md)):

- **The plugin** (`plugin/`): a Kotlin Android library with flavours `play` and `direct`, built as
  a Godot v2 plugin (`org.godotengine.plugin.v2.PKeyS10` meta-data). Common code: install source
  and Keystore. `play`: In-App Updates through a step script that drives either
  `FakeAppUpdateManager` or the real manager on the main thread, one step per main-loop turn, and
  PAD with a state listener. `direct`: a verified PackageInstaller session with a
  manifest-declared status receiver that logs to `files/pi_log.jsonl` and emits a signal.
- **The Godot side** (`game/`): `probe.gd` reads `plan.json` from the app's external files
  directory, runs each step, records every signal (with whether the handler ran on Godot's main
  thread), and writes `result_<case>.json` after every step, because a self-update kills the
  process mid-plan. `addons/pkey_s10/export_plugin.gd` is the export plugin under test.
- **Builds** (`build.sh`): Godot's headless export with the Gradle build. `direct` builds APKs at
  versionCode 1, 2 and 3, a versionCode 2 signed with the other key, and versionCode 1 and 2
  without `UPDATE_PACKAGES_WITHOUT_USER_ACTION`. `play` builds an AAB with Godot's install-time
  pack plus `s10ff` (fast-follow, 5 MB PCK, 64 entries) and `s10od` (on-demand, 20 MB PCK),
  generated by S-05's `gen_packs.py`, then `bundletool build-apks --local-testing`.
- **Sequences**: `seq_play.sh` (11 fake In-App Updates scenarios, the real manager, a PAD pass),
  `seq_direct.sh` (refusals, prompt, silent update, gentle update, missing permission,
  Play-owned install). Each ran on API 34, then again on API 36 (`SUF=_36`). "The user allows
  install unknown apps" is emulated with `appops set <pkg> REQUEST_INSTALL_PACKAGES allow`, the
  state the Settings toggle writes [I]; the prompts themselves were captured with `uiautomator`.

Commands:

```sh
(cd plugin && ./gradlew :plugin:assembleRelease :plugin:testPlayDebugUnitTest)   # 19.0 s, daemon cold, deps cached
./build.sh play 1; ./build.sh direct 1; ./build.sh direct 2; ./build.sh direct 3
./build.sh direct 2 s10other; ./build.sh direct 1 s10 true direct-v1-omit; ./build.sh direct 2 s10 true direct-v2-omit
emulator -avd s10-api34 -port 5610 -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect
ANDROID_ADB_SERVER_PORT=5099 adb connect 127.0.0.1:5611   # a private adb server: other agents restart the default one
java -jar bundletool-all-1.18.3.jar install-apks --apks out/play-v1-s10.apks --device-id 127.0.0.1:5611
./seq_play.sh && ./seq_direct.sh all                     # then the same with SUF=_36 on s10-api36
bundletool dump manifest --bundle out/play-v1-s10.aab; aapt2 dump xmltree out/direct-v1-s10.apk --file AndroidManifest.xml
dexdump -d <dex> | grep -c 'Landroid/content/pm/PackageInstaller'   # flavour boundary
```

## Results

### 1. In-App Updates [emulated; the real manager measured]

Every scenario ran in the play build on API 34 and again on API 36 with identical traces. Steps
are the fake's methods; "listener" is the `InstallStateUpdatedListener`. The fake was set up with
`setUpdateAvailable(2)`, priority 4, staleness 3 days, unless noted [E].

| Scenario                                    | Trace (listener `installStatus` in bold)                                                                                                                                                                                                                                                                                                                                | Notes                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Flexible, accepted                          | `info` (availability 2, both types allowed, priority 4, staleness 3) → `start:flexible` returns `true`, dialog visible → accept **1** → `downloadStarts` **2** → `downloadCompletes` **11** → `info` (availability **3**, installStatus 11, no type allowed) → `completeUpdate` **3**, splash visible, task succeeds → `installCompletes` **4** → `info` availability 1 | the "downloaded, call `completeUpdate`" state reads back as availability 3 plus installStatus 11, which is what a relaunch sees |
| Flexible, rejected                          | `startUpdateFlow` (the `Task` variant) resolves `RESULT_OK` (−1) **before** the user answers; reject → no listener event; `info` unchanged (availability 2)                                                                                                                                                                                                             | the fake's `Task` result is meaningless; test with `startUpdateFlowForResult` and the visibility observers                      |
| Immediate, accepted                         | `start:immediate` returns `true`, immediate UI visible → accept, download, install: **no listener events** → `info` availability 1                                                                                                                                                                                                                                      | Play owns the immediate UI; the game only sees the activity result (notes/E2 §A2) [S]                                           |
| Immediate, interrupted                      | after accept and `downloadStarts`: `info` availability **3**, installStatus 2                                                                                                                                                                                                                                                                                           | on resume, call `startUpdateFlowForResult(IMMEDIATE)` again (Play's documented resume rule) [S]                                 |
| Flexible only (`setUpdateAvailable(2, 0)`)  | `immediateAllowed: false`; `start:immediate` returns `false`                                                                                                                                                                                                                                                                                                            |                                                                                                                                 |
| Download fails / user cancels download      | **1** → **2** → **5** (FAILED) or **6** (CANCELED); `info` back to availability 2, installStatus 0                                                                                                                                                                                                                                                                      | offer again later                                                                                                               |
| Install fails                               | … **11** → `completeUpdate` **3** → **5**; `info` availability 2                                                                                                                                                                                                                                                                                                        |                                                                                                                                 |
| Not available                               | `info` availability 1; `start:flexible` returns `false`                                                                                                                                                                                                                                                                                                                 |                                                                                                                                 |
| `setInstallErrorCode(-6)`                   | `getAppUpdateInfo` fails with `InstallException`, `getErrorCode()` −6, `statusCode` −6                                                                                                                                                                                                                                                                                  | the only way the fake produces an error code                                                                                    |
| **Real manager, no Play Store** (both AVDs) | `getAppUpdateInfo` fails in 1.5–7.2 ms with `com.google.android.play.core.appupdate.internal.zzy`: "Failed to bind to the service." [M]                                                                                                                                                                                                                                 | not an `InstallException`, so no `-9`; match on "any failure"                                                                   |

Byte counts stayed 0 in every listener event, even after `setTotalBytesToDownload` and
`setBytesDownloaded` [E]: the fake does not exercise a progress bar. `getFailedUpdatePreconditions`
was empty in every scenario [E].

The same flexible flow ran as a JVM test (`FakeIauTest`, Robolectric 4.14.1, a
`Robolectric.buildActivity` activity, `shadowOf(mainLooper).idle()` between steps) and passed in
9.3 s, listener order `[1, 2, 11, 3, 4]` [M]. So P5-06's `testPlayDebugUnitTest` can cover the
state mapping without an emulator.

**Mapping to Polaris Key's update decision.** On the `play` outlet the decision is `store`
(`binaryUpdates: store`, `sdks/godot/addons/polaris_key/distribution/decision.gd` step 10) with
`mandatory` (below the floor) and `critical` [M, read]. Play is authoritative for availability
because rollouts are staged per device (notes/E2 §A2) [S]. Proposed mapping for P3-10's `play`
adapter and P5-06's `PKeyAndroid` [I]:

| Play says                                                                 | Decision `store`, not mandatory          | Decision `store`, `mandatory` or `critical`       | No update in the decision |
| ------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- | ------------------------- |
| availability 2, the wanted type allowed                                   | flexible flow (priority ≤ 3)             | immediate flow if allowed, else flexible          | flexible if priority ≥ 4  |
| availability 3, installStatus 11 (downloaded)                             | `completeUpdate()` at a safe moment      | `completeUpdate()` now                            | `completeUpdate()`        |
| availability 3, installStatus 1–3                                         | show progress                            | resume `startUpdateFlowForResult(IMMEDIATE)`      | show progress             |
| availability 1 (not yet offered to this device)                           | nothing (Play is staging); no link       | listing link plus the decision's mandatory screen | nothing                   |
| `getAppUpdateInfo` fails (any exception), or outlet is not `play`         | listing link (today's `PKeyPlayAdapter`) | listing link plus the mandatory screen            | nothing                   |
| listener 5 (FAILED) or 6 (CANCELED), or activity result `RESULT_CANCELED` | offer again next session                 | show the mandatory screen again                   | —                         |

### 2. Play Asset Delivery [emulated]

The AAB's extra packs come from asset-pack Gradle modules added to Godot's build template
(`assetPacks = [":assetPackInstallTime", ":s10ff", ":s10od"]`, S-05's method); P5-08 owns that
generation. Installed with `bundletool install-apks` from the `--local-testing` set; the
install-time pack lands as `split_assetPackInstallTime.apk` [M].

| Observation                                     | API 34                                                                                                                                                                                     | API 36            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| State before any fetch (fast-follow too)        | `NOT_INSTALLED` (8), total bytes known (5,017,948 and 20,021,596), `getPackLocation` null                                                                                                  | same              |
| `fetch(["s10od"])` listener sequence            | `PENDING` → `DOWNLOADING` (10,010,798 B) → `TRANSFERRING` 0 % → `TRANSFERRING` 100 % → `COMPLETED`, all on Android's main thread                                                           | same              |
| Time from `fetch` to `COMPLETED`                | s10od (20 MB) 193 ms; s10ff (5 MB) 54 ms                                                                                                                                                   | 84 ms; 17 ms      |
| `fetch` task result                             | succeeds with the pack in `PENDING`; completion arrives only through the listener                                                                                                          | same              |
| Location after `COMPLETED`                      | `assetsPath` `/data/data/org.polariskey.s10/files/assetpacks/s10od/1/1/assets`, storage 0 (`STORAGE_FILES`)                                                                                | same              |
| `load_resource_pack(assetsPath + "/s10od.pck")` | `true` in 4.4 ms (s10od) and 3.2 ms (s10ff); 2.0 ms on the next launch; a file inside the pack is visible                                                                                  | 0.4 ms and 0.8 ms |
| Install-time pack                               | `getPackLocation("assetPackInstallTime")`: storage **1 (`APK_ASSETS`)**, `assetsPath` and `path` null; `getPackStates` on it fails (`LocalTestingException`: "No APKs available for pack") | same              |
| A batch with one unknown name                   | `getPackStates(["s10ff","s10od","nosuchpack"])` and `fetch(["nosuchpack"])` fail as a whole with `LocalTestingException`                                                                   | same              |
| `showConfirmationDialog`                        | `AssetPackException` −14: "The installed app version was not installed by Play."                                                                                                           | same              |
| `removePack("s10od")`                           | succeeds; location null afterwards; a second `fetch` repeats the full sequence                                                                                                             | same              |
| `cancel(["s10od"])` right after `fetch`         | returns `COMPLETED`: the local copy finished first                                                                                                                                         | same              |

Findings:

- **Fast-follow is not delivered after install under local testing**; it waits for `fetch` like
  on-demand (Google's PAD testing page says so, notes/E2 §A3) [E]. On Play it starts downloading
  at install (notes/E2 §A3) [S], so a game's first launch can see it `DOWNLOADING` or already `COMPLETED` [U].
- The path holds the versionCode twice (`/1/1/`), so re-read it on every launch (S-05 §4.2) [E].
- `WAITING_FOR_WIFI` (7), `REQUIRES_USER_CONFIRMATION` (9), `FAILED`, real `CANCELED`, pack
  updates with an app update, and `APK_ASSETS` for a fast-follow or on-demand pack need Play [U].
- **The play build's merged manifest gains** `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`
  (from `asset-delivery`), and `WAKE_LOCK`, `ACCESS_NETWORK_STATE`, `RECEIVE_BOOT_COMPLETED` (from
  its `androidx.work:work-runtime` 2.9.1), plus WorkManager's receivers [M]. Whether the Play
  Console's foreground-service declaration then asks the owner about `dataSync` is [U].

### 3. PackageInstaller self-update [measured]

Base install by `adb install` (installer null, initiator `com.android.shell`) unless noted. The
update APK is copied into the app's private `files/` (the caller's download, P5-06 scope), then
verified and committed with `setRequireUserAction(USER_ACTION_NOT_REQUIRED)`. Identical results
on Android 14 (API 34) and Android 16 (API 36) except where a cell shows both.

| #   | Situation                                                                                              | Commit result                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Fresh install; "install unknown apps" not allowed (`canRequestPackageInstalls` false)                  | `STATUS_PENDING_USER_ACTION` (−1) with a `CONFIRM_INSTALL` intent. Launched, it shows "For your security, your phone currently isn't allowed to install unknown apps from this source. You can change this in Settings." (Cancel / Settings). **Cancel** gives `STATUS_FAILURE_ABORTED` (3), legacy −115, "INSTALL_FAILED_ABORTED: User rejected permissions"                                                                                                |
| D2  | The user allowed it (`canRequestPackageInstalls` true); v1 → v2 with `setRequestUpdateOwnership(true)` | **`STATUS_SUCCESS` (0), no prompt**, "INSTALL_SUCCEEDED: Session installed", 1.25 s after commit on API 34 (0.54 s on a first run), 0.78 s on API 36. Afterwards installer = initiator = `org.polariskey.s10d`, `packageSource` 0, **update owner null**                                                                                                                                                                                                     |
| D3  | v2 → v3 via `commitSessionAfterInstallConstraintsAreMet(GENTLE_UPDATE, 120 s)`, game in the foreground | holds; installs 2 s after `HOME` (commit → success 18.0 s on API 34, 17.5 s on API 36, of which about 16 s in the foreground)                                                                                                                                                                                                                                                                                                                                |
| D5  | As D2 but the installing build lacks `UPDATE_PACKAGES_WITHOUT_USER_ACTION`                             | `STATUS_PENDING_USER_ACTION`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D6  | First install `adb install --update-ownership -i com.android.vending` (update owner = the stub store)  | `STATUS_PENDING_USER_ACTION`. The prompt: API 34 "Update this app from S10 probe? This app normally receives updates from license checker. By updating from a different source, you may receive future updates from any source on your phone. App functionality may change." (Cancel / Update anyway); API 36 "Update this app using S10 probe?" with the same body. **Update anyway** installs, and the update owner is cleared; installer becomes the game |
| —   | `pi.verify` of v2 (good), v2 with a wrong expected hash, v2 signed by `s10other`, v1 again             | ok; `hash_mismatch`; `signer_mismatch`; `version_not_higher`. 71–166 ms each on 74 MB (SHA-256 plus `getPackageArchiveInfo(GET_SIGNING_CERTIFICATES)`); no session is opened for a refusal                                                                                                                                                                                                                                                                   |
| —   | `checkInstallConstraints([self], GENTLE_UPDATE)` while installer is null                               | `SecurityException`: "Caller has no access to package org.polariskey.s10d". After D2 (installer = self) it answers `allSatisfied: false` in the foreground                                                                                                                                                                                                                                                                                                   |
| —   | `getMySessions()` after D1                                                                             | the pending session stays listed (`active: false`, progress 0.8) until abandoned                                                                                                                                                                                                                                                                                                                                                                             |

Findings:

- **No bootstrap is needed.** The rules notes/E2 §B2 lists ("installer of record … or updating
  itself") hold as "updating itself": an `adb`-installed game updated itself silently [M]. For a
  real direct download the first install is by the system Package Installer (S-06 §7), so this
  applies to the first self-update too [I]. The target-SDK floor for silent updates was not
  probed (every build targets 36) [U]; notes/E2 §B2 gives a table [S].
- **`UPDATE_PACKAGES_WITHOUT_USER_ACTION` is required** at target SDK 36 [M].
- **Update ownership cannot be claimed by a self-updater.** The game never performs its own first
  install, and the flag on an update is ignored [M]. The `ENFORCE_UPDATE_OWNERSHIP` permission and
  the flag are therefore dead weight for P5-06 [I]. The useful fact is the reverse: an install
  owned by Play (or by F-Droid or Obtainium, which claim ownership, S-06 §7) prompts, and the
  prompt names the owner.
- **Lifecycle**: the success broadcast starts a new process of the new version for the receiver
  only (`S10Plugin.instance` null); the game is not restarted [M]. Anything the game wants to
  know about the update must be written by the receiver and read on the next launch [I].
- **Stale sessions** survive and count against the app; abandon them at start-up [I].
- On Android 14 and 16 the prompt texts differ only in wording; the flows are the same [M].
  Android 15 (API 35) was not run [U].

### 4. Install source and Keystore [measured]

| Moment (direct build)                                   | installing                | initiating                | initiator signer             | packageSource | updateOwner           |
| ------------------------------------------------------- | ------------------------- | ------------------------- | ---------------------------- | ------------- | --------------------- |
| `adb install`                                           | null                      | `com.android.shell`       | null                         | 1             | null                  |
| `adb install --update-ownership -i com.android.vending` | `com.android.vending`     | `com.android.shell`       | null                         | 1             | `com.android.vending` |
| after a self-update (D2, D3)                            | **`org.polariskey.s10d`** | **`org.polariskey.s10d`** | `b258a7ba…` (the game's own) | **0**         | null                  |
| after "Update anyway" (D6)                              | `org.polariskey.s10d`     | `org.polariskey.s10d`     | —                            | —             | **cleared**           |
| play build via `bundletool`                             | null                      | `com.android.shell`       | null                         | 1             | null                  |

The first two rows repeat S-06 §7 on API 34 from Kotlin [M]. The reads take 0.05–0.94 ms on the
render thread [M]. The self-updated rows are new: P3-11's matcher sees the game's own package as
installer and initiator, which no row of S-06's table covers.

Keystore (`KeyVault`: AES-256-GCM, 12-byte IV, blob `0x01 ‖ iv ‖ ciphertext+tag`, stored in
`user://`):

| Check                                | API 34                                                                              | API 36 |
| ------------------------------------ | ----------------------------------------------------------------------------------- | ------ |
| Create key and wrap a 16-byte token  | 14.3 ms                                                                             | 5.2 ms |
| Unwrap after v1 → v2 (silent update) | `device-token-123`, 3.0 ms                                                          | 1.8 ms |
| Unwrap after v2 → v3 (gentle update) | `device-token-123`, 4.4 ms                                                          | 2.9 ms |
| `KeyInfo`                            | software (`securityLevel` 0, `isInsideSecureHardware` false), 256-bit, no user auth | same   |
| `setIsStrongBoxBacked(true)`         | `StrongBoxUnavailableException`                                                     | same   |

Godot's template sets `android:allowBackup="false"` [M], so the wrapped blob is not restored onto
another device where the key would be missing [I]. Uninstalling removes both the key and the
blob [I]. Hardware-backed (TEE) levels and StrongBox need a device [U].

### 5. The Godot binding [measured]

**Packaging.** The plugin is a plain Android library: `compileOnly
"org.godotengine:godot:4.7.2.stable"` from Maven Central, the v2 meta-data in its manifest, a
`GodotPlugin` subclass with `@UsedByGodot` methods and `getPluginSignals()`. The export plugin
(`game/addons/pkey_s10/export_plugin.gd`) has five overrides from Godot 4.7.2's
`EditorExportPlugin` API (read from `--dump-extension-api`) [D]:

- `_get_export_options` adds `pkey_s10/flavor` (`play`/`direct`) to the Android preset;
  `get_option()` reads it inside the Android hooks, and `get_export_preset()` names the preset
  [M].
- `_get_android_libraries` returns `pkey_s10/bin/pkey-s10-<flavor>-release.aar` (relative to
  `res://addons/`) [M].
- `_get_android_dependencies` returns the two Play Core coordinates for `play` only [M].
- `_get_android_manifest_element_contents` returns the install permissions for `direct` only [M].

With `[editor_plugins] enabled` in `project.godot`, a headless `--export-release` loads the
plugin and calls these hooks (the log prints `PKeyS10 export: flavor=direct preset=Android`) [M].
The direct APK's manifest has `REQUEST_INSTALL_PACKAGES`, `ENFORCE_UPDATE_OWNERSHIP`,
`UPDATE_PACKAGES_WITHOUT_USER_ACTION` and the receiver; the play AAB's has none of them [M].

**Flavour boundary** (dex of the exported builds, `dexdump`) [M]:

| Build        | Classes | `com.google.android.play.*` | Our classes                                                               | `PackageInstaller` references                                                                                                                                                   |
| ------------ | ------- | --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| play (AAB)   | 5,435   | 320                         | `S10Plugin`, `FlavorOps` (play), `IauScript`, `InstallSource`, `KeyVault` | 4, all in `com.google.android.gms.common.GooglePlayServicesUtilLight`: `getPackageInstaller`, `getAllSessions`, `SessionInfo.getAppPackageName`; **0** `createSession`/`commit` |
| direct (APK) | 3,904   | **0**                       | adds `Installer`, `InstallStatusReceiver`                                 | 35                                                                                                                                                                              |

**Threading** [M], from `emitFrom(where)` and `threadInfo()` in every run:

- GDScript's calls into the plugin run on `GLThread NN`, Godot's render thread, with no Android
  `Looper`. Play Core tasks complete on Android's main thread. PackageInstaller's commit is safe
  on the render thread; `startActivity` and `startUpdateFlowForResult` were run through
  `runOnUiThread` [M].
- A signal emitted from a new thread, from `runOnUiThread`, from `runOnRenderThread` or inline
  reaches the GDScript handler on Godot's main thread every time, one frame later: 16.5, 3.5,
  16.1 and 16.6 ms [M]. P5-06 needs no queue or poll on Android (unlike the iOS C interface in
  S-09).
- Numbers inside the JSON strings come back to GDScript as floats (`"status": -1.0`); the facade
  casts [M].

**Traps** [M]:

- A `@UsedByGodot fun call(…)` is unreachable: `plugin.call("pi.canRequest", args)` runs
  `Object.call` and returns `null`. Name methods so they cannot collide with `Object`'s (`call`,
  `get`, `set`, `connect`, `emit_signal`, `free`, …).
- Godot's Gradle template's launcher is `com.godot.game.GodotAppLauncher`; `GodotApp` is not
  exported (matters for `am start` in tests).

**CI cost** [M]: `./gradlew clean :plugin:assembleRelease :plugin:testPlayDebugUnitTest
:plugin:testDirectDebugUnitTest` 19.0 s with a cold daemon and a warm dependency cache; one Godot
Gradle export 6–14 s warm. AARs: 30,108 B (play), 28,551 B (direct). Exported sizes: direct APK
74.4 MB (arm64 only, release template), play AAB 52.0 MB.

## Recommendation: the recipe for P5-06

1. **Layout.** `sdks/kotlin/platform` as in the brief, flavours `play` and `direct`, AGP 8.6.1,
   Kotlin 2.1.21, compile SDK 36, min SDK 24, Java 17 bytecode, `compileOnly` nothing from Godot.
   `sdks/godot/native/android/` is a second library that depends on the platform AAR flavour and
   `compileOnly org.godotengine:godot:4.7.2.stable`; it holds only the `GodotPlugin` subclass and
   the manifest meta-data. Guard every API-level call (`longVersionCode` 28, `getInstallSourceInfo`
   30, `setRequireUserAction` 31, `packageSource` 33, update owner and install constraints 34);
   the probe did not, because its floor was the emulators.
2. **Plugin surface.** Singleton `PolarisKeyAndroid`. Methods take and return JSON strings (as
   here) or Godot `Dictionary`, and none is called `call`. Signals `update_state`, `pack_state`,
   `install_status`. Calls arrive on the render thread; post Play Core and activity work to the UI
   thread; emit from anywhere.
3. **In-App Updates** (play): `check()` → availability, allowed types, priority, staleness,
   installStatus; `start(type)` through `startUpdateFlowForResult(info, activity, options,
requestCode)` and `onMainActivityResult`; listener → `update_state`; `complete()`. Treat **any**
   `getAppUpdateInfo` failure as `unavailable` (with the exception class and, for
   `InstallException`, the code). On every resume re-check: installStatus 11 means "call
   `complete()`", availability 3 with an immediate update means "resume the flow". Use the table
   in §Results 1 for the decision mapping. Test with Robolectric and `FakeAppUpdateManager`
   through `startUpdateFlowForResult` and the visibility observers, not the `startUpdateFlow`
   task.
4. **PAD** (play): wrap `AssetPackManager` behind an interface and fake that. Query and fetch
   **one pack per call** (or check names against the build's pack list first). Drive state from
   the listener; the `fetch` task only says "accepted". After `COMPLETED`, mount
   `assetsPath() + "/<pack>.pck"`; treat storage `APK_ASSETS` or a null path as "install-time:
   use `res://`" for Godot's own pack and as "not available" otherwise. Re-read paths every
   launch. Handle 7 and 9 with `showConfirmationDialog(activity)` (device check).
5. **PackageInstaller** (direct):
   - At start-up abandon the app's stale sessions.
   - `canInstall()` returns `canRequestPackageInstalls()`; `openInstallSettings()` opens
     `ACTION_MANAGE_UNKNOWN_APP_SOURCES` for the package.
   - `install(path, sha256, expectedVersionCode)`: refuse on hash, package name, signer set
     (equal to the installed `apkContentsSigners`) or versionCode ≤ installed, before opening a
     session; then `MODE_FULL_INSTALL`, `setAppPackageName`, `INSTALL_REASON_USER`, `setSize`,
     `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` on 31+; do not call
     `setRequestUpdateOwnership` (no effect on an update) and do not set `packageSource`.
   - Optional `whenBackgrounded: true` on 34+: `commitSessionAfterInstallConstraintsAreMet(GENTLE_UPDATE, timeout)`;
     call `checkInstallConstraints` only inside `try` (it throws until the game is its own
     installer).
   - Status through a **manifest-declared, non-exported receiver** and an explicit
     `PendingIntent` (`FLAG_MUTABLE` on 31+). The receiver writes the outcome to a file;
     `install_status` is emitted when Godot is alive. `PENDING_USER_ACTION`: start the
     `EXTRA_INTENT` from the activity on the UI thread when the game asked for prompts; report
     `owner` (`getUpdateOwnerPackageName`) so the game can explain the ownership prompt.
   - The facade reports the previous attempt on the next launch (`last_install` from the file).
6. **Install source**: as S-06, plus the self-updated case (installer = initiator = own package →
   `direct`). Read it at every launch.
7. **Keystore**: AES-256-GCM, versioned blob, alias per product (`pkey:<product>:device`); request
   StrongBox, fall back to TEE on `StrongBoxUnavailableException`; report `securityLevel`. On
   `KeyPermanentlyInvalidatedException` or a missing key, delete the blob and re-enrol.
8. **Export plugin**: one option `polaris_key/android_flavor` (`play` default); AAR and Play Core
   coordinates per flavour; for `direct` add `REQUEST_INSTALL_PACKAGES` and
   `UPDATE_PACKAGES_WITHOUT_USER_ACTION` (drop `ENFORCE_UPDATE_OWNERSHIP`).
9. **CI** (`ci:android`): JDK 17 (21 also works), the SDK's `platforms;android-36` and
   `build-tools;36.1.0`; `./gradlew :platform:testPlayDebugUnitTest :platform:testDirectDebugUnitTest
:platform:assembleRelease`; then the boundary checks on the release AARs: the play manifest
   has no install permission, the play classes have no `PackageInstaller.createSession` or
   `Session.commit` (from any package) and none of the direct source set's classes, and the
   direct classes have no `com.google.android.play`. An optional emulator job can run
   `seq_direct.sh` (about 2 minutes per API level here).
10. **Facade** (`PKeyAndroid`): unsupported reasons as the brief lists; on desktop the singleton
    is absent (`Engine.has_singleton("PKeyS10")` was `false` headless on macOS) [M].

## Proposed edits (not applied; the lead applies them)

- **P5-06 Scope, PackageInstaller**: replace "uses `setRequireUserAction(USER_ACTION_NOT_REQUIRED)`
  on API 31+, `setRequestUpdateOwnership(true)` on first install (API 34), and install
  constraints where available" with "uses `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` on API
  31+ (silent when the user has allowed installs from the game and no other installer owns its
  updates, S-10 §3); does not request update ownership (a self-updater never makes the first
  install); offers `commitSessionAfterInstallConstraintsAreMet(GENTLE_UPDATE)` on API 34+ and
  guards `checkInstallConstraints` (it throws until the game is its own installer). Abandons stale
  sessions at start-up. The status receiver is manifest-declared; the update kills the game and
  nothing relaunches it, so the receiver persists the outcome and the facade reports it on the
  next launch."
- **P5-06 Scope, the Godot plugin**: "the manifest entries `REQUEST_INSTALL_PACKAGES`,
  `UPDATE_PACKAGES_WITHOUT_USER_ACTION` and `ENFORCE_UPDATE_OWNERSHIP`" becomes "the manifest
  entries `REQUEST_INSTALL_PACKAGES` and `UPDATE_PACKAGES_WITHOUT_USER_ACTION`". Add: "Plugin
  methods run on Godot's render thread; Play Core and activity calls are posted to the UI thread;
  signals may be emitted from any thread (they reach GDScript on the main thread next frame). No
  method may share a name with an `Object` method (`call` is shadowed, S-10 §5)."
- **P5-06 Scope, In-App Updates**: add "Any `getAppUpdateInfo` failure, not only an
  `InstallException`, means unavailable (without the Play Store the failure is an internal
  'Failed to bind to the service.'). On resume, installStatus 11 means `completeUpdate()` and
  availability 3 means resume an immediate flow."
- **P5-06 Scope, PAD**: add "one pack per `fetch`/`getPackStates` call (one unknown name fails a
  batch); state from the listener only; storage `APK_ASSETS` with a null path is the install-time
  pack."
- **P5-06 Design notes, "What can be built before a human supplies anything"**: "a fake
  asset-pack manager" becomes "a fake behind the plugin's own pack interface (Play Core 2.3.0 has
  no fake)"; add "Robolectric 4.14 runs `FakeAppUpdateManager` (S-10: 9.3 s); test through
  `startUpdateFlowForResult` and the visibility observers, because the fake's `startUpdateFlow`
  task resolves before the user answers."
- **P5-06 Acceptance criteria**: "its classes include no PackageInstaller use" becomes "its
  classes include no `PackageInstaller.createSession` or `Session.commit` and no class from the
  direct source set (Play services' `GooglePlayServicesUtilLight` reads
  `PackageInstaller.getAllSessions`)". "A direct export preset gets the three manifest entries"
  becomes "the two manifest entries".
- **P5-06 Step 7 (device checklist)**: replace with this note's §Hand-off rows 1–11.
- **P3-11 / `outlet-matrix.json`**: add `installing == initiating == own package` → `direct`
  (declared): a self-updated direct build (S-10 §4). Note that the user accepting an ownership
  prompt clears `updateOwner`.
- **P3-10 `play` and `apk` adapters**: the `play` adapter's In-App Updates path follows the table
  in §Results 1; `apply` on `apk` returns behaviour `restart` but the game is killed and not
  relaunched, so the prompt says "the game will close to update" and the next launch reports the
  result. A `whenBackgrounded` option maps to gentle constraints on API 34+.
- **P5-08**: one pack per PAD call; fast-follow is fetch-on-demand under `--local-testing`
  (test plans must call `fetch`); the play build's manifest gains `FOREGROUND_SERVICE_DATA_SYNC`
  and WorkManager's permissions from `asset-delivery` 2.3.0.
- **notes/E2 §B2**: "is the installer of record of the existing app or is updating itself" →
  measured: updating itself suffices, even after an `adb` install;
  `UPDATE_PACKAGES_WITHOUT_USER_ACTION` is required at target 36; requesting ownership on an
  update has no effect. **§A3/§G**: "Absolute-path loading from `/data/...` … unverified" is
  verified (S-05 §4.2, S-10 §2).

## Hand-off: Play and device checklist for the owner [U]

Needs: a Play Console app with an internal test track and internal app sharing (two uploads, a
lower and a higher versionCode, the higher with `inAppUpdatePriority` set through P5-03, and both
asset packs); a physical device on Android 14 or later with the Play Store, and ideally a second
on Android 12 or 13 and one on Android 15. Build P5-06's sample (or this probe, `seq_play.sh`
steps) signed with the upload key. Defaults hold until a row is run.

| #   | Run                                                               | Record                                                                                                                   | Default until then                                                                 |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | Install vN from the internal track; publish vN+1 with priority 4  | `check()`: availability, allowed types, `updatePriority`, `clientVersionStalenessDays`; time until Play offers it        | table in §Results 1; staleness null                                                |
| 2   | Flexible flow to the end                                          | listener statuses and bytes; activity result codes; whether `completeUpdate()` restarts the game                         | §Results 1 order; game restarts                                                    |
| 3   | Immediate flow; background the app during the download and return | resume behaviour; result codes; `RESULT_IN_APP_UPDATE_FAILED`                                                            | re-start the immediate flow on resume                                              |
| 4   | Same, on a device where the app came from internal app sharing    | availability and errors (`-10` app not owned?)                                                                           | treat as unavailable                                                               |
| 5   | Fresh internal-track install: fast-follow pack                    | status at first launch (`DOWNLOADING` or `COMPLETED`), storage method, path, mount                                       | S-05/S-10 path rule                                                                |
| 6   | On-demand pack over 200 MB on mobile data (or Wi-Fi off)          | `WAITING_FOR_WIFI` or `REQUIRES_USER_CONFIRMATION`; `showConfirmationDialog` result                                      | show the dialog on 7 or 9                                                          |
| 7   | Update the app with changed packs                                 | pack states and paths after the update (versionCode segments), whether a re-fetch is needed                              | re-read paths; re-fetch when not `COMPLETED`                                       |
| 8   | Internal-track install: install source                            | installer and initiator `com.android.vending`, **the initiator certificate SHA-256**, `packageSource`, `updateOwner`     | Play is declared, not attested (S-06)                                              |
| 9   | Direct APK from a browser on Android 14+, then a self-update      | prompt or silent; installer afterwards                                                                                   | §Results 3 (silent once the user allows the source)                                |
| 10  | Direct APK on Android 12 or 13 and on Android 15                  | the same, plus the target-SDK floor for silent updates                                                                   | notes/E2 §B2 table                                                                 |
| 11  | Keystore on the device                                            | `securityLevel` (TEE 1 or StrongBox 2), StrongBox availability; the Play Console's foreground-service declaration prompt | TEE, StrongBox optional; declare `dataSync` for PAD extraction if the Console asks |

## Sources

- Play Core AARs, read with `javap -constants`: `com.google.android.play:app-update:2.1.0`,
  `asset-delivery:2.3.0` and its `AndroidManifest.xml`; versions from Google's Maven metadata on
  2026-10-03 [D].
- Godot 4.7.2: `--dump-extension-api` (`EditorExportPlugin`), the export template
  `android_source.zip` (`config.gradle`, `build.gradle`, `gradle-wrapper.properties`), and
  `org.godotengine:godot:4.7.2.stable` (`GodotPlugin`, `SignalInfo` via `javap`) [D].
- bundletool 1.18.3 release (github.com/google/bundletool) [D].
- Emulator observations: `dumpsys package`, `uiautomator dump`, `logcat -s S10`, `aapt2 dump`,
  `bundletool dump manifest`, `dexdump` [M].
- notes/S-06 §7 (install source, stub Play Store, signer digests), notes/S-05 §4.2 (PAD paths and
  mounts), notes/E2 §A2, §A3, §B2, §G, `sdks/godot/addons/polaris_key/distribution/decision.gd`
  and `outlets/play.gd`, program briefs P3-10, P3-11, P5-03, P5-06, P5-08 [S].
