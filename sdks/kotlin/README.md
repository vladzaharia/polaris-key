# Polaris Key — Kotlin

The Kotlin SDK for native Android apps and JVM desktop apps (P6-05), and the shared Android
backend that the Godot SDK, and later Unity and MAUI, bind. It is built in slices: P6-06 landed the
verified core and the conformance runner, P6-07 the licence, config, devices, identity and release
services and the umbrella client, P6-08 the update client and the pack engine, P6-09 the platform
module's stable API and P6-12 the Android glue; the Compose UI kit (P6-11) follows. `parity.json` says which features are implemented today; the
docs' parity page renders it.

| Module         | Kind                  | What                                                                                                                                                                      |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:core`        | JVM library (JAR)     | JWS + Ed25519, the signed documents, trust, the verified cache and clock floor, transport, discovery, sync, capabilities, the boot stage machine, the generated constants |
| `:license`     | JVM library (JAR)     | the licence gate, activation, enrolment, entitlements, channels, deactivation                                                                                             |
| `:config`      | JVM library (JAR)     | layered config resolution, the user-visible list, secrets, the catalog fetch, edge-mint                                                                                   |
| `:identity`    | JVM library (JAR)     | RFC 8628 device-code sign-in (the OIDC redirect stays a host-supplied closure)                                                                                            |
| `:release`     | JVM library (JAR)     | the changelog, download and install URLs, release-record verification                                                                                                     |
| `:update`      | JVM library (JAR)     | the version check, the signed channel feed and the v4 update decision (content included), the boot guard, the `InstallDriver` port                                        |
| `:packs`       | JVM library (JAR)     | the pack engine: planner, full / file / chunk / delta appliers (zstd-jni), install state, `DirPackStorage`, revocations, delegation, handlers, provides, feed deltas      |
| `:sdk`         | JVM library (JAR)     | `PolarisKeyClient`, the umbrella; re-exports `:core` and every service module (`api`)                                                                                     |
| `:conformance` | tests only            | the corpus and HTTP-transcript runner (never published)                                                                                                                   |
| `:platform`    | Android library (AAR) | install source, Keystore, Play Integrity, Play In-App Updates / Play Asset Delivery or PackageInstaller self-update (flavours `play`, `direct`); standalone               |
| `:android`     | Android library (AAR) | the Android glue, the only module that sees both `:sdk` and `:platform`: Keystore store, device inputs, outlet readers, install drivers, the PAD transport (P6-12)        |
| `:godot`       | Android library (AAR) | the Godot Android plugin (v2) over `:platform` ONLY, singleton `PolarisKeyAndroid` (`../godot/native/android/`); `checkPlatformOnly`                                      |
| `:boundary`    | Android app (probe)   | an empty app per flavour; `tools/check_flavours.sh` proves the flavour boundary on its release                                                                            |
| `:ui`          | Android library (AAR) | the Jetpack Compose UI kit (P6-11): boot shell, gate, activation, sign-in with QR, settings, devices, update banner and prompt, pack progress; see `ui/README.md`         |

`:ui` sees `:sdk` and never `:platform` or `:android`. No JVM module has an Android
dependency, each service module depends on `:core` only (never on a sibling; `:sdk` is the one
place they meet), `:platform` depends on no SDK module, and no module but `:android` sees both
`:core` and `:platform` (and nothing but the `:boundary` probe depends on `:android`):
`./gradlew checkModuleBoundaries` fails otherwise, in CI.

Coordinates are `im.plrs.key:polaris-key-<module>`, except `:platform`, which publishes one
artifact per flavour: `polaris-key-platform-play` and `polaris-key-platform-direct` (see below),
`:android`, likewise `polaris-key-android-play` and `polaris-key-android-direct` (each depending on
`polaris-key-sdk` and the platform artifact of the same flavour), and `:godot`, likewise
`polaris-key-godot-play` and `polaris-key-godot-direct`, each depending on
the platform artifact of the same flavour and on no other SDK module (P6-10: Godot keeps its
verifier, licence client, updater and pack engine in GDScript, as Godot on iOS links only Swift's
`PolarisKeyPlatform`).
Kotlin artifacts reach adopters only through Polaris Key's own Maven feed (F-07, F-10); there is
no Maven Central publication, no signing configuration and no remote repository in this build. `maven-publish` writes to
`build/repo` only (`./gradlew :core:publishCorePublicationToLocalRepository` and the same task
per JVM module, e.g. `:sdk:publishSdkPublicationToLocalRepository`,
`./gradlew :platform:publishAllPublicationsToLocalRepository`,
`./gradlew :godot:publishAllPublicationsToLocalRepository`).

Versions follow Godot 4.7.2's Android build template (AGP 8.6.1, Gradle 8.11.1, Kotlin 2.1.21,
compile and target SDK 36, min SDK 24, Java 17 bytecode), so the AARs drop into a Godot Gradle
export unchanged. The SDK-wide values live in `gradle/libs.versions.toml` (`androidCompileSdk`,
`androidTargetSdk`, `androidMinSdk`, `jvmTarget`), never in a module's build file. Play Core:
`app-update` 2.1.0, `asset-delivery` 2.3.0, `integrity` 1.6.0. The JVM modules use kotlinx-coroutines 1.10.2 (`suspend` calls, `Flow` streams),
kotlinx-serialization-json 1.8.1 (the `JsonElement` tree; parsing is the SDK's own strict scanner),
OkHttp 4.12.0 (the one HTTP client on Android API 24 and the JVM) and, below Android API 33, Tink
for Ed25519 (`compileOnly` in `:core`; the JCA's Ed25519 serves JDK 15+ and Android API 33+).

## Install

Every artifact is published to Polaris Key's Maven feed by `.github/workflows/publish-sdks.yml`
(everything `publishAllPublicationsToLocalRepository` writes), at the server's version: each `v*`
tag publishes exactly that version, each push to `main` a `<next>-main.<N>` pre-release. Send the `im.plrs.key` group to the feed alone, so it is never looked up anywhere else:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository {
                maven { url = uri("https://pkg.plrs.im/maven/polaris-key/") }
            }
            filter { includeGroupAndSubgroups("im.plrs.key") }
        }
        google()
        mavenCentral()
    }
}
```

