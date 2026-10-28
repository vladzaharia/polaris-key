# Polaris Key — Kotlin

The Kotlin SDK for native Android apps and JVM desktop apps, with a Jetpack Compose UI kit, and the
shared Android backend that the Godot SDK, and later Unity and MAUI, bind. It has full parity: the verified core and the conformance runner, the license, config,
devices, identity and release services and the umbrella client, the update client and the
pack engine, the platform module's stable API, the Godot binding on `:platform`, the Compose UI
kit and the Android glue. `parity.json` says which features are implemented;
the docs' parity page renders it. The SDK parity pass (notes/SDK-PARITY-PASS.md §5.5) added
attestation, commerce, update-health events and the typed activation results; the rows it leaves
planned are `identity.oidc` (native browser sign-in waits on the server's redirect-token route) and `packs.transport.steam`,
each with a note.

| Module                 | Kind                  | What                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:core`                | JVM library (JAR)     | JWS + Ed25519, the signed documents, trust, the verified cache and clock floor, transport, discovery, sync, capabilities, the boot stage machine, the generated constants                                                                                                                             |
| `:license`             | JVM library (JAR)     | the license gate, activation, enrolment, entitlements, channels, deactivation                                                                                                                                                                                                                         |
| `:config`              | JVM library (JAR)     | layered config resolution, the user-visible list, secrets, the catalog fetch, edge-mint                                                                                                                                                                                                               |
| `:identity`            | JVM library (JAR)     | RFC 8628 device-code sign-in (the OIDC redirect stays a host-supplied closure), the token exchange and `autoSignIn()`                                                                                                                                                                                 |
| `:release`             | JVM library (JAR)     | the changelog, download and install URLs, release-record verification                                                                                                                                                                                                                                 |
| `:update`              | JVM library (JAR)     | the version check, the signed channel feed and the v4 update decision (content included), the boot guard, the `InstallDriver` port                                                                                                                                                                    |
| `:packs`               | JVM library (JAR)     | the pack engine: planner, full / file / chunk / delta appliers (zstd-jni), install state, `DirPackStorage`, revocations, delegation, handlers, provides, feed deltas                                                                                                                                  |
| `:sdk`                 | JVM library (JAR)     | `PolarisKeyClient`, the umbrella; re-exports `:core` and every service module (`api`)                                                                                                                                                                                                                 |
| `:ui-core`             | JVM library (JAR)     | the Compose-free UI layer: state holders and the presentation core of the Kotlin UI kits; no Compose or AndroidX; `:ui` exposes it (`api`)                                                                                                                                                            |
| `:server`              | JVM library (JAR)     | `polaris-key-server`: gate a server route with the app's signed license document, offline: the six-step verdict, `Require` (entitlement, tier, sign-in), the problem body (eight locales), the trust refresh, `PolarisTestKit` for tests; no framework, over `:core` only; see `server/README.md`     |
| `:server-ktor`         | JVM library (JAR)     | `polaris-key-server-ktor`: the Ktor plugin over `:server`: `polarisKey { }`, `requireLicense`, `requireEntitlement`, `requireTier`, `requireSignIn`, `requireAll`; see `server-ktor/README.md`                                                                                                        |
| `:spring-boot-starter` | JVM library (JAR)     | `polaris-key-spring-boot-starter`: Spring Boot auto-configuration (`polaris-key.*`) and Spring Security over `:server`: `http.polarisKey()`, `PolarisKey.license/entitlement/tier/signIn/all` for `access(...)`, the problem-body entry point and denied handler; see `spring-boot-starter/README.md` |
| `:conformance`         | tests only            | the corpus and HTTP-transcript runner (never published)                                                                                                                                                                                                                                               |
| `:platform`            | Android library (AAR) | install source, Keystore, Play Integrity, Play In-App Updates / Play Asset Delivery or PackageInstaller self-update (flavors `play`, `direct`); standalone                                                                                                                                            |
| `:android`             | Android library (AAR) | the Android glue, the only module that sees both `:sdk` and `:platform`: Keystore store, device inputs, outlet readers, install drivers, the PAD transport                                                                                                                                            |
| `:godot`               | Android library (AAR) | the Godot Android plugin (v2) over `:platform` ONLY, singleton `PolarisKeyAndroid` (`../godot/native/android/`); `checkPlatformOnly`                                                                                                                                                                  |
| `:boundary`            | Android app (probe)   | an empty app per flavor; `tools/check_flavours.sh` proves the flavor boundary on its release                                                                                                                                                                                                          |
| `:ui`                  | Android library (AAR) | the Jetpack Compose UI kit: boot shell, gate, activation, sign-in with QR, settings, devices, update banner and prompt, pack progress; see `ui/README.md`                                                                                                                                             |
| `:billing`             | Android library (AAR) | Play Billing as license flags (SP-K05): `PolarisPlayBilling` buys with the license binding as `obfuscatedAccountId`, claims, acknowledges after the claim, restores                                                                                                                                   |

`:ui` sees `:sdk` and never `:platform` or `:android`. No JVM module has an Android
dependency, each service module depends on `:core` only (never on a sibling; `:sdk` is the one
place they meet), `:platform` depends on no SDK module, and no module but `:android` sees both
`:core` and `:platform` (and nothing but the `:boundary` probe depends on `:android`):
`./gradlew checkModuleBoundaries` fails otherwise, in CI.

Coordinates are `im.plrs.key:polaris-key-<module>`, except `:platform`, which publishes one
artifact per flavor: `polaris-key-platform-play` and `polaris-key-platform-direct` (see below),
`:android`, likewise `polaris-key-android-play` and `polaris-key-android-direct` (each depending on
`polaris-key-sdk` and the platform artifact of the same flavor), and `:godot`, likewise
`polaris-key-godot-play` and `polaris-key-godot-direct`, each depending on
the platform artifact of the same flavor and on no other SDK module (Godot keeps its
verifier, license client, updater and pack engine in GDScript, as Godot on iOS links only Swift's
`PolarisKeyPlatform`).
Kotlin artifacts reach adopters only through Polaris Key's own Maven feed; there is
no Maven Central publication, no signing configuration and no remote repository in this build. `maven-publish` writes to
`build/repo` only (`./gradlew :core:publishCorePublicationToLocalRepository` and the same task
per JVM module, e.g. `:sdk:publishSdkPublicationToLocalRepository`,
`./gradlew :platform:publishAllPublicationsToLocalRepository`,
`./gradlew :godot:publishAllPublicationsToLocalRepository`).

Versions follow Godot 4.7.2's Android build template (AGP 8.6.1, Gradle 8.11.1, Kotlin 2.1.21,
compile and target SDK 36, min SDK 24, Java 17 bytecode; the packs facet needs `java.nio.file` and so Android API 26: on API 24-25 it answers `UnsupportedException` with reason `runtime`), so the AARs drop into a Godot Gradle
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

```kts title="settings.gradle.kts"
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

```kts title="build.gradle.kts"
dependencies {
    implementation("im.plrs.key:polaris-key-sdk:0.1.0")
    // Android: one platform flavor per build
    implementation("im.plrs.key:polaris-key-platform-play:0.1.0") // or -direct
}
```

Maven, the coordinate table and the other SDKs:
[Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/).

## :core

- **Verification.** `JwsVerifier.verify` follows the wire contract's order (v4); `verifyLicenseDoc`,
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
- **Presentation** (`core.presentation`). `discover()` also parses the product's display
  data (`PresentationRules`, client-core's rules): `client.presentation()` (name, developer,
  accents, icon), `client.presentationIcon(px, scale)` (verified bytes, or null) and
  `client.presentationSource` (the `PresentationSource` seam the Compose kit reads:
  `PolarisTheme { PolarisKeyGate(client) { … } }` passes it to the theme itself). The icon is a plain GET with no
  headers and no redirect followed, SHA-256 checked, cached by hash under the store's state
  directory (`presentation/`, at most four files, `presentation.json` for a cold start). The
  integrator's logo and accent always win; the kit falls back to the icon, then the monogram.
- **Stores.** `InMemoryStore`, the 0600 `FileStore` (`status()` reports `file` /
  `keyring-unavailable`) and, on a JVM desktop, `KeyringStore`: the token in the OS keyring
  (Keychain, Credential Manager, Secret Service) through java-keyring, the device id and cache in
  0600 files, Python's `KeyringStore` rules (a verified write else the file, file-first reads, a
  `FileStore` token moves in). java-keyring is `compileOnly`: without it at runtime, or with no
  reachable keyring, the token stays in the file and `supports(core.store)` says `dependency`. On
  Android, `:android`'s `AndroidKeystoreStore` (below). Every default store is scoped to its control
  plane (`CoreContext.storageNamespace`): production (`https://key.plrs.im`) keeps the bare
  product name, any other `baseUrl` (a local `pkey dev` Worker) names its directory, keyring service,
  Keystore alias and pack root `<product>@<host>[_<port>]` (`storeNamespace`), so it never shares a
  token, device id or cache with production.
