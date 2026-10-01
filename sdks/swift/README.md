# PolarisKey — Swift SDK

A product-agnostic native Swift client for **Polaris Key** (licensing, remotely-managed
config, updates). It implements the frozen Polaris Key wire crypto natively on **CryptoKit**
(Ed25519 compact JWS) and stores the per-device token in the **Keychain** — no Node engine, no
network dependency for verification. The same cross-language conformance corpus that pins the
Node/Python/React SDKs is verified here byte-for-byte (`conformance/corpus/v2`, mirrored into
`Tests/PolarisKeyTests/Resources/v2/`).

Wire contract: `docs/security/WIRE-CONTRACT-V3.md`.

## Targets

Polaris Key is a suite of opt-in services over an always-on Core, and on Apple platforms that
division is spent at LINK time: a product that does not ship updates does not link Sparkle, and
a product with no license service does not carry the gate.

| Product              | Contents                                                                                      | Depends on                               |
| -------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `PolarisKey`         | `PolarisKeyClient` + `@_exported import` of Core/License/Config/Identity/Release — one import | Core, License, Config, Identity, Release |
| `PolarisKeyCore`     | device principal, trust set, verified cache, clock floor, transport, discovery, bundles       | —                                        |
| `PolarisKeyLicense`  | the gate, activation, entitlements                                                            | Core                                     |
| `PolarisKeyConfig`   | the config document, layered resolution, device facts, edge-mint, the catalog fetch           | Core                                     |
| `PolarisKeyIdentity` | device-code sign-in (RFC 8628)                                                                | Core                                     |
| `PolarisKeyRelease`  | the changelog, the install and artifact URLs (macOS **and** iOS)                              | Core                                     |
| `PolarisKeyUpdate`   | Sparkle wiring. **macOS only**                                                                | Core, Sparkle ≥ 2.9.6                    |
| `PolarisKeyUI`       | the brandable SwiftUI drop-in gate                                                            | Core, License, Config                    |

Platforms: macOS 14+, iOS 17+. Swift 6 (strict concurrency, everything `Sendable`).

## Install

```swift
// Package.swift
dependencies: [
    .package(path: "../polaris-key/sdks/swift")
],
targets: [
    .target(name: "MyApp", dependencies: [
        .product(name: "PolarisKey", package: "PolarisKey"),
        .product(name: "PolarisKeyUI", package: "PolarisKey"),
        // macOS only — see "Updates" below.
        .product(name: "PolarisKeyUpdate", package: "PolarisKey",
                 condition: .when(platforms: [.macOS])),
    ])
]
```

## Headless usage

```swift
import PolarisKey

// `create` throws on a non-https base URL and when the credential store itself is unavailable
// (locked keychain, unwritable config dir) — the latter used to be swallowed, silently
// re-activating every launch and burning a seat each time.
let client = try await PolarisKeyClient.create(options: .init(
    productSlug: "djdl",
    version: "1.4.2",
    // kid -> raw Ed25519 public key (base64url). PLACEHOLDERS — substitute YOUR product's real
    // values; see "Where the trust set comes from" below.
    pinnedKeys: ["<your-signing-key-id>": "<your-product-signing-key-b64url>"],
    // What this build expects the product to run, for the offline capability fallback (D-21).
    expectedServices: [.license, .config]
))

// Offline-first: status comes from the cached signed documents with no network.
if await client.isLicensed() {
    let concurrency = await client.config.config("run.concurrency", default: .int(4))
    let vpnUrl = await client.config.secret("proxy.subscriptionUrl")
    let hasVpn = await client.license.isEntitled("polarisVpn")
}

// Activate with a license key (key → token, persisted, then a forced sync).
let result = await client.activate(key: userEnteredKey)

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
isEntitled,entitlements,entitledChannels,profile,deactivate}`, `client.config.{config,
configSource,secret,listUserConfig,schemaVersion,fetchSchema,mintToken}`,
`client.identity.{beginSignIn,pollSignIn,waitForSignIn}` and `client.release.{changelog,
installURL,downloadURL(version:binary:arch:checksum:dmg:)}`. `client.{status,isLicensed,config,
activate,enroll,register,report,sync,deactivate,importBundle,syncState}` are convenience
passthroughs for the calls a host makes before it knows which service it is talking to.