```kotlin
// build.gradle.kts
dependencies {
    implementation("im.plrs.key:polaris-key-sdk:0.1.0")
    // Android: one platform flavour per build
    implementation("im.plrs.key:polaris-key-platform-play:0.1.0") // or -direct
}
```

Maven, the coordinate table and the other SDKs:
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/).

## :core

- **Verification.** `JwsVerifier.verify` is WIRE-CONTRACT-V4 §1 in order; `verifyLicenseDoc`,
  `verifyConfigDoc`, `verifyTrustManifest`, `mergeTrust` and `inspectBundle` (§7, naming the
  refusing step) sit on it. `StrictJson.validate` is the V4 §1.2 scanner (duplicate names by
  scalar value, U+0000, depth, digit-judged numbers) and reports the non-wire-integer pointers
  every integer claim is decided from. `Ed25519.verifier` is the JCA or Tink backend behind one
  port, with the §1.1 prechecks before either.
- **State.** `CoreContext` holds the device id, the token, the trust set, the verified cache and
  the clock floor; `start()` re-verifies the stored record and derives every counter from it;
  `sync()` refreshes trust on Core's cadence, fetches the enabled documents in parallel with their
  ETags, takes at most one shared re-acquire, escalates a 304 past the half-life, writes the cache
  once and reports. `discover()` installs the product's capability map (fail closed).
- **Stores.** `InMemoryStore` and the 0600 `FileStore`. On the JVM there is no OS keyring without
  a native library, so `FileStore.status()` reports `file` / `keyring-unavailable`; on Android,
  `:android`'s `AndroidKeystoreStore` (below).
- **Capabilities.** `Capabilities.sdk().supports(feature, services)` answers from the generated
  table (`Constants.generated.kt`, from `parity.json`), with typed reasons.
- **Pure functions.** `bootTransition` (the boot stage machine), `licenseState`,
  `Fingerprint.hashComponents` and the source rules, `DeviceId.fromRaw`, `detectOutlet`,
  `effectiveCapabilities`, `canonicalPlatform` / `canonicalArch`, `Semver`.

`Constants.generated.kt` and `ServiceSlug.generated.kt` are written by `pnpm gen:constants` and
`pnpm gen:services`; never edit them by hand.

## The services and PolarisKeyClient

`polaris-key-sdk` is the one-line dependency: `PolarisKeyClient` composes `:core` with one
sub-client per service, and every public call is `suspend` (licence changes stream as a `Flow`,
`licenseChanges`). Errors are `:core`'s `PolarisException` with a registry code; a call to a
service the product does not run throws `service-unavailable` before any request (D-21).

