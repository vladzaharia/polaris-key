# PolarisKey — Swift SDK

A product-agnostic native Swift client for **Polaris Key** (licensing, remotely-managed
config, updates). It implements the frozen Polaris Key wire crypto natively on **CryptoKit**
(Ed25519 compact JWS) and stores the per-device token in the **Keychain** — no Node engine, no
network dependency for verification. The same cross-language conformance corpus that pins the
Node/Python/React SDKs is verified here byte-for-byte (`conformance/corpus/v2`, read in place by
the tests).

Wire contract: `docs/security/WIRE-CONTRACT-V4.md`.

## Targets

Polaris Key is a suite of opt-in services over an always-on Core, and on Apple platforms that
division is spent at LINK time: a product that does not ship updates does not link Sparkle, and
a product with no license service does not carry the gate.

| Product              | Contents                                                                                                                                             | Depends on                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `PolarisKey`         | `PolarisKeyClient` + `@_exported import` of Core/License/Config/Identity/Release — one import                                                        | Core, License, Config, Identity, Release     |
| `PolarisKeyCore`     | device principal, trust set, verified cache, clock floor, transport, discovery, bundles, and wire v4's feed and record verifiers and update decision | —                                            |
| `PolarisKeyLicense`  | the gate, activation, entitlements                                                                                                                   | Core                                         |
| `PolarisKeyConfig`   | the config document, layered resolution, device facts, edge-mint, the catalog fetch                                                                  | Core                                         |
| `PolarisKeyIdentity` | device-code sign-in (RFC 8628)                                                                                                                       | Core                                         |
| `PolarisKeyRelease`  | the changelog, the install and artifact URLs (macOS **and** iOS)                                                                                     | Core                                         |
| `PolarisKeyPacks`    | packs: the planner, appliers, install state and pipeline, the `PacksClient` facet and its vendored zstd 1.5.7 (macOS **and** iOS); optional          | Core, Platform, Update, vendored libzstd     |
| `PolarisKeyUpdate`   | wire v4's `UpdateClient` decision and the Sparkle wiring (**macOS only**); no packs and no zstd                                                      | Core, Platform, Sparkle ≥ 2.9.6 (macOS only) |
| `PolarisKeyUI`       | the brandable SwiftUI gate, sign-in and offline activation over the `@Observable` `PolarisKeyModel`                                                  | Core, License, Config                        |
| `PolarisKeyPlatform` | the Apple platform edges behind a C surface: AppDistributor, AppTransaction, StoreKit 2, Keychain, Background Assets, App Attest                     | — (standalone)                               |

Platforms: macOS 15+, iOS 18+ (iPadOS and Mac Catalyst take the iOS paths and are built in CI); tvOS 18 and visionOS 2 are declared.
tvOS, visionOS and watchOS derive the device id from `identifierForVendor`; their platform header
value waits on a shared enum (W8), so until then they report `ios`. Swift 6 (strict concurrency,
everything `Sendable`).

## Install

The package is published, signed, to Polaris Key's Swift registry as `polaris-key.PolarisKey`.
Register the scope once (add `--global` for every project on the machine):

```sh
swift package-registry set --scope polaris-key https://pkg.plrs.im/swift/polaris-key
```

```swift title="Package.swift"
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MyApp",
    platforms: [.macOS(.v15), .iOS(.v18)],   // at least the package's floors
    dependencies: [
        .package(id: "polaris-key.PolarisKey", from: "0.9.3")
    ],
    targets: [
        .executableTarget(name: "MyApp", dependencies: [
            .product(name: "PolarisKey", package: "polaris-key.PolarisKey"),
            .product(name: "PolarisKeyUI", package: "polaris-key.PolarisKey"),
            // The signed update decision (macOS and iOS). Sparkle is linked on macOS only — see
            // "Updates" below.
            .product(name: "PolarisKeyUpdate", package: "polaris-key.PolarisKey"),
        ])
    ]
)
```

Signature enforcement and the other clients:
[Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/). Working on the SDK itself,
depend on a checkout instead: `.package(path: "../polaris-key/sdks/swift")`, with
`package: "PolarisKey"` in each product.

### Which products to add

- **Every app:** `PolarisKey` (licensing, config, identity, devices, commerce, release notes).
- **A SwiftUI app:** add `PolarisKeyUI` for the gate, sign-in and offline-activation views.
- **Updates:** add `PolarisKeyUpdate`. It links Sparkle on macOS only and links no packs or zstd, so
  it is safe in an iOS target for `decide()`. An iOS-only app can leave it out: App Store builds
  update through the store, and `client.update` exists only when it is imported.
- **Packs:** also add `PolarisKeyPacks`, then pass a `PacksClient` as
  `UpdateClientOptions.content`; `update.packs` is the same client.

### From a bundled plist

`pkey sdk --lang swift --write` writes `PolarisConfig.swift`, the path the
[quickstart](https://key.plrs.im/docs/build/quickstart/swift/) takes. To configure a build from a file instead, add a
`PolarisKey.plist` to the app target and start the client in one call. The version is the bundle's
`CFBundleShortVersionString`. The plist's keys are `product` (or `productSlug`), `baseUrl` (default
`https://key.plrs.im`), `pinnedKeys` (required, `kid` to base64url key), `pinnedReleaseKeys`,
`expectedServices`, `channel`, `refreshIntervalSeconds`, `keychainAccessGroup` and `appGroup`:

```swift
import PolarisKey

func startFromBundle() async throws -> PolarisKeyClient {
    try await PolarisKeyClient.fromBundle()
}
```

## One client, every service

Everything below hangs off one `PolarisKeyClient`. Names match the other SDKs up to casing
(`notes/SDK-PARITY-PASS.md`).

| Surface                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activateWithKey(_:)`, `enroll()`                                         | A typed `ActivationResult` sorted by the server's error code: `unauthorized`, `deviceLimit`, `fingerprintRequired`, `hardwareMismatch`, `enrollDisabled`, `enrollClaimed`, `licenseDisabled`, `licenseExpired`, `attestationRequired`, `rateLimited(retryAfterSeconds:)`, `refused(code:status:message:)` or, with no usable answer, `error(code:message:status:)`. An unknown 403 is never `deviceLimit`. `PolarisError` is a `LocalizedError` whose text comes from the shared copy.                   |
| `entitlements.has(_:)`, `entitlements.value(_:)`, `entitlements.all()`    | False whenever the gate is not usable (revoked, expired, blocked), even while a cached document still lists the flag.                                                                                                                                                                                                                                                                                                                                                                                    |
| `licenseInfo()`                                                           | License id, tier and tier label, device limit, expiry, profile and channels.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `config.bool` / `int` / `double` / `string` / `decode(_:as:)`             | Typed reads of the resolved value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `config.set(_:_:)`, `clear(_:)`, `localValues()`                          | The user's own values, persisted in UserDefaults (an app-group suite with `appGroup`). They beat the environment and a remote `default`, never `enforced` or `hidden`, and are checked against the catalog's `type` and `enum`.                                                                                                                                                                                                                                                                          |
| `config.fetchCatalog()`                                                   | The served catalog decoded as `ConfigCatalog` (entries, schema type, enum, UI hints).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `events`                                                                  | One `AsyncStream<PolarisKeyEvent>` per subscriber, one event per difference: `license(status:previous:)`, `entitlement(name:value:previous:)`, `config(key:value:previous:source:)`, `updateAvailable(version:action:mandatory:channel:)`, `packs(pack:phase:done:total:)`, `store(reason:detail:)`, the same kinds and fields as every SDK. `changes` is the deprecated earlier name. `syncOnForeground()` syncs when the app becomes active; SwiftUI gets it from `.polarisKeyGate` and `.polarisKey`. |
| `devices.attest()`                                                        | App Attest on iOS: challenge, `attestKey` over SHA-256 of the request hash, POST, key id in the Keychain, a fresh key when the old one is invalid. A 403 `attestation_required` from edge-mint or a commerce claim attests once and retries once. macOS answers the typed `runtime` N/A.                                                                                                                                                                                                                 |
| `commerce.purchase(productID:)`, `restore()`, `startTransactionUpdates()` | StoreKit 2 with `appAccountToken` set to the server binding, then claim, then `finish()` only after the claim, then sync.                                                                                                                                                                                                                                                                                                                                                                                |
| `identity.signIn.start(_:)`, `identity.signOut()`, `identity.current()`   | `signIn.start` begins the device-code flow (or the redirect channel) and returns a `SignInSession`: `wait()` settles to a `SignInOutcome`, the code shows in `ASWebAuthenticationSession` through `SignInOptions(browser:)`. Sign-out is `deactivate()` plus the `license` event; `current()` is the signed profile (an empty field reads nil), or nil when no license or an anonymous profile names no one. The client-level `signOut()` forwards to it.                                                |
| `report(extras:)`                                                         | The device report carries the gate, the outlet and up to 16 queued update-health events (`update_offered`, `update_downloaded`, `update_applied`, `update_confirmed`, `pack_failed`, `boot_rolled_back`), dropped only once a report is accepted.                                                                                                                                                                                                                                                        |
| `boot()`                                                                  | Drives the boot stages (discover, guard, sync, gate, decide, fetch, mount) and confirms the launch after `BOOT_OK_SECONDS`. The boot guard counts unconfirmed launches; an Apple app has no previous build, so it journals `boot_rolled_back` once instead.                                                                                                                                                                                                                                              |
| `update.install(_:)`, `update.feedUrl(_:)`, `update.fetch(...)`           | Opens the App Store, TestFlight or marketplace listing on iOS and hands off to Sparkle on macOS. `PolarisSparkle.start(client:)` follows license and channel changes.                                                                                                                                                                                                                                                                                                                                    |
| `distribution`                                                            | The download-page model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Keychain and directories: `keychainAccessGroup` (`<TeamID>.<group>`) puts the token item in a
shared access group so extensions read the same credential, and `appGroup` places the config,
data, cache and state directories in the group container.

## Headless usage

```swift
import PolarisKey

