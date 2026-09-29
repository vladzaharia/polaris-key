> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# A2 — Porting Polaris Key to a sixth language: a Godot 4.x (GDScript) SDK

Research date 2026-09-29, repo HEAD `fde0c0e`. Read-only; no repo files modified.

Scope: everything a GDScript client for Godot 4.x (targets iOS, Android, macOS, Windows, Linux,
Web) must implement to be a conformant Polaris Key client, how hard each piece is, and the parity
work needed so it can replace Node/Swift in a shipped game (Diceroll). Line references are
`path:line` at HEAD. "SDK" below means the four existing implementations: Node
(`packages/sdk-node` + `packages/client-core`), React (`packages/sdk-react`), Python
(`sdks/python`), Swift (`sdks/swift`).

> Diceroll note: I was denied read access to `/home/user/vladzaharia/diceroll` (permission
> classifier), so §13's Diceroll use cases assume a typical single-player/online dice game with a
> `user://settings.cfg`, and should be reconciled with whatever the Diceroll-mapping research
> found.

---

## 0. Verdict in one screen

- **No wire change is needed.** Everything the contract requires is expressible in GDScript plus
  one primitive Godot does not ship: **Ed25519 verification, which also needs SHA-512**. Godot's
  `Crypto` is mbedTLS/RSA-only, and `HashingContext` stops at SHA-256.
- **The hardest problem is Ed25519 (+ SHA-512)**, and it gets harder on **Web** (single-threaded,
  GDExtension only works with the "Extensions Support" template). Suggested design: one
  `PKeyEd25519` interface with three backends. (1) A GDExtension (Monocypher-based
  `gd-ed25519` or libsodium) for native targets. (2) WebCrypto `Ed25519` via `JavaScriptBridge`
  on Web (Chrome 137+, Firefox 129+, Safari 17+). (3) A pure-GDScript reference port
  (TweetNaCl/ref10 plus SHA-512). The pure port is the one CI runs against the corpus, and it is
  the fallback everywhere else.
- **Godot's JSON parser differs from the reference.** It returns every number as `float`, keeps
  the last of duplicate keys, accepts raw control characters and rejects lone surrogates. The port
  needs its own duplicate-key pre-scan (a straight port of `hasDuplicateKeys`) and float-aware
  claim checks. Float semantics actually match the TypeScript reference (JS numbers) better than
  Swift's `Int`.
- **Web exports cannot talk to the Worker today.** The Worker sets **no CORS headers at all**,
  and every request carries `Authorization`/`X-PKey-*`, which forces a CORS preflight. Web needs
  either a Worker CORS change (HTTP-level, not wire) or a same-origin reverse proxy. The proxy
  works because `iss` is fixed rather than derived from the base URL.
- **Fingerprints cover only part of Godot.** Desktop can read 5–7 components with
  `OS`/`FileAccess`/`OS.execute`. iOS and Android give `machineUuid` (the vendor/app-scoped id),
  `machineModel`, `ramBucket` and, except on Android, `cpuModel`. **Web gives no stable anchor**,
  so keyless `license/enroll` (which requires the `machineUuid` anchor) is impossible there, and
  `strict` tiers are unreliable.
- **Identity is effectively device-code only for native.** Loopback OIDC isn't wired
  server-side, and `requires-identity` registration is cookie-only. Device-code is
  the right default on every platform, shown as QR + URL (the _full_ verification URL; there is
  no short-code entry page).
- **Ecosystem gaps a Godot SDK would be first to fill.** No existing SDK implements an
  **edge-mint client**, an **identity/device-flow client** (React delegates it to a host
  bridge), or the spec's **"registered devices re-register on 401"** rule.
- **Size:** ~4–5k lines of GDScript for Core + all services, ~1.5–2k for UI scenes, ~2k for
  tests including a headless corpus runner. Crypto is ~1k of that if done in pure GDScript.
  Roughly 7–11 engineer-weeks for full parity. Crypto is the long pole: 2–3 weeks including
  hardening and Web.

---

## 1. The complete client algorithm surface

### 1.1 Compact JWS verification — the frozen 13-step order

Reference: `packages/shared-jws/src/index.ts:308-379` (`verifyJws`). The same order appears in
Swift `sdks/swift/Sources/PolarisKeyCore/JWSVerifier.swift:90-165` and Python
`sdks/python/src/polaris_key/core/jws.py:13-27,137-235` (the docstring lists the numbered steps).

| #   | Step                                                                                                           | Ref               | GDScript notes                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `split(".")` → exactly 3 parts                                                                                 | index.ts:313-315  | `jws.split(".", true)` (keep empties)                                                                            |
| 2   | encoded header length ≤ `b64Cap(1024)`                                                                         | :319, caps :80-91 | `b64Cap(n)=ceil(n*4/3)+4` (TS), Swift `(n*4+2)/3+4` — same                                                       |
| 3   | encoded payload length ≤ `b64Cap(cap)`; cap = `max(65536, requested)`; only `pkey-bundle+jws` raises to 262144 | :98-103, :320     | the bundle cap travels with `typ` (Swift refuses a raised cap without a required typ, JWSVerifier.swift:100-101) |
| 4   | strict base64url decode header (`^[A-Za-z0-9_-]*$`, no `=`/`+`/`/`/whitespace)                                 | :106-121          | regex or byte loop, then `Marshalls.base64_to_raw` after alphabet map + re-pad                                   |
| 5   | decoded header ≤ 1024 bytes                                                                                    | :324              |                                                                                                                  |
| 6   | parse header rejecting duplicate keys; must be an object                                                       | :136-201, :331    | Godot `JSON` keeps the last duplicate → **must port `hasDuplicateKeys`** (54 lines, byte-level)                  |
| 7   | `alg === "EdDSA"` (before any crypto)                                                                          | :334              |                                                                                                                  |
| 8   | `typ` must equal the call site's expected typ; an absent typ is rejected on every v3 path                      | :339-340          | Python's `require_typ` / Swift's `requireTyp` default true                                                       |
| 9   | `kid` is a string                                                                                              | :341              |                                                                                                                  |
| 10  | key = `trust[kid]` (never from the doc); raw 32-byte Ed25519 key, base64url                                    | :342, :259-273    | key length check = 32                                                                                            |
| 11  | strict base64url decode the signature                                                                          | :355-356          |                                                                                                                  |
| 12  | Ed25519 verify over the **ASCII bytes of `encHeader + "." + encPayload` exactly as received**                  | :359-368          | never re-serialize                                                                                               |
| 13  | only now decode the payload, apply the ≤ cap check, parse with duplicate-key rejection                         | :373-376          |                                                                                                                  |

Header key order `{"alg","typ","kid"}` (WIRE-CONTRACT-V3.md §1, index.ts:6) matters **only to
signers**. A verifier parses the header, so a Godot client never needs it. (Doc inconsistency:
`JWSVerifier.swift:6` still says `alg,kid,typ`; the wire contract explicitly calls that ordering
wrong.)

### 1.2 base64url

- Wire segments: **strict** alphabet `[A-Za-z0-9_-]`, unpadded (index.ts:106-121; Python
  `core/b64url.py:31-49`; Swift `Base64URL.swift:21`). Trust-set keys use the lenient decoder
  (index.ts:221-225).
- Corpus pins it with `base64url-payload-padding`, `base64url-payload-trailing-data`,
  `sig-out-of-alphabet-{stars,whitespace,padding}`.
- GDScript: validate the alphabet by hand (a byte loop over `to_ascii_buffer()` is fast), map
  `-`→`+` and `_`→`/`, re-pad, then use `Marshalls.base64_to_raw`. mbedTLS's decoder skips
  whitespace, so the alphabet check **must** come first. Encoding is `Marshalls.raw_to_base64`,
  then replace `+/` and strip `=`.

### 1.3 JSON — no canonical JSON anywhere client-side, but Godot's parser needs guarding

**No client code path requires canonical JSON or byte-exact re-serialization.**

- Signatures are over the received bytes (index.ts:302-306).
- The cache persists compact JWS strings verbatim (`client-core/src/store.ts:34-50`).
- ETags are computed server-side and echoed verbatim
  (`packages/worker/src/services/license/document.ts:57,143`;
  `services/config/document.ts:111`).
- The only client-built strings that get hashed are the fingerprint/device-id formulas. Those
  are string concatenations over UTF-8, not JSON (§3).

Where Godot's `JSON` (core/io/json.cpp, fetched upstream) differs from `JSON.parse`:

| Behaviour                    | JS (reference) | Godot 4 `JSON`                                             | Consequence for the port                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numbers                      | IEEE double    | **always `float`** (tokenizer calls `String::to_float`)    | Claim checks must accept `TYPE_FLOAT` (and `TYPE_INT` if you swap parsers). Float semantics equal the TS reference; e.g. `valid-large-integer-timestamps` (2^53-1) round-trips exactly. `schemaVersion` "integer ≥ 1" (`verify.ts:35-37`) → `v == floor(v) and v >= 1`. The cache's `v == 3` works (float 3.0 == 3) but a `typeof == TYPE_INT` check would fail. |
| Duplicate keys               | last wins      | last wins (`r_object[key] = v`)                            | **Reject by pre-scan** (port `hasDuplicateKeys`, index.ts:136-185; Swift byte version JWSVerifier.swift:209-256). Pinned by `duplicate-key-header-alg` and `duplicate-key-payload`.                                                                                                                                                                              |
| Raw control chars in strings | rejected       | **accepted**                                               | Divergence. Harmless post-signature, but headers parse pre-signature. Add a strict validator (a ~100-line scan) if you want exact parity; no corpus vector covers it today.                                                                                                                                                                                      |
| Lone surrogate `\ud800`      | accepted       | **rejected** ("unpaired lead surrogate")                   | A validly-signed payload with a lone surrogate would verify in JS/Python and fail in Godot. No vector covers it; candidate corpus case.                                                                                                                                                                                                                          |
| `\u0000`                     | fine           | accepted, yields NUL                                       | `valid-nul-byte-in-string` passes (both sides parsed identically), but keep payload handling byte-based; `get_string_from_utf8()` on raw bytes stops at a raw NUL.                                                                                                                                                                                               |
| Failure signalling           | throws         | `parse_string` returns `null` (ambiguous with JSON `null`) | Use `JSON.new().parse()` and check the `Error`.                                                                                                                                                                                                                                                                                                                  |
| Depth                        | engine-deep    | `Variant::MAX_RECURSION_DEPTH`                             | Edge only.                                                                                                                                                                                                                                                                                                                                                       |

### 1.4 Ed25519 verification

Every SDK delegates to a platform primitive:

- Node/React: WebCrypto `crypto.subtle.verify({name:"Ed25519"})` (index.ts:359).
- Swift: CryptoKit `Curve25519.Signing.PublicKey.isValidSignature` (JWSVerifier.swift:147-156).
- Python: `cryptography`'s `Ed25519PublicKey.verify` (jws.py:51-54, 218).

Raw 32-byte public keys, no SPKI wrapper (jws.py:125-134). Godot has none of this; see §7.

### 1.5 Trust manifest: pinning, rotation, revocation

`client-core/src/trust.ts:26-116`, Swift `Trust.swift:70-117`, WIRE-CONTRACT-V3 §1, §2.3.

- **Two tiers.** Pins are compiled into the app. Manifest keys come only from a
  `pkey-trust+jws` verified **against the pins only**, on both network and reload paths
  (trust.ts:72-74).
- `mergeTrust = {...discovered, ...pinned}`, so pins are terminal (trust.ts:26-28).
- Checks, in order:
  - `schemaVersion ∈ {1}` (:18, :80);
  - `aud == product`, `iss == "key.plrs.im"`;
  - `issuedAt`/`expiresAt` are numbers;
  - anti-rollback `issuedAt > lastTrustIssuedAt` (the _previous in-memory manifest_, never a
    disk counter);
  - network-path freshness: `issuedAt ≤ now+300` and `expiresAt > now-300`;
  - `keys` is an array of objects with string `kid`/`publicKey`.
- **Substitution:** a pinned kid with different bytes rejects the whole manifest (:107-109).
- `status:"revoked"` → drop (:110). A non-`EdDSA/OKP/Ed25519` entry → **skip, not fatal**
  (:111-112).
- The discovered set is **replaced wholesale**, so absence means revocation.
- Server side: the manifest is served at `GET /<p>/.well-known/polaris-trust.jws`
  (`content-type: application/jose`, `cache-control: public, max-age=300`), with
  `expiresAt = issuedAt+300` (`worker/src/core/trust.ts:22,58-120`).
- The SDK refreshes trust at the top of **every** `sync()`, on Core's cadence
  (`sdk-node/src/core/sync.ts:97-101`; Swift `CoreContext.swift:822-825`). A fetch failure keeps
  the old set.
- Corpus: 11 `trustCases`.

### 1.6 Document envelope + per-type claims

`client-core/src/verify.ts:75-159`; Swift `Verify.swift:75-133`; WIRE-CONTRACT-V3 §2–§3.

- **Envelope** (`validateEnvelope`, verify.ts:102-135):
  - `aud == product`, `iss == "key.plrs.im"`, `deviceId == local device id`;
  - `issuedAt`, `expiresAt`, `graceUntil` are numbers;
  - per-type anti-replay `issuedAt > lastAcceptedIssuedAt`;
  - `graceUntil ≥ expiresAt` (:128);
  - `graceUntil ≤ issuedAt + 31 536 000` (:129);
  - network path only: `issuedAt ≤ now+300` and `expiresAt > now-300` (:130-133).
- **License** (`pkey-license+jws`, :75-84): `licenseId` is a non-empty string; `entitlements`
  is a plain object; `profile`, if present, is an object.