```kotlin
val client = PolarisKeyClient.create(
    PolarisKeyClientOptions(
        core = CoreOptions(productSlug = "djdl", version = BuildConfig.VERSION_NAME, pinnedKeys = PINNED),
    ),
)
client.activate(key)                       // license: stores the token, then syncs (forced)
if (!isUsable(client.status())) showGate()
val theme = client.config("ui.theme", JsonPrimitive("dark"))
val notes = client.release.changelog()
val prompt = client.identity.beginSignIn("Living room TV")  // RFC 8628; show prompt.userCode
client.identity.waitForSignIn(prompt)
```

- **`:license`**: `LicenseClient.status()` (the §5 gate over the verified cache and the clock
  floor), `activate`, `enroll`, `deactivate` (remote best-effort, local wipe mandatory),
  `entitlements`, `isEntitled`, `profile`, `licenseId`, `entitledChannels` (the grants, raw, or
  `["stable"]`). A 401 re-acquires once per pass (§5): `POST /license/token`, or re-registration
  for a registered-without-licence device (P1b-06).
- **`:config`**: `ConfigClient.config(key, default)` and `configSource` (enforced or hidden, then
  local, environment, remote default, fallback), `listUserConfig`, `secret`, `fetchSchema` (null
  on any failure), `mintToken` (edge-mint, cached in memory only and bound to the device token).
  `ConfigResolution` is the pure resolver `config-matrix.json` pins.
- **Devices** (in `:core`, as the registry files them): `registerDevice`, `listDevices`,
  `renameDevice`, `deauthorizeDevice`, the report, and two ports: `FingerprintSource`
  (`JvmFingerprintSource` on a desktop) and `DeviceFactsSource` (`JvmDeviceFactsSource`); the
  Android implementations are `:android`'s.
- **`:identity`**: `beginSignIn`, `pollSignIn` (once), `waitForSignIn` (paced, cancellable).
- **`:release`**: `changelog`, `installUrl`, `downloadUrl` (built, never fetched), `verifyRecord`
  (a `pkey-release+jws` against the keys the app pins; `:core`'s `verifyReleaseRecord`, which the
  update engine shares).

## Update and packs

`client.update` is the update client and `client.packs` the pack facet (P6-08). The facade hands
the packs facet to the update client as its content host, so `decide()` sees the running pack set
and the engine sees each committed feed's delta menu; `:update` and `:packs` never depend on each
other.

```kotlin
val client = PolarisKeyClient.create(
    PolarisKeyClientOptions(
        core = CoreOptions(productSlug = "djdl", version = BuildConfig.VERSION_NAME, pinnedKeys = PINNED),
        update = UpdateClientOptions(pinnedReleaseKeys = RELEASE_KEYS, outlet = HostOutlet.Kind("play")),
        packs = PacksOptions(contentStamp = PackStampSource.FromFile(stampFile), axes = mapOf("locale" to listOf("fr", "en"))),
    ),
)
val check = client.update.decide()           // the signed feed, the record by hash, the decision
when (val d = check.decision) {
    is UpdateDecision.Packs -> client.packs.ensureReleases(d.install)
    is UpdateDecision.Store -> openListing(d.listingUrl)
    else -> {}
}
client.packs.ensure(listOf("djdl.levels"))   // the stamp's pinned release, by the cheapest strategy
```

- **`:update`**: `check()` (`update/version`), `channelFeed()`, `decide(channel, staged,
skipVersion)`, `releaseRecord(hash)`, `buildUrl(version, buildId)` and `install(check)` through the
  `InstallDriver` port (Play In-App Updates and PackageInstaller are `:android`'s; a JVM desktop build has
  none, `JvmInstallDriver` throws the typed `runtime` N/A). The decision logic is `:core`'s
  (`verifyFeed`, `decideUpdate`, `runUpdateCheck`, the content decision), as in Swift's
  `PolarisKeyCore`. `BootGuard` is the GUARD stage over a host's `UpdateSlots` (apply a staged update,
  count unconfirmed launches, roll back after two with `skipVersion`, the confirmation rows); outlet
  signals come through `OutletSignalReader` (Android's reader is `:android`'s).