// `create` throws on a non-https base URL and when the credential store itself is unavailable
// (locked keychain, unwritable config dir) — the latter used to be swallowed, silently
// re-activating every launch and using up a device each time.
let client = try await PolarisKeyClient.create(options: .init(
    productSlug: "djdl",
    version: "1.4.2",
    // kid -> raw Ed25519 public key (base64url). PLACEHOLDERS — substitute YOUR product's real
    // values; see "Where the trust set comes from" below.
    pinnedKeys: ["<your-signing-key-id>": "<your-product-signing-key-b64url>"],
    // What this build expects the product to run, for the offline capability fallback.
    expectedServices: [.license, .config]
))

// Offline-first: status comes from the cached signed documents with no network.
if await client.isLicensed() {
    let concurrency = await client.config.get("run.concurrency", default: .int(4))
    let vpnUrl = await client.config.getSecret("proxy.subscriptionUrl")
    let hasVpn = await client.entitlements.has("polarisVpn")
}

// Activate with a license key (key → token, persisted, then a forced sync).
let result = await client.license.activateWithKey(userEnteredKey)

// Or, for a config-only product, mint a credential with no key at all (§6).
let registered = await client.register()

// One Core pass: trust refresh → enabled documents in parallel → verify → cache → floor →
// telemetry. `force: true` drops the conditional requests.
await client.sync()