`client.report()` posts the telemetry snapshot now (`sync()` already reports after each pass);
it answers `false` rather than throwing when no credential is held or the server refused.
`client.config.fetchSchema()` returns the catalog's bytes, or `nil` on any failure — it is
unsigned and diagnostic. `client.release` throws `service-unavailable` when the product does not
run Release, forwards the device token when one is held, and throws a 401/403 with the refusal
body's own code (`unauthorized`, `channel_not_allowed`, …).

A 401 on a document gets exactly **one** re-acquire per `sync()` pass, then one retry of the
failed fetch. A licensed device rotates its token with `POST /<product>/license/token`. A
registered device without a licence **re-registers** instead: when License is off for the
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
default (license + config; release/distribution/update/identity off). It is **fail-closed** (D-21): a
service the discovery document omits reads as disabled, never as "unknown, assume on".

A product with the license service disabled gates `not-applicable` — `isLicensed()` is `true`
and the gate renders your UI. That is the point of D-08: a config-only product boots usable
rather than sitting on `needs-activation` forever.

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

`client.config.config(_:default:)` resolves a value through the **same precedence** as every
Polaris Key SDK; `configSource(_:)` returns which layer won:

```
enforced | hidden (remote)  >  localOverrides  >  environment  >  remote default  >  fallback
```

`enforced`/`hidden` remote values are **locked to the server** — `localOverrides` and env vars
are ignored for those keys; `hidden` keys are additionally withheld from `listUserConfig()` (but
still applied by `config(_:default:)`).

The env var for a key is `envPrefix + key` with dots replaced by `__` (default prefix
`PKEY_CONFIG_`): `run.concurrency` → `PKEY_CONFIG_run__concurrency`. The raw string is
JSON-decoded when it looks like JSON (`4` → int, `true` → bool, `[1,2]` → array); otherwise it
is taken as a plain string. Supply `localOverrides` / `envPrefix` / an injected `environment`
via `ConfigClientOptions`.

### Device-code sign-in

For a host that cannot complete a browser redirect — a TV app, a kiosk, a command-line tool —
`client.identity` signs in with a device code (RFC 8628). It needs the Identity service
(`expectedServices` or discovery); with it off, every call throws `service-unavailable` before
any request.

```swift
let prompt = try await client.identity.beginSignIn(deviceName: "Living-room Apple TV")
// Show prompt.userCode; render prompt.verificationUriComplete as a QR code (the verification
// page with the code filled in); show prompt.verificationUri as the short URL.
let signIn = Task { try await client.identity.waitForSignIn(prompt) }
// …cancel `signIn` if the player backs out: polling stops and it throws CancellationError.
if try await signIn.value == .ready {
    // The device token is stored and the post-activation sync has already run.
}
```