- **Capabilities.** `Capabilities.sdk().supports(feature, services)` answers from the generated
  table (`Constants.generated.kt`, from `parity.json`), with typed reasons.
- **Pure functions.** `bootTransition` (the boot stage machine), `licenseState`,
  `Fingerprint.hashComponents` and the source rules, `DeviceId.fromRaw`, `detectOutlet`,
  `effectiveCapabilities`, `canonicalPlatform` / `canonicalArch`, `Semver`.

`Constants.generated.kt` and `ServiceSlug.generated.kt` are written by `pnpm gen constants` and
`pnpm gen services`; never edit them by hand.

## The services and PolarisKeyClient

`polaris-key-sdk` is the one-line dependency: `PolarisKeyClient` composes `:core` with one
sub-client per service, and every public call is `suspend` (licence changes stream as `events`, a
`SharedFlow<PolarisEvent>`). Errors are `:core`'s `PolarisException` with a registry code; a call to a
service the product does not run throws `service-unavailable` before any request.

```kotlin
import im.plrs.key.core.CoreOptions
import im.plrs.key.identity.SignInOptions
import im.plrs.key.license.isUsable
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.serialization.json.JsonPrimitive

suspend fun start(key: String) {
    val client = PolarisKeyClient.create(
        PolarisKeyClientOptions(
            core = CoreOptions(productSlug = "djdl", version = BuildConfig.VERSION_NAME, pinnedKeys = PINNED),
        ),
    )
    client.license.activateWithKey(key)                       // license: stores the token, then syncs (forced)
    if (!isUsable(client.status())) showGate()
    val theme = client.config.get("ui.theme", JsonPrimitive("dark"))
    val notes = client.release.changelog()
    val session = client.identity.signIn.start(SignInOptions(deviceName = "Living room TV"))  // RFC 8628; show session.userCode
    session.wait()
}
```