- **`:packs`**: `PackEngine` (`load`, `ensure`, `ensureReleases`, `estimate`, `state`, `rollback`,
  `confirm`, `recoverState`, `revocations`, `isAvailable`, `packFor`, `registerHandler`, progress
  events) over the `PackStorage` port (`DirPackStorage` under the store's data directory, never a
  cache directory; `MemoryPackStorage` for tests), the object transport port
  (`OkHttpPackObjectTransport`, bounded single ranges for chunk sync) and the `ZstdPort` (`LibZstd`
  over zstd-jni 1.5.7: streamed `full` payloads, `--patch-from` deltas with the base as a raw-content
  dictionary after the dictionary-magic refusal and the window check). Built-in handlers:
  `files.tree`, `data.json`, `l10n.table`; `MlModelHandler` is host-registered. `PacksClient` is the
  facet: the content stamp, embedded baselines, `bootFetch` for the stage machine, and the device
  report's `content.packSetId`.
- **Native code.** zstd-jni is the SDK's only native library. The JAR carries the desktop natives;
  on Android the `:android` glue excludes it and links zstd-jni's Android AAR, at 1.5.7-12
  (`zstdJniAndroid`: every AAR from 1.5.7-13 on declares minCompileSdk 37, which compileSdk 36
  under AGP 8.6.1 cannot consume), whose `.so` files are 16 KB page aligned
  (`tools/check_16k_alignment.py`, in the `kotlin` CI job, and on the `:boundary` APKs in
  `tools/check_flavours.sh`). Where the native library cannot load, `supports(packs.apply.delta)`
  answers `dependency`.

**Typed catalog mirror.** `pnpm gen:mirrors --catalog catalog.json --out-dir <dir> --lang kotlin
--kotlin-package com.example.catalog` writes `ConfigSchema.generated.kt`, a dependency-free
`ProductCatalog` object (keys, entries, each entry's JSON schema and default; a secret's default is
never compiled in). The `:config` tests compile a sample of it.

## :platform

`:platform` is the Android platform module (P5-06, moved into the SDK structure by P6-09): the
Godot SDK reaches it through the `PolarisKeyAndroid` plugin now, and the rest of the Kotlin SDK,
Unity and MAUI build on it. Pure Kotlin, no NDK.

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

## :platform API

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

## :android

`:android` (P6-12) is the Kotlin SDK's Android glue: the one module that depends on both the SDK
(`:sdk`, and through it `:core` and every service module) and `:platform`, so `:platform` stays
standalone for the Godot binding. Flavours match the platform's (`play`, `direct`), and the flavour
boundary covers it (`tools/check_flavours.sh` reads the `:boundary` APKs, which now carry it).

```kotlin
val client = PolarisKeyAndroid.client(
    context,
    PolarisKeyClientOptions(
        core = CoreOptions(productSlug = "diceroll", version = BuildConfig.VERSION_NAME, pinnedKeys = trust),
        update = UpdateClientOptions(pinnedReleaseKeys = releaseKeys, stamp = stamp),
        packs = PacksOptions(contentStamp = PackStampSource.FromBytes(assets.open("pkey-content.json").readBytes())),
    ),
    AndroidOptions(activity = { currentActivity }, playPacks = listOf("diceroll.foes")),
)
val check = client.update.decide()
client.update.install(check)   // In-App Updates (play) or the verified PackageInstaller session (direct)
```

- **`AndroidKeystoreStore`** (`core.store`): the token and the device id wrapped by `SecureStore`
  (one AndroidKeyStore AES-256-GCM key per product, StrongBox where present, blobs in
  `noBackupFilesDir`), the verified cache and a copy of the device id in plain files under
  `noBackupFilesDir/pkey/<product>/`. A legacy `FileStore`'s token and device id migrate in (the
  token file is then removed, retried until it is); a failed Keystore call throws `StoreException`
  and `status()` reports `keystore` / `keyring-error` until a call succeeds (no file fallback); a
  lost key drops the token (`lastReset`) and keeps the device id.