// Wipe local state + best-effort server deauthorize. Throws if the LOCAL wipe failed — the
// caller needs to know the credential is still on the machine.
try await client.deactivate()
```

The suite's shape is `client.<service>.<verb>`: `client.license.{status,activate,enroll,
entitledChannels,getProfile,deactivate}`, `client.entitlements.{has,value,all}`, `client.config.{get,
getConfigSource,getSecret,listUserConfig,schemaVersion,fetchSchema,mintToken}`,
`client.identity.{beginSignIn,pollSignIn,waitForSignIn}` and `client.release.{changelog,
installUrl,downloadUrl(version:binary:arch:checksum:dmg:)}`. `client.{status,isLicensed,
activate,enroll,register,report,sync,deactivate,importBundle,getSyncState}` are convenience
passthroughs for the calls a host makes before it knows which service it is talking to.

`client.report()` posts the telemetry snapshot now (`sync()` already reports after each pass);
it answers `false` rather than throwing when no credential is held or the server refused.
`client.config.fetchSchema()` returns the catalog's bytes, or `nil` on any failure — it is
unsigned and diagnostic. `client.release` throws `service-unavailable` when the product does not
run Release, forwards the device token when one is held, and throws a 401/403 with the refusal
body's own code (`unauthorized`, `channel_not_allowed`, …).

A 401 on a document gets exactly **one** re-acquire per `sync()` pass, then one retry of the
failed fetch. A licensed device rotates its token with `POST /<product>/license/token`. A
registered device without a license **re-registers** instead: when License is off for the
product, or the token came from `register()` in this process, the one attempt is
`POST /<product>/devices/register` (the same request as `register()`: the fingerprint when
fingerprinting is enabled, and no `Authorization` header). Both documents share the attempt, so
two parallel 401s make one call. A refusal (403 `registration_closed`, 404, 429) spends the
attempt and the hard 401 is recorded. After a restart the token's origin is not persisted, so a
product with License on uses `license/token`. Under the `requires-identity` policy a native
device cannot re-register (that needs a browser session) and lands on the hard 401.

### Capabilities

`client.capabilities()` reports which services the product runs. Resolution is: a discovery
document loaded this session (`await client.discover()`) > `expectedServices` > the suite
default (license + config; release/distribution/update/identity off). It is **fail-closed**: a
service the discovery document omits reads as disabled, never as "unknown, assume on".

A product with the license service disabled gates `not-applicable` — `isLicensed()` is `true`
and the gate renders your UI. That is the point: a config-only product boots usable
rather than sitting on `needs-activation` forever.

### Product presentation

After `await client.discover()`, `client.presentation` is the product's registered presentation
(discovery's unsigned `core.presentation`: `name`, `developerName`, `accent`, `accentDark`, `icon`),
or nil. `await client.presentationIcon(points: 48, scale: 2)` returns the icon's bytes for that hero
size, verified against the SHA-256 discovery names, or nil. The icon is fetched with no credential,
cookie or redirect, within 10 s and 10 MiB, and cached by hash under the product's data directory
with the last member (`presentation.json`), so an offline start still shows it. A failure is
silent. `client.presentationSource` is the seam the kits read; `.polarisKey(client)` and
`PolarisKeyGateModel` use it by default, and your theme's name, logo and accent always win.

### Where the trust set comes from

> [!WARNING]
> Every `kid`/public key shown in this repository's docs, tests and `conformance/corpus/**` is
> a **placeholder or a test fixture whose private half is committed**. Pinning one means anyone
> can forge a document your client accepts: the verifying key is selected by the header `kid`
> from whatever map you supply.

Your product's real trust set is minted server-side when the product is registered, and is
never checked into a client repo. Get it from either the **onboarding bundle** the admin portal
returns when it mints the product's signing key (`kid -> publicKey`), or
`GET https://key.plrs.im/<product>/.well-known/jwks.json` over TLS, once — then compile the
values into your application. Pins are terminal, so treat updating them as a release, not a
runtime fetch; routine key rotation is handled by the signed trust manifest at
`/<product>/.well-known/polaris-trust.jws`, which is verified against your pins.

### Layered config

`client.config.get(_:default:)` resolves a value through the **same precedence** as every
Polaris Key SDK; `getConfigSource(_:)` returns which layer won:

```
enforced | hidden (remote)  >  localOverrides  >  environment  >  remote default  >  fallback
```

`enforced`/`hidden` remote values are **locked to the server** — `localOverrides` and env vars
are ignored for those keys; `hidden` keys are additionally withheld from `listUserConfig()` (but
still applied by `get(_:default:)`).

The env var for a key is `envPrefix + key` with dots replaced by `__` (default prefix
`PKEY_CONFIG_`): `run.concurrency` → `PKEY_CONFIG_run__concurrency`. The value is the decoded
JSON value when the raw string is one strict JSON text (`4` → int, `true` → bool, `[1,2]` →
array), and otherwise the plain string, unchanged (the wire contract, v4; pinned by
`conformance/corpus/v2/config-matrix.json`). Strict means: no trailing comma, leading byte order
mark, duplicate member names (compared by scalar value) or member name holding U+0000; every
number zero or of magnitude 10^−307 up to below 10^308; and at most 64 levels of nesting.
Reading a variable never throws. One declared limit: Swift's
`[String: JSONValue]` keeps only the first of two canonically equivalent member names, though
the verdict is the same as everywhere else. Supply `localOverrides` / `envPrefix` / an injected
`environment` via `ConfigClientOptions`; the rules themselves are the public, pure
`ConfigResolution`.

Every request carries `X-PKey-Platform` and `X-PKey-Arch` as the canonical §5.2 values of the
binary's compilation conditions (`macos`, `ios` — a Catalyst build sends `macos` — `tvos`,
`visionos`, `watchos`, `linux`, `windows`, `android`; `arm64`, `x86_64`, `armv7`, `wasm32`),
omitted when there is none, and `X-PKey-SDK: swift` (`POLARIS_SDK_NAME`, the generated
`SdkId.swift`). `tvos`, `visionos` and `watchos` are header values only (WIRE-CONTRACT-V4 §5.2
rule 5): on those OSes the update client needs `UpdateClientOptions.platform`.

### Device-code sign-in

For a host that cannot complete a browser redirect — a TV app, a kiosk, a command-line tool —
`client.identity` signs in with a device code (RFC 8628). It needs the Identity service
(`expectedServices` or discovery); with it off, every call throws `service-unavailable` before
any request.

```swift
import PolarisKey

func signInOnTV(_ client: PolarisKeyClient) async throws {
    let session = try await client.identity.signIn.start(
        SignInOptions(deviceName: "Living-room Apple TV"))
    // Show session.userCode and session.verificationUri (the short URL); "Open browser" opens
    // session.verificationUriComplete (the page with the code filled in). On a TV, also render that
    // URL as a QR code; never on a phone, tablet or Mac.
    let waiting = Task { try await session.wait() }
    // …call `session.cancel()` if the player backs out: polling stops and `wait()` returns `.cancelled`.
    if case .signedIn(let ready) = try await waiting.value {
        // The device token is stored and the post-activation sync has already run.
        // `ready.identity` names who signed in (name, email) when the Worker said.
        _ = ready.identity
    }
}
```

`wait()` waits at least `session.interval` seconds before each poll; a `slow_down`
lengthens the interval for every later poll (to the server's value, or by five seconds), and a
poll that fails on the network or with a 5xx is retried at the same interval, never faster. It
returns `.expired` once `session.expiresAt` has passed without asking the server again. The poll
credential stays inside the session: never ask for it, never show it. A sign-in yields the
signed-in identity's **own** license; it does not attach a license this device already held. A
Deny on the approval page throws `SignInError` with `code == ErrorCode.signInDenied`.
`SignInOptions(browser:)` shows the verification page in a browser sheet as the session starts;
`session.reopen()` shows it again.

**After `.signedIn`, show on the device which account signed in.** Anyone holding the user code can
complete the sign-in on the verification page, so the player must be able to see a mis-binding.
`.signedIn(let ready)` carries `ready.identity` (name and email, when the Worker said) and
`ready.attached`; the post-acquisition sync has already run, so `await client.currentDevice().profile`
(or `LicenseClient.getProfile()`) returns the signed license profile too. Show "Signed in as Ada
Lovelace <ada@example.com>" with a way out: the kit's sign-in form does, ending in Continue and
"Not you?" (which signs out and starts again).

`MintedToken` prints (`print`, `String(describing:)`, `debugPrint`, `dump`) with `token` as
`[redacted]`; the property itself reads normally.

### Automatic sign-in

`client.identity.autoSignIn()` signs the person in from what the device already has, with no form. It
needs the Identity service and a product that publishes the Apple exchange (the product's
`identity.platformSignIn` setting). With no platform provider installed it answers
`.needsSignIn(.noCredential)`; with the installed Apple provider and the default prompt it answers the same
without a request, and `.unavailable` only when the Worker or the platform refuses. It runs a ladder and
stops at the first rung that answers:

| Rung | What it does                                            | Runs when                                                |
| ---- | ------------------------------------------------------- | -------------------------------------------------------- |
| 1    | A stored sign-in and a license: `.signedIn`, no network | Always                                                   |
| 2    | Silent restore of a saved sign-in                       | Not in this SDK yet                                      |
| 3    | The platform provider with no UI, then the exchange     | The provider has a silent mode (Apple has none: skipped) |
| 4    | The provider's one account sheet, then the exchange     | `prompt: .optional`                                      |

Past rung 4 the sign-in form is yours (or the kit's). A refusal is a result, not a throw; only
cancelling the task throws (a cancellation error).

```swift
import PolarisKey
import PolarisKeyIdentity

func signInAutomatically(_ client: PolarisKeyClient) async throws {
    // PolarisKeyClient installs Sign in with Apple. Apple has no silent mode, so `.optional`
    // is what shows its sheet; the default `.never` runs rungs 1 and 3 only.
    let result = try await client.identity.autoSignIn(AutoSignInOptions(prompt: .optional))
    switch result {
    case .signedIn(let ready):
        _ = ready.identity            // who signed in, when the Worker said
    case .confirm(let pending):
        // First use of this app with the account: show pending.consent (the app, the account, the
        // license line), then complete with the person's yes.
        _ = try await client.identity.choice.complete(
            grant: pending.grant, choice: nil, consent: ChoiceConsent(claims: []))
    case .choose(let pending):
        _ = pending                   // two or more licenses: the choice screen (`identity.choice`)
    case .deviceLimit(let manageUrl, let view):
        _ = (manageUrl, view)         // every seat is taken: offer Replace a device
    case .needsSignIn(_, let reason):
        _ = reason                    // .noLink, .terms, .signedOut, .noCredential: the regular form
    case .unavailable(let code):
        _ = code                      // no exchange here; the regular form
    }
}
```

- **Signing out sticks.** `identity.signOut()` sets a flag that keeps rungs 3 and 4 quiet until the
  person starts a sign-in themselves (`reason: .signedOut`). A sign-out during the Apple sheet wins
  too: nothing is stored.
- **Revoked in Settings.** If the person revokes the app's Apple credential, the next
  `autoSignIn()` signs the device out. If the Worker cannot be reached the check repeats at the next
  launch.
- **First use asks.** `.confirm` carries what the app and account will share; a new account never
  binds without the person's yes. `.needsSignIn(linkHandle:reason:)` with `.noLink` means the Apple
  account is not linked to a Polaris Locker account yet.
- **Nothing secret prints.** A result, a token, a grant and a link handle show `[redacted]`.

A custom provider conforms to `PlatformIdentityProvider` and is passed as
`AutoSignInOptions(provider:)` or set with `client.identity.installPlatformIdentity(_:)`.

**Setup for Sign in with Apple.** Add the _Sign in with Apple_ capability to every target that
signs in (the `com.apple.developer.applesignin` entitlement) and note your Apple **Team ID**: the
product's `identity.platformSignIn.apple.teamId` setting names it, with the bundle ids. The full
walkthrough is planned.

In the SwiftUI kit the gate runs the ladder once at launch with no sheet, and the provider row's
Sign in with Apple button opens the sheet and then the exchange. Pass
`.polarisKeyGate(client, autoSignIn: false)` (or `.polarisKey(client, autoSignIn: false)`) to turn
the launch attempt off.

### Cloud Sync platforms

Cloud Sync runs where the SDK's transport can refuse a redirect and stream a response under a size cap:
Apple platforms. On Linux (`FoundationNetworking`) it is off: `CloudSyncHostDeps.live` reports Sync
disabled and `CloudSyncTransport` sends nothing over the stock session. The licence, config, identity
and key-ring calls are unaffected. An injected transport that follows no redirect can still be used.

### Cloud Sync key ring

`client.keyring` holds the person's end-to-end key: one root per ring, shared by their devices and
never sent to the Worker in the clear. The Worker stores only wraps of it, one per device, and a
blob sealed under the recovery code. The Cloud Sync client that seals settings with it is planned;
the key ring itself is here. It uses the device keys `client.connect` uses (a `DeviceKeyPort`).

| Call                              | What it does                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `status()`                        | What this device holds now, with no request: `unlocked`, `ringId`, `epoch`, `pinned`, `rootStored`.                                     |
| `unlock()`                        | Opens this device's own wrap. `.unlocked`, `.locked(reason:)` (`.noRing`, `.noWrap`, `.unusableWrap`) or `.ringChanged`.                |
| `create(recovery:)`               | A new ring: a fresh root, a wrap to this device and, by default, a recovery code. A ring that already exists throws `keyring_conflict`. |
| `reset(recovery:)`                | Starts over with a new ring. The Worker keeps the old ring as `previous` for 30 days.                                                   |
| `wrapTo(deviceId:agreeKey:)`      | Wraps the root to another device of the same person, with the agreement key its nearby approval carried.                                |
| `setRecoveryCode()`               | A new recovery code; the previous one stops working.                                                                                    |
| `recover(_:)`                     | Opens the root from the typed recovery code.                                                                                            |
| `adopt(ringId:)`, `openAdopted()` | Folds an earlier ring's root under the current one, and opens the roots others folded.                                                  |
| `lock()`, `forget()`              | Drops the roots from memory (quit), or from memory and the Keychain with the pin (sign-out).                                            |

A locked ring refuses to seal or open with `sync-locked`. `attach(_:)` takes a `SyncRootListener`
that is told whenever the root is gained or lost.

```swift
import PolarisKey

func openRing(_ client: PolarisKeyClient) async throws -> String? {
    let ring = client.keyring
    let status = await ring.status()
    if status.unlocked { return nil }          // a restart: the stored root came back, no request

    switch try await ring.unlock() {
    case .unlocked:
        return nil
    case .locked(let reason) where reason == .noRing:
        // The first device. The recovery code is returned once, here, and kept nowhere.
        return try await ring.create().recoveryCode
    case .locked:
        return nil                             // no wrap for this device: wrap it from another, or recover
    case .ringChanged(let pinned, let served, _, _):
        _ = (pinned, served)                   // see "A changed ring" below
        return nil
    }
}
```

**The recovery code** is shown once, when the ring is created or the code is reset, and the SDK
keeps it nowhere: not in the Keychain, not in a log, not in an error, and `SyncCreatedRing` prints
without it. Show it to the person to write down, and ask for it only inside your app. Every type
that holds a root prints as redacted.

```swift
import PolarisKey

func recoverRing(_ client: PolarisKeyClient, typed: String) async throws -> Bool {
    do {
        let recovered = try await client.keyring.recover(typed)
        return recovered.wrapDeposited         // true: the next start unlocks without the code
    } catch let error as PolarisError where error.code == "recovery-code-invalid" {
        return false                           // a typo or the wrong code; the checksum failed first
    }
}
```

`recover(_:)` checks the code before any request. On success the root is held and pinned, and this
device deposits its own wrap.

**Wrapping to another device.** On a device that holds the root, `wrapTo(deviceId:agreeKey:)` seals
it to the other device's agreement key. That device then calls `unlock()`. The agreement key never
leaves its `DeviceKeyPort`: a wrap is opened through the port.

```swift
import PolarisKey

func approve(_ client: PolarisKeyClient, deviceId: String, agreeKey: String) async throws {
    try await client.keyring.wrapTo(deviceId: deviceId, agreeKey: agreeKey)
}
```

**A changed ring.** The first root this device acquires pins the ring's `ringId`, `epoch` and
`rootKid`. A ring or wrap the Worker later serves that differs from the pin is never opened:
`unlock()` answers `.ringChanged` and nothing is replaced. Show the person what changed (`served`,
`createdAt`, and `by`, the device that wrapped), and call `acceptRingChange(confirmed:)` only from
their yes. `recover(_:)` also re-pins.

```swift
import PolarisKey

func acceptChange(_ client: PolarisKeyClient, served: SyncRingPin) async throws -> Bool {
    // Call this only after the person confirmed the ring they were shown.
    let result = try await client.keyring.acceptRingChange(confirmed: served)
    if case .unlocked = result { return true }
    return false                               // the Worker now serves another ring: ask again
}
```

**Reset and adopt.** `reset()` makes a new ring; the root this device held stays in memory so
`adopt(ringId:)` can fold it under the new one. `openAdopted()` opens the roots already folded in,
so `client.keyring.codec` reads data sealed under them.

**Sign-out.** Releasing the device (`deactivate()`, or a sign-out that releases it) calls
`forget()`: the roots leave memory and the Keychain and the pin is dropped, so the next person
starts clean. A root that cannot be deleted throws and stops the release.

**Where the root lives.** In memory while the app runs, and in one Keychain item: service
`pkey:<product>`, account `sync-root`, accessible after first unlock on this device only
(`AfterFirstUnlockThisDeviceOnly`), never synchronizable. A restart takes it back while it matches
the pin. A Keychain write that fails leaves the root in memory only. An iCloud Keychain backup of
the root is planned.

### Edge-mint

`try await client.config.mintToken("musickit")` asks the Worker to sign a short-lived
third-party token through an operator-approved recipe (`GET /<product>/config/mint/<id>/token`,
with the device token) and returns a `MintedToken(token:expiresAt:)`. It is cached **in memory
only** — never in the cache file or the keychain — and reused until 30 seconds before
`expiresAt`, and only while the client still holds the device token it was minted with —
`deactivate()`, a cleared token or a different sign-in drops it. A 401 gets the usual single re-acquire, on the same route a document 401 takes (so a registered device without a license re-registers), and one retry. Failures throw
`PolarisError`: `service-unavailable` (Config off) and `bad_request` (an id outside `[a-z0-9-]`)
before any request, `unauthorized` (no token, or still 401), or the Worker's `not_found` /
`rate_limited` / `misconfigured`.

### Cloud Connect

`client.cloudConnect` links the devices signed in to one account and opens an encrypted channel between
them, over the local network first and the relay when the LAN does not answer. It needs sign-in and a
product with the `connect` service on.

```swift
try await client.cloudConnect.start()
let stopListening = client.cloudConnect.onChannel { session in /* a device opened a session to this one */ }
let peers = await client.cloudConnect.peers()
if let first = peers.first {
    let session = try await client.cloudConnect.open(first.deviceId)
    try await session.send(Data("hello".utf8))
}
await client.cloudConnect.stop()
```

`stop()` never waits past 15 seconds; sign-out and release stop it first. `CloudConnectOptions(lan:relay:)`
turns a path off.

**Local network access (Apple platforms).** The LAN path advertises and browses over Bonjour, so the app's
`Info.plist` needs both keys; without them `start()` reports the LAN as not configured and the relay still works:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Finds your other devices on this network.</string>
<key>NSBonjourServices</key>
<array>
  <string>_pkeypeer._tcp</string>
</array>
```