- **Config** (`pkey-config+jws`, :87-95): `schemaVersion` is an integer ≥ 1 (a catalog version,
  _not_ allow-listed); `config` and `secrets` are plain objects. A config doc needs no license
  fields (D-08).
- Constants: `CLOCK_SKEW_SECONDS=300`, `MAX_GRACE_SECONDS=31536000`,
  `REFRESH_MARGIN_SECONDS=1800` (`client-core/src/claims.ts:10,18,26`); `DOC_EXPIRY_SECONDS=3600`,
  `SECONDS_PER_DAY=86400` (`shared-protocol/src/core.ts:217,220`); `ISSUER` (:15);
  `PROTOCOL_VERSION=3` (:9).
- Corpus: 16 `licenseDocCases` + 18 `configDocCases`.

### 1.7 Monotonic clock floor

`client-core/src/clock.ts:26-41`, Swift `MonotonicClock.swift`, WIRE-CONTRACT-V3 §4.2.

- `highWaterMark = max(issuedAt)` over the **re-verified** trust manifest + license doc +
  config doc. `effectiveNow = max(system, floor)`.
- It is never persisted: it is recomputed at load (`sdk-node/src/core/cache.ts`; Swift
  `CoreContext.swift:495-545`) and raised on every accept.
- The floor is used by the gate (`gate.ts:73`) and by the 304 half-life rule
  (`sync.ts:207`).
- Corpus: 7 `clockFloorCases`. One of them (`floor-config-doc-alone-does-not-stop-rollback`)
  pins that a document-only floor is inert.
- Godot: `Time.get_unix_time_from_system()` returns float seconds; floor it. There is no need
  for a monotonic OS clock; the signed floor _is_ the monotonic source.
- Swift-only extra: its reload path bounds a cached doc's `issuedAt ≤ now + 365d`
  (`CoreContext.swift:567`), and it signature-verifies each cached doc twice (peek, then
  `verifyDoc`, :558-573). Don't copy the double verify; in GDScript it doubles the most expensive
  operation.

### 1.8 Verified cache (what is persisted, where, integrity)

`client-core/src/store.ts:13-64`; WIRE-CONTRACT-V3 §4.1.

- The record is
  `{v:3, trustJws?, docs?{license?,config?}, etags?{license?,config?}, importedBundle?{bundleId,importedAt}, lastSyncUnauthorized?, blocked?{reason,allowedRange?}}`.
- It holds **signed artifacts only**, plus two unsigned hints (`lastSyncUnauthorized`,
  `blocked`) that can only make the gate stricter. ETags are non-security.
- Load procedure (`sdk-node/src/core/cache.ts:98-150`):
  - `v != 3` → discard, never migrate;
  - `trustJws` is checked against the pins with freshness off;
  - each doc is checked against the effective set with freshness off;
  - a failing artifact is treated as absent;
  - derived counters (anti-replay floors, clock floor, `lastVerifiedAt = newest issuedAt × 1000`)
    are never read from the file.
- Writes are a whole-record read-modify-write, **once per sync** (`sync.ts:115-148`).
- Where it lives: Node `FileStore` puts `<configDir>/<product>/{token,device,managed.json}` with
  mode 0600 and `O_NOFOLLOW` (`sdk-node/src/core/store.ts:66-77,102`). The token goes to the
  keyring as service `pkey:<product>` (:159). Swift uses the same layout with the Keychain
  (`Store.swift:229,343`; the iOS dir is Application Support, :220). Python does the same.
- **Integrity comes entirely from re-verification.** No MAC, no encryption. Confidentiality of
  `managed.json` (it contains the config doc, **including `clientScoped` secrets**) relies on
  file permissions only (§4).

### 1.9 Gate evaluation and every license status value

`client-core/src/gate.ts:69-112`; WIRE-CONTRACT-V3 §5; `shared-protocol/src/license.ts:31-56`.

Order (the order is contract):

1. `now = max(now, highWaterMark)`.
2. `licenseServiceEnabled == false` → **`not-applicable`** (usable). This precedes everything,
   including `blocked`.
3. `activation == null` → **`needs-activation`**.
4. `blocked` hint → **`version-too-old` | `version-too-new` | `channel-not-entitled`** (with
   `allowedRange`).
5. `lastSyncUnauthorized` → **`revoked`**.
6. No doc → `needs-activation`.
7. `now > graceUntil` → **`expired`**.
8. `now > expiresAt` → **`grace`**.
9. Otherwise **`ok`**.

`isUsable` = `ok | grace | not-applicable` (:109-112).

`activation` is `"token"` when a `pkeyt_` token is held; otherwise `"bundle"` when an imported
bundle left a _verified license doc_; otherwise null (`sdk-node/src/license/client.ts:76-85`).
A token supersedes a bundle.

Corpus: `gate-matrix.json`, 21 rows (15 carried from v1 plus 6 v3 rows). Each row pairs
build-gate inputs with license inputs.

**Build gate (server side), and a runner divergence worth knowing.** Clients never compute the
build gate; they record the Worker's 403 (`sdk-node/src/core/context.ts:348-365`). The corpus
runners, however, re-implement it to derive `expect.reason`
(`conformance/runners/node/corpusV2.test.ts:322-373`). That port is **stale against the server**
in two ways:

- The server refuses an **unrecognised `X-PKey-Channel`** (e.g. `beta`) with
  `channel-not-entitled` (`worker/src/core/gate.ts:82-88,144-148`). The runner maps unknown
  values to `stable` (corpusV2.test.ts:350-355).
- The server's dev-build bypass requires a `dev` entitlement or `allowDevBuilds` (R3-01,
  gate.ts:119-121). The runner bypasses on any `0.0.0-dev*` (:357).

A Godot runner should port the runner's semantics to pass the matrix. The SDK itself must send
**only** `stable | staging | pr | pr-N | dev` as the channel header.

### 1.10 Config precedence resolution