- **`AndroidFingerprintSource`, `AndroidDeviceFactsSource`** (`devices.fingerprint`,
  `devices.facts`): `machineUuid` is `ANDROID_ID` (app-scoped; else a random anchor kept in the
  Keystore), with `Build.MODEL` and the RAM bucket, hashed by `:core`; the device id hashes the same
  anchor. Facts read `Build` and answer only the product's declared `android` probes, one
  `getPackageInfo` each (list them in the app's `<queries>` on API 30+; no enumeration).
- **`AndroidOutletSignalReader`** (`outlet.detect`): `android.installSource` and
  `android.installerMismatch` from `:platform`'s `InstallSource`, as Godot reads them.
- **Install drivers** (`update.driver`): `PlayInstallDriver` (play) acts on a `store` decision
  through In-App Updates (complete a downloaded update, flexible or immediate by urgency, staging
  answered `Declined("play-staging")`; `PlayUpdatePolicy` can make Play's priority or staleness
  urgent). `DirectInstallDriver` (direct) installs `binary {method: native}`: the verified record's
  one `payload` artifact, downloaded into `filesDir/pkey/<product>/updates/apk/`, size and SHA-256
  checked, then `ApkInstaller`'s verified session; every refusal is `swap-refused` with its reasons.
  `DirectInstallDriver.launchOutcome(context)` reads the journaled result at the next launch.
- **`PlayPackTransport`** (`packs.transport.play`): on play, `PadPackTransport` re-reads each carried
  pack's PAD location on every call (never persisted), finds `pkey/` or `pkey#tcf_*/`, and hands
  `:packs` an embedded baseline the marker, record and stamp pin verify; `ensure(packId)` waits for
  COMPLETED, asking the confirm hook before Play's cellular dialog. On direct it answers
  `Unsupported(outlet)`. A pack delivered mid-session mounts at the facet's next start.

## Build and test

```sh
cd sdks/kotlin
# JVM modules (JDK 17; no Android SDK needed with -Ppkey.jvmOnly=true)
./gradlew -Ppkey.jvmOnly=true :core:test :license:test :config:test :identity:test :release:test \
          :update:test :packs:test :sdk:test :conformance:test checkModuleBoundaries
python3 tools/check_16k_alignment.py   # zstd-jni's Android natives are 16 KB page aligned
# Android modules
./gradlew :platform:testPlayDebugUnitTest :platform:testDirectDebugUnitTest \
          :godot:testPlayDebugUnitTest :godot:testDirectDebugUnitTest \
          :android:testPlayDebugUnitTest :android:testDirectDebugUnitTest
./gradlew :platform:assembleRelease :godot:assembleRelease :android:assembleRelease :boundary:assembleRelease
tools/check_flavours.sh        # the boundary on the release AARs and APKs
./gradlew :platform:checkStandalone :godot:checkPlatformOnly checkModuleBoundaries \
          :platform:publishAllPublicationsToLocalRepository :godot:publishAllPublicationsToLocalRepository \
          :android:publishAllPublicationsToLocalRepository
tools/check_publication.sh     # both flavours of each in build/repo with POM, sources and .module
```

`:conformance` reads `conformance/corpus/v2/` and `conformance/transcripts/` from the repository
in place. Its `test` task depends on `testTink`, so every suite runs on the JCA Ed25519 backend
and again with Tink forced: `cases.json` (the JWS, licence, config, trust, clock-floor and bundle
families and their pointer sets, `releaseRecordCases`, `feedCases`, `feedContentCases`,
`revocationCases`, `packRecordCases`, `markerCases` and `delegationCases`), `gate-matrix.json`,
`config-matrix.json`, `update-matrix.json`, `plan-matrix.json`, every `content/` section (under
both zstd paths), `headers.json`, `fingerprint.json`, `stage-matrix.json`,
`outlet-matrix.json`, and every transcript `parity.json` makes applicable (replayed by
`TranscriptReplay.kt`, a port of the Node engine, driving `PolarisKeyClient`). Every suite extends
`ConformanceSuite`, which installs the backend the task names before the suite runs. The `kotlin` job in `.github/workflows/ci.yml`
runs the JVM line.

The Android modules need the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`) with
`platforms;android-36` and `build-tools;36.1.0`; `settings.gradle.kts` includes them only when an
SDK is configured. The unit tests run on Robolectric 4.14 with Play Core's
`FakeAppUpdateManager`, a fake `PackManager`, fake `PackageFacts` and Robolectric's
PackageInstaller; AndroidKeyStore is replaced by a software `KeyProvider` (Robolectric has none).
The `android` job in `.github/workflows/ci.yml` runs all of it. The real Keystore, a real silent
self-update and Play Asset Delivery under `bundletool --local-testing` run on an emulator through
`sdks/godot/native/android/export_check.sh` (see its README). In-App Updates and PAD from a real Play
install, and `:android`'s device rows (an internal-track update offered, a direct self-update, a
fast-follow pack mounted, the outlet readout), need the owner's device checklist (the P5-06 and P6-12
briefs).

The Gradle wrapper pins `distributionSha256Sum`; the wrapper jar is committed (the repository's
`.gitignore` re-includes it).