- **`:license`**: `LicenseClient.status()` (the §5 gate over the verified cache and the clock
  floor), `activateWithKey`, `enroll`, `deactivate` (remote best-effort, local wipe mandatory),
  `licenseInfo` (license id, tier, tier label,
  device limit, profile, channels), `getProfile`, `getLicenseId`, `getLicenseUser`, `entitledChannels` (the grants, raw, or
  `["stable"]`). The `entitlements` namespace (`has`, `value`, `all`, in `EntitlementsClient`) reads the held document; **`entitlements.has` answers `false` whenever the gate is not usable** (revoked,
  expired, blocked, never activated; S-19 G11), whatever the last document said; it used to read
  the document alone. Activation answers a typed `ActivationResult` whose every refusal carries the
  server's registry `code`: `DeviceLimit`, `Unauthorized`, `FingerprintRequired`,
  `HardwareMismatch`, `EnrollDisabled`, `EnrollClaimed`, `LicenseDisabled`, `LicenseExpired`,
  `AttestationRequired`, `RateLimited(retryAfterSeconds)`, `Refused(code, status, message)` for any
  other 4xx, and `Error` (`network` or `server-error`). An unknown 403 is `Refused`, never
  `DeviceLimit` (notes/SDK-PARITY-PASS.md §3.1). A 401 re-acquires once per pass (§5): `POST /license/token`, or re-registration
  for a registered-without-license device (P1b-06).