`client-core/src/config.ts:49-121`; docs `build/sdks/index.md` ("The `PKEY_CONFIG_*` env
convention").

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

- The env var name is `prefix + key.replaceAll(".", "__")` with default prefix `PKEY_CONFIG_`
  (:49-51, `sdk-node/src/config/client.ts:33`).
- An env value is JSON-parsed when it "looks like JSON" (:61-76), otherwise used as a raw
  string.
- `resolveSource` returns the provenance (`enforced|hidden|local|env|remote-default|fallback`,
  :79-89).
- `listUserEntries` excludes `hidden` and marks `enforced` read-only (:112-121).
- Secrets are read only via `getSecret(key)` (string-only), are never enumerated, and have no
  override layers (`sdk-node/src/config/client.ts:95-98`).
- Godot mapping is in §11.

### 1.11 Entitlements

- `entitlements` on the license doc is the **only** grant carrier (D-20). Its entries are
  `ManagedEntry{state,value,updatedAt}`.
- Admin policy is injected as `license.tier`, `license.tierLabel`, `channels`, `app.minVersion`,
  `app.maxVersion` and `deviceLimit`, alongside catalog `flag` keys
  (`shared-protocol/src/license.ts:15-26`).
- API:
  - `isEntitled(name)` ⇔ `value === true` (`sdk-node/src/license/client.ts:107-110`);
  - `getEntitlements()` flattens to values;
  - `getProfile()` returns the signed `{name, firstName, email, activatedAt}`;
  - `getLicenseId()`;
  - Swift adds `entitledChannels()` (`PolarisKeyLicense/LicenseClient.swift:113-118`).

### 1.12 Offline bundle import

`client-core/src/bundle.ts:117-222`; host write in `sdk-node/src/core/bundle.ts:58-96`;
WIRE-CONTRACT-V3 §7.

1. Verify the bundle against the **pins only**, with `typ=pkey-bundle+jws` and cap 262 144.
2. Claims:
   - `bundleId` is a non-empty string and `trust` is a string;
   - `aud` and `deviceId` match;
   - **network-path freshness** on the 30-day import window;
   - `docs` is an object, each entry is a string;
   - **not both absent**.
3. The inner trust manifest verifies against the pins with the reload profile, which builds the
   effective set.
4. Each inner doc verifies against the effective set, reload profile, bound to the **local**
   device id.
5. The host **replaces** the cache record `{v:3, trustJws, docs, importedBundle}` with no
   ETags, then re-runs the normal load.

Refusals are attributed to the step: `bundle-jws-rejected | bundle-claims-rejected |
bundle-trust-rejected | inner-doc-rejected`. Corpus: 9 `bundleCases`. No token is created.

### 1.13 Error taxonomy

- `PolarisErrorCode` (`shared-protocol/src/core.ts:191-205`):
  - `unauthorized`, `device_limit`, `license_disabled`, `license_expired`;
  - `version_blocked`, `channel_not_allowed`;
  - `rate_limited`, `not_found`, `bad_request`, `forbidden`;
  - `hardware_mismatch`, `fingerprint_required`, `enroll_disabled`, `registration_closed`.
- Body shapes: nested `{"error":{"code":…}}`, used by v3 surfaces (register, the 403 build
  block, service 404), and flat `{"error":"code","message":…}`, used by moved v2 routes. Extra
  fields sit at the top level (`allowedRange`, `limit`, `deviceCount`, `drift`, `changed`). See
  `docs/…/services/core/errors.md`.
- Both spellings must be read. See the Swift `ForbiddenBody` and `HardwareMismatchBody` decoders
  (`PolarisKeyLicense/Endpoints.swift:141-189`) and Node's `activationLike`
  (`sdk-node/src/license/endpoints.ts:33-96`).
- Client-side codes (not wire): `insecure-base-url`, `local-only`, `service-unavailable`,
  `device-management-unsupported`, and the four bundle step codes.
- The verification path never throws; it returns null (fail closed).

### 1.14 Retries, backoff, ETag/304, 401

- **There are no generic retries or backoff in any SDK.** The only automatic re-requests are:
  - **304 half-life escalation:** on a 304, if `effectiveNow > expiresAt − 1800`, refetch
    unconditionally (`sync.ts:195-221`; Swift `CoreContext.swift:893-906`);
  - **exactly one 401 re-acquire** per sync pass (`POST /<p>/license/token` with the current
    token), shared across the two parallel document fetches, then one retry of the failed fetch
    (`sdk-node/src/core/token.ts:66-92`, `sync.ts:222-236`; Swift
    `CoreContext.swift:907-913,950-964`). A hard 401 records `lastSyncUnauthorized` → `revoked`.
- A 200 or 304 clears both unsigned hints (`sync.ts:124-139`).
- **Spec gap in every SDK.** WIRE-CONTRACT-V3 §5 says registered-without-license devices
  "re-register instead". All SDKs wire only `license/token` (`sdk-node/src/client.ts:130-137`;
  Python `client.py:161,409-411`; Swift `PolarisKeyClient.swift:193-207`). A Godot port should
  implement the spec: when the product runs no License, or the device holds no license,
  re-acquire via `POST /devices/register`.
- **Timeouts:** 15 s default per request (`sdk-node/src/core/context.ts:58`). In Godot use
  `HTTPRequest.timeout = 15.0` and also cap the body (`body_size_limit ≈ 512 KiB`).
- **Periodic refresh** is **off by default** (`refreshIntervalSeconds`, `client.ts:359-373`;
  Swift `startRefreshLoop`, `PolarisKeyClient.swift:369-384`).
- **429:** the SDKs surface `rate-limited`/`device-cap` results; there is no `Retry-After` on
  these routes. The device flow returns `429 {"status":"slow_down","interval":2}` and the client
  must honour it (§6).
- **Base URL guard:** only `https:` is allowed, except `http://localhost|127.0.0.1|::1`
  (`context.ts:78-94`; Swift `Endpoints.swift:43-63`).

### 1.15 Discovery and capability negotiation

- `GET /<p>/.well-known/polaris.json` (`worker/src/core/discovery.ts:85-134`) returns:
  `version:2`, `protocolVersion`, `schemaVersion`, `product`, `name`, `baseUrl`,
  `core{registration, compat{min,max}, endpoints{…, register?}}`,
  `trust{jwksUrl, trustManifestUrl, cacheSeconds, pinnedKeys, signingKid, signingPub, keys[]}`,
  and `services{license,config,release,update,identity}` (a disabled service is exactly
  `{enabled:false}`).
- The client parser (`sdk-node/src/discovery.ts:258-291` + parse helpers) enforces:
  - product match;
  - `services` must be an object;
  - `enabled === true` must be a strict boolean;
  - a missing slug counts as disabled.
- Capability precedence (fail-closed, D-21): discovery loaded this session > `expectedServices`
  > default `{license, config}` on and release/update/identity off
  > (`sdk-node/src/core/context.ts:235-246`, `discovery.ts:50-56`).
- **Never pin from discovery's `trust.pinnedKeys`.** That would be trust-on-first-use; pins are
  compiled in.

---

## 2. The HTTP API surface an SDK calls

Every product-scoped call carries the seven headers `X-PKey-Device`, `X-PKey-Version`,
`X-PKey-Channel`, `X-PKey-SDK`, `X-PKey-SDK-Version`, `X-PKey-Platform` and `X-PKey-Arch`
(`shared-protocol/src/core.ts:224-230`; `sdk-node/src/core/context.ts:288-299`). Bearer
credentials are `pkeyt_` device tokens (43 base64url chars after the prefix) or, for activation
only, `pkey_…` license keys. Routes are from `packages/worker/openapi/polaris-key.v3.yaml`.

| Route                                                             | Auth                                                                                                            | Request                                               | Success                                                                                                                                     | Other statuses the client must map                                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<p>/.well-known/polaris.json`                               | none                                                                                                            | —                                                     | discovery JSON (§1.15), `max-age=300`                                                                                                       | 404 unknown product                                                                                                                                                     |
| `GET /<p>/.well-known/polaris-trust.jws`                          | none (`accept: application/jose`)                                                                               | —                                                     | compact JWS                                                                                                                                 | any non-200 → keep old trust                                                                                                                                            |
| `GET /<p>/.well-known/jwks.json`                                  | none                                                                                                            | —                                                     | `{keys:[{kty,crv,use,alg,kid,x}]}`                                                                                                          | _not used by SDKs_ (manifest supersedes)                                                                                                                                |
| `POST /<p>/devices/register`                                      | **none** (keyless); `X-PKey-Device` must match `^[A-Za-z0-9_-]{32}$`                                            | optional `{"fingerprint":{components,hwid}}` (≤4 KiB) | `{token, deviceId}`                                                                                                                         | 403 `registration_closed` (one body for four causes), 429 (10/60 s/IP, fail-closed), 400 malformed id (`worker/src/core/register.ts:73,102-160`)                        |
| `POST /<p>/license/activate`                                      | `Bearer pkey_…`                                                                                                 | optional fingerprint body                             | `{token, schemaVersion, device, license}`                                                                                                   | 401; 403 `device_limit{limit,deviceCount}` or `fingerprint_required`; 409 `hardware_mismatch{drift,changed}`; 429 (30/60 s) (`services/license/activation.ts:46-80`)    |
| `POST /<p>/license/enroll`                                        | none                                                                                                            | **fingerprint required, with `machineUuid` anchor**   | same as activate                                                                                                                            | 404 `enroll_disabled` (route hidden), 403 `fingerprint_required` / `enroll_claimed` / `license_disabled`, 429 policy/hour (`services/license/enroll.ts:139-255`)        |
| `POST /<p>/license/token`                                         | `Bearer pkeyt_` + matching `X-PKey-Device`                                                                      | —                                                     | `{token, schemaVersion}`                                                                                                                    | 401, 429 (30/60 s)                                                                                                                                                      |
| `POST /<p>/license/deauthorize`                                   | `Bearer pkeyt_`                                                                                                 | —                                                     | —                                                                                                                                           | best-effort, errors swallowed                                                                                                                                           |
| `GET /<p>/license/document`                                       | `Bearer pkeyt_`, `If-None-Match`                                                                                | —                                                     | `application/jwt`, `ETag`, `no-store`                                                                                                       | 304; 401; **403 `{"error":{"code":"version_blocked"\|"channel_not_allowed","reason":…},"allowedRange":{…}}`** (`services/license/document.ts:78-160`); 429 → device-cap |
| `GET /<p>/config/document`                                        | `Bearer pkeyt_`, `If-None-Match`                                                                                | —                                                     | JWS + ETag                                                                                                                                  | 304, 401 (no build gate here)                                                                                                                                           |
| `GET /<p>/config/schema`                                          | none                                                                                                            | —                                                     | active catalog JSON (unsigned)                                                                                                              | used only by Swift `ConfigFetch.fetchSchema`                                                                                                                            |
| `GET\|POST /<p>/config/mint/<id>/token`                           | `Bearer pkeyt_` (+ usable license iff License enabled)                                                          | —                                                     | `{token, expiresAt}`                                                                                                                        | 401, 404, 429 (60/60 s), 500 `misconfigured` (**no SDK implements this yet**)                                                                                           |
| `GET /<p>/devices`                                                | `Bearer pkeyt_`                                                                                                 | —                                                     | `{currentDeviceId, devices:[{id,licenseId,label,status,current,firstSeen,lastSeen,userAgent,platform,arch,appVersion,sdkName,sdkVersion}]}` | 401 (flat)                                                                                                                                                              |
| `PATCH /<p>/devices/<id>`                                         | `Bearer pkeyt_` (self only)                                                                                     | `{"label": string\|null}` (≤120 chars)                | `{ok, device}`                                                                                                                              | 403 not-self, 404                                                                                                                                                       |
| `DELETE /<p>/devices/<id>`                                        | `Bearer pkeyt_` (self only)                                                                                     | —                                                     | `{ok:true}`                                                                                                                                 | 403, 404                                                                                                                                                                |
| `POST /<p>/devices/report`                                        | `Bearer pkeyt_`                                                                                                 | snapshot ≤16 KiB; allowlisted keys only (§8)          | `{ok:true}`                                                                                                                                 | 401, 413; best-effort                                                                                                                                                   |
| `POST /<p>/identity/auth/device/start`                            | none                                                                                                            | `{deviceId, deviceName?}` (or `X-PKey-Device`)        | `{status:"pending", deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn:600, interval:2, pollUrl}`                    | 429 (60/60 s)                                                                                                                                                           |
| `POST /<p>/identity/auth/device/poll`                             | none (the device code is the handle)                                                                            | `{deviceCode, deviceId}`                              | `{status:"pending"}` … `{status:"ready", token:"pkeyt_…", schemaVersion}`                                                                   | `429 {status:"slow_down",interval:2}`, `{status:"error"\|"timeout"}`, 401 device mismatch (`services/identity/oidc.ts:1212-1283`)                                       |
| `GET /<p>/update/version[?channel=]`                              | optional bearer (required in `entitled` mode)                                                                   | —                                                     | `{version, tag, url}`                                                                                                                       | 403 not entitled, 404                                                                                                                                                   |
| `GET /<p>/update[/<channel>]/appcast.xml[?arch=arm64\|x86_64]`    | optional bearer                                                                                                 | —                                                     | Sparkle XML                                                                                                                                 | (desktop-updater only)                                                                                                                                                  |
| `GET /<p>/release/changelog`                                      | optional bearer                                                                                                 | —                                                     | `{entries:[{version,tag,date,summary,url}]}`                                                                                                | 403/404                                                                                                                                                                 |
| `GET /<p>/release/dl/<version>/<binary>-<arch>[?checksum=sha256]` | depends on `ReleaseAccess` (`public\|authenticated\|licensed\|entitled`, `shared-protocol/src/release.ts:7-21`) | —                                                     | redirect/stream                                                                                                                             | the asset **must** carry an arch suffix (`arm64\|aarch64\|x86_64\|amd64`, `services/release/routes.ts:23`)                                                              |

Browser-only routes are not usable from a native game: `/identity/session`,
`/identity/session/license`, `/identity/auth/{start,callback,poll,logout}`.
`/identity/auth/poll` only completes for device-bound flows, which only device/start creates
(docs `services/identity/oidc.md`).

**Web (HTML5) exports.** Godot's `HTTPRequest` on Web is `fetch`, which is subject to CORS. The
Worker emits no `Access-Control-*` headers anywhere (`grep -rn access-control
packages/worker/src` finds nothing). Every call here sends `Authorization` and/or `X-PKey-*`,
which forces a preflight, so a cross-origin Web build fails outright. Options:

- (a) Add a per-product origin allowlist to the Worker: OPTIONS handling, `Allow-Headers:
authorization, if-none-match, content-type, x-pkey-*`, `Expose-Headers: etag`, no
  credentials. That is a router/security change, not a wire change. It still touches
  `openapi/…v3.yaml` + `test/routeCoverage.test.ts` (AGENTS.md rule 10) and needs a security
  review because of bearer-token exposure.
- (b) Serve the game from an origin that reverse-proxies `/pkey/*` to `key.plrs.im`. This is
  safe because `iss` is fixed (`shared-protocol/src/core.ts:15`) and never derived from the
  base URL.

itch.io-style hosting can't run a proxy, so it needs (a).

---

## 3. Fingerprint

### 3.1 What the server expects

Server side: `packages/worker/src/fingerprint.ts`. Protocol constants:
`shared-protocol/src/core.ts:105-163`.

- **Components.** Seven, iterated in the canonical order `machineUuid, boardSerial, cpuModel,
primaryMac, bootVolumeUuid, ramBucket, machineModel`. `machineUuid` is the **anchor**.
- **Per-component hash.** `base64url(sha256("pkey-hw:<product>:<component>:<raw>"))[0:22]`,
  salted per product via the slug; the prefix is frozen at `fingerprintVersion 1`.
- **Composite.** `hwid = base64url(sha256(join("\n", ["<c>=<hash>" in canonical order])))[0:32]`.
  The server **discards the client hwid** and recomputes it (`fingerprint.ts:66-93`).
- **Parsing.** Unknown components are dropped; a known one must be a 22-char base64url string or
  the whole fingerprint is rejected.
- **Device id** (not part of the fingerprint): `base64url(sha256("pkey-device:<product>:<raw>"))[0:32]`
  (`sdk-node/src/devices/deviceId.ts:55-60`). The raw value is the OS machine id, with a random
  UUID fallback; it is persisted once in the `device` file.
- **Matching** (`fingerprint.ts:156-179`):
  - drift = stored components now missing or different; newly present ones don't count;
  - tolerance by mode: `off` ∞, `lenient` 4, `normal` 2 (default), `strict` 0;
  - +1 if the anchor matches and the base > 0.
- **Mode resolution:** tier policy → product default → `normal`. Product `enabled:false` means
  `off` (:182-189, 210-214).
- **Binding outcomes** (`core/devices.ts:228-465`):
  - mismatch → the binding is **retired**, and a retry re-binds and consumes a seat;
  - same-hwid siblings on the same license are **coalesced**;
  - no fingerprint on activation in a non-off mode → row marked `unverified`;
  - registration writes no `unverified` row.
- **`strict`** refuses a missing fingerprint with 403 `fingerprint_required` (`core/authz.ts:267`).
- **Enroll** requires a fingerprint _with the anchor_. Its dedupe key is
  `sha256("pkey-hw:enroll:machineUuid=<anchorHash>")[0:32]` (`fingerprint.ts:117-126`,
  `services/license/enroll.ts:192-214`).
- **Corpus.** `fingerprint.json` holds 6 component vectors, including `unicode-model` and
  `reversed-input-order`, plus 4 device-id vectors. Everything is plain SHA-256 + UTF-8, so it
  is fully portable to GDScript (`HashingContext`/`String.sha256_buffer()` +
  `to_utf8_buffer()`).

### 3.2 How each SDK computes components today

| Component      | Node (`devices/fingerprint.ts`, `deviceId.ts`)                                                                                                                                                                   | Python (`devices/fingerprint.py`)                                                                                       | Swift (`PolarisKeyCore/Fingerprint.swift`, `DeviceID.swift`)                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| device-id raw  | macOS `ioreg -rd1 -c IOPlatformExpertDevice` → IOPlatformUUID; Windows `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`; Linux `/etc/machine-id` → `/var/lib/dbus/machine-id` (deviceId.ts:21-51) | same sources                                                                                                            | macOS IOKit IOPlatformUUID; iOS `identifierForVendor` (DeviceID.swift:25-35) |
| machineUuid    | same as device id, but Linux prefers `/sys/class/dmi/id/product_uuid` (fingerprint.ts:160-177)                                                                                                                   | same                                                                                                                    | macOS IOPlatformUUID; iOS identifierForVendor (Fingerprint.swift:95-101)     |
| boardSerial    | macOS ioreg `IOPlatformSerialNumber`; Windows `wmic baseboard get serialnumber /format:csv`; Linux `/sys/class/dmi/id/board_serial` (root-only on most distros)                                                  | same                                                                                                                    | macOS IOKit serial                                                           |
| cpuModel       | `os.cpus()[0].model + ":" + cpus().length` (:69-73)                                                                                                                                                              | darwin `sysctl machdep.cpu.brand_string`; win `PROCESSOR_IDENTIFIER` env (**differs from Node**); linux `/proc/cpuinfo` | macOS sysctl brand + `processorCount`                                        |
| primaryMac     | lowest non-internal non-zero MAC from `os.networkInterfaces()` (:81-92)                                                                                                                                          | `uuid.getnode()` (may differ on multi-NIC)                                                                              | not collected                                                                |
| bootVolumeUuid | macOS `diskutil info -plist /`; Windows `cmd /c vol C:`; Linux `findmnt -no UUID /`                                                                                                                              | same                                                                                                                    | macOS URL resourceValues `volumeUUIDString`                                  |
| ramBucket      | `2^floor(log2(totalGiB))` (no `<1` guard)                                                                                                                                                                        | same, returns None if <1 GiB                                                                                            | same, None if <1 GiB                                                         |
| machineModel   | macOS `sysctl -n hw.model`; Windows `wmic computersystem get model`; Linux `/sys/class/dmi/id/product_name`                                                                                                      | same                                                                                                                    | macOS `hw.model`, iOS `hw.machine`                                           |

Cross-SDK raw values already disagree (Windows `cpuModel`, `primaryMac`). Hashes are per product
and binding is per device id, so only intra-SDK stability matters in practice. `wmic` is
deprecated and absent on current Windows 11 installs, so the Node/Python `boardSerial` and
`machineModel` reads silently degrade there.

### 3.3 What GDScript can obtain, per platform

`OS.get_unique_id()` per platform, from upstream source/docs:

- **Windows:** the _hardware-profile GUID_ from `GetCurrentHwProfileA` (`os_windows.cpp`). This
  is **not** `MachineGuid`.
- **macOS:** the **platform serial number** (`kIOPlatformSerialNumberKey`, `os_macos.mm`). That
  corresponds to `boardSerial`, not `machineUuid`.
- **Linux:** `/etc/machine-id`.
- **iOS:** `identifierForVendor`.
- **Android:** `Settings.Secure.ANDROID_ID`, scoped per signing key and user on Android 8+.
- **Web:** an empty string, with an error logged.

The same caveat applies to `get_model_name` and `get_processor_name`, which also vary by
platform.

| Component                | Windows                                                                                                                                                           | macOS                                                                                                                                                       | Linux                                                                                                          | iOS                                                                                                                 | Android                                                           | Web                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| **machineUuid (anchor)** | `OS.execute("reg",["query","HKLM\\SOFTWARE\\Microsoft\\Cryptography","/v","MachineGuid"])` (matches Node/Python); fallback `OS.get_unique_id()` (HW-profile GUID) | `OS.execute("ioreg",["-rd1","-c","IOPlatformExpertDevice"])` → IOPlatformUUID (a Mac App Store sandbox may block exec; then there is no pure-GDScript path) | `FileAccess` read `/sys/class/dmi/id/product_uuid` (usually root-only) → `/etc/machine-id` (= `get_unique_id`) | `OS.get_unique_id()` = identifierForVendor (same as Swift; resets when the last app from the vendor is uninstalled) | `OS.get_unique_id()` = ANDROID_ID (stable per signing key + user) | **impossible**            |
| boardSerial              | PowerShell `Get-CimInstance Win32_BaseBoard` via `OS.execute` (wmic is gone)                                                                                      | `OS.get_unique_id()` (serial) or ioreg                                                                                                                      | `/sys/class/dmi/id/board_serial` (root-only)                                                                   | no                                                                                                                  | no                                                                | no                        |
| cpuModel                 | `OS.get_processor_name() + ":" + str(OS.get_processor_count())` (registry `ProcessorNameString`)                                                                  | same (sysctl brand; strip any trailing NUL)                                                                                                                 | same (`/proc/cpuinfo` model name)                                                                              | `get_processor_name` implemented                                                                                    | **empty**                                                         | **empty**                 |
| primaryMac               | `OS.execute("getmac",["/fo","csv","/nh"])` (`IP.get_local_interfaces()` has no MACs)                                                                              | `OS.execute("ifconfig")`                                                                                                                                    | read `/sys/class/net/*/address`                                                                                | OS returns a fixed dummy, so omit                                                                                   | fixed dummy, omit                                                 | no                        |
| bootVolumeUuid           | `OS.execute("cmd",["/c","vol","C:"])`                                                                                                                             | `OS.execute("diskutil",["info","-plist","/"])`                                                                                                              | `OS.execute("findmnt",["-no","UUID","/"])`                                                                     | no                                                                                                                  | no                                                                | no                        |
| ramBucket                | `OS.get_memory_info()["physical"]`                                                                                                                                | same                                                                                                                                                        | same                                                                                                           | same                                                                                                                | same                                                              | often `-1`/unknown → omit |
| machineModel             | `OS.get_model_name()` (SystemProductName/BaseBoardProduct)                                                                                                        | `OS.get_model_name()` (`hw.model`)                                                                                                                          | read `/sys/class/dmi/id/product_name` (Godot returns `GenericDevice`)                                          | `OS.get_model_name()` (e.g. `iPhone15,2`)                                                                           | `OS.get_model_name()` (Build.MODEL)                               | `GenericDevice` → omit    |

`OS.execute` is blocking and desktop-only. Run it once at first launch (on a `WorkerThreadPool`
task) and memoize.

**Device id in Godot.** Use the same `pkey-device:<slug>:<raw>` formula. Raw sources:
MachineGuid (Windows), IOPlatformUUID (macOS), machine-id (Linux), identifierForVendor (iOS),
ANDROID_ID (Android). On Web, or on failure, use a `Crypto.generate_random_bytes(16)` UUID.
Persist it immediately, and **surface a write failure**: Swift's R4-12 lesson is that a silent
failure mints a new id each launch, which burns a seat each time.

### 3.4 Consequences per registration policy × fingerprint mode

| Policy (`devices.registration`, §6)                                                                                               | Desktop                                                                                                                                            | iOS / Android                                                                                                  | Web                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `open` → `POST /devices/register` (fingerprint optional, no `unverified` row)                                                     | fine                                                                                                                                               | fine                                                                                                           | fine, if CORS/proxy; 10/min/IP can bite behind shared NAT                                       |
| `requires-identity` → register only with a **browser session cookie** (`services/identity/browserSession.ts`, docs `sessions.md`) | **no native path.** The cookie lives in the system browser, not the game. Use the device-code flow (§6), which mints a license-bound token instead | same                                                                                                           | only if same-origin with the Worker                                                             |
| `requires-license` → only `license/activate`, `license/enroll`, device-flow `ready`                                               | activate works in all modes; enroll needs the anchor (OK)                                                                                          | activate OK; enroll OK (Android stable; iOS re-enroll after vendor-app uninstall mints a **new free license**) | activate OK in non-strict modes; **enroll impossible** (no anchor → 403 `fingerprint_required`) |

| Mode                 | Effect on a Godot client                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`                | nothing enforced and no seat coalescing. A Web user who clears storage gets a new device id and a new seat.                                                                                                                                                                                                                                                             |
| `lenient` / `normal` | a missing fingerprint is accepted (recorded `unverified`). Partial fingerprints are fine. Drift only counts previously stored components, so a stable subset set (mobile: anchor + model + RAM) works.                                                                                                                                                                  |
| `strict`             | the fingerprint is mandatory, with tolerance 0 on every stored component. Web can only send forgeable, unstable junk, so **don't put Web players on strict tiers**. Also note **device-flow sign-in never sends a fingerprint** (`oidc.ts` `authorizeAndMint` calls `authorizeDevice` with no fingerprint), so strict tiers fail via device flow. That is a server gap. |

---

## 4. Secrets

- **Delivery modes.** `SecretDelivery = serverOnly | clientScoped | edgeMint`
  (`shared-protocol/src/config.ts:20`; docs `services/config/catalog.md` "`delivery`: how a
  secret reaches a runtime").
  - `clientScoped` (the default): the value rides in the **config document's `secrets` map**,
    plaintext inside the signed JWS (base64url JSON).
  - `serverOnly`: pruned from every device-facing document and bundle; never delivered.
  - `edgeMint`: the value is never delivered. The client calls
    `/<p>/config/mint/<id>/token` with its device token and gets a short-lived
    `{token, expiresAt}` minted by the Worker (ES256/RS256/EdDSA, docs `edge-mint.md`).
- **Where SDKs actually store secrets.** The docs say "decrypted client-side into the OS keyring"
  (`catalog.md`) and "Store secret-kind values in the OS keyring" (`services/config/index.md`,
  "How a client uses it"). **No SDK does this.** All four keep only the `pkeyt_` token in the
  keyring. The config JWS, secrets included, lives in the 0600 `managed.json` cache:
  - Node `getSecret` reads the in-memory doc (`sdk-node/src/config/client.ts:95-98`) and
    `FileStore.writeCache` writes it to 0600 `managed.json` (`core/store.ts:102,132`);
  - Swift's comment explicitly calls `managed.json` "the one that first contains a config
    document's secrets" (`Store.swift` writeSecure docs);
  - Python mirrors both.

  This is a docs-vs-code divergence worth fixing whichever way the maintainers choose.

- **No SDK implements the edge-mint client call.** A Godot SDK would be first.
- **Browser sessions** always get `secrets: {}` (docs `sessions.md`).
- **Can a product not use secrets?** Yes. The catalog declares none, so `secrets` is `{}`
  (still required to be an object, `verify.ts:92`).
- **Is there a delivery mode that avoids client storage?** Yes: **`edgeMint`**. Nothing
  long-lived is stored. The minted token can be held in memory until `expiresAt`, and a
  confused-deputy guard requires a usable license when License is enabled.
- **Godot recommendation.** Treat `clientScoped` secrets as **not secret** in a game. Anything in
  the cache or the PCK is extractable, and on Web any same-origin script can read IndexedDB.
  Recommend `edgeMint` (or server-side use) for third-party API keys, and implement
  `config.mint_token(recipe_id)`. If clientScoped secrets must be supported, see §12.

---

## 5. Conformance: how a sixth language joins the corpus

### 5.1 What's in the corpus

One generator, `tools/sign-corpus.ts` (2381 lines), with two committed test keys
(`djdl-test-2026`, `pkey-test-prod-2026`) and fixed clocks, writes:

- `conformance/corpus/v2/cases.json` (1.46 MB, mostly the cap vectors):
  - `corpusVersion: 2`
  - `keys`
  - 36 `jwsCases`: `{id, description, jws, trust, typ, maxPayloadBytes?, expect{verify, kid?, doc?}}`
  - 16 `licenseDocCases` and 18 `configDocCases`: `{jws, trust, typ, expectedAud, expectedIss, deviceId, now, lastAcceptedIssuedAt?, checkFreshness?, expect{accept}}`
  - 11 `trustCases`: `{pinned, before, manifestJws, now, checkFreshness?, expect{accepted, trust, issuedAt?}}`
  - 7 `clockFloorCases`: `{pinned, trustJws?, licenseJws?, configJws?, expectedAud, deviceId, systemClock, expect{highWaterMark, effectiveNow, status}}`
  - 9 `bundleCases`: `{bundleJws, pinned, expectedAud, deviceId, now, maxPayloadBytes, expect{imports, docs|reason}}`
    (`sign-corpus.ts:1619-1630`)
- `gate-matrix.json`: `gateMatrixVersion: 2`, 21 rows, each
  `{name, gate{version, channel?, compatMin, compatMax, entitlements}, license{licenseServiceEnabled, activation, now, issuedAt?, expiresAt?, graceUntil?, lastSyncUnauthorized?, lastVerifiedAt?}, expect{status, ok, reason?, allowedRange?}}`
  (:2034-2120).
- `fingerprint.json`: `{fingerprintVersion:1, componentOrder, componentHashLength:22,
hwidLength:32, deviceIds[{id, product, raw, expected}], vectors[{id, description, product, raw,
components, hwid}]}` (:2207-2310).
- The same three files are mirrored into `sdks/swift/Tests/PolarisKeyTests/Resources/v2/`
  (:34-46, 2356-2376) because SwiftPM test bundles can't reach up the tree.

### 5.2 How each language consumes it

- **Node:** `conformance/runners/node/corpusV2.test.ts` (reads `../../corpus/v2`, :168-175) and
  `fingerprint.test.ts`, both driving `client-core`.
- **Python:** `sdks/python/tests/test_conformance.py` locates the corpus by relative path
  (`parents[3]/conformance/corpus/v2`, :43-44), plus `test_fingerprint_conformance.py`.
- **Swift:** `Tests/PolarisKeyTests/ConformanceTests.swift`, `GateMatrixTests.swift` and
  `FingerprintConformanceTests.swift` read the mirrored `Resources/v2`.
- **React:** `packages/sdk-react/test/gateMatrixParity.test.ts` (gate projection only).
- **Worker:** `packages/worker/test/fingerprintCorpus.test.ts`.

**CI** (`.github/workflows/ci.yml`):

- `js` job: build, typecheck, test (which includes the Node runner), lint, `gen:corpus -- --check`.
- `python` job: ubuntu + macOS-14, `pytest`.
- `swift` job: macOS-15, `swift test`.
- There is no mirror gate for gen-mirrors.

### 5.3 A headless Godot runner

Layout proposal: `sdks/godot/` is a Godot project whose addon lives at `addons/polaris_key/`,
with tests in `tests/`.

```gdscript
# sdks/godot/tests/run_conformance.gd   —  godot --headless --path sdks/godot -s res://tests/run_conformance.gd
extends SceneTree

const CORPUS := "../../conformance/corpus/v2/"   # desktop FileAccess reads absolute/relative OS paths
var failures := 0

func _init() -> void:
    var root := ProjectSettings.globalize_path("res://").path_join(CORPUS)
    var cases: Dictionary = _load(root + "cases.json")
    var matrix: Dictionary = _load(root + "gate-matrix.json")
    var fp: Dictionary = _load(root + "fingerprint.json")
    assert(int(cases.corpusVersion) == 2)
    for c in cases.jwsCases:
        var r := PKeyJws.verify(c.jws, c.trust, {"typ": c.typ, "maxPayloadBytes": c.get("maxPayloadBytes")})
        _check(c.id, (r != null) == (c.expect.verify == "ok"))
        if r != null and c.expect.has("doc"): _check(c.id + ":doc", r.payload == c.expect.doc and r.kid == c.expect.kid)
    for c in cases.licenseDocCases: _check(c.id, (PKeyVerify.license_doc(c.jws, _opts(c)) != null) == c.expect.accept)
    for c in cases.configDocCases:  _check(c.id, (PKeyVerify.config_doc(c.jws, _opts(c)) != null) == c.expect.accept)
    # trustCases → PKeyTrust.verify_manifest + merge; clockFloorCases → reload path + PKeyGate.license_state
    # bundleCases → PKeyBundle.inspect (assert reason string); gate-matrix → port runner's checkBuildGate + license_state
    # fingerprint.json → PKeyFingerprint.hash_components / PKeyDeviceId.from_raw
    print("failures: ", failures)
    quit(1 if failures > 0 else 0)
```

Notes:

- Dictionary `==` compares contents. Both sides come from the same Godot JSON parser (floats),
  so `expect.doc` equality holds, including the 2^53-1 vector.
- If the SDK uses `class_name` globals, CI must first run an import pass to build
  `.godot/global_script_class_cache.cfg` (`godot --headless --path sdks/godot --import` on 4.3+,
  or `--editor --quit` on older 4.x). Otherwise use `preload()`.
- Crypto time. There are about 150 Ed25519 verifications in total (bundle cases do 3–4 each, and
  the two 256 KiB cap vectors need SHA-512 over ~350 KB). A pure-GDScript backend should finish
  in 1–3 minutes on a CI runner (unmeasured estimate). If the GDExtension backend is used, CI
  also needs a Linux x86_64 binary.
- **No Swift-style mirror is needed**, because a desktop Godot run can read
  `../../conformance/…`. Add a mirror only if the addon must ship its own self-contained tests
  (e.g. to the Asset Library). That would mean a `GODOT_V2_RESOURCES` reconcile block in
  `sign-corpus.ts`, guarded by `--check` exactly like Swift's.
- A Web-backend check (JavaScriptBridge + WebCrypto) would need a Web export driven by headless
  Chromium (Playwright). That is an optional nightly job.

**CI job to add** (`.github/workflows/ci.yml`):

```yaml
godot:
  name: Godot SDK (headless conformance)
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Install Godot 4.x (headless-capable Linux build)
      run: |
        curl -fsSLo godot.zip https://github.com/godotengine/godot/releases/download/4.4.1-stable/Godot_v4.4.1-stable_linux.x86_64.zip
        unzip -q godot.zip && sudo mv Godot_v4.4.1-stable_linux.x86_64 /usr/local/bin/godot
    - run: godot --headless --path sdks/godot --import || true # build class cache
    - run: godot --headless --path sdks/godot -s res://tests/run_conformance.gd
    - run: godot --headless --path sdks/godot -s res://tests/run_unit.gd
```

Optionally add a Windows/macOS matrix leg to smoke-test the platform readers (`OS.execute`
parsing). Also add a `release-godot.yml` that zips `addons/polaris_key` for the Asset Library
(the pattern of `release-python.yml` and `release-swift.yml`).

### 5.4 Every place the repo enumerates the language set

The "four SDKs / five languages" count must become five SDKs / six languages. Language-count
mentions only; the many "all five" that refer to the five _services_ are unaffected. Found with a
grep for five-language / four SDKs / four runners / Node, Python, Swift:

- **Canonical / agent docs:**
  - `AGENTS.md:8-9` (repo description; also add `sdks/godot/` to the repo map at `:15-37`), `:118`
    ("all five implementations pass"), and the green-gate block (add the godot command);
  - `CLAUDE.md` (inherits);
  - `CONTRIBUTING.md:3-4,65,81,84`;
  - `README.md:4,58`.
- **Wire contract:** `docs/security/WIRE-CONTRACT-V3.md:5` (Scope: "the four client SDKs (Node,
  React, Python, Swift)").
- **Docs site:**
  - `packages/docs/src/content/docs/index.mdx:3`;
  - `start/index.md:9,99,101-103`;
  - `start/concepts.md:10`;
  - `build/index.md:16,26`;
  - `build/sdks/index.md:3` and the surfaces table + `## In this section` (add a
    `build/sdks/godot.mdx` page);
  - `build/wire/index.md:78`;
  - `build/wire/corpus.md:3,9,67-84` (the "Four runners" table), `:131,146`;
  - `contribute/index.md:8-9,28-29`;
  - `contribute/corpus.md:3,11,31`;
  - `contribute/waves.md:3,29,35` (the "five languages" walkthrough needs a Godot step);
  - `contribute/setup.md:79`;
  - `agents/index.md:57-58`;
  - `admin/bundles.md:11`.
- **Code comments:**
  - `packages/client-core/src/claims.ts:2`, `bundle.ts:24,68`;
  - `packages/sdk-node/src/devices/deviceId.ts:54`;
  - `sdks/python/src/polaris_key/core/jws.py:13,108`, `core/bundle.py:16,65`,
    `core/models.py:193`, `devices/deviceid.py:86`, `_version.py:20`;
  - `sdks/swift/Sources/PolarisKeyCore/Bundle.swift:24,62`, `Trust.swift:3`, `DeviceID.swift:24`;
  - `tools/sign-corpus.ts:2,2119`.
- **Code that emits per-SDK artifacts:**
  - `packages/cli/src/manifest.ts:161-178` (`pkey trust` prints JSON/Node/Python/Swift snippets;
    add GDScript `const PINNED_KEYS := {…}`) and `packages/cli/README.md:104`;
  - `packages/admin/src/views/ProductOverview.tsx:498` (Node-only quick-start snippet; optional
    Godot tab);
  - `tools/gen-mirrors.ts:248-258` (`Lang = "ts"|"python"|"swift"` plus the FILENAME/RENDER
    maps; add a `gdscript` renderer emitting `catalog_generated.gd` so settings UIs can compile
    in catalog labels/defaults, see §11).
- **Scripts/CI:**
  - root `package.json:12` (`test:all`, add a godot run);
  - `.github/workflows/ci.yml` (new job);
  - a new `release-godot.yml`.
- **Generated docs:** `packages/docs/src/content/docs/reference/corpus.mdx` mentions only the
  Swift mirror (regenerate if a Godot mirror is added).
- `SDK_NAME` values are free-form (`@polaris-key/node`, `polaris-key-python`,
  `PolarisKeySwift`, `@polaris-key/react`). The Worker has no allowlist
  (`core/devices.ts:671-686`), so use `polaris-key-godot`.

---

## 6. Identity for games

**What exists server-side** (`services/identity/oidc.ts`; docs `device-flow.md`, `oidc.md`,
`sessions.md`):

- **Browser PKCE** (`/identity/auth/start` → IdP → `/identity/auth/callback`). The redirect URI
  is **always** `…/<p>/identity/auth/callback` on the Worker origin (`oidc.ts:676`), not an app
  deep link or loopback. With `return_to` it sets a cookie; without it, it shows "You're signed
  in, return to the app". `/auth/poll` only completes for flows bound to a device id, and only
  `device/start` creates those (`oidc.ts:1143-1182`). **There is no native loopback or
  deep-link variant, so neither is needed or usable.**
- **Device-code flow**: "loosely" RFC 8628.
  - `POST /identity/auth/device/start {deviceId, deviceName}` returns
    `{deviceCode, userCode, verificationUri(Complete), expiresIn:600, interval:2}`
    (`oidc.ts:729-785`).
  - **Difference from RFC 8628:** `userCode` is display-only (the first 8 chars of the device
    code, uppercased and hyphenated). `verificationUri` already embeds the full device code, and
    **there is no page where a user types a short code**. So a short code alone cannot be read
    out to a phone; the full URL must be conveyed (a QR code is ideal).
  - The human opens the URL. `GET` renders a confirm page; `POST` (CSRF + Origin checked) stamps
    `confirmedAt` and 303s to the IdP. After the callback, `activateFromIdentity` mints or locates
    a **license** for the OIDC subject. It is idempotent on `sub` and can **claim** or
    **migrate** an anonymous enrolled license the device already holds.
  - `POST /identity/auth/device/poll {deviceCode, deviceId}` requires a matching device id and
    enforces the 2 s interval (`429 slow_down`). It ends in `{status:"ready", token:"pkeyt_…"}`
    exactly once, or `error`/`timeout`.

**Which SDKs implement it:** none natively.

- React's desktop adapter delegates to a host bridge's `beginSignIn`/`pollSignIn`
  (`sdk-react/src/desktop/bridge.ts:66-111`).
- React's browser adapter does a full-page redirect to `/identity/auth/start?return_to=`
  (`browserAdapter.ts:386`).
- Swift's `PolarisLoginView` takes an `onSignIn` closure the host implements
  (`PolarisKeyUI/PolarisLoginView.swift:106-113`).

**The right default for a Godot game**, on every platform, is the device-code flow:

| Platform                          | UX                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows/macOS/Linux               | Show the code + QR in-game, a "Open browser" button (`OS.shell_open(verificationUriComplete)`) and "Copy link" (`DisplayServer.clipboard_set`). Auto-poll every `interval` seconds, backing off on `slow_down`.                                                                                                                                                                                                                       |
| Steam Deck game mode / couch / TV | **QR first.** There is no desktop browser in game mode, so the user scans with a phone.                                                                                                                                                                                                                                                                                                                                               |
| iOS/Android                       | `OS.shell_open` to the system browser (the user returns to the app manually; polling completes). Offer the QR "sign in on another device" as secondary. No deep link/custom scheme is needed because the token arrives via poll. (Store rules: using an external browser for account sign-in is fine. _Unlocking paid digital content_ via externally bought license keys is not, under Apple 3.1.1 / Google Play Payments; see §13.) |
| Web                               | Same flow (needs CORS/proxy). `OS.shell_open` goes through `window.open`, which popup blockers may eat unless it runs inside the input-event gesture, so always render the link/QR as well. The cookie/session path (`/identity/session`) is only viable if the game is served from the Worker origin.                                                                                                                                |

Implementation notes:

- The poll `deviceId` must be the SDK's `X-PKey-Device` value.
- `deviceName` can be `OS.get_model_name()` or a player-editable label; it is truncated at 120.
- After `ready`, store the token and run `sync(force=true)`.
- `strict`-tier fingerprints are not sent on this path (server gap, §3.4).
- Godot has no built-in QR encoder. Use a GDScript QR asset (several exist on the Asset
  Library), or render the URL as text.

---

## 7. Size, complexity, and the hardest problem

### 7.1 The hardest problem: Ed25519 (plus SHA-512) in Godot

**Confirmed gaps:**

- `Crypto` documents RSA only (`generate_rsa`, `sign`/`verify` with RSA `CryptoKey`s;
  docs.godotengine.org `class_crypto`). mbedTLS doesn't do EdDSA.
- `HashingContext` supports only **MD5, SHA-1 and SHA-256**. RFC 8032 verification computes
  `SHA-512(R ‖ A ‖ M)`, so a pure implementation also needs **SHA-512**.
- **What the SDKs rely on:** WebCrypto (Node/React, `shared-jws/src/index.ts:259-273,359`),
  CryptoKit (`JWSVerifier.swift:147-156`), and `cryptography`/OpenSSL (`jws.py:51-54,218`).

**Is any alternative algorithm accepted on the wire? No.**

- JWS `alg` must be `EdDSA` (`shared-jws/src/index.ts:334`).
- Trust-manifest entries that aren't `EdDSA/OKP/Ed25519` are **skipped** (`trust.ts:111-112`).
  That is a forward-compat hook for _key lists_, not a way to verify a document under another
  algorithm.
- Edge-mint signs ES256/RS256/EdDSA third-party tokens, but the SDK passes those on without
  verifying them.
- OIDC ID tokens (RS256/ES256/EdDSA) are verified server-side only.

**Does the wire need to change? No, and it shouldn't.** Accommodating Godot natively would mean,
for example, dual-signing RS256 so `Crypto.verify` works. That requires a new alg, multi-signature
artifacts (compact JWS carries one signature), `PROTOCOL_VERSION=4`, corpus regeneration and all
SDKs following. That is exactly the "all-languages event" `AGENTS.md` rule 2 warns about, to
save what is a solvable client-side problem.

**Options without a wire change:**

| Backend                                                                                                                        | How                                                                                                                                                                                                                                           | Pros                                                                                                                  | Cons                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Pure GDScript** (port TweetNaCl `crypto_sign_open` or ref10 + SHA-512)                                                    | GDScript 64-bit `int` for 16-bit-limb field arithmetic (TweetNaCl's `gf` fits int64 without overflow). SHA-512 needs care: GDScript `>>` is arithmetic, so mask for logical shifts; mod-2^64 adds rely on wraparound, or use 2×32-bit halves. | Runs on **every** target, including Web without special templates. Deterministic. Easy to put under the corpus in CI. | **Slow.** Rough estimate: ~9–10k field multiplications per verify ≈ 3–4M basic ops, so ~0.2–1 s per verify on desktop and 1–3 s on mid mobile (**unmeasured; benchmark first**). Must run on `WorkerThreadPool` (native) or be chunked across frames (Web, no threads). TweetNaCl **omits the `S < L` check**; add it, plus canonical point decoding, to match OpenSSL/CryptoKit/WebCrypto malleability behaviour. ~600–900 lines + ~150 for SHA-512. |
| **B. GDExtension** (e.g. MIT `gd-ed25519`, Monocypher-backed, `Ed25519.verify(sig, msg, pubkey)`; or libsodium)                | Native lib per platform/arch: Win x64/arm64, macOS universal, Linux x64/arm64, Android arm64/armv7/x86_64, iOS static xcframework, Web wasm.                                                                                                  | Fast (µs). SHA-512 included.                                                                                          | Binary build/sign/notarize matrix. **Web requires the "Extensions Support" export template**, which is bigger and version-coupled. Supply-chain review needed. Monocypher's edge-case policy must be checked against the corpus (and Wycheproof).                                                                                                                                                                                                     |
| **C. Web: `JavaScriptBridge` → WebCrypto** `crypto.subtle.importKey("raw", k, {name:"Ed25519"}, false, ["verify"])` + `verify` | Async; bridge the Promise with `JavaScriptBridge.create_callback` → a signal the GDScript `await`s.                                                                                                                                           | Native speed. Same primitive family as the TS reference. Chrome 137+, Firefox 129+, Safari 17+.                       | Async API forces async verify throughout. Older browsers need a fallback (A, or a bundled `@noble/ed25519` in the HTML shell).                                                                                                                                                                                                                                                                                                                        |

**Recommendation.** A `PKeyEd25519` facade picks B if `ClassDB.class_exists("Ed25519")`, else C
on `OS.has_feature("web")` when WebCrypto Ed25519 is present, else A. A stays the CI-tested
reference. Keep an **in-memory** memo `(jws, keyBytes) → payload` per session to avoid
re-verifying (e.g. bundle import followed by reload). **Never persist a "verified" marker**:
§4.1 forbids derived state on disk.

**Corpus hardening to do alongside.** The corpus pins no signature-malleability cases (non-canonical
`S ≥ L`, non-canonical `A`/`R`, small-order points). Per `build/wire/corpus.md` ("an observed
divergence gets a corpus case before a fix"), add `jwsCases` such as `sig-s-not-canonical`
(valid sig with `S+L`). Every backend (WebCrypto, CryptoKit, OpenSSL, Monocypher, the GDScript
port) must then agree.

### 7.2 Per-module estimates (GDScript, code lines excluding comments)

| Module                                                                                                                                              |                    LOC | Difficulty | Notes                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------: | ---------- | ----------------------------------------------------------------------------------- |
| base64url strict + caps                                                                                                                             |                     60 | low        |                                                                                     |
| Strict JSON helpers (dup-key scan, typed getters, float-aware ints; optional strict validator)                                                      |                120–450 | low–med    | Full custom parser only if you want exact JS parity on control chars and surrogates |
| **Ed25519 + SHA-512 (pure)**                                                                                                                        |               750–1050 | **high**   | + threading/chunking; + backends B/C (~150 GDScript + ~40 JS)                       |
| JWS verify (13 steps)                                                                                                                               |                    120 | low        |                                                                                     |
| Claim validation (license/config/envelope)                                                                                                          |                    100 | low        |                                                                                     |
| Trust manifest + merge                                                                                                                              |                     80 | low        |                                                                                     |
| Clock floor                                                                                                                                         |                     20 | trivial    |                                                                                     |
| Gate + semver + channel (+ runner's build-gate port)                                                                                                |                    150 | low        |                                                                                     |
| Bundle inspect + import                                                                                                                             |                    140 | low–med    |                                                                                     |
| Config resolution (+ env/cmdline layer)                                                                                                             |                    120 | low        |                                                                                     |
| Cache manager + store backends (file/encrypted/secure-plugin)                                                                                       |                    300 | med        | atomic write via temp + `DirAccess.rename_absolute`                                 |
| Transport (HTTPRequest pool, headers, timeouts, header parsing, status ladder, https guard)                                                         |                    250 | med        | Web/CORS realities                                                                  |
| Sync loop (parallel docs, single write, 304 half-life, shared single re-acquire via signal)                                                         |                    250 | med        | no promises in GDScript, so signal-based join                                       |
| Token manager + reacquire (license/token or re-register)                                                                                            |                     80 | low        |                                                                                     |
| License client + endpoints (both error-body shapes)                                                                                                 |                    250 | low–med    |                                                                                     |
| Config client + schema fetch + **edge-mint**                                                                                                        |                    180 | low        |                                                                                     |
| Devices client (register/list/rename/deauthorize/report) + facts + probes                                                                           |                    280 | low–med    |                                                                                     |
| Fingerprint + device id (per-OS readers, `OS.execute` parsing, memoization)                                                                         |                    350 | med        | per-platform testing                                                                |
| Discovery                                                                                                                                           |                    150 | low        |                                                                                     |
| Release + Update                                                                                                                                    |                    150 | low        |                                                                                     |
| Identity device flow                                                                                                                                |                    200 | med        | UX + polling                                                                        |
| Facade/autoload, options Resource, signals, local-only, refresh timer, app-lifecycle hooks                                                          |                    300 | med        |                                                                                     |
| **Core + services subtotal**                                                                                                                        |       **~4,000–4,900** |            |                                                                                     |
| UI scenes (gate, activation, sign-in code+QR, device list, managed settings panel, update prompt, status banner, bundle import/request code, theme) | ~1,500–2,000 + `.tscn` | med        | QR encoder via asset (+400 if vendored)                                             |
| Tests (corpus runner ~500, transport mocks, sync/store/UI smoke)                                                                                    |                 ~2,000 | med        |                                                                                     |

Swift, for comparison: ~5.6k lines of Swift sources (heavily commented) for the same scope minus
identity and edge-mint.

---

## 8. Device facts reporting and Godot equivalents

- **Report path.** `POST /<p>/devices/report` carries
  `{...DeviceFacts, config:{k:v}, entitlements:{k:v}}` (values only, taken from
  **re-verified** docs). It is best-effort, and skipped only after a hard 401 with nothing
  applied (`sdk-node/src/core/telemetry.ts:29-74`, `sync.ts:164`).
- **`DeviceFacts`** (`shared-protocol/src/core.ts:173-185`): `os{name, version?, build?,
kernel?}`, `hardware{cpuModel?, cpuCores?, ramMb?, machineModel?}`, `runtime{name, version}`,
  `locale?`, `timezone?`, `probes?{id:{present, version?}}` (max 32 probes).
- **Server allowlist** (`packages/worker/src/core/devices.ts:859-875`): `os, hardware, runtime,
locale, timezone, probes, sdk, sdkVersion, appVersion, platform, arch, gate, config,
entitlements, timestamp`. **Anything else is silently dropped.** Strings are truncated to 128
  (facts row) / 64 (probe ids), and the body is capped at 16 KiB (:877-1001).
- **Probes** are product-declared companion-app path checks (macOS/Windows/Linux keys), passed
  by the host (`sdk-node/src/devices/facts.ts:20-88`). There is no app enumeration (rule 7).

| Fact                                                        | Node                                   | Swift                    | Proposed Godot                                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os.name`                                                   | `os.platform()` (`darwin/win32/linux`) | `darwin/ios`             | map `OS.get_name()`: Windows→`win32`, macOS→`darwin`, Linux/\*BSD→`linux`, iOS→`ios`, Android→`android`, Web→`web` (same value as `X-PKey-Platform`)                                                |
| `os.version`                                                | `os.release()`                         | `major.minor.patch`      | `OS.get_version()` (empty on Web)                                                                                                                                                                   |
| `os.build`                                                  | `sw_vers -buildVersion` (mac)          | `kern.osversion`         | Linux: `OS.get_distribution_name()`; Web: the host OS from the `web_android/web_ios/web_windows/web_macos/web_linuxbsd` feature tags                                                                |
| `os.kernel`                                                 | `os.type()`                            | `kern.ostype`            | `OS.get_name()` verbatim                                                                                                                                                                            |
| `hardware.cpuModel` / `cpuCores` / `ramMb` / `machineModel` | `cpus()`, `totalmem()`, `arch()` (sic) | sysctl                   | `OS.get_processor_name()`, `OS.get_processor_count()`, `OS.get_memory_info().physical/1048576`, `OS.get_model_name()`                                                                               |
| `runtime`                                                   | `{node, process.versions.node}`        | `{swift, "6"}`           | `{name:"godot", version: Engine.get_version_info().string}`                                                                                                                                         |
| `locale`                                                    | Intl                                   | `Locale.current`         | `OS.get_locale()`                                                                                                                                                                                   |
| `timezone`                                                  | IANA via Intl                          | IANA                     | `Time.get_time_zone_from_system().name` is an **abbreviation, not IANA**. On Web use `JavaScriptBridge.eval("Intl.DateTimeFormat().resolvedOptions().timeZone")`; elsewhere send the offset or omit |
| `probes`                                                    | `accessSync(path)`                     | `FileManager.fileExists` | `FileAccess.file_exists`/`DirAccess.dir_exists_absolute` on desktop (non-sandboxed); omit on mobile/Web                                                                                             |
| headers `X-PKey-Arch`                                       | `x64/arm64`                            | `arm64/x86_64`           | `Engine.get_architecture_name()` (`x86_64`, `arm64`, `arm32`, `x86_32`, `wasm32`, …). Note Node/Python/Swift already disagree (`x64` vs `x86_64` vs `AMD64`)                                        |

**Godot-specific facts worth reporting.** These are engine-level details that help a game
operator:

- renderer: `RenderingServer.get_video_adapter_name()`/`_vendor()`/`_api_version()`, plus the
  rendering method from `ProjectSettings "rendering/renderer/rendering_method"`;
- display: `DisplayServer.get_name()`, screen size/scale/refresh;
- `OS.is_debug_build()`;
- **distribution channel / surface**: custom export feature tags such as `steam`, `itch`,
  `gplay`, `appstore`, `demo`, `beta`, checked via `OS.has_feature()`;
- export platform;
- Steam Deck detection (env `SteamDeck=1`).

**None fits the allowlist.** Recommended: add one key, e.g. `engine`, to `REPORT_KEYS` with a
bounded object. That is a Worker change plus a `licensingReport` test plus an OpenAPI example. It
is not a wire-contract change: the report is unsigned telemetry, and the whole bounded report is
persisted in `devices.reported_json`, so no migration is needed for storage. Admin display would
need UI. Interim hack (not recommended): encode tags as `probes` entries.

---

## 9. Parity matrix (scope addition a)

Legend:

- **Godot difficulty:** L = low, M = medium, H = high.
- **Platform caveats:** D = desktop, M = mobile, W = Web.
- `await` means the method is a coroutine returning a typed `RefCounted` result.
- Proposed singleton: autoload `PolarisKey` with sub-objects `core`, `license`, `config`,
  `devices`, `identity`, `release`, `update`.

### 9.1 Core / client facade

| Capability                                                                                                               | Node (`@polaris-key/node`)                                                                                     | Swift                                           | Python                                             | React                                 | Godot proposal                                                                                                                                                                             | Diff.              | Caveats                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------- |
| Construct + offline load (no network)                                                                                    | `PolarisKeyClient.create(opts)` / `init()` (client.ts:171-186)                                                 | `PolarisKeyClient.create(options:)` / `start()` | `PolarisKeyClient.create(**opts)` / `init()`       | `<PolarisKeyProvider adapter>`        | `PolarisKey.configure(opts: PKeyOptions)` then `await PolarisKey.start()`, which emits `ready`                                                                                             | M (crypto on load) | W: IndexedDB; verification must not block the frame     |
| Options: productSlug, baseUrl, version, channel, pinned trust, trustRefresh, store, configDir, timeout, expectedServices | `CoreOptions` (context.ts:100-132)                                                                             | `CoreOptions`                                   | kwargs                                             | adapter opts                          | `PKeyOptions extends Resource` (inspector-editable `.tres`); version defaults to `ProjectSettings "application/config/version"` (must be semver)                                           | L                  |                                                         |
| https-only base URL guard                                                                                                | `InsecureBaseUrlError`                                                                                         | throws `insecure-base-url`                      | same                                               | —                                     | `PKeyError.INSECURE_BASE_URL` at configure                                                                                                                                                 | L                  |                                                         |
| `discover()`                                                                                                             | ✓ (:197)                                                                                                       | ✓                                               | ✓                                                  | `discoverProduct`                     | `await PolarisKey.discover()`                                                                                                                                                              | L                  | W: CORS                                                 |
| `capabilities()` (fail-closed D-21)                                                                                      | ✓ (:217)                                                                                                       | ✓                                               | ✓                                                  | `useCapabilities`                     | `PolarisKey.capabilities() -> Dictionary`                                                                                                                                                  | L                  |                                                         |
| `sync({force})`                                                                                                          | ✓ (:226)                                                                                                       | ✓                                               | ✓                                                  | `adapter.refresh()`                   | `await PolarisKey.sync(force := false) -> PKeySyncResult`; emits `sync_finished`                                                                                                           | M                  | W: no threads                                           |
| `getSyncState()` bridge snapshot                                                                                         | ✓ (:265)                                                                                                       | `syncState()`                                   | `get_sync_state()`                                 | `BridgeState`                         | `PolarisKey.get_sync_state() -> PKeySyncState`                                                                                                                                             | L                  |                                                         |
| `importBundle(jws, now)`                                                                                                 | ✓ (:281)                                                                                                       | ✓                                               | `import_bundle`                                    | ✗                                     | `await PolarisKey.import_bundle(text) -> PKeyImportResult` (errors carry the §7 step)                                                                                                      | M                  | W: file via paste/drag-drop; M: file picker permissions |
| `status()` / `isLicensed()`                                                                                              | ✓                                                                                                              | ✓                                               | ✓                                                  | `useLicense`, `useLicenseGate`        | `PolarisKey.status() -> PKeyLicenseState`, `is_licensed()`                                                                                                                                 | L                  |                                                         |
| `getConfig(key, fallback)`                                                                                               | ✓                                                                                                              | `config(_:default:)`                            | `get_config`                                       | `useManagedConfig`                    | `PolarisKey.get_config(key, fallback)`                                                                                                                                                     | L                  |                                                         |
| `register()` top-level                                                                                                   | via `devices`                                                                                                  | ✓                                               | ✓                                                  | —                                     | `await PolarisKey.register()`                                                                                                                                                              | L                  |                                                         |
| `activate(key)` / `enroll()` / `deactivate()` top-level                                                                  | via `license`                                                                                                  | ✓                                               | via `license` / `deactivate`                       | `submitKey`/`signOut`                 | passthroughs                                                                                                                                                                               | L                  |                                                         |
| `getCurrentDevice()` / `listDevices()` / `renameDevice()` / `deauthorizeDevice()`                                        | ✓ (:300-356)                                                                                                   | ✓                                               | ✓                                                  | `DeviceManager` (desktop bridge only) | same names, snake_case, `await`                                                                                                                                                            | L                  |                                                         |
| Refresh loop + `onChange`                                                                                                | `refreshIntervalSeconds`, `onChange`, `close()`                                                                | `startRefreshLoop(onChange:)`, `close()`        | `refresh_interval_seconds`, `on_change`, `close()` | reactive state                        | `Timer` child + `state_changed(state)` signal; also sync on `NOTIFICATION_APPLICATION_RESUMED` / focus-in                                                                                  | L                  | M: pause/resume                                         |
| Store failure surfacing                                                                                                  | throws                                                                                                         | `storeFailure()` / `lastStoreError`             | raises                                             | —                                     | `store_error(err)` signal + `last_store_error`                                                                                                                                             | L                  |                                                         |
| Local-only profile                                                                                                       | `createLocalClient` / `createBundleClient` (local/index.ts:52-73)                                              | `createLocal` / `createFromBundle`              | `create_local_client` / `create_bundle_client`     | ✗                                     | `opts.local_only = true` (the transport refuses at dial); `PolarisKey.create_from_bundle(text)`; or a feature tag `pkey_local_only`                                                        | L                  | kiosk/demo builds                                       |
| CLI adapters                                                                                                             | commander/yargs over `cli/commands.ts` (activate, enroll, deactivate, status, register, config, import-bundle) | ✗                                               | argparse/click/typer                               | ✗                                     | `PKeyCli.run(OS.get_cmdline_user_args())` for headless/server builds: `-- --pkey activate <key>`, `--pkey status`, `--pkey import-bundle <path>`, `--pkey register`, `--pkey config <key>` | L                  | D only                                                  |

### 9.2 License

| Capability                                                | Node                        | Swift                       | Python              | React            | Godot                                                                                                                                                                            | Diff. | Caveats                                                          |
| --------------------------------------------------------- | --------------------------- | --------------------------- | ------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- |
| `activation()`                                            | ✓ (license/client.ts:76)    | ✓                           | ✓                   | state            | `license.activation() -> StringName` (`&"token"`, `&"bundle"`, `&""`)                                                                                                            | L     |                                                                  |
| `status(now)` / `isLicensed`                              | ✓                           | ✓                           | ✓                   | ✓                | `license.status()` / `is_licensed()`                                                                                                                                             | L     |                                                                  |
| `isEntitled(name)` / `getEntitlements()`                  | ✓                           | ✓                           | ✓                   | `useEntitlement` | `license.is_entitled(name)`, `license.get_entitlements()`                                                                                                                        | L     |                                                                  |
| `getProfile()` / `getLicenseId()`                         | ✓                           | `profile()` / `licenseId()` | ✓                   | `profile`        | `license.get_profile() -> PKeyProfile`, `get_license_id()`                                                                                                                       | L     |                                                                  |
| `entitledChannels()`                                      | ✗                           | ✓                           | ✗                   | ✗                | `license.entitled_channels()`                                                                                                                                                    | L     |                                                                  |
| `enroll()`                                                | ✓                           | ✓                           | ✓                   | ✗                | `await license.enroll()`                                                                                                                                                         | L     | W: impossible (no anchor); iOS: re-enroll after vendor uninstall |
| `activateWithKey(key)` (+ fingerprint)                    | ✓                           | `activate(key:)`            | `activate_with_key` | `submitKey`      | `await license.activate_with_key(key) -> PKeyActivationResult` (`OK, DEVICE_LIMIT, UNAUTHORIZED, FINGERPRINT_REQUIRED, HARDWARE_MISMATCH, ENROLL_DISABLED, RATE_LIMITED, ERROR`) | L     | store policy for paid unlocks on M                               |
| `deactivate()` (best-effort remote, mandatory local wipe) | ✓                           | ✓ (throws on wipe failure)  | ✓                   | `signOut`        | `await license.deactivate()`                                                                                                                                                     | L     |                                                                  |
| Fingerprint opt-out                                       | `license.fingerprint=false` | ✓                           | ✓                   | —                | `opts.fingerprint_enabled`                                                                                                                                                       | L     |                                                                  |

### 9.3 Config

| Capability                                       | Node                                          | Swift                     | Python                                      | React                        | Godot                                                                                                                 | Diff. | Caveats                                      |
| ------------------------------------------------ | --------------------------------------------- | ------------------------- | ------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------- |
| `getConfig(key, fallback)` with precedence       | ✓                                             | `config(_:default:)`      | `get_config`                                | `useManagedConfig().get`     | `config.get_value(key, fallback)`                                                                                     | L     |                                              |
| `getConfigSource(key)`                           | ✓                                             | `configSource`            | `get_config_source` / `resolve_with_source` | ✓                            | `config.get_source(key) -> StringName`                                                                                | L     |                                              |
| `listUserConfig()` (no hidden; enforced flagged) | ✓                                             | ✓                         | ✓                                           | `ConfigPanel`                | `config.list_user_config() -> Array[PKeyConfigEntry]`                                                                 | L     |                                              |
| `getSecret(key)`                                 | ✓                                             | `secret(_:)`              | `get_secret`                                | ✗ (browser strips)           | `config.get_secret(key)`                                                                                              | L     | treat as non-secret on W                     |
| `schemaVersion()` / `enabled`                    | ✓                                             | ✓                         | ✓                                           | —                            | ✓                                                                                                                     | L     |                                              |
| Local overrides                                  | `ConfigClientOptions.localOverrides` (static) | same                      | same                                        | `onOverride` (host persists) | a **provider** (Callable/`PKeyOverrideStore`) backed by the game's `ConfigFile`, so overrides are live-editable (§11) | L     |                                              |
| Env layer (`PKEY_CONFIG_a__b`)                   | `process.env`                                 | `ProcessInfo`             | `os.environ`                                | desktop only                 | `OS.get_environment()` (D) + `--pkey-config key=value` user args; disabled on M/W by default                          | L     | macOS Finder-launched apps have no shell env |
| Catalog fetch (`/config/schema`)                 | ✗                                             | `ConfigFetch.fetchSchema` | ✗                                           | ✗                            | `await config.fetch_catalog()` + compiled mirror from `gen-mirrors --lang gdscript`                                   | L     | unsigned; UI hints only                      |
| **Edge-mint** (`/config/mint/<id>/token`)        | ✗                                             | ✗                         | ✗                                           | ✗                            | `await config.mint_token(recipe_id) -> {token, expires_at}` with in-memory cache until expiry                         | L     | new to the ecosystem                         |

### 9.4 Devices

| Capability                                                                  | Node                     | Swift                                | Python | React          | Godot                                                         | Diff. | Caveats           |
| --------------------------------------------------------------------------- | ------------------------ | ------------------------------------ | ------ | -------------- | ------------------------------------------------------------- | ----- | ----------------- |
| `register()` keyless                                                        | ✓ (devices/client.ts:99) | `registerDevice`                     | ✓      | ✗              | `await devices.register()`                                    | L     | 10/min/IP         |
| `list()` / `rename()` / `deauthorize()`                                     | ✓ (:137-182)             | ✓                                    | ✓      | desktop bridge | ✓                                                             | L     |                   |
| `report()` telemetry                                                        | ✓ (:184)                 | via sync                             | ✓      | ✗              | automatic in `sync()`; `devices.report()`                     | L     | §8 allowlist      |
| `fingerprint()` / `collectFingerprint` / `hashComponents` / `rawComponents` | ✓                        | `Fingerprint.collect/hashComponents` | ✓      | ✗              | `PKeyFingerprint.collect(slug)`, `hash_components(slug, raw)` | M     | §3.3 per platform |
| `deriveDeviceId` / `deviceIdFromRaw`                                        | ✓                        | `DeviceID.derive/fromRaw`            | ✓      | ✗              | `PKeyDeviceId.from_raw(slug, raw)`                            | L     |                   |
| `collectFacts` / `runProbes`                                                | ✓                        | `Facts.collect/runProbes`            | ✓      | ✗              | `PKeyFacts.collect(probes)`                                   | L     |                   |

### 9.5 Identity

| Capability          | Node                               | Swift                     | Python | React                                    | Godot                                                                                                                                                                                                                                        | Diff. | Caveats                                         |
| ------------------- | ---------------------------------- | ------------------------- | ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------- |
| Browser OIDC        | ✗                                  | host closure (`onSignIn`) | ✗      | `signInWithOidc` (browser redirect)      | ✗ (the only native completion path is device-code)                                                                                                                                                                                           | —     | W same-origin only                              |
| Device-code sign-in | ✗ (desktop host bridge implements) | ✗                         | ✗      | `beginSignIn` / `pollSignIn` via bridge  | `await identity.begin_sign_in(device_name) -> PKeySignInPrompt{user_code, verification_uri, expires_in, interval}`; `identity.sign_in_pending(prompt)` / `sign_in_finished(result)` signals; auto-poll with `slow_down`; `identity.cancel()` | M     | strict tiers fail (no fingerprint on this path) |
| Capability flags    | —                                  | —                         | —      | `supportsOidcLogin` / `supportsKeyEntry` | `identity.is_available()` (from `services.identity.enabled` + `configured`)                                                                                                                                                                  | L     |                                                 |

### 9.6 Release / Update

| Capability                                           | Node                     | Swift                                                            | Python        | React                               | Godot                                                                                                              | Diff. | Caveats                                                          |
| ---------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------- |
| `release.changelog()`                                | ✓ (release/client.ts:38) | ✗                                                                | ✓             | ✗                                   | `await release.changelog()`                                                                                        | L     |                                                                  |
| `release.installUrl()` / `downloadUrl(v, bin, arch)` | ✓                        | ✗                                                                | ✓             | ✗                                   | ✓ + `await release.download(v, asset, to_path)` with `?checksum=sha256` verification (HashingContext)              | L     | an arch suffix is required in asset names                        |
| `update.check({channel})`                            | ✓ (update/client.ts:42)  | ✓                                                                | ✓             | `useLatestVersion` / `UpdatePrompt` | `await update.check(channel) -> PKeyVersionCheck`; `update_available` signal                                       | L     |                                                                  |
| Appcast URL / Sparkle                                | `appcastUrl()`           | `UpdateFeed`, `SparkleUpdater`, `feedHeaders`, `allowedChannels` | `appcast_url` | —                                   | `update.appcast_url()` only (no Sparkle in Godot); optional in-game self-update for direct-download desktop builds | L     | stores (Steam/itch/App Store/Play) own updates on those channels |

---

## 10. UI components (scope addition b)

**What exists today.**

- **Swift `PolarisKeyUI`:**
  - `PolarisGateModel` (ObservableObject bridging `LicenseClient`, with `reload`, `refresh`,
    `activate(key:)` and `deactivate`, plus human error copy for every `ActivationResult`) —
    `PolarisLoginView.swift:25-104`;
  - `PolarisLoginView` (renders by status: an OIDC button + key-entry card on
    `needs-activation`, a grace banner, a version-block screen, and the product UI via a `content`
    slot when usable), `:106-314`;
  - `PolarisTheme` (177 lines).
  - No settings or device UI.
- **React** (`packages/sdk-react/src/components`), with headless hooks
  `usePolarisKey/useCapabilities/useLicense/useManagedConfig/useEntitlement/usePolarisAuth/useLicenseGate/useLatestVersion`
  and `screenFor` (hooks.ts:306-335):
  - `LicenseGate`: full-window gate with slots for loading/login/grace/revoked/expired/
    versionBlock/error, `allowGrace`, and `not-applicable` renders children;
  - `PolarisLogin`: OIDC button shown only if Identity is enabled, key form only if License is
    enabled;
  - `PolarisLogout`;
  - `ConfigPanel`: rows with a provenance badge, the override affordance **only** on
    `default`/`fallback` keys, `hidden` excluded, `enforced` read-only; the host persists
    overrides;
  - `DeviceManager`: list/rename/disconnect, with "unsupported" as a first-class state;
  - `UpdatePrompt`: a polite banner or a blocking dialog;
  - `theme` + primitives (`MessageScreen`, `Button`, `Panel`, `TextField`).
- **Python/Node:** CLI only.

**Proposed Godot `addons/polaris_key/ui/`.** Control scenes, themable via a `Theme` resource and
`PKeyUiCopy` (localizable via `tr()`), each with a headless controller script so a game can
restyle freely.

| Scene                         | Driven by                                      | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PKeyGate.tscn` (full-screen) | `status()` + `state_changed`                   | Mirrors `screenFor`: loading → spinner; `not-applicable`/`ok` → hide and emit `usable`; `grace` → non-blocking `PKeyStatusBanner` (or block if `allow_grace=false`); `needs-activation` → `PKeyActivationPanel`; `revoked` → "This device was signed out" + sign-in; `expired` → "Connect to the internet to continue" + retry (`sync(force)`); `version-too-old` → "Update required (min X)" + store/itch link or `update.check()` URL; `version-too-new` / `channel-not-entitled` → "This build isn't available on your license" (beta access copy)                     |
| `PKeyActivationPanel.tscn`    | License + Identity capabilities                | "Enter license key" `LineEdit` (only if License enabled; paste-friendly; human errors per result kind); "Sign in" button (only if Identity enabled → `PKeySignInDialog`); "Continue free" (only if auto-issue enrollment is advertised / attempted; hidden on Web); "Offline activation…" → `PKeyOfflineDialog`                                                                                                                                                                                                                                                           |
| `PKeySignInDialog.tscn`       | `identity.begin_sign_in`                       | Large `userCode`, **QR of `verificationUriComplete`**, "Open browser" / "Copy link", countdown from `expiresIn`, cancel. Controller/gamepad-navigable (focus neighbours) for Deck/TV                                                                                                                                                                                                                                                                                                                                                                                      |
| `PKeyOfflineDialog.tscn`      | `import_bundle`                                | Shows the **request code** (product slug + device id) with copy + QR. "Load bundle file…" (`FileDialog`, access FILESYSTEM on D; Android SAF), paste area (`TextEdit`), drag-drop on D/W. Errors name the §7 step                                                                                                                                                                                                                                                                                                                                                         |
| `PKeyDeviceList.tscn`         | `list_devices` / `rename` / `deauthorize`      | Current device highlighted; rename inline; "Sign out this device" = `deactivate`. Other devices are **read-only**: the server forbids cross-device mutation with a device token (`core/devices.ts` R3-09). Link to the customer portal for that                                                                                                                                                                                                                                                                                                                           |
| `PKeySettingsPanel.tscn`      | `list_user_config` + catalog                   | One row per non-hidden entry, grouped by `category`, sorted by `ui.order`. Widgets from `ui.widget` (switch → `CheckButton`, stepper → `SpinBox`, select → `OptionButton` with `optionLabels`, textarea, password masked). **Enforced rows disabled with a lock + "Set by <product>" tooltip.** A `default` row is editable and writes to the game's local override store, with a "Reset to default" button. The provenance badge shows `local` / `env` / `remote default` / `fallback`. `dependsOn` hides rows. `advanced` goes behind a toggle. `hidden` is never shown |
| `PKeyStatusBanner.tscn`       | `state_changed`                                | Grace ("Offline — N days left", from `graceUntil` − `effectiveNow`), last verified ("checked 3 h ago", `lastVerifiedAt`), update available                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PKeyUpdatePrompt.tscn`       | `update_available`                             | Banner or modal (`blocking` flag)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PKeyEntitlementBadge.tscn`   | `is_entitled` + catalog `userGrant/grantLabel` | "Included with Supporter" chips                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 11. Client-side config precedence in a Godot game (scope addition c)

The precedence stays exactly as specified: enforced/hidden (remote) > local override >
environment > remote default > fallback (`client-core/src/config.ts:93-108`). In Godot the fallback
is the schema default, then the caller's argument. Mapping each layer:

- **Remote** is the verified config doc's `config` map (`ManagedEntry{state, value, updatedAt}`).
- **Local override** is the player's own setting, stored in the game's `user://settings.cfg`
  (`ConfigFile`).
  - Map by the catalog entry's **`accessor`** (a dotted path into the client's config object,
    docs `catalog.md` "`accessor`"). Use `section.key` → `settings.cfg [section] key`, with an
    explicit table as fallback.
  - Implement it as a live provider: `PolarisKey.config.set_override_store(PKeyConfigFileStore.new("user://settings.cfg", mapping))`.
    `get_value` then reads the player's current value at call time, and the settings panel's
    edits write straight to the same file.
  - Only `default`-state or absent keys consult it. When a key is `enforced`/`hidden`, the game
    **must ignore the saved player value**, even though it is still in the file. Keep the file
    untouched so the player's choice returns if the admin relaxes the state.
- **Environment:**
  - Desktop: `OS.get_environment("PKEY_CONFIG_" + key.replace(".", "__"))`. This is a per-key
    lookup, so there is no need to enumerate env vars. macOS apps launched from Finder don't
    inherit a shell env.
  - All platforms that pass args: `--pkey-config key=value` via `OS.get_cmdline_user_args()`.
    On Web, the export's HTML shell can inject args.
  - Recommend disabling the env layer in release mobile/Web builds (`OS.is_debug_build()` or an
    option). It can only affect `default` keys anyway.
- **Fallback / schema default:** use a compiled catalog mirror
  (`tools/gen-mirrors.ts --lang gdscript` → `catalog_generated.gd` with `const DEFAULTS := {…}`),
  or `ProjectSettings` defaults, or the caller's fallback argument.
- **Applying values:**
  - Engine-level settings (`display/window/vsync/vsync_mode`, audio bus volumes, `max_fps`) are
    applied by game code in a `config_changed(keys)` handler. `ProjectSettings.set_setting` at
    runtime does not re-apply most engine settings, so call the live API
    (`DisplayServer.window_set_vsync_mode`, `AudioServer.set_bus_volume_db`, `Engine.max_fps`).
  - **Feature flags:** remote kill-switches/booleans are `config` keys (managed state). **Paid or
    earned features** are `flag` entitlements on the license doc (`license.is_entitled`). Godot
    **feature tags** (`OS.has_feature`) are build-time facts. Use them to pick the X-PKey channel
    and facts, not as remote flags.
  - Provide `PKeyConfigBinding.bind_property(node, "property", "key", fallback)`, which re-applies
    on `config_changed`.

---

## 12. Local persistence plan in Godot (scope addition d)

The layout mirrors `<configDir>/<product>/{token,device,managed.json}` under
`user://pkey/<product>/`.

| Item                                                         | What                                          | Where / protection                                                                                                                                                                                                                                                                                                                | Notes                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device`                                                     | 32-char device id                             | plain file; `FileAccess.set_unix_permissions(path, 0o600)` (Godot 4.1+) on macOS/Linux                                                                                                                                                                                                                                            | write once; surface failures; never regenerate silently                                                                                                                                                                          |
| `token`                                                      | `pkeyt_…` bearer                              | **Preferred:** a platform secure-store backend: iOS Keychain / Android Keystore (EncryptedSharedPreferences) via a small native plugin, desktop Keychain / Credential Manager / libsecret via GDExtension. **Fallback:** 0600 file (desktop Unix), per-user `%APPDATA%` ACL (Windows), app sandbox (iOS/Android), IndexedDB (Web) | optionally obfuscate with `FileAccess.open_encrypted_with_pass` (AES) keyed by a random per-install key. Obfuscation only; state that honestly                                                                                   |
| `managed.json`                                               | `CacheRecordV3` (signed JWSs + ETags + hints) | same file protections                                                                                                                                                                                                                                                                                                             | integrity comes from re-verification; confidentiality matters only for `clientScoped` secrets → prefer edge-mint (§4). Atomic write: temp file + `DirAccess.rename_absolute` (an improvement over Node/Swift's in-place O_TRUNC) |
| Clock floor, anti-replay floors, trust set, `lastVerifiedAt` | —                                             | **never persisted** (derived at load, §4.1)                                                                                                                                                                                                                                                                                       |                                                                                                                                                                                                                                  |
| Local overrides                                              | the player's settings                         | the game's own `user://settings.cfg`                                                                                                                                                                                                                                                                                              | host-owned, like React's `onOverride`                                                                                                                                                                                            |
| Edge-mint tokens                                             | short-lived                                   | memory only                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                                                                                                  |

Per-platform notes:

- **Web.** `user://` is IndexedDB. It is persistent only if the browser allows it
  (`OS.is_userfs_persistent()`), and it is readable by any same-origin script. If the host serves
  many games from one origin (as some HTML5 portals do), other games can read it. A cleared
  storage means a new device id and a new seat, with no fingerprint to coalesce.
- **iOS/Android:** app-sandboxed, fine for tokens against non-root attackers.
- **Desktop:** per-user, 0600.

---

## 13. Diceroll use cases per service (scope addition e)

These assume a dice game with settings in `user://settings.cfg`; see the note at the top.

| Service                            | Diceroll use                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config (managed)**               | Remote balance/economy tuning without a patch (`dice.rerollCost`, `economy.dailyBonus`, `events.theme`). Competitive values `enforced`; cosmetic/accessibility values `default` (the player can override: dice animation speed, haptics); analytics sample rate and other internal knobs `hidden`. Emergency kill switches (`online.leaderboards.enabled` enforced `false`). Staged rollouts via tier profiles and per-device overrides (QA devices). |
| **Flags / entitlements (License)** | Supporter tier (`license.tier == "supporter"`) unlocks dice skins/themes (`extras.diceSkins` flag, `userGrant` label "Included with Supporter"). `deviceLimit` for multi-device supporters. `app.minVersion` to force old clients to update (gate `version-too-old` screen).                                                                                                                                                                          |
| **Keyless enrollment**             | "Free tier" license auto-issued per machine (desktop/mobile). An anonymous player can later sign in and **claim** it, keeping their devices. Not on Web (no anchor).                                                                                                                                                                                                                                                                                  |
| **License keys**                   | Kickstarter/itch bundle backers redeem keys on desktop. **Mobile caveat:** unlocking digital content with externally purchased keys likely conflicts with Apple App Store 3.1.1 and Google Play payments policy. Mobile supporter purchases may need IAP, with server-side grant (a separate integration).                                                                                                                                            |
| **Identity**                       | Cross-device supporter status: device-code sign-in (QR) on phone + desktop → the same license (idempotent on OIDC `sub`). Also a player-visible device list.                                                                                                                                                                                                                                                                                          |
| **Channels**                       | Beta testers: beta export preset with feature tag `beta` → SDK sends `X-PKey-Channel: staging` (never `beta`: the server refuses unknown channels) → the license entitlement `channels: ["stable","staging"]` lets it through; others see "This beta build isn't available on your license".                                                                                                                                                          |
| **Release / Update**               | Direct-download desktop builds: `update.check()` banner + `release.download_url()`. Supporter-only content packs as release artifacts in `entitled` access mode, loaded with `ProjectSettings.load_resource_pack()`. The asset name must carry an arch suffix (e.g. `diceroll-extras-x86_64.pck`), a server limitation.                                                                                                                               |
| **Edge-mint**                      | Short-lived tokens for third-party services (leaderboard/cloud-save/analytics ingest) so no API key ships in the PCK.                                                                                                                                                                                                                                                                                                                                 |
| **Offline bundles / local-only**   | Event/kiosk builds (convention booth) activated air-gapped; `local_only` demo builds.                                                                                                                                                                                                                                                                                                                                                                 |
| **Devices / facts**                | Crash/perf triage by renderer/GPU/engine version (needs the `engine` report key, §8). Seat management UI.                                                                                                                                                                                                                                                                                                                                             |

**Realism.** GDScript and PCKs are trivially decompiled and patched (e.g. gdsdecomp). The client
gate is UX, not DRM. That matches the repo's own `docs/security/arch/anti-piracy-realism.md`:
the "client-side half is built as if it were also enforcement, and it isn't". Protect value
server-side: entitled downloads, edge-mint, server-authoritative online features.

---

## 14. Repo divergences found along the way (worth tickets)

1. **The runner's build-gate port is stale vs the server.** It handles an unknown channel
   differently and has the dev bypass R3-01 removed (`corpusV2.test.ts:350-357` vs
   `worker/src/core/gate.ts:82-88,119-121,144-148`).
2. **Secrets are "stored in the keyring" per docs**, but are actually cached in the 0600
   `managed.json` by every SDK (§4).
3. **§5 registered-device re-register on 401** is not implemented by any SDK (§1.14).
4. **No SDK implements the edge-mint client or a native device-flow client** (§4, §6).
5. **`JWSVerifier.swift:6` comment** has the wrong header key order (alg,kid,typ).
6. **Swift double-verifies each cached document on load** and adds a reload bound the other SDKs
   lack (`CoreContext.swift:558-573`).
7. **Platform/arch header vocabularies differ** across SDKs: Node `win32`/`x64`, Python
   `windows`/`AMD64`, Swift `darwin|ios`/`x86_64`.
8. **`ramBucket` for <1 GiB:** Node emits `"0.5"`, Python/Swift omit it.
9. **Node/Python use `wmic`** for board serial and model, which is no longer present by default
   on Windows 11.
10. **No CORS on the Worker**, so no cross-origin browser client is possible. That includes
    React's browser adapter unless it is same-origin.
11. **Device-flow sign-in never carries a fingerprint**, so `strict` tiers can't use it.
12. **`requires-identity` registration** is only satisfiable with a browser session cookie; there
    is no native path.
13. **No corpus vectors for Ed25519 malleability** (non-canonical S/A/R) or JSON
    lone-surrogate/control-character handling.

## 15. Non-wire server changes that would help Godot (ranked)

1. CORS for Web exports (per-product origin allowlist; OPTIONS; expose `etag`). Router +
   OpenAPI + `routeCoverage` + security review.
2. `engine` key in the report allowlist (+ test/OpenAPI).
3. Accept an optional fingerprint on `identity/auth/device/start` (carried to `authorizeAndMint`)
   so strict tiers work via sign-in.
4. An RFC 8628-style short-code entry page (`/identity/auth/device` + typed `userCode`) for TV
   and console UX. Needs a proper independent user code, which the docs already flag as a
   product-shape change.
5. A token-returning path for `requires-identity` registration that doesn't need a cookie
   (e.g. a device-flow variant that registers without minting a license).

None of these touches the signed document set, `PROTOCOL_VERSION`, or the corpus.

## 16. External sources consulted (Godot/browser facts)

- Godot docs:
  [OS](https://docs.godotengine.org/en/stable/classes/class_os.html),
  [JSON](https://docs.godotengine.org/en/stable/classes/class_json.html),
  [Crypto](https://docs.godotengine.org/en/stable/classes/class_crypto.html),
  [HashingContext](https://docs.godotengine.org/en/stable/classes/class_hashingcontext.html),
  [Exporting for the Web](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html)
- Godot source (master):
  [os_windows.cpp](https://github.com/godotengine/godot/blob/master/platform/windows/os_windows.cpp),
  [os_linuxbsd.cpp](https://github.com/godotengine/godot/blob/master/platform/linuxbsd/os_linuxbsd.cpp),
  [os_macos.mm](https://github.com/godotengine/godot/blob/master/platform/macos/os_macos.mm),
  [core/io/json.cpp](https://github.com/godotengine/godot/blob/master/core/io/json.cpp)
- [Godot forum: get_unique_id returns ANDROID_ID](https://forum.godotengine.org/38207/os-get_unique_id-returns-android_id-in-android)
- [MDN SubtleCrypto.verify](https://developer.mozilla.org/docs/Web/API/SubtleCrypto/verify),
  [caniuse: SubtleCrypto verify Ed25519](https://caniuse.com/mdn-api_subtlecrypto_verify_ed25519)
- [gd-ed25519 (Monocypher GDExtension)](https://github.com/freehuntx/gd-ed25519),
  [Asset Library entry](https://godotengine.org/asset-library/asset/4860)
