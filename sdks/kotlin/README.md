# Polaris Key — Kotlin (Android platform backend)

`polaris-key-platform` is the shared Android backend for Polaris Key (P5-06): the Godot SDK
reaches it through the `PolarisKeyAndroid` plugin now, and the Kotlin SDK proper (P6-05), Unity
and MAUI build on it later. Pure Kotlin, no NDK. Proposed Maven coordinates:
`im.plrs.key:polaris-key-platform` (not published yet).

| Module      | Where                      | What                                                                                   |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `:platform` | `platform/`                | the AAR, flavours `play` and `direct`                                                  |
| `:godot`    | `../godot/native/android/` | the Godot Android plugin (v2) over it, singleton `PolarisKeyAndroid`                   |
| `:boundary` | `boundary/`                | an empty app per flavour; `tools/check_flavours.sh` proves the boundary on its release |

Versions follow Godot 4.7.2's Android build template (AGP 8.6.1, Gradle 8.11.1, Kotlin 2.1.21,
compile and target SDK 36, min SDK 24, Java 17 bytecode), so the AARs drop into a Godot Gradle
export unchanged. Play Core: `app-update` 2.1.0, `asset-delivery` 2.3.0.

## The flavours are a policy boundary

Play forbids self-update and `REQUEST_INSTALL_PACKAGES` in Play builds, so a build is one or the
other, fixed at build time (`PolarisKeyPlatform.flavor`):

| Flavour  | Has                                                                              | Never has                                          |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `play`   | install source, Keystore, Play In-App Updates, Play Asset Delivery               | PackageInstaller session code, install permissions |
| `direct` | install source, Keystore, verified PackageInstaller self-update, status receiver | any `com.google.android.play` class                |

Neither AAR declares a permission: a direct app adds `REQUEST_INSTALL_PACKAGES` and
`UPDATE_PACKAGES_WITHOUT_USER_ACTION` itself (the Godot export plugin does it for direct presets).
`asset-delivery` brings `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` and WorkManager's
permissions into play builds (notes/S-10 §2).

## API

- **`InstallSource.read(context)`**: raw `getInstallSourceInfo` facts (API 30+, the
  `getInstallerPackageName` fallback below): installer, initiator, the initiator's
  signing-certificate SHA-256s, `packageSource` (33+), `updateOwner` (34+), own signers,
  `selfUpdated` (installer == initiator == own package, after a self-update). Mapping them to an
  outlet is the SDK's job; a `com.android.vending` claim is forgeable through `adb` and attested
  only by the initiator certificate (notes/S-06 §7).
- **`SecureStore(context, product)`**: small secrets wrapped by one AndroidKeyStore AES-256-GCM key
  per product (`pkey:<product>:device`; StrongBox where present, else the TEE). Blobs
  `0x01 ‖ iv ‖ ct ‖ tag` in `noBackupFilesDir/pkey/<product>/keystore/<account>.kv`, AAD
  `pkey/v1/<product>/<account>`. A lost or invalidated key drops its blobs and `get` answers
  `Read(null, reset)`; every other failure throws `SecureStoreException(reason)`.
- **`play.InAppUpdates(manager)`**: `check` (any failure is `UpdatesUnavailable`, not only an
  `InstallException`: without the Play Store the failure is an internal bind error), `start`
  (`startUpdateFlowForResult`; the result arrives as the activity's result for `REQUEST_CODE`),
  `complete`, install-state listeners. On resume, `readyToComplete` means "complete" and
  `inProgress` with an immediate update means "start the immediate flow again".
- **`play.AssetPacks(manager, known)`** over the fakeable `PackManager` (`PlayPackManager` adapts
  Play Core; 2.3.0 ships no fake): one pack per call (one unknown name fails a whole Play batch),
  names checked first, state from the listener, `PackLocation.pckPath` for a completed
  `STORAGE_FILES` pack (re-read every launch: the path holds the versionCode), `installTime` for the
  install-time pack.
- **`direct.ApkInstaller(context)`**: `verify` and `install(file, sha256, versionCode, options)`.
  Refusals before any session: `missing_file`, `path_not_private`, `hash_required`,
  `hash_mismatch`, `unparseable`, `package_mismatch`, `signer_mismatch`, `version_not_higher`,
  `version_mismatch`; the bytes are hashed again while they stream into the session
  (`hash_changed`). `USER_ACTION_NOT_REQUIRED` on API 31+, optional gentle constraints on 34+, no
  update-ownership request. `abandonStaleSessions`, `canInstall`, `settingsIntent`,
  `gentleConstraintsSatisfied` (null until the app is its own installer). The status reaches the
  manifest-declared `InstallStatusReceiver`, usually in a new process of the new version (the
  update kills the app; nothing relaunches it), which journals it (`InstallJournal`) for the next
  launch and tells a running app through `InstallEvents.listener`.

## Build and test

```sh
cd sdks/kotlin
./gradlew :platform:testPlayDebugUnitTest :platform:testDirectDebugUnitTest \
          :godot:testPlayDebugUnitTest :godot:testDirectDebugUnitTest
./gradlew :platform:assembleRelease :godot:assembleRelease :boundary:assembleRelease
tools/check_flavours.sh        # the boundary on the release AARs and APKs
```

JDK 17 or later and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`) with
`platforms;android-36` and `build-tools;36.1.0`. The unit tests run on Robolectric 4.14 with Play
Core's `FakeAppUpdateManager`, a fake `PackManager`, fake `PackageFacts` and Robolectric's
PackageInstaller; AndroidKeyStore is replaced by a software `KeyProvider` (Robolectric has none).
The `android` job in `.github/workflows/ci.yml` runs all of it. The real Keystore, a real silent
self-update and Play Asset Delivery under `bundletool --local-testing` run on an emulator through
`sdks/godot/native/android/export_check.sh` (see its README). In-App Updates and PAD from a real Play
install need the owner's device checklist (the P5-06 brief).

The Gradle wrapper pins `distributionSha256Sum`; the wrapper jar is committed (the repository's
`.gitignore` re-includes it).