A refused Local Network prompt is the `nearby-permission-denied` error. A **sandboxed macOS app** also needs the
`com.apple.security.network.client` and `com.apple.security.network.server` entitlements (it dials out and listens).

### Stores

- `KeychainStore` (default) — token in the OS keychain (service **`pkey:<product>`**), device id
  - offline cache as 0600 files under `~/.config/<product>/` (Application Support on iOS). Files
    are created at 0600 by `open(2)` (never chmod'd afterwards) and both the read and write paths
    refuse to follow a symlink.
- `InMemoryStore` — for tests.
- `Store` is a protocol; supply your own to back the token/cache differently. Its mutating
  methods `throw`, so a failed keychain write or an unwritable config dir surfaces as a typed
  `StoreError` instead of vanishing.

**The keychain.** The token goes to the data-protection keychain with
`kSecAttrAccessibleAfterFirstUnlock`. A macOS process without the entitlement it needs (an
unsigned CLI, a test bundle) has its writes refused with `errSecMissingEntitlement` and keeps
using the file-based login keychain, which ignores the accessibility attribute. Its reads of the
data-protection keychain answer "not found" rather than that error, so `status()` follows a "not
found" with a delete of a sentinel item that never exists, which does answer
`errSecMissingEntitlement`. Reads try the data-protection keychain
first and migrate a legacy item into it when it is available; `clearToken()` deletes from both.
iOS always uses the data-protection keychain.

**Store status.** `await client.storeStatus()` returns a `StoreStatus` (`backend`, `degraded`), or
`nil` for a host store that does not implement `status()` (the protocol's default). The default
store reports `.keychain`, degraded by `.legacyKeychain` on an unentitled macOS process (and on an entitled one whose
token has not yet been migrated out of the legacy keychain) and by
`.keyringError` when the keychain refuses; `InMemoryStore` reports `.memory`.

**Directories.** `CoreOptions` takes `dataDir`, `cacheDir` and `stateDir` (bases; `<product>` is
appended), and `core.dirs` holds the resolved `ProductDirs`. Nothing is created until something
uses one, and the config directory has not moved.

| Base   | macOS                                     | iOS                                       |
| ------ | ----------------------------------------- | ----------------------------------------- |
| config | `~/.config`                               | Application Support (unchanged)           |
| data   | `<Application Support>/polaris-key/data`  | `<Application Support>/polaris-key/data`  |
| cache  | `<Caches>/polaris-key`                    | `<Caches>/polaris-key`                    |
| state  | `<Application Support>/polaris-key/state` | `<Application Support>/polaris-key/state` |

Application Support and Caches come from `FileManager` (the container's inside a sandbox).
`ProductDirs.excludeFromBackup(_:)` sets `isExcludedFromBackup` on an existing directory (plus a
`CACHEDIR.TAG` on macOS) and never throws.

### What the cache holds

Only **signed artifacts** (§4.1): the compact JWS of each per-service document and of the trust
manifest, per-document ETags, the imported offline bundle (`bundle`, verbatim), the evidence for any
tombstoned pin (`pinRevocations`), two fail-closed hints
(`blocked`, `lastSyncUnauthorized`), and wire v4's two update slices — `feeds` (each committed
`pkey-feed+jws`, keyed by its own `channel` claim) and `releaseRecords` (each `pkey-release+jws`,
keyed by its SHA-256, kept only while a committed feed pins it). Every JWS is re-verified on load — the manifest against the
**usable pinned** keys only (pins minus the tombstoned ones) — and every counter (the per-type anti-replay floors, the monotonic clock
floor, `lastVerifiedAt`, each channel's feed `seq` floor) is derived from that re-verified
content; `core.feedFloors` shows the floors. A record from any other cache
version is **discarded, never migrated**.

## When the device limit is reached

A refused activation returns `.deviceLimit(limit:deviceCount:manageURL:)`. `manageURL` is the
customer-portal link that makes room for another device (WIRE-CONTRACT-V4 §5.3), present while the product's portal
is on and already validated by `ManageLink.read`. It is never an auth failure.

```swift
import PolarisKey

func replaceDeviceLink(_ client: PolarisKeyClient, key: String) async -> String? {
    if case .deviceLimit(_, _, let manageURL?) = await client.license.activateWithKey(key) {
        // Offer "Replace a device", opening this link behind a tap.
        return ManageLink.withReturn(ManageLink.withKey(manageURL, key), "myapp://activated")
    }
    return nil
}
```

The SwiftUI gate does this for you. `.polarisKeyGate` (and `.polarisKey`) shows **Replace a
device** under the error, opens the link as the portal served it, and retries the key once when the
app becomes active again. Leave `withKey` out of any QR you draw yourself: anyone who can see the
screen can scan it, so the phone's page asks for the key. Release note: the case gained a third associated value, so an exhaustive
`case .deviceLimit(let l, let c)` binding needs a third pattern.

## supports() and capabilities

`client.supports(_:)` says whether a feature works here and now, without a request:

```swift
import PolarisKey

func offerNativeUpdater(_ client: PolarisKeyClient) async {
    switch await client.supports(Feature.updateDriver) {
    case .supported:
        break  // offer the native updater
    case .unsupported(let why):
        // why.reason: runtime | outlet | product | dependency | version; why.detail: human text
        print(why)
    }
}
```

The answer comes from the capability table generated from `parity.json` into
`Constants.generated.swift` (`CAPABILITIES`, `pnpm gen constants`), so it always matches the
parity page. In order: an unknown id or a `planned` feature is `version`; an N/A declared for this
runtime (`macos` or `ios`) is `runtime`; a feature of a service the product does not run (from
`discover()`, else `expectedServices`, else the default) is `product`; `update.driver` on iOS is
`outlet` (iOS updates through its outlet, so the SDK offers a store link only). A call into an
unsupported feature throws `UnsupportedError` (code `unsupported`) with the same `feature`,
`reason` and `detail`. The exception is a sub-client whose service is off. It still throws
`PolarisError` with code `service-unavailable`, so existing `catch` sites keep matching, and
`PolarisError.unsupported` carries the `product` fields. Both calls are `async` because the services live on the `CoreContext`
actor; neither touches the network.

`client.caps()` lists the supported feature ids in registry order. Every device report carries it
as `caps`, so the console can show what the fleet can do. It names SDK features only: no hardware
value, no installed software.

## Offline

Three depths, all first-class:

1. **Online with grace** (default) — post-activation zero-network operation to `graceUntil`.
2. **Air-gapped activation** (§7) — an operator mints a `.pkeybundle` against this device's id;
   `try await client.importBundle(jws)` verifies it against the **pins** all-or-nothing and
   writes the cache atomically. No token is created; the gate reads `activation: .bundle` while
   the stored bundle still re-verifies and carries the cached license document. A bundle must
   be strictly newer than the documents already held, and re-importing the same bytes is a no-op. A
   refusal throws `PolarisError` carrying the §7 step that refused, because the step is the
   operator's remedy.
3. **Local-only** (§7.3) — `PolarisKeyClient.createLocal(options:)` substitutes `NoNetworkTransport`,
   which refuses at the DIAL, before a URL is built. Config resolution, the gate and bundle
   import all still work; anything that would open a socket rejects with code `local-only`.
   `PolarisKeyClient.createFromBundle(options:bundle:)` does both in one step.

## SwiftUI gate

`PolarisKeyUI` draws the gate in SwiftUI. `.polarisKeyGate(client)` is the one-line drop-in: it
starts the client, shows the product's icon with a loading line until the first check answers (a
licensed launch never flashes the activation card), re-renders on `client.events`, syncs when the
scene becomes active, runs every screen the license needs, shows an offline-grace banner over your
content, and for a blocking state offers the actions that can change it. Your own UI shows once the
license is usable (`ok`, `grace` or `not-applicable`). The kit reads the nine launch locales. The
screens, `KitGateOptions` and the theme are on the
[SwiftUI kit](https://key.plrs.im/docs/build/ui/frameworks/swiftui/) page.

```swift
import PolarisKey
import PolarisKeyUI
import SwiftUI

@main
struct MyApp: App {
    @State private var client: PolarisKeyClient?

    var body: some Scene {
        WindowGroup {
            if let client {
                MyAppRootView().polarisKeyGate(client)
            } else {
                ProgressView().task {
                    client = try? await PolarisKeyClient.create(
                        options: PolarisConfig.clientOptions(version: "1.4.2"))
                }
            }
        }
    }
}

struct MyAppRootView: View {
    var body: some View { Text("Licensed") }
}
```

A host that brings its own sign-in entry holds the `PolarisKeyGateModel` and gives it to
`PolarisKeyGate(model:)`; `polarisKeySignIn(isPresented:model:)` presents the one sign-in form as a
sheet from your own button:

```swift
import PolarisKey
import PolarisKeyUI
import PolarisKeyUICore
import SwiftUI

struct GatedRoot: View {
    @State private var model: PolarisKeyGateModel
    @State private var signingIn = false

    init(client: PolarisKeyClient) {
        _model = State(initialValue: PolarisKeyGateModel(client: client))
    }

    var body: some View {
        PolarisKeyGate(model: model) {
            Button("Sign in") { signingIn = true }
                .polarisKeySignIn(isPresented: $signingIn, model: model)
        }
    }
}
```

### On a Mac

The same gate runs on macOS 15 and later. Add `PolarisKeyUI` (and `PolarisKeyUpdate` plus
`PolarisKeyUpdateUI` for the kit's Sparkle update window), then two lines wire the Settings tab and
the app menu:

```swift
#if os(macOS)
import PolarisKey
import PolarisKeyUI
import SwiftUI

struct MacScenes: Scene {
    let client: PolarisKeyClient

    var body: some Scene {
        WindowGroup { Text("Licensed").polarisKeyGate(client) }
            .commands { PolarisKeyCommands(client) }
        Settings { PolarisKeySettingsPane(client) }
    }
}
#endif
```

`PolarisSparkleUserDriver(client:)` passed as `PolarisSparkle.start(client:userDriver:)` draws
Sparkle's flow in the kit's update window. The Settings tab, the commands, the AppKit hosting recipe
(`NSHostingController`, `beginSheet`) and Replace a Device are on the
[SwiftUI kit](https://key.plrs.im/docs/build/ui/frameworks/swiftui/#macos) page.

### `.polarisKey`: the model and the gate in one modifier

`.polarisKey(client)` is `.polarisKeyGate(client)` plus the observable `PolarisKeyModel` in the
environment: it syncs when the scene becomes active (at most once a minute) and wraps your content
in `PolarisKeyGate`, so there is one gate, whichever modifier you use. Read the model with
`@Environment(PolarisKeyModel.self)` for the license state, the signed profile and `refresh()`.
Pass `gate: false` for the model and the sync alone.

```swift
import PolarisKey
import PolarisKeyUI
import PolarisKeyUICore
import SwiftUI

@main
struct MyApp: App {
    @State private var client: PolarisKeyClient?

    var body: some Scene {
        WindowGroup {
            Group {
                if let client {
                    MyAppRootView().polarisKey(
                        client,
                        theme: PolarisTheme(branding: .native),
                        options: KitGateOptions(keyEntry: false))
                }
            }
            .task {
                do { client = try await PolarisKeyClient.fromBundle() } catch {
                    print("Polaris Key: \(error.localizedDescription)")
                }
            }
        }
    }
}

struct MyAppRootView: View {
    var body: some View { Text("Licensed") }
}
```

`KitGateOptions` is what you decide about the gate: `keyEntry` (off where the store's rules forbid
key entry, App Store 3.1.1), `offlineActivation` (off on iOS), `trial`, `restore`, `enroll`, the
`signInPresentation` and `replace` modes and the `integrator` identity. `offersFreeTier: true`
turns on **Continue free** (keyless enrolment). `handlers:` carries your Trial, Restore, update
and Replace a device actions. How the gate looks is `.polarisKeyTheme(PolarisKeyTheme(...))`
(UI-KITS §3.1). The legacy `theme:` argument still maps `branding` (to the preset) and `accent`;
its `palette`, `typography`, `copy`, `logo` and `accentOn` have no counterpart there and are
ignored, so move them to `PolarisKeyTheme`'s `colors`, `typography`, `copy` and `product`.

A blocking state always has a way out, and the product leads every screen: your
`PolarisKeyTheme.product`, else the product's presentation (name, developer, accent and the
verified icon, through `.polarisKeyPresentation(_:)`), else your app's icon, else a monogram.
An accent goes through the contrast resolver (`PolarisAccent`): the button fill and its label
clear 4.5:1, and so does the accent text, in both color schemes.

**"Powered by Polaris Locker" is optional and off by default**, and never on the gate (UI-KITS
§1.6). The account pane draws the line as its last section footer when the theme opts in
(`poweredBy`). On your about or credits screen place `PolarisPoweredByAttribution(style: .badge)`:
the Locker `powered-by` badge (320 × 104 points, never narrower) where 320 points are free, else
the line. `PolarisPoweredByBadge` draws the badge alone.

Release note: the 0.8 gate family is gone; `PolarisKeyGate`, `KitGateOptions` and the kit's own
screens replace it. The [CHANGELOG](CHANGELOG.md) lists the removed names.

## Updates (macOS)

`PolarisKeyUpdate` wires **Sparkle ≥ 2.9.6** to the product's own feed. That is the security floor:
2.9.5 and 2.9.6 fixed a symlink attack in delta patching and a root privilege escalation, on top of
CVE-2025-0509 (fixed in 2.6.4).
It carries three facts from Polaris Key to Sparkle and refuses to do a fourth:

```swift
#if os(macOS)
import PolarisKey
import PolarisKeyUpdate
import Sparkle

@MainActor
func makeUpdater(_ client: PolarisKeyClient) async throws
    -> (controller: SPUStandardUpdaterController, delegate: PolarisSparkleUpdaterDelegate)
{
    _ = await client.discover()                   // the feed URL comes from DISCOVERY, not a literal
    let update = UpdateClient(core: client.core)
    let feed = await update.feed(
        channel: "stable",
        entitlements: await client.entitlements.all())

    // Sparkle holds its delegate weakly: keep both objects for the app's lifetime.
    let delegate = PolarisSparkleUpdaterDelegate(feed: feed)
    let controller = SPUStandardUpdaterController(
        startingUpdater: false, updaterDelegate: delegate, userDriverDelegate: nil)

    // Throws SparkleAnchorError when the host bundle carries no `SUPublicEDKey`.
    try PolarisSparkleUpdater.configure(
        controller.updater,
        feed: feed,
        headers: await update.feedHeaders())      // the bearer token, for `entitled` feeds
    try controller.updater.start()
    return (controller, delegate)
}
#endif
```

- **feed URL** from the discovery document (`?arch=` applied), never string-built — §R1 moved
  these paths and left aliases behind.
- **`httpHeaders`** so an `entitled` product's feed is reachable at all; Sparkle makes its
  own HTTP requests, and without this they are anonymous and answer 401.
- **`allowedChannels`** from the license's `channels` entitlement, so a stable-only customer is
  not offered a beta the server will then refuse. A UX narrowing, not an enforcement point. A
  `staging` grant also allows `beta`, and a `beta` grant `staging`, as the server treats them.

`PolarisSparkle.start(client:)` does all of it in one call and keeps it current: it asserts
`SUPublicEDKey`, starts a standard updater controller, and re-derives the feed, the headers and the
channels on every `license` event. Keep the object it returns for the app's lifetime.

To draw your own update UI, pass an `SPUUserDriver`: `PolarisSparkle.start(client:userDriver:)` builds
an `SPUUpdater` on it instead of the standard controller (`controller` is then `nil`; `updater` is
set on both paths). Only the UI changes: the feed, the `SUPublicEDKey` check and the install path
stay Sparkle's. Sparkle keeps the driver for you; keep the returned object as before.

```swift
#if os(macOS)
import PolarisKey
import PolarisKeyUpdate

@MainActor
func startSparkle(_ client: PolarisKeyClient) async throws -> PolarisSparkle {
    try await PolarisSparkle.start(client: client)
}
#endif
```

It does **not** verify updates. `SUPublicEDKey` in the host app's code-signed `Info.plist` is the
terminal anchor; `PolarisKeyUpdate` asserts it is present and fails loudly if it is not, because an
app that ships Sparkle without it does not fail to build, launch, or check for updates — it
simply installs unsigned payloads. A Polaris Key-side signature check would be a second, weaker
anchor beside the real one.

## Signed update decisions (wire v4)

`UpdateClient.decide()` answers "what should this install do next?" from the signed channel feed
(`pkey-feed+jws`) and the release record it pins (`pkey-release+jws`). It works on **iOS and
macOS** alike: an iOS app (App Store, TestFlight, a marketplace) is a "decide only" host, and a
macOS direct build hands a `binary` answer to Sparkle or its own installer. Nothing it needs
imports Sparkle: the verifiers and the decision are pure functions in `PolarisKeyCore`
(`verifyFeed`, `verifyReleaseRecord`, `decideUpdate`, `rolloutBucket`, `effectiveCapabilities`,
`resolveUpdateOutlet`, `bootDecision`, `runUpdateCheck`, and the content-aware `feedContent`, `holdsOf`,
`revocationOf`, `verifyRevocation`, `newerRevocation` and `selectPackRows`), held to every
`feedCases`, `feedContentCases`, `releaseRecordCases`, `revocationCases` and `update-matrix.json`
row (`rows` and `contentRows`). `check(channel:)` and the Sparkle helpers
below are unchanged beside it.

```swift
import PolarisKey
import PolarisKeyUpdate

func checkForUpdate(_ client: PolarisKeyClient) async throws {
    let update = try UpdateClient(
        core: client.core,
        options: UpdateClientOptions(
            pinnedReleaseKeys: ["acme-release-2026": "<raw base64url>"],
            outlet: .kind("app-store"),   // turns offers on; without one the install is `unknown`
            format: "ipa"))

    let check = try await update.decide(channel: "latest")
    // check.channel == "stable" (the feed's own claim), check.feed == .network, check.errors == []
    switch check.decision {
    case .store(_, let listingUrl, _, _, _, _):
        // open listingUrl, or the page you compiled in when it is nil (AltStore, iOS web distribution)
        _ = listingUrl
    case .binary(_, let release, let build, _, _, _, _, _):
        let url = await update.buildUrl(version: release.version, buildId: build)
        _ = url  // download, check the payload's `size` and `sha256` against the record, then stage
    case .none, .codeReady, .platform, .blocked, .packs:
        break
    }
    if isUndismissable(check.decision) {
        // a persistent notice the user cannot dismiss, over an app that keeps running
    }
}
```

The answer is an `UpdateCheck`: `channel` (the canonical channel — record it as
`StagedUpdate.channel` when you stage), `decision`, `feed` (`.network` or `.committed`), `record`
(`.network`, `.cache` or `.none`) and `errors` (`[UpdateCheckError]`, each a `code` and a
`detail`). `check.json` spells it as the transcripts and the other SDKs do.

| `UpdateClientOptions` | Notes                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pinnedReleaseKeys`   | `[kid: raw Ed25519 key, base64url]`: the **only** keys a release record verifies against. Compiled in; never merged with the trust pins, never persisted, never learned from the network.  |
| `outlet`              | `.kind("direct")` (the Polaris Key outlet), or `.outlet(id:kind:subkind:)` for a product outlet id. Wins over `stamp` and `detected`; without it the client detects the outlet (`detect`). |
| `stamp`, `detected`   | The build stamp's outlet fields (with `outletIds`) and a detection result the host computed itself, through `resolveUpdateOutlet`.                                                         |
| `detect`              | Default `true`: at the first decision, `readOutletSignals()` and `detectOutlet` run over this install and the stamp. `outlet()` and `detected()` expose the answer.                        |
| `buildNumber`         | Informational in v4. Default: the main bundle's `CFBundleVersion`.                                                                                                                         |
| `format`              | The installed build's format; a binary build of another format is never offered. Default nil (any).                                                                                        |
| `methods`             | What the host can do with a `binary` answer: a subset of `native`, `download`, `sidecar-pck`. Default `["native", "download"]` on macOS, where Sparkle is linked; `["download"]` on iOS.   |
| `binaryVersion`       | The executable's version when it differs from `CoreOptions.version`. Defaults to `version`.                                                                                                |
| `engine`              | `godot-<major>.<minor>` for a host that runs Godot code packs; nil otherwise.                                                                                                              |
| `platform`, `arch`    | Default to this binary's (`macos`/`ios`, `arm64`/`x86_64`).                                                                                                                                |

**Outlet detection**. With no `outlet`, the update client detects one at its
first decision. `readOutletSignals()` reads, on iOS, MarketplaceKit's `AppDistributor.current`
behind `#available(iOS 17.4, *)` (its `web` case from iOS 17.5) raced against a 2-second deadline
(it can hang: a timeout records `timeout`, which is no evidence), AltStore's
`ALTBundleIdentifier` and an `embedded.mobileprovision`; on macOS, the App Store receipt
(`Contents/_MASReceipt/receipt`), its `ProductionSandbox` marker (TestFlight), the signing leaf
(`SecCodeCopySigningInformation`; a Developer ID leaf is reported without its team) and the
product's Caskroom link. `detectOutlet`, the same function every SDK runs over
`outlet-matrix.json`, maps them with the stamp to `{kind, confidence, source, subkind}`. An App
Store or TestFlight install is detected without any stamp; nothing is persisted.

- **Refusals.** A bad option, or a release key whose bytes are also a trust pin, makes the
  initializer throw `invalid-options`; an empty `pinnedReleaseKeys` (or `UpdateClient(core:)`)
  makes `decide()` throw `not-configured`. A product that runs no Update service is refused
  before dialling (`service-unavailable`), and so is a Worker whose discovery document has
  no `update.endpoints.feed` or `release.endpoints.record` — fall back to `check()`.
- **Discovery.** `decide()` loads discovery when this session has not. The feed is
  `GET …/update/{channel}/feed.jws?platform=…` with the channel as requested (`latest` is fine:
  the Worker answers with the canonical `stable` feed); the record is
  `GET …/release/records/{sha256}`, read at most 88 845 bytes (`PolarisRequest.maxBodyBytes`,
  streamed by `URLSessionTransport`) and hashed before any signature work. The device bearer goes
  only to the control plane's own origin.
- **After a refusal** it decides from the committed feed and reports the refusal in `errors`
  (`feed-rejected` with the step as `detail`, `feed-rollback`, `record-rejected`,
  `record-mismatch`, `network-error` or the Worker's wire code). It throws a `PolarisError` (with
  `detail`) only when nothing committed is left to decide from. Offline, the committed feed
  decides; once it is past `expiresAt + 300` the answer is `none {stale}`.
- **The cache.** The `feeds` and `releaseRecords` slices hold signed JWSs only, through Core's
  read-modify-write. Every load, every trust change and every decision re-verifies them; each
  channel's `seq` floor is derived from the committed feed that survives, never stored, so it
  survives a restart and cannot be edited on disk. A deactivation or a bundle import keeps them.
- **The clock** is the effective clock, `max(system clock, highWaterMark)`: winding the system
  clock back cannot revive an expired feed.
- **Floors never stop the app; revoked required content does** (a CI-signed revocation of a required pack). `binary`, `store` and `platform` with `mandatory: true`, and every `blocked` answer, are
  prompts the user cannot dismiss (`isUndismissable`): show them as a persistent notice with no
  dismiss control over an app that keeps running, never as a sheet that covers it. The one
  exception is a CI-signed revocation of a **required** pack with no usable fix:
  `blocked {revoked-content}`, or an offer whose `contentBlock` is `revoked-content`, gives
  `bootDecision` `.required`, which stops the boot at a confirmed `blocked {update-required}`.
  Show your own copy there, not the generic update-required text, for example "Some of this
  game's content was withdrawn by its developer and can't be used. Update the app to keep
  playing." (with the offer's button when the answer is an offer). `blocked {content-floor}` and
  `contentBlock: content-floor` stay `.optional`; a revoked optional pack is unmounted and play
  continues (`packs {revoke}`).
- **Content**. With `UpdateClientOptions.packs.contentStamp` set,
  `decide()` also runs the content decision: it reads the feed's `packSets`, `packFloors` and
  `revocations` beside the claims (a malformed member is ignored, never a refusal), fetches each
  relevant revocation by hash (at most 64 per check), verifies it against `pinnedReleaseKeys`
  only, stores it through `update.packs` (`revocations.json`), and fetches and verifies a
  revocation's replacement. The answer can then be `packs {install, revoke, set}` (apply it with
  `update.packs.ensureReleases(install)`, or `bootFetch(…, install:)` at boot; boot value
  `.none`), a `binary` offer with `prestage` (the new content level's required and essential
  packs), an offer made mandatory by `contentBlock`, or `blocked {content-floor | revoked-content}`.
  Without a stamp every answer is the plain update decision.
- `channelFeed(channel:)` returns the verified feed `decide()` would use, without the record and
  without release keys (it is named apart from `feed(channel:)`, the Sparkle helper);
  `releaseRecord(hash:)` verifies one record by hash (cross-checked and cached when a committed
  feed pins it); `buildUrl(version:buildId:)` is the `distribution/builds` route, never the
  R2-only blob route.

## Packs (`update.packs`)

Content packs install through `PolarisKeyPacks.PacksClient`, handed
to `UpdateClient` as `UpdateClientOptions.content`; `update.packs` returns that client. Pack
records verify against `pinnedReleaseKeys` only. The running build's pins come from its **content
stamp** (`pkey-content.json`, written by `pkey release content-stamp` before the build and shipped
in the app's own read-only resources): a build without one has no packs, and `ensure` throws
`not-configured`.

```swift
import Foundation
import PolarisKey
import PolarisKeyPacks
import PolarisKeyUpdate

func installPacks(_ client: PolarisKeyClient) async throws {
    let packs = PacksClient(
        core: client.core,
        releaseKeys: ["djdl-release-2026": "<raw key, base64url>"],
        options: PacksOptions(
            contentStamp: .file(Bundle.main.url(forResource: "pkey-content", withExtension: "json")!),
            embedded: [EmbeddedPack(path: Bundle.main.url(forResource: "djdl.l10n", withExtension: nil)!)],
            axes: ["locale": ["fr", "en"]]))
    let update = try UpdateClient(
        core: client.core,
        options: UpdateClientOptions(
            pinnedReleaseKeys: ["djdl-release-2026": "<raw key, base64url>"], content: packs))

    update.packs.on { p in print(p.phase, p.done, p.total) }    // or `for await p in update.packs.progress()`
    let installs = try await update.packs.ensure(["djdl.l10n"])  // fetch, verify, commit, activate
    let dir = try await update.packs.path("djdl.l10n")           // a files.tree pack's directory
    try await update.packs.confirm()                             // this boot is healthy
    _ = (installs, dir)
}
```

- **What it does.** `ensure` fetches the pinned record by hash (`release.endpoints.record`),
  checks its type (a registered handler; `files.tree` is built in), entitlement and variant
  (`axes`, `engine`), plans the cheapest strategy (`delta`, `file` or `full`) against what is
  installed, stages each object from `distribution.endpoints.blobs` with `Range`/`If-Range`
  (resuming after a dropped connection, re-hashing what is staged), applies and verifies it, and
  swaps the pointer in `state.json`. `files.tree` is hot: the new directory is live at once.
- **Where it lives.** `<data dir>/packs` (`CoreOptions.dataDir`, P1b-09), excluded from backups:
  `staging/`, `store/<pack>/<payload sha256>/` and `state.json`, written by temp file, `F_FULLFSYNC`
  and rename. A torn `state.json` is held aside as `state.json.torn` (with its snapshot in
  `state.json.torn.list`) and garbage collection waits for `recoverState()`; one that cannot be read
  makes every write throw `pack-state-unreadable` this process; an install whose bytes cannot be
  read is kept, unused, until a later launch can check it. `state().stateIssue` says which.
- **zstd.** libzstd 1.5.7 is vendored in the package as a C target (the official release tarball,
  SHA-256 `eb33e51f…6fa3`; Apple's Compression has no zstd), so SwiftPM clones nothing for it.
  `--patch-from` deltas decode as raw-content prefixes, and every one passes the frame window
  check before it is decoded.
- **Memory.** `memBudget` (default 256 MiB) caps one delta frame's `memBytes`: a `--patch-from`
  decode holds the base, the frame and the output at once. iOS background tasks and app
  extensions (widgets, share and notification extensions, Background Assets) run under much
  tighter memory limits than a foreground app, so pass a lower budget there, for example
  `PacksOptions(memBudget: 32 * 1024 * 1024)`. A delta over the budget is never chosen: the
  planner falls back to the `file` or `full` strategy, which costs more bytes but less memory.
- **Feed-offered deltas**. The committed channel feed can list lazy deltas (`deltas`, the
  Worker's delta menu). The client keeps the menu of the last feed `decide()` or `channelFeed()`
  used, fresh or stale, and reads the committed feed from the cache when the pack engine starts,
  so an offline launch still has it. The engine (`feedDeltas`) adds the entries for a container's
  payload beside the record's own deltas (`withFeedDeltas`); every byte is still checked against
  the CI-signed record, any failure (a 404 included) falls back, and at most one feed-offered
  delta is tried per install. Nothing to configure.
- **Boot.** `bootOptions()` gives `BootOptions`' `requiredPacks` and `essentialPacks`;
  `bootFetch(send:consent:metered:answer:install:)` drives the stage machine's FETCH stage
  (`fetch.consent`, `fetch.progress`, `fetch.done`). Given a `packs` answer's `install`, it
  installs the required and essential entries at exactly their release before mount and returns
  the rest in `background` for `ensureReleases` after the boot.
- **Revocations**. A release that a verified revocation names is never
  installed, activated or mounted: `ensure`/`ensureReleases` throw `PackError` `pack-revoked`, a
  running `hot` install is deactivated when the revocation is learned, and an embedded baseline
  is refused. Revocations persist in a sibling `revocations.json` beside `state.json`, created
  only when the first one is stored (after `state.json` gains `revocationsStored: true`), and
  re-verified entry by entry at every load against the pinned release keys: an entry signed by a
  key you no longer pin is forgotten (the recovery from a stolen release key); any other failure
  puts its pack in `relearn`. A torn `revocations.json` is held aside and its stamp's pinned and
  embedded packs go into `relearn`; an unreadable one writes nothing and, when
  `revocationsStored` is set, refuses those embedded baselines. A pack in `relearn` has its
  embedded baseline refused at every boot until a fresh feed re-teaches its revocations (online
  the pack is fetched instead; when it cannot be, `pack-revoked` with `detail: "relearn"`);
  `recoverState()` clears it. At most 256 targets are kept, the oldest dropped first.
  `revocations()` reports them. **A product that has never had a revocation has no
  `revocations.json`, no flag and no `relearn`, and behaves exactly as before.**
- **Delegated content**. A compatible or standalone pack release signed by a
  delegated content key installs through the same engine when it arrives as a feed target
  (`ensureReleases`): the delegation its `pkd1-` kid names is fetched from the record route (at
  most 16 per call, kept for the process), verified against `pinnedReleaseKeys` only, and stored
  with the install (`PackInstall.delegation`), so a reload re-verifies it offline and after its
  window. Every file must pass the data-only rule (`DataOnly.swift`): an extension allow-list over
  the files index before any payload object is fetched, then a head sniff, a tail sniff and, for
  `json`, `csv`, `tsv`, `po` and `txt`, a whole-file text rule as each file is written; a refusal
  is `pack-not-data-only` with the `path` and the rule as `detail`. A release under a revoked
  delegation is `pack-revoked`, detail `delegation`, and stops running. The stamp's pins and
  holds, a revocation's replacement and embedded baselines never take the delegated path, and a
  `pinnedReleaseKeys` kid matching `pkd1-<64 hex>` is `invalid-options`. Parse delegated text only
  with a pure JSON or CSV parser. The delegation conformance tests run every `delegationCases` and
  `dataOnlyCases` vector through `verifyReleaseRecord(options: …delegation:)`,
  `verifyRevocation`, `recordRevoked`, `verifyFeed` and `dataOnlyRefusal`.
- **Telemetry.** `devices/report` carries `content: {packSetId}` of the running set once a stamp
  is configured.
- **Handlers.** `registerHandler(_:)` adds a type (`layout` `tree` or `container`, `activation`
  `hot` or `restart`, `supports(formatVersion)`, optional `activate`/`deactivate`).
- **Apple-hosted Background Assets** (`packs.transport.apple`). Pass
  `PacksOptions(platformTransport: AppleAssetPackTransport(packs: ["diceroll.foes"]))`. A carried
  pack is installed only through Background Assets: the asset pack `<pack>-c<contentApi>` (dots to
  hyphens, as `pkey transport apple-ba package` uploads it), its files under `pkey/<asset pack>/`
  resolved with `url(for:)` on every call. The engine verifies the marker and the payload or
  treeDigest against the signed record, accepts a later unrevoked release (Apple-hosted packs
  float), and never copies the files into its own store. Below iOS / macOS 26.4 the transport
  answers the typed `version` N/A, and a build without the Background Assets Info.plist keys
  answers `outlet`. Either way the pack is refused with `plan-transport-unsupported`, never
  fetched from the CDN instead.

### Source changes

The content decision changes some public Swift signatures. Callers that switch exhaustively or
destructure positionally need updating:

- `UpdateDecision` gains a `.packs` case.
- `.binary`, `.store`, `.platform` and `.blocked` gain a trailing `contentBlock: String?`
  (default `nil`); positional patterns need one more `_`.
- `binary`'s `prestage` is now `[PackTarget]`.
- `RESERVED_RECORD_KINDS` is removed (`revocation` is now a real record kind).
- `runBootFetch` and `PacksClient.bootFetch` return a 3-tuple that adds `background`.

### Source changes

- `VerifyReleaseRecordResult` gains `.delegated(ReleaseRecordDoc, RecordDelegation)`, returned
  only when `VerifyReleaseRecordOptions.delegation` is passed; `record` covers both success cases
  and `delegation` reads the new one. Exhaustive switches need the new case.
- `ReleaseRecordStep` gains `.delegation` and `.scope`.
- `FeedRevocation` gains `kind: String?` (default `nil`), and `PackInstall` and `PackJournal`
  gain `delegation: String?` (default `nil`).

## Channels

The channel names are the wire contract's: `stable`, `beta`, `pr`/`pr-<n>`, `dev` and a
product's manual channels. `Semver.channelForVersion` derives the default `X-PKey-Channel` from
the build version: `0.0.0-beta*` and the legacy `0.0.0-staging*` builds are now `.beta`.

**Behavior note (P1b-07):** `client.license.entitledChannels()` now answers `["stable"]` when
the license carries no `channels` entitlement (or a non-array one), where it used to answer `[]`.
That is the Worker's own answer and every other SDK's; Sparkle's `allowedChannels(from:)` already
treated an empty grant as stable only, so the updater's behavior does not change. The list is
the raw grants: `staging` is not rewritten to `beta`.

**Source note:** `enum Channel` gained `case beta`, and `case staging` is deprecated
(`staging` is the legacy spelling of `beta`; `channelForVersion` no longer returns it). An
exhaustive `switch` over `Channel` in your code needs a `.beta` case. Pass
`CoreOptions.channel: "staging"` only as a stopgap against a Worker older than this change.

## Apple platform edges (`PolarisKeyPlatform`)

A standalone target (it depends on no other target). A native host binds it through three C
functions in the separate `PolarisKeyPlatformC` target, which only native hosts link, so a Swift
consumer of `PolarisKeyPlatform` exports no `pkp_*` symbols; the Godot GDExtension in `sdks/godot/native/ios/` links its sources, and Unity, MAUI
and Tauri can bind the same functions:

```c
char *pkp_call(const char *json);                       // JSON in, JSON out; free with pkp_free
void  pkp_free(char *p);
void  pkp_set_event_callback(void (*cb)(const char *json));  // any thread; NULL unregisters
```

A synchronous op answers its result; an asynchronous one answers `{"ok":true,"req":N}` and later
emits `{"ev":"<op>","req":N,…}` through the callback. Failures are `{"ok":false,"error":…}`; an
API this OS or build lacks is `{"ok":false,"unsupported":true,"reason":…,"detail":…}`.

| Op                                                                                                                             | Kind  | Result                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`, `capabilities`                                                                                                         | sync  | `{protocol, platform, appDistributor, appDistributorWeb, managedAssetPacks, backgroundAssetsConfigured, storeKit, keychain, entitlementsForID}`                                                                                                                                                         |
| `distributor {deadline?}`                                                                                                      | async | `{signal, reason?, ms, provisioned, altBundleIdentifier, bundleIdentifier}`: `AppDistributor.current` (iOS 17.4, `web` from 17.5) raced against 2 s at every call, never cached; `unavailable` = no evidence; the bundle evidence can veto a store outlet, never select one                             |
| `app_transaction {refresh?}`                                                                                                   | async | `{jws, verified, environment, originalAppVersion, appVersion, bundleID, appTransactionID, …}`, for commerce only                                                                                                                                                                                        |
| `products {ids}`                                                                                                               | async | `{products: [{id, type, displayName, displayPrice, price}]}`                                                                                                                                                                                                                                            |
| `purchase {product, appAccountToken?}`                                                                                         | async | `{result: success\|pending\|userCancelled, confirmIn, transaction?}`; main-actor isolated, `purchase(confirmIn:)` with the foreground scene                                                                                                                                                             |
| `entitlements {product?}`, `finish {id}`                                                                                       | async | `finish` only after the server recorded the purchase                                                                                                                                                                                                                                                    |
| `listen`                                                                                                                       | async | starts the `Transaction.updates` listener; each new transaction state is emitted once as `transaction_updated`                                                                                                                                                                                          |
| `kc_get` / `kc_set` / `kc_delete {product, account, value?}`                                                                   | sync  | service `pkey:<product>`, data-protection keychain, `AfterFirstUnlockThisDeviceOnly`, no access group                                                                                                                                                                                                   |
| `packs_status`, `packs_ensure {packs:[{id,path}], latest?}`, `packs_check_updates`, `packs_remove`, `packs_url`, `packs_watch` | async | `AssetPackManager`, iOS / macOS 26.4 (`version` below), and only where the `BA*` Info.plist keys exist (`outlet` otherwise); events `pack_progress`, `pack_ready`, `pack_failed`                                                                                                                        |
| `app_attest_supported`                                                                                                         | sync  | `{supported}`: `DCAppAttestService.isSupported`; unsupported `runtime` on macOS, the simulator and app extensions                                                                                                                                                                                       |
| `app_attest_attest {requestHash, keyId?}`                                                                                      | async | `{keyId, attestation, generated, ms}`: generates a key when none is given, then `attestKey` with `clientDataHash = SHA-256(UTF-8(requestHash))`; errors `invalid_key` (regenerate: keys die on reinstall), `server_unavailable` (retry with the same key), `invalid_input`, `system_failure`, `timeout` |
| `app_attest_assert {keyId, clientData}`                                                                                        | async | `{keyId, assertion}`: `generateAssertion` over `SHA-256(clientData)`, for later per-request assertions                                                                                                                                                                                                  |

Transaction ids are strings, and every transaction carries its signed JWS. Under StoreKit Testing
the JWS is signed by a per-session self-signed certificate (`kid Apple_Xcode_Key`), fit for
testing the parsing, not its chain validation.

**Xcode 16.4.** The macos-15 job compiles this target with Xcode 16.4 (Swift 6.1). Code that
needs the Xcode 26 SDK (`AssetPackManager` and its 26.4 methods) is behind `#if compiler(>=6.3)`,
the iOS 27 manifest API behind `#if compiler(>=6.4)`; `canImport(BackgroundAssets)` does not
separate them. No Swift 6.2+ language feature is used. `tools/typecheck-platform-old-swift.sh`
type-checks the target and its tests on the Swift 6.0, 6.1 and 6.2 Linux images.

**Keychain classes.** This target writes the device id and the token
`AfterFirstUnlockThisDeviceOnly`; `KeychainStore` (PolarisKeyCore) still writes the token
`AfterFirstUnlock` and keeps the device id in a 0600 file. The difference is deliberate here
(S-09) and left for the Swift SDK's owner to decide for `KeychainStore`.

**Tests.** `swift test` drives every module through fakes (`Tests/PolarisKeyPlatformTests`):
StoreKit Testing loads no products there and the Keychain answers -34018. The real StoreKit,
Keychain and AppDistributor run in the hosted XCTest project, `PlatformHostTests/run.sh`
(XcodeGen; a host app with `get-task-allow`; every StoreKit test asserts the product count).

## The frozen wire contract

Compact JWS, **EdDSA / Ed25519**:

```
header       = {"alg":"EdDSA","kid":<kid>,"typ":<typ>}   (key order fixed)
signingInput = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
signature    = Ed25519 over the ASCII bytes of signingInput
compact JWS  = signingInput "." base64url(signature)
```

The verifying key is selected by the header `kid` from a caller-supplied trust set (NEVER from
the document); `alg == "EdDSA"` and a String `kid` are asserted _before_ any signature math (a
`none`/HMAC downgrade is rejected). Public keys are RAW 32 bytes
(`Curve25519.Signing.PublicKey(rawRepresentation:)`) — no SPKI prefix. The signature is checked
over the ASCII bytes of the original `encHeader.encPayload` substrings; the payload is never
re-serialized, so verification is byte-stable across Node, Python, React and Swift.

Additionally, in this order: the **encoded** segments are bounded before any decode (1 KiB
header, 64 KiB payload — 256 KiB for `pkey-bundle+jws` alone), base64url is **strict** (`-_`
only — no `+/`, no `=`, no whitespace), **duplicate JSON keys are rejected** rather than resolved
(`JSONSerialization` is used nowhere in the verify path), `typ` is **required** and asserted
against the call site's expected document type, and the payload is parsed **only after** the
signature verifies. `verifyLicenseDoc`/`verifyConfigDoc` then check `aud`, `iss` (`key.plrs.im` —
host-neutral), `deviceId`, the per-type monotonic `issuedAt` floor, the 365-day grace ceiling,
and the whole signed validity window with a 300 s clock skew.

Six document types, domain-separated by `typ`: `pkey-license+jws`, `pkey-config+jws`,
`pkey-trust+jws`, `pkey-bundle+jws`, and wire v4's `pkey-feed+jws` (the channel feed, signed by
the product key) and `pkey-release+jws` (the release record, signed by a CI-held release key and
verified against `pinnedReleaseKeys` only, after its SHA-256 matches the feed's pin).

## Develop

```sh
swift build
swift test    # includes the cross-language conformance corpus (v2)
PlatformHostTests/run.sh                 # PolarisKeyPlatform against StoreKit Testing (iOS simulator)
tools/typecheck-platform-old-swift.sh    # PolarisKeyPlatform on Swift 6.0 / 6.1 / 6.2 (Docker)
swift test --filter UpdateMatrixTests   # wire v4's update-matrix.json, row for row
swift test --filter "ContentConformanceTests|PlanMatrixTests|PackRecordConformanceTests"  # packs
swift test --filter PkeyDevLiveTests   # the quickstart against a live `pkey dev` (skipped unless it is set up, below)

# The Sparkle conditioning: PolarisKeyUpdate must build for iOS without linking a macOS framework,
# and the decision lives in PolarisKeyCore, which iOS needs whole.
xcodebuild -scheme PolarisKeyCore -destination 'generic/platform=iOS' build
xcodebuild -scheme PolarisKeyUpdate -destination 'generic/platform=iOS' build
xcodebuild -scheme PolarisKeyPacks -destination 'generic/platform=iOS' build

# Availability guard: the PolarisKey scheme builds for tvOS, visionOS, iOS and macOS (CI should run it).
tools/build_platforms.sh
```

The tests read the corpus (`conformance/corpus/v2/`, `content/` included) and the HTTP transcripts
(`conformance/transcripts/`) from the checkout through the corpus locator, which finds the repository
root from its own `#filePath`; nothing is copied into the test bundle, so run the suite from a
monorepo checkout (from any working directory: CI runs `swift test --package-path sdks/swift`).

The corpus and the transcripts are **generated**: run `pnpm gen corpus` (or `pnpm gen transcripts`)
from the repo root after any wire change, and `pnpm gen corpus --check` (and
`pnpm gen transcripts --check`) is the CI drift gate.

**Against a live `pkey dev`.** The PkeyDevLiveTests suite runs the quickstart against a real local
Polaris Key over the SDK's own `URLSessionTransport`: no replayed traffic. It covers first
activation (`ok`, `floating`), each refusal the other five seeded keys reach (`unauthorized`,
`device_limit`, `key_entry_limit`), a `config` change event after `pkey dev config`, device-code
sign-in (`beginSignIn`, an approval by the harness, `pollSignIn`, `waitForSignIn`) and the update
decision before and after `pkey dev release`. Every client is built from the origin and pins in the
`PolarisConfig.swift` that `pkey sdk` wrote for that server. Start a fresh server and set three
variables; the tests are skipped when none is set and fail when only some are:

```sh
pnpm exec pkey dev --builtin --auto-approve        # from the repo root; it prints its port (8787 by default)
pnpm exec pkey sdk --lang swift --dev --url http://127.0.0.1:8787 --write --out /tmp/PolarisConfig.swift
PKEY_DEV_BASE_URL=http://127.0.0.1:8787 PKEY_DEV_CONFIG=/tmp/PolarisConfig.swift \
  PKEY_DEV_APPROVE="$(git rev-parse --show-toplevel)/packages/cli/scripts/dev-approve.mjs" \
  swift test --filter PkeyDevLiveTests
```

The approver is `node` (22.13 or later, on `PATH`). Each device the tests use is fixed, so a second run
against the same server works. The CI Swift job starts its own server and sets the variables for its
`swift test`.
