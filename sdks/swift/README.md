# PolarisKey — Swift SDK

A product-agnostic native Swift client for **Polaris Key** (licensing + remotely-managed
config). It implements the frozen Polaris wire crypto natively on **CryptoKit** (Ed25519
compact JWS) and stores the per-device token in the **Keychain** — no Node engine, no
network dependency for verification. The same cross-language conformance corpus that pins
the Node/Python/React SDKs is verified here byte-for-byte (`Tests/.../cases.json`).

Two products:

- **`PolarisKey`** — the headless core: JWS verifier, license gate, HTTP endpoints, device
  id, stores, and the `PolarisKeyClient` actor.
- **`PolarisKeyUI`** — a brandable SwiftUI drop-in gate layered over the core.

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
    ])
]
```

## Headless usage

```swift
import PolarisKey

// `create` throws when the credential store itself is unavailable (locked keychain,
// unwritable config dir) — that used to be swallowed, silently re-activating every launch.
let client = try await PolarisKeyClient.create(options: .init(
    productSlug: "djdl",
    version: "1.4.2",
    // kid -> raw Ed25519 public key (base64url). PLACEHOLDERS — substitute YOUR product's
    // real values; see "Where the trust set comes from" below.
    trust: PolarisTrust(pinnedKeys: [
        "<your-signing-key-id>": "<your-product-signing-key-b64url>"
    ])
))

// Offline-first: status comes from the cached signed doc with no network.
if client.isLicensed() {
    let concurrency = client.config("run.concurrency", default: .int(4)).intValue ?? 4
    let vpnUrl = client.secret("proxy.subscriptionUrl")
    let hasVpn = client.isEntitled("polarisVpn")
}

// Activate with a license key (exchanges key → token, persists, refreshes).
let result = await client.activate(key: userEnteredKey)

// Re-pull managed config online (single /token re-acquire on 401), then re-apply.
// `force: true` drops the conditional request, so the server must return a fresh document.
await client.refresh()

// Wipe local state + best-effort server deauthorize. Throws if the local wipe failed —
// the caller needs to know the credential is still on the machine.
try await client.deactivate()
```

The client mirrors the Node SDK's surface: `start()`/`activate(key:)`/`deactivate()`/
`refresh(force:)`/`status()`/`isLicensed()`/`config(_:default:)`/`secret(_:)`/
`isEntitled(_:)`/`entitlements()`/`profile()`.

### Where the trust set comes from

> [!WARNING]
> Every `kid`/public key shown in this repository's docs, tests and
> `conformance/corpus/v1/cases.json` is a **placeholder or a test fixture whose private
> half is committed**. Pinning one means anyone can forge a document your client accepts:
> the verifying key is selected by the header `kid` from whatever map you supply.

Your product's real trust set is minted server-side when the product is registered, and is
never checked into a client repo. Get it from either the **onboarding bundle** the admin
portal returns when it mints the product's signing key (`kid -> publicKey`), or
`GET https://key.plrs.im/<product>/.well-known/jwks.json` over TLS, once — then compile the
values into your application. Pins are terminal, so treat updating them as a release, not a
runtime fetch; routine key rotation is handled by the signed trust manifest at
`/<product>/.well-known/polaris-trust.jws`, which is verified against your pins.

### Layered config

`config(_:default:)` resolves a value through the **same precedence** as every Polaris Key
SDK; `configSource(_:)` returns which layer won:

```
enforced | hidden (remote)  >  localOverrides  >  environment  >  remote default  >  fallback
```

`enforced`/`hidden` remote values are **locked to the server** — `localOverrides` and env
vars are ignored for those keys; `hidden` keys are additionally withheld from
`listUserConfig()` (but still applied by `config(_:default:)`). Otherwise the order is
`localOverrides[key]` → env → remote value → your `default`.