`waitForSignIn` waits at least `prompt.interval` seconds before each poll; a `slow_down`
lengthens the interval for every later poll (to the server's value, or by five seconds), and a
poll that fails on the network or with a 5xx is retried at the same interval, never faster. It
returns `.expired` once `prompt.expiresAt` has passed without asking the server again.
`pollSignIn(_:)` makes exactly one poll (`.pending`, `.slowDown(interval:)`, `.ready`, `.expired`
or `.error`). `prompt.deviceCode` is the poll credential: never show it. A sign-in yields the
signed-in identity's **own** licence; it does not attach a licence this device already held.

**After `.ready`, show on the device which account signed in.** Anyone holding the user code can
complete the sign-in on the verification page, so the player must be able to see a mis-binding:
`.ready` carries no identity itself, but the post-acquisition sync has already run, so
`await client.currentDevice().profile` (or `LicenseClient.profile()`) returns the signed licence
profile (`name`, `email`) to show — for example "Signed in as Ada Lovelace
<ada@example.com>" with a way to sign out.

`SignInPrompt` and `MintedToken` print (`print`, `String(describing:)`, `debugPrint`, `dump`)
with `deviceCode` / `token` as `[redacted]`; the properties themselves read normally.

### Edge-mint

`try await client.config.mintToken("musickit")` asks the Worker to sign a short-lived
third-party token through an operator-approved recipe (`GET /<product>/config/mint/<id>/token`,
with the device token) and returns a `MintedToken(token:expiresAt:)`. It is cached **in memory
only** — never in the cache file or the keychain — and reused until 30 seconds before
`expiresAt`, and only while the client still holds the device token it was minted with —
`deactivate()`, a cleared token or a different sign-in drops it. A 401 gets the usual single re-acquire, on the same route a document 401 takes (so a registered device without a licence re-registers), and one retry. Failures throw
`PolarisError`: `service-unavailable` (Config off) and `bad_request` (an id outside `[a-z0-9-]`)
before any request, `unauthorized` (no token, or still 401), or the Worker's `not_found` /
`rate_limited` / `misconfigured`.

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
manifest, per-document ETags, an offline-bundle import marker, and two fail-closed hints
(`blocked`, `lastSyncUnauthorized`). Every JWS is re-verified on load — the manifest against the
**pinned** keys only — and every counter (the per-type anti-replay floors, the monotonic clock
floor, `lastVerifiedAt`) is derived from that re-verified content. A record from any other cache
version is **discarded, never migrated**.

## Offline

Three depths, all first-class:

1. **Online with grace** (default) — post-activation zero-network operation to `graceUntil`.
2. **Air-gapped activation** (§7) — an operator mints a `.pkeybundle` against this device's id;
   `try await client.importBundle(jws)` verifies it against the **pins** all-or-nothing and
   writes the cache atomically. No token is created; the gate reads `activation: .bundle`. A
   refusal throws `PolarisError` carrying the §7 step that refused, because the step is the
   operator's remedy.
3. **Local-only** (§7.3) — `PolarisKeyClient.createLocal(options:)` substitutes `NoNetworkTransport`,
   which refuses at the DIAL, before a URL is built. Config resolution, the gate and bundle
   import all still work; anything that would open a socket rejects with code `local-only`.
   `PolarisKeyClient.createFromBundle(options:bundle:)` does both in one step.

## SwiftUI gate

`PolarisLoginView` renders by status: an OIDC sign-in button + license-key entry card when
activation is needed, an offline-grace banner over your content, version-block and
expired/revoked screens, and your own UI once usable (`ok` / `grace` / `not-applicable`).

```swift
import PolarisKey
import PolarisKeyUI

@StateObject var gate = PolarisGateModel(
    license: client.license,
    sync: { await client.sync() }   // the gate renders licence state; a sync is Core's
)

var body: some View {
    PolarisLoginView(
        model: gate,
        theme: PolarisTheme(
            accent: .indigo,
            copy: PolarisCopy(productName: "DJDL"),
            logo: { AnyView(Image("BrandLogo").resizable().scaledToFit().frame(width: 56)) }
        ),
        onSignIn: { startMyOIDCFlow() }   // the SDK is transport-agnostic about the browser dance
    ) {
        MyAppRootView()   // shown when usable
    }
}
```

## Updates (macOS, D-24)

`PolarisKeyUpdate` wires **Sparkle ≥ 2.9.6** to the product's own feed. That is the security floor:
2.9.5 and 2.9.6 fixed a symlink attack in delta patching and a root privilege escalation, on top of
CVE-2025-0509 (fixed in 2.6.4).
It carries three facts from Polaris Key to Sparkle and refuses to do a fourth:

```swift
#if os(macOS)
import PolarisKeyUpdate

await client.discover()                       // the feed URL comes from DISCOVERY, not a literal
let update = UpdateClient(core: client.core)
let feed = await update.feed(
    channel: "stable",
    entitlements: await client.license.entitlements())

// Throws SparkleAnchorError when the host bundle carries no `SUPublicEDKey`.
let delegate = try PolarisSparkleUpdater.configure(
    updaterController.updater,
    feed: feed,
    headers: await update.feedHeaders())      // the bearer token, for `entitled` feeds
updaterController.updater.delegate = delegate // RETAIN it: `delegate` is weak
#endif
```

- **feed URL** from the discovery document (`?arch=` applied), never string-built — §R1 moved
  these paths and left aliases behind.
- **`httpHeaders`** so an `entitled` product's feed (D-13) is reachable at all; Sparkle makes its
  own HTTP requests, and without this they are anonymous and answer 401.
- **`allowedChannels`** from the licence's `channels` entitlement, so a stable-only customer is
  not offered a beta the server will then refuse. A UX narrowing, not an enforcement point. A
  `staging` grant also allows `beta`, and a `beta` grant `staging`, as the server treats them.

It does **not** verify updates. `SUPublicEDKey` in the host app's code-signed `Info.plist` is the
terminal anchor; `PolarisKeyUpdate` asserts it is present and fails loudly if it is not, because an
app that ships Sparkle without it does not fail to build, launch, or check for updates — it
simply installs unsigned payloads. A Polaris Key-side signature check would be a second, weaker
anchor beside the real one.

## Channels

The channel names are WIRE-CONTRACT-V3 §5.1's: `stable`, `beta`, `pr`/`pr-<n>`, `dev` and a
product's manual channels. `Semver.channelForVersion` derives the default `X-PKey-Channel` from
the build version: `0.0.0-beta*` and the legacy `0.0.0-staging*` builds are now `.beta`.

**Behaviour note (P1b-07):** `client.license.entitledChannels()` now answers `["stable"]` when
the licence carries no `channels` entitlement (or a non-array one), where it used to answer `[]`.
That is the Worker's own answer and every other SDK's; Sparkle's `allowedChannels(from:)` already
treated an empty grant as stable only, so the updater's behaviour does not change. The list is
the raw grants: `staging` is not rewritten to `beta`.

**Source note (P0-04):** `enum Channel` gained `case beta`, and `case staging` is deprecated
(`staging` is the legacy spelling of `beta`; `channelForVersion` no longer returns it). An
exhaustive `switch` over `Channel` in your code needs a `.beta` case. Pass
`CoreOptions.channel: "staging"` only as a stopgap against a Worker older than this change.

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
re-serialised, so verification is byte-stable across Node, Python, React and Swift.

Additionally, in this order: the **encoded** segments are bounded before any decode (1 KiB
header, 64 KiB payload — 256 KiB for `pkey-bundle+jws` alone), base64url is **strict** (`-_`
only — no `+/`, no `=`, no whitespace), **duplicate JSON keys are rejected** rather than resolved
(`JSONSerialization` is used nowhere in the verify path), `typ` is **required** and asserted
against the call site's expected document type, and the payload is parsed **only after** the
signature verifies. `verifyLicenseDoc`/`verifyConfigDoc` then check `aud`, `iss` (`key.plrs.im` —
host-neutral), `deviceId`, the per-type monotonic `issuedAt` floor, the 365-day grace ceiling,
and the whole signed validity window with a 300 s clock skew.

Four document types, domain-separated by `typ`: `pkey-license+jws`, `pkey-config+jws`,
`pkey-trust+jws`, `pkey-bundle+jws`.

## Develop

```sh
swift build
swift test    # includes the cross-language conformance corpus (v2)

# The Sparkle conditioning: PolarisKeyUpdate must build for iOS without linking a macOS framework.
xcodebuild -scheme PolarisKeyUpdate -destination 'generic/platform=iOS' build
```

The corpus fixtures under `Tests/PolarisKeyTests/Resources/` are **generated**: run
`pnpm gen:corpus` from the repo root after any wire change, and `pnpm gen:corpus -- --check` is
the CI drift gate.