- **`:config`**: `ConfigClient.get(key, default)` and `getConfigSource` (enforced or hidden, then
  local, environment, remote default, fallback), `listUserConfig`, `getSecret`, `fetchSchema` (null
  on any failure), `mintToken` (edge-mint, cached in memory only and bound to the device token).
  `ConfigResolution` is the pure resolver `config-matrix.json` pins. **Local overrides**
  (notes/SDK-PARITY-PASS.md §3.11): `set(key, value)` persists one (it beats a remote default,
  never an enforced or hidden key: `managed_by_admin`), checked against the catalog entry's schema
  once `fetchCatalog()` has run, else against the document's JSON type (`invalid-options`);
  `clear(key)` and `clearAll()` remove them. They live in `local-config.json` beside the token
  store (on Android, the Keystore store's no-backup directory), or any `StateSlot` passed as
  `ConfigClientOptions.localStore`. This deliberately differs from the plan's Jetpack DataStore
  (notes/SDK-PARITY-PASS.md §3.11, SP-K07): one small JSON file read whole and replaced
  atomically keeps `:config` free of an Android dependency, the same on the JVM and Android, and
  on Android the no-backup directory keeps overrides out of cloud backups, as the token store is.
  `setting(key)` is a live `StateFlow` of the key's effective value and `changes` a
  `SharedFlow<ConfigChange>` of every change (a local override or a new document). `fetchCatalog()` / `catalog` type the served catalog (label, description, schema,
  widget) for a settings screen.
- **Source-breaking:** `LicenseClient`'s constructor takes `onDeactivated` before `onAcquired`
  (so the trailing lambda still binds `onAcquired`); a caller passing the listener positionally must
  now pass it by name or swap the order. `OkHttpTransport` has two constructors, `()` (owns its client,
  `close()` shuts it down) and `(client)` (shares the host's, `close()` leaves it alone).
- **Live license state**: `events` (as `PolarisEvent.License`) and the `licenseState` StateFlow emit on
  every transition (activate, deactivate, wipe, a server revoke or block seen by a sync, grace and
  expiry as the floor moves), not only when a document's ETag moved; an unchanged state is not
  repeated. `entitlements.value()` answers nothing while the gate is not usable
  (`licenseInfo()` stays the diagnostic). A 401 on `/license/token` is final for that token and at
  most 5 token requests go out a minute; boot retries back off from 1 s to 30 s; concurrent `sync()`
  calls share one pass; `close()` cancels the client's scope and shuts OkHttp down so a JVM `main`
  ends; `listDevices()` marks a roster it could not fetch `offline`; `update.check()` keeps the
  server's code; `PolarisPlayBilling` gives Play 10 s to connect.
- **`client.events`**: one multi-subscriber `SharedFlow<PolarisEvent>`: `License` (a sync that
  changed the documents, an activation), `Config` (a key's value moved), `UpdateAvailable` (a
  decision offered a newer build; also `update.offers`) and `Packs` (pack progress).
- **Channels**: `channelChoices()` lists the current channel, `stable` and every channel the license
  grants, and `lockedBy` names the outlet when its capabilities forbid a switch (store, Steam,
  package-managed builds). `setChannel(channel)` switches at runtime (persisted beside the store;
  `null` returns to the build's channel), refused `channel_not_allowed` when the outlet locks it or
  the license does not grant it, then syncs so documents and decisions follow.
- **Java callers** (SP-K11): `PolarisKeyFutures(client)` wraps the suspend API as
  `CompletableFuture`s (`start`, `sync`, `status`, `hasEntitlement`, `licenseInfo`, `activateWithKey`,
  `enroll`, `setConfig`, `decide`, `install`, `fetch`, `setChannel`, `crashTags`, …;
  `PolarisKeyFutures.create(options)` builds the client), and every options class has
  `@JvmOverloads` constructors.
- **Devices** (in `:core`, as the registry files them): `registerDevice`, `listDevices`,
  `renameDevice`, `deauthorizeDevice`, the report, and two ports: `FingerprintSource`
  (`JvmFingerprintSource` on a desktop) and `DeviceFactsSource` (`JvmDeviceFactsSource`); the
  Android implementations are `:android`'s.
- **`devices.attest()`** (notes/SDK-PARITY-PASS.md §3.10): `client.devices.attest()` runs the
  Worker's challenge, the platform token and `POST /devices/attest` through an
  `AttestationProvider`: Play Integrity on a play build Google Play installed (`:android`'s
  `PlayIntegrityAttestation`, installed by `PolarisKeyAndroid.client`), the typed `outlet` N/A on any
  other Android build and `runtime` on a JVM desktop. Edge-mint and commerce claims that answer
  `attestation_required` attest once and retry once.
- **`client.commerce`** (§3.9): `binding()` (hand `bindingId` to the store before buying),
  `claim(store, payload)`, `claimPlay`, `claimSteam` (the host passes the `GetAuthTicketForWebApi`
  hex ticket; works on the JVM), `claimAppStore`, typed `ClaimResult`s (`Ok`, `NotOwned`,
  `AttestationRequired`, `Refused(code, reason)`), `hiddenHere`/`isUnlocked` (App Store 3.1.3(b)).
  After an `Ok` claim call `sync(force = true)`. `polaris-key-billing`'s `PolarisPlayBilling`
  (`PolarisPlayBilling.create(context, client)`) is the one-call Play purchase: `purchase(...)`
  sets the binding as `obfuscatedAccountId`, claims, acknowledges only after the claim
  answered ok and syncs; `restore()` and the `PurchasesUpdatedListener` loop claim what Play holds,
  each purchase under its own product. When Play Billing is unavailable both answer a typed
  `BillingFailed` (`unsupported`); `restore()`'s `Restored.unlisted` names the product types Play
  could not list. Built on Play Billing Library 9 (Play's floor for new apps and updates from
  31 August 2026).
- **`:identity`**: `identity.signIn.start(options)` and its `SignInSession` (`wait()` paced and cancellable, `wait(once = true)`, `cancel()`, `reopen()`).
- **Delivery helpers** (notes/SDK-PARITY-PASS.md §3.5–§3.8, §3.14): `release.fetch(target, to,
onProgress)` downloads one build of a verified release record (a `binary` decision, a version +
  build + record hash, or a record you verified) from discovery's builds template, with the bearer
  and the `X-PKey-*` headers gated delivery reads, in bounded `Range` windows resumed with
  `If-Range`; nothing is left at `to` unless size and SHA-256 match (`payload-mismatch`
  otherwise). `update.feedUrl(kind)` / `appcastUrl()` expand discovery's `appcast`, `winsparkle`,
  `velopack`, `appInstaller` and `zsync` templates (the typed `product` N/A when one is not
  advertised). `distribution.downloadModel()` / `thisPlatform()` type the public download page.
  The SDK builds no customer-portal URLs (owner decision Q6): the "Replace a device" link is the
  server-supplied `manageUrl` on the `device_limit` refusal (PX-W8), and a "Sign in" link the
  `signInUrl`, once the Worker sends it.
  `crashTags()` answers `release` (`app@<version>[+<build>]`), `environment` and `pkey.outlet`
  for your crash reporter.
- **`:release`**: `changelog`, `installUrl`, `downloadUrl` (built, never fetched), `verifyRecord`
  (a `pkey-release+jws` against the keys the app pins; `:core`'s `verifyReleaseRecord`, which the
  update engine shares).

## When the device limit is reached

A refused activation returns `ActivationResult.DeviceLimit(limit, deviceCount, manageUrl)`.
`manageUrl` is the customer-portal link that makes room for another device (WIRE-CONTRACT-V4 §5.3), present while
the product's portal is on and already validated by `ManageLink.read`. It defaults to null, so the
class stays source-compatible. It is never an auth failure.

```kotlin
import im.plrs.key.core.ManageLink
import im.plrs.key.license.ActivationResult

suspend fun replaceDevice(key: String) {
    val r = client.license.activateWithKey(key)
    if (r is ActivationResult.DeviceLimit && r.manageUrl != null) {
        val link = ManageLink.withReturn(ManageLink.withKey(r.manageUrl!!, key), "myapp://activated")
        // offer "Replace a device", opening `link`
    }
}
```

The Compose gate (`:ui`) does this for you: pass `returnUrl` to `PolarisGateState` and the
activation screen shows **Replace a device** (a QR code on Android TV). The QR code carries
`PolarisActivationUi.manageQrUrl`, the link without the key: anyone who can see a TV can scan it,
so the phone's page asks for the key. Leave `withKey` out of any QR you draw yourself.

## Update and packs

`client.update` is the update client and `client.packs` the pack facet. The facade hands
the packs facet to the update client as its content host, so `decide()` sees the running pack set
and the engine sees each committed feed's delta menu; `:update` and `:packs` never depend on each
other.

```kotlin
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.HostOutlet
import im.plrs.key.core.UpdateDecision
import im.plrs.key.packs.PackStampSource
import im.plrs.key.packs.PacksOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.update.UpdateClientOptions

suspend fun checkForUpdate() {
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
}
```

- **`:update`**: `check()` (`update/version`), `channelFeed()`, `decide(channel, staged,
skipVersion)`, `releaseRecord(hash)`, `buildUrl(version, buildId)` and `install(check)` through the
  `InstallDriver` port (Play In-App Updates and PackageInstaller are `:android`'s; on a JVM desktop the
  default is `DesktopInstallDriver`: the record's payload for the decision's build, fetched
  resumably by `OkHttpArtifactFetch`, size and SHA-256 checked before the OS opens it). The decision logic is `:core`'s
  (`verifyFeed`, `decideUpdate`, `runUpdateCheck`, the content decision), as in Swift's
  `PolarisKeyCore`. `BootGuard` is the GUARD stage over a host's `UpdateSlots` (apply a staged update,
  count unconfirmed launches, roll back after two with `skipVersion`, the confirmation rows), with
  `DirUpdateSlots` and `FileBootGuardStore` as the default JVM slots and state; outlet signals come
  through `OutletSignalReader` (Android's reader is `:android`'s).
  `client.bootGuard(slots)` builds one over `boot-guard.json` beside the token store, journaling to
  `client.updateEvents`. A driver that keeps working after `install()` returns (a Play flexible
  update) is a `ProgressiveInstallDriver`: `progress` is a `StateFlow<InstallStage>` (`Idle`,
  `Downloading(done, total)`, `ReadyToRestart`, `Failed`), `finish()` installs the downloaded update
  and `resume()` re-reads the platform on return to the foreground. `update.installDriver` is the
  driver in use; `install()` journals `update_applied` when a `DesktopInstallDriver` hands off.
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

**Update health.** Every update outcome is journaled for staged-rollout auto-halt (notes/SDK-PARITY-PASS.md §3.13): `update.decide()` records `update_offered` once per offered
release, `BootGuard` (pass `events = client.updateEvents`) records `update_applied`,
`boot_rolled_back` (`failed-boots`, or `no-previous` when nothing could be restored),
`update_reverted` and, on the first healthy launch of a new version (staged swap or
platform-installed), `update_confirmed`; `PacksClient` records `update_downloaded`,
`update_applied` and `pack_failed` per pack, and `:android`'s install drivers record
`update_downloaded` and `update_applied`. The journal lives in `update-events.json` beside the
token store (`Store.stateDirectory`; in memory for a store without one), never in the verified
cache. `report()` carries the oldest 16 as `updates`, with `gate` and `outlet`, and drops them once
the Worker accepted the report.

**Typed catalog mirror.** `pnpm gen mirrors --catalog catalog.json --out-dir <dir> --lang kotlin
--kotlin-package com.example.catalog` writes `ConfigSchema.generated.kt`, a dependency-free
`ProductCatalog` object (keys, entries, each entry's JSON schema and default; a secret's default is
never compiled in). The `:config` tests compile a sample of it.

## Cloud Connect

`client.cloudConnect` links a person's signed-in devices (feature page: `/docs/features/cloud-connect/`).
`start()` begins discovery and the relay; `peers` and `devices()` list who is reachable; `open(deviceId)`
opens an encrypted channel and `onChannel` receives one another device opens (close it when nothing listens).
On the JVM it tries the LAN first (mDNS and TCP), then the relay. On Android the relay works today; LAN
discovery needs the Android adapter (CC-12b) and reports `off` with reason `unsupported` until then.
`stop()` and sign-out close every session within 2 s each. `PolarisKeyFutures` has the Java forms.

## JVM desktop

`PolarisKeyDesktop` (in `:sdk`) is the desktop entry point, as `PolarisKeyAndroid` is
Android's. It fills in the keyring store, the desktop install driver and the default slots:

```kotlin
// build.gradle.kts: implementation("im.plrs.key:polaris-key-sdk:…")
//                   runtimeOnly("com.github.javakeyring:java-keyring:1.0.4")   // the OS keyring
import im.plrs.key.desktop.PolarisKeyDesktop
import im.plrs.key.sdk.PolarisKeyClientOptions

suspend fun desktop(options: PolarisKeyClientOptions) {
    val client = PolarisKeyDesktop.create(options)            // KeyringStore, DesktopInstallDriver
    val guard = PolarisKeyDesktop.bootGuard("djdl", "1.4.0", baseUrl = options.core.baseUrl) // the GUARD stage over DirUpdateSlots
    val check = client.update.decide()
    client.update.install(check)                              // download, verify, open the installer
}
```

Everything lives under `FileStore.defaultDirectory(product)` unless `DesktopOptions.dataDirectory`
says otherwise; `DesktopOptions` also takes the keyring binding, the installer opener and download
progress.

**One control plane, one directory.** Those paths are production's (`https://key.plrs.im`). A
client whose `baseUrl` is anything else (a local `pkey dev` Worker, a staging Worker) keeps its token,
device id, cache, installers, update slots and guard state under `<product>@<host>[_<port>]` instead
(`storeNamespace`; its keyring service is `pkey:<product>@<host>`), so it never reads, overwrites or
applies production's. An explicit `DesktopOptions.dataDirectory` stays production's directory
unchanged, and every other control plane gets `<dataDirectory>/<product>@<host>` beneath it. `client`
reads the control plane from its options; `dataDirectory`, `store`, `slots` and `bootGuard` run before
a client exists, so they take the same `baseUrl` (`CoreOptions.baseUrl`; left out, production). A
payload staged in a local control plane's `slots` is therefore never applied by production's launch,
and the reverse.

The `kotlin-desktop` CI job runs the keyring store's contract against the real OS keyring
on macOS, Windows and Linux (`PKEY_KEYRING_TESTS=1`).

## :platform

`:platform` is the Android platform module: the
Godot SDK reaches it through the `PolarisKeyAndroid` plugin now, and the rest of the Kotlin SDK,
Unity and MAUI build on it. Pure Kotlin, no NDK.

**Standalone.** `:platform` depends on no other SDK module, so a host that wants only the Android
edges (Godot, later Unity and MAUI) links it alone, exactly as Godot on iOS links only Swift's
`PolarisKeyPlatform`. `./gradlew :platform:checkStandalone` (part of `check`, and run by the
`android` CI job) fails if any compile or runtime classpath of any variant holds a project
dependency or an `im.plrs.key` module. A convenience that wants the core belongs in `:android`, never here.

**Coordinates.** One artifact per flavor, each with its own POM (the play one depends on Play
Core, the direct one must not), sources jar and Gradle module metadata:
`im.plrs.key:polaris-key-platform-play` and `im.plrs.key:polaris-key-platform-direct`. They are
published only to a local repository, `./gradlew :platform:publishAllPublicationsToLocalRepository`
into `sdks/kotlin/build/repo` (`tools/check_publication.sh` checks it). There is no signing and no
Maven Central: adopters get them from the Polaris Key Maven feed later.

**Stability.** The Kotlin API is public SDK surface (`explicitApi`, KDoc on every type) and grows
additively: the Godot binding addresses it through its `cmd(json)` surface, so a rename is a
breaking change for the Godot binding.

## The flavors are a policy boundary

Play forbids self-update and `REQUEST_INSTALL_PACKAGES` in Play builds, so a build is one or the
other, fixed at build time (`PolarisKeyPlatform.flavor`):

| Flavor   | Has                                                                                                                               | Never has                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `play`   | install source, Keystore, Play In-App Updates, Play Asset Delivery, Play Integrity                                                | PackageInstaller session code, install permissions |
| `direct` | install source, Keystore, verified PackageInstaller self-update, status receiver (builds for the Polaris Key outlet, id `direct`) | any `com.google.android.play` class                |

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
- **`play.PlayIntegrity(backend)`** over the fakeable `IntegrityBackend`
  (`PlayIntegrityBackend` adapts Play's `StandardIntegrityManager`; Play ships no fake): the
  STANDARD API, `prepare(cloudProjectNumber)` once and `request(cloudProjectNumber, requestHash)` per
  verdict, the provider cached per cloud project number, dropped and prepared again once on
  `INTEGRITY_TOKEN_PROVIDER_INVALID` (-19). The request hash is the Worker's `requestHash` from
  `POST /<product>/devices/attest/challenge`, verbatim (1–500 characters). Failures are
  `IntegrityError(errorCode)` with the `StandardIntegrityErrorCode`, or none without Play services.
- **`PlatformIntegrity.create(context)`**: the same Integrity surface in every flavor.
  `prepare(cloudProjectNumber)` and `request(cloudProjectNumber, requestHash)` answer an
  `IntegrityResult`: `Success` (a `PlatformIntegrityToken` with its `prepared`/`reprepared` flags),
  `Refused` (a project number that is not positive, a hash outside 1–500 characters; Play is never
  asked), `Failed(exception, message, errorCode)` (Play's failure), or `Unsupported(reason)`. The
  `play` flavor answers through `play.PlayPlatformIntegrity` over `play.PlayIntegrity` (Play's
  manager created on first use); the `direct` flavor answers `Unsupported("outlet")` to every call
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

`:android` is the Kotlin SDK's Android glue: the one module that depends on both the SDK
(`:sdk`, and through it `:core` and every service module) and `:platform`, so `:platform` stays
standalone for the Godot binding. Flavors match the platform's (`play`, `direct`), and the flavor
boundary covers it (`tools/check_flavours.sh` reads the `:boundary` APKs, which now carry it).

```kotlin android
import android.app.Activity
import android.content.Context
import im.plrs.key.android.AndroidOptions
import im.plrs.key.android.PolarisKeyAndroid
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.HostOutlet
import im.plrs.key.packs.PackStampSource
import im.plrs.key.packs.PacksOptions
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.update.UpdateClientOptions

suspend fun androidUpdate(context: Context, currentActivity: () -> Activity?) {
    val client = PolarisKeyAndroid.client(
        context,
        PolarisKeyClientOptions(
            core = CoreOptions(productSlug = "diceroll", version = BuildConfig.VERSION_NAME, pinnedKeys = PINNED),
            update = UpdateClientOptions(pinnedReleaseKeys = RELEASE_KEYS, outlet = HostOutlet.Kind("play")),
            packs = PacksOptions(contentStamp = PackStampSource.FromBytes(context.assets.open("pkey-content.json").readBytes())),
        ),
        AndroidOptions(activity = currentActivity, playPacks = listOf("diceroll.foes")),
    )
    val check = client.update.decide()
    client.update.install(check)   // In-App Updates (play) or the verified PackageInstaller session (direct)
}
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
- **Lifecycle** (SP-K08): `PolarisKeyLifecycle.install(application, client)` (from
  `Application.onCreate`) tracks the current activity (`AndroidOptions(activity =
lifecycle::currentActivity)`), syncs when the app comes to the foreground (once a minute at most;
  ETags and backoff still apply) and calls the install driver's `resume()`. `PlayInstallDriver`
  reports a flexible update's download through `progress`, journals `update_downloaded` when Play
  has it, and `finish()` completes it (`update_applied`); pass the activity's result for
  `InAppUpdates.REQUEST_CODE` to `activityResult(requestCode, resultCode)`. A periodic background
  sync is your own WorkManager worker calling `client.sync()`: the SDK adds no WorkManager
  dependency.
- **`PlayPackTransport`** (`packs.transport.play`): on play, `PadPackTransport` re-reads each carried
  pack's PAD location on every call (never persisted), finds `pkey/` or `pkey#tcf_*/`, and hands
  `:packs` an embedded baseline the marker, record and stamp pin verify; `ensure(packId)` waits for
  COMPLETED, asking the confirm hook before Play's cellular dialog. On direct it answers
  `Unsupported(outlet)`. A pack delivered mid-session mounts at the facet's next start.

## Samples

`samples/cli` (`:sample-cli`) is a runnable command-line app on `polaris-key-sdk` alone: `status`,
`activate <key>`, `config <key>`, `set <key> <json>`, `channels`, `update` and `tags`.

```sh
PKEY_PRODUCT=djdl PKEY_TRUST=k1=<base64url key> ./gradlew :sample-cli:run --args="status"
```

Its test drives every command against a scripted Worker, so it builds and runs with the JVM modules.

## Build and test

```sh
cd sdks/kotlin
# JVM modules (JDK 17; no Android SDK needed with -Ppkey.jvmOnly=true)
./gradlew -Ppkey.jvmOnly=true :core:test :license:test :config:test :identity:test :release:test \
          :update:test :packs:test :sdk:test :ui-core:test :server:test :server-ktor:test :spring-boot-starter:test :conformance:test :sample-cli:test checkModuleBoundaries
python3 tools/check_16k_alignment.py   # zstd-jni's Android natives are 16 KB page aligned
# Android modules
./gradlew :platform:testPlayDebugUnitTest :platform:testDirectDebugUnitTest \
          :godot:testPlayDebugUnitTest :godot:testDirectDebugUnitTest \
          :android:testPlayDebugUnitTest :android:testDirectDebugUnitTest :ui:testDebugUnitTest
./gradlew :platform:assembleRelease :godot:assembleRelease :android:assembleRelease :boundary:assembleRelease \
          :ui:assembleRelease
tools/check_flavours.sh        # the boundary on the release AARs and APKs
./gradlew :platform:checkStandalone :godot:checkPlatformOnly checkModuleBoundaries \
          :platform:publishAllPublicationsToLocalRepository :godot:publishAllPublicationsToLocalRepository \
          :android:publishAllPublicationsToLocalRepository :ui:publishAllPublicationsToLocalRepository
tools/check_publication.sh     # platform, godot, android in build/repo with POM, sources and .module (not :ui)
```

`:conformance` reads `conformance/corpus/v2/` and `conformance/transcripts/` from the repository
in place. Its `test` task depends on `testTink`, so every suite runs on the JCA Ed25519 backend
and again with Tink forced: `cases.json` (the JWS, license, config, trust, clock-floor and bundle
families and their pointer sets, `releaseRecordCases`, `feedCases`, `feedContentCases`,
`revocationCases`, `packRecordCases`, `markerCases` and `delegationCases`), `gate-matrix.json`,
`config-matrix.json`, `update-matrix.json`, `plan-matrix.json`, every `content/` section (under
both zstd paths), `headers.json`, `fingerprint.json`, `stage-matrix.json`,
`outlet-matrix.json`, and every transcript `parity.json` makes applicable (replayed by
`TranscriptReplay.kt`, a port of the Node engine, driving `PolarisKeyClient`). Every suite extends
`ConformanceSuite`, which installs the backend the task names before the suite runs. The `kotlin` job in `.github/workflows/ci.yml`
runs the JVM line.

`:conformance:liveDevTest` is a separate task, not part of `test` or `testTink`: it runs the
quickstart against a real `pkey dev` ([Run Polaris Key locally](https://key.plrs.im/docs/build/local/)) on the JCA
backend only. It drives the `PolarisConfig.kt` that `pkey sdk` generated, the SDK's own client over
its OkHttp transport and the dev server's approval script (Node on PATH): first activation, what
each of the seven test keys does, a config change event, a device-code sign-in and an update
decision. It needs a fresh server (it spends devices and key entries) and three variables:
`PKEY_DEV_BASE_URL` (the server's origin), `PKEY_DEV_CONFIG` (the absolute path of the generated
file, which Gradle compiles into the test sources) and `PKEY_DEV_APPROVE`
(`packages/cli/scripts/dev-approve.mjs`).

```sh
pkey dev --builtin --auto-approve --port 8787 &
pkey sdk --lang kotlin --dev --url http://127.0.0.1:8787 --write --out /tmp/PolarisConfig.kt
cd sdks/kotlin
PKEY_DEV_BASE_URL=http://127.0.0.1:8787 PKEY_DEV_CONFIG=/tmp/PolarisConfig.kt \
  PKEY_DEV_APPROVE="$(git rev-parse --show-toplevel)/packages/cli/scripts/dev-approve.mjs" \
  ./gradlew --no-daemon -Ppkey.jvmOnly=true :conformance:liveDevTest
```

With the variables unset the suite skips, so no server is needed anywhere else; under `CI=true` an
unset one fails it. The `kotlin` job starts its own `pkey dev` for this task. It covers the JVM
line only, not Android.

The Android modules need the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`) with
`platforms;android-36` and `build-tools;36.1.0`; `settings.gradle.kts` includes them only when an
SDK is configured. The unit tests run on Robolectric 4.14 with Play Core's
`FakeAppUpdateManager`, a fake `PackManager`, fake `PackageFacts` and Robolectric's
PackageInstaller; AndroidKeyStore is replaced by a software `KeyProvider` (Robolectric has none).
The `android` job in `.github/workflows/ci.yml` runs all of it. The real Keystore, a real silent
self-update and Play Asset Delivery under `bundletool --local-testing` run on an emulator through
`sdks/godot/native/android/export_check.sh` (see its README). In-App Updates and PAD from a real Play
install, and `:android`'s device rows (an internal-track update offered, a direct self-update, a
fast-follow pack mounted, the outlet readout), need the owner's device checklist (the Android platform and glue
briefs).

The Gradle wrapper pins `distributionSha256Sum`; the wrapper jar is committed (the repository's
`.gitignore` re-includes it).