The env var for a key is `envPrefix + key` with dots replaced by `__` (default prefix
`PKEY_CONFIG_`): `run.concurrency` → `PKEY_CONFIG_run__concurrency`. The raw string is
JSON-decoded when it parses (`"4"` → int, `"true"` → bool, `"[1,2]"` → array); otherwise it
is taken as a plain string. Supply `localOverrides` / `envPrefix` via the client options.

### Stores

- `KeychainStore` (default) — token in the OS keychain (service `pkey:<product>`), device
  id + offline cache as 0600 files under `~/.config/<product>/`. Files are created at 0600
  by `open(2)` (never chmod'd afterwards) and both the read and write paths refuse to follow
  a symlink.
- `InMemoryStore` — for tests.
- `Store` is a protocol; supply your own to back the token/cache differently. Its mutating
  methods `throw`, so a failed keychain write or an unwritable config dir surfaces as a
  typed `StoreError` instead of vanishing.

### What the cache holds

Only **signed artifacts**: the compact JWS of the managed-config doc and of the trust
manifest, plus two fail-closed hints (`blocked`, `lastSyncUnauthorized`). Both JWS are
re-verified on load — the manifest against the **pinned** keys only — and every counter
(`lastAcceptedIssuedAt`, the monotonic clock floor, `lastVerifiedAt`) is derived from that
re-verified content. A `v1` cache record is discarded, not migrated. See
`docs/security/WIRE-CONTRACT-V2.md` §4.

## SwiftUI gate

`PolarisKeyLoginView` renders by status: an OIDC sign-in button + license-key entry card
when activation is needed, an offline-grace banner over your content, version-block and
expired/revoked screens, and your own UI once usable (ok/grace).

```swift
import PolarisKey
import PolarisKeyUI

@StateObject var gate = PolarisKeyGateModel(client: client)

var body: some View {
    PolarisKeyLoginView(
        model: gate,
        theme: PolarisKeyTheme(
            accent: .indigo,
            copy: PolarisKeyCopy(productName: "DJDL"),
            logo: { AnyView(Image("BrandLogo").resizable().scaledToFit().frame(width: 56)) }
        ),
        onSignIn: { startMyOIDCFlow() }   // the SDK is transport-agnostic about the browser dance
    ) {
        MyAppRootView()   // shown when licensed
    }
}
```

Everything is brandable via `PolarisKeyTheme` (accent, logo, copy). The headless API stays
on `PolarisKeyClient`; the view is a thin renderer over it.

## The frozen wire contract

Compact JWS, **EdDSA / Ed25519**:

```
header       = {"alg":"EdDSA","typ":<typ>,"kid":<kid>}  (key order fixed; typ is v2+)
signingInput = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
signature    = Ed25519 over the ASCII bytes of signingInput
compact JWS  = signingInput "." base64url(signature)
```

The verifying key is selected by the header `kid` from a caller-supplied trust set (NEVER
from the document); `alg == "EdDSA"` and a String `kid` are asserted _before_ any signature
math (a `none`/HMAC downgrade is rejected). Public keys are RAW 32 bytes
(`Curve25519.Signing.PublicKey(rawRepresentation:)`) — no SPKI prefix. The signature is
checked over the ASCII bytes of the original `encHeader.encPayload` substrings; the payload
is never re-serialised, so verification is byte-stable across Node, Python, React, and Swift.

Wire contract v2 additionally requires, in this order: the **encoded** segments are bounded
before any decode (1 KiB header, 64 KiB payload), base64url is **strict** (`-_` only — no
`+/`, no `=`, no whitespace), **duplicate JSON keys are rejected** rather than resolved
(`JSONSerialization` is no longer used anywhere in the verify path), `typ` is asserted
against the call site's expected document type, and the payload is parsed **only after** the
signature verifies. `verifyDoc` then checks `schemaVersion`, `aud`, `iss`, `deviceId`,
monotonic `issuedAt`, and the whole signed validity window with a 300s clock skew.

## Develop

```sh
swift build
swift test    # includes the cross-language conformance corpus
```
