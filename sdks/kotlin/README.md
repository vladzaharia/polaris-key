# Polaris Key — Kotlin (Android platform backend)

`polaris-key-platform` is the Kotlin SDK's Android platform module (P5-06, moved into the SDK
structure by P6-09): the Godot SDK reaches it through the `PolarisKeyAndroid` plugin now, and the
rest of the Kotlin SDK (P6-05), Unity and MAUI build on it. Pure Kotlin, no NDK.

**Standalone.** `:platform` depends on no other SDK module, so a host that wants only the Android
edges (Godot, later Unity and MAUI) links it alone, exactly as Godot on iOS links only Swift's
`PolarisKeyPlatform`. `./gradlew :platform:checkStandalone` (part of `check`, and run by the
`android` CI job) fails if any compile or runtime classpath of any variant holds a project
dependency or an `im.plrs.key` module. A convenience that wants the core belongs in `:android`
(P6-12), never here.

**Coordinates.** One artifact per flavour, each with its own POM (the play one depends on Play
Core, the direct one must not), sources jar and Gradle module metadata:
`im.plrs.key:polaris-key-platform-play` and `im.plrs.key:polaris-key-platform-direct`. They are
published only to a local repository, `./gradlew :platform:publishAllPublicationsToLocalRepository`
into `sdks/kotlin/build/repo` (`tools/check_publication.sh` checks it). There is no signing and no
Maven Central: adopters get them from the Polaris Key Maven feed later (F-07, F-10).

**Stability.** The Kotlin API is public SDK surface (`explicitApi`, KDoc on every type) and grows
additively: the Godot binding addresses it through its `cmd(json)` surface, so a rename is a
breaking change for P6-10.

| Module      | Where                      | What                                                                                   |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `:platform` | `platform/`                | the AAR, flavours `play` and `direct`                                                  |
| `:godot`    | `../godot/native/android/` | the Godot Android plugin (v2) over it, singleton `PolarisKeyAndroid`                   |
| `:boundary` | `boundary/`                | an empty app per flavour; `tools/check_flavours.sh` proves the boundary on its release |

Versions follow Godot 4.7.2's Android build template (AGP 8.6.1, Gradle 8.11.1, Kotlin 2.1.21,
compile and target SDK 36, min SDK 24, Java 17 bytecode), so the AARs drop into a Godot Gradle
export unchanged. The SDK-wide values live in `gradle/libs.versions.toml` (`androidCompileSdk`,
`androidTargetSdk`, `androidMinSdk`, `jvmTarget`), never in a module's build file. Play Core: `app-update` 2.1.0, `asset-delivery` 2.3.0, `integrity` 1.6.0.

## The flavours are a policy boundary

Play forbids self-update and `REQUEST_INSTALL_PACKAGES` in Play builds, so a build is one or the
other, fixed at build time (`PolarisKeyPlatform.flavor`):

| Flavour  | Has                                                                                | Never has                                          |
| -------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| `play`   | install source, Keystore, Play In-App Updates, Play Asset Delivery, Play Integrity | PackageInstaller session code, install permissions |
| `direct` | install source, Keystore, verified PackageInstaller self-update, status receiver   | any `com.google.android.play` class                |

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
- **`play.PlayIntegrity(backend)`** (P6-02) over the fakeable `IntegrityBackend`
  (`PlayIntegrityBackend` adapts Play's `StandardIntegrityManager`; Play ships no fake): the
  STANDARD API, `prepare(cloudProjectNumber)` once and `request(cloudProjectNumber, requestHash)` per
  verdict, the provider cached per cloud project number, dropped and prepared again once on
  `INTEGRITY_TOKEN_PROVIDER_INVALID` (-19). The request hash is the Worker's `requestHash` from
  `POST /<product>/devices/attest/challenge`, verbatim (1–500 characters). Failures are
  `IntegrityError(errorCode)` with the `StandardIntegrityErrorCode`, or none without Play services.
- **`PlatformIntegrity.create(context)`** (P6-09): the same Integrity surface in every flavour.
  `prepare(cloudProjectNumber)` and `request(cloudProjectNumber, requestHash)` answer an
  `IntegrityResult`: `Success` (a `PlatformIntegrityToken` with its `prepared`/`reprepared` flags),
  `Refused` (a project number that is not positive, a hash outside 1–500 characters; Play is never
  asked), `Failed(exception, message, errorCode)` (Play's failure), or `Unsupported(reason)`. The
  `play` flavour answers through `play.PlayPlatformIntegrity` over `play.PlayIntegrity` (Play's
  manager created on first use); the `direct` flavour answers `Unsupported("outlet")` to every call
  and carries no Play Core class. The cloud project number is the host app's, supplied at call time
  (the Worker returns it with each challenge); the module never embeds one.
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
./gradlew :platform:checkStandalone :platform:publishAllPublicationsToLocalRepository
tools/check_publication.sh     # both flavours in build/repo with POM, sources and .module
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
