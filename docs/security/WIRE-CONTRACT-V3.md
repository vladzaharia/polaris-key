# Polaris Wire Contract v3

**Status:** Normative. Supersedes `WIRE-CONTRACT-V2.md` (v2 remains the historical record of the pre-suite contract; its §6 divergence findings seed §10 here).
**PROTOCOL_VERSION:** `3` (`@polaris-key/protocol` `core.PROTOCOL_VERSION`).
**Scope:** Everything that crosses the wire or the disk boundary between the Polaris Worker and the four client SDKs (Node, React, Python, Swift): JWS envelope, per-service signed documents, trust distribution, device principal, offline bundles, verified cache, and the monotonic clock floor. Server-internal behavior (D1 shapes, admin API) is out of scope except where it produces signed artifacts.
**Conformance:** `conformance/corpus/v2/` pins every rule marked **[C]** byte-for-byte across all implementations. `pnpm gen:corpus -- --check` is the drift gate.

Design spec: `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` (decision register D-01…D-24).

---

## 1. Trust model (carried from v2, restated normatively)

Two tiers, strictly decreasing authority. The on-disk cache is **never** a key source.

1. **Pinned keys** — `TrustSet = Record<kid, base64url(raw Ed25519 pubkey)>` compiled into the host app. Terminal: `mergeTrust(discovered, pinned) = { ...discovered, ...pinned }` (pins spread last; a manifest can never shadow a pin). **[C]**
2. **Manifest keys** — learned only from a verified trust manifest (`pkey-trust+jws`). The discovered set is **replaced wholesale** on every successful verification; absence of a previously-seen kid is revocation. **[C]**

Trust manifests are always verified against **pinned keys only** — never against the effective (merged) set — on both the network path and the cache-reload path, so online and offline verification are identical. A manifest that presents a pinned `kid` with different key bytes is rejected in full (substitution attempt; previous trust kept). Keys with `status: "revoked"` are dropped; `retired` and `staged` are trusted for verification. Manifest entries that are not `alg: "EdDSA"` / `kty: "OKP"` / `crv: "Ed25519"` are **skipped, not fatal** (carried v2 semantics): a future-alg key in the manifest must not brick current verifiers. **[C]**

JWS mechanics are frozen and unchanged from v2: compact JWS, `alg: "EdDSA"` (Ed25519) only, fixed header key order `{"alg","kid","typ"}`, header ≤ 1024 bytes decoded, payload ≤ 65 536 bytes decoded (encoded-length caps checked **before** any decode), strict base64url alphabet (reject `+ / =` and whitespace), duplicate-JSON-key rejection in header and payload, signature verified over the raw encoded bytes **before** the payload is parsed, verification key selected only by header `kid` from the caller's trust set. **[C]**
Exception: the `pkey-bundle+jws` payload cap is **262 144 bytes** (it wraps up to three inner compact JWSs); the caller passes this cap explicitly to the verifier for that `typ` alone (§7).

## 2. Document envelope

Four document types, domain-separated by `typ` (unknown or missing `typ` is rejected — the v2 tolerance window is over): **[C]**

| `typ`              | Artifact                  |
| ------------------ | ------------------------- |
| `pkey-license+jws` | License document          |
| `pkey-config+jws`  | Config document           |
| `pkey-trust+jws`   | Trust manifest            |
| `pkey-bundle+jws`  | Offline activation bundle |

Shared claims on license and config documents (**the envelope**):

```jsonc
{
  "iss": "key.plrs.im", // ISSUER — a FIXED string, never derived from the base URL (§8)
  "aud": "<product-slug>",
  "deviceId": "<32-char base64url device id>",
  "issuedAt": 1756252800, // unix seconds
  "expiresAt": 1756256400, // issuedAt + DOC_EXPIRY_SECONDS (3600) on the online path
  "graceUntil": 1758844800, // issuedAt + maxOfflineDays*86400, see §3.3
}
```

Normative constants (all **[C]**): `DOC_EXPIRY_SECONDS = 3600` · `CLOCK_SKEW_SECONDS = 300` · `MAX_GRACE_SECONDS = 31 536 000` (365 d) · `REFRESH_MARGIN_SECONDS = 1800` · `SECONDS_PER_DAY = 86 400`.

### 2.1 License document (`pkey-license+jws`)

Envelope plus:

```jsonc
{
  "licenseId": "…",
  "profile": {
    /* DocProfile — optional signed greeting/holder block */
  },
  "entitlements": {
    /* JSONValue map */
  },
}
```

`entitlements` is the **only** carrier of grant data (D-20): admin/tier policy is injected here as enforced entitlements — `license.tier`, `license.tierLabel`, `channels` (string array), `app.minVersion`, `app.maxVersion`, `deviceLimit` — alongside catalog-declared `flag` entries. License _state_ (`ok`/`grace`/…) is **never** carried in the document; it is derived by the client gate (§5).

### 2.2 Config document (`pkey-config+jws`)

Envelope plus:

```jsonc
{
  "schemaVersion": 4,           // the product's active catalog version (NOT the wire version)
  "config":  { "<key>": { "state": "default|enforced|hidden", "value": …, "updatedAt": … } },
  "secrets": { "<key>": { … } }
}
```

Contains no license fields. A product with `config` enabled and `license` disabled issues config documents to any registered device (§6) — this is the wire-level guarantee of service independence (D-08).

### 2.3 Trust manifest (`pkey-trust+jws`)

Unchanged from v2 in shape and semantics (`schemaVersion`, `aud`, `issuedAt`, `expiresAt`, `keys[{kid,key,status}]`, `cacheSeconds`). Servers continue to emit revoked keys explicitly for ≥ 2 × cacheSeconds so clients receive a positive prune signal.

## 3. Claim validation

Two validation profiles per document, selected by `checkFreshness`: **[C]**

- **Network path** (`checkFreshness: true`): reject if `now > expiresAt + CLOCK_SKEW_SECONDS` or `issuedAt > now + CLOCK_SKEW_SECONDS`. A stale or future-dated document must never enter the cache.
- **Reload path** (`checkFreshness: false`): the document is _expected_ to be past `expiresAt` (that is what offline operation is); only `graceUntil` bounds it, enforced by the gate against `effectiveNow` (§4.2). Used for cache reload **and bundle import** (§7).

Always enforced on both paths, both document types **[C]**: `typ` matches expectation · `iss === "key.plrs.im"` · `aud` equals the expected product · `deviceId` equals the local device id · `graceUntil ≥ expiresAt` · `graceUntil ≤ issuedAt + MAX_GRACE_SECONDS` (a hostile signer cannot grant a century of grace) · anti-replay: a document with `issuedAt` lower than the currently-accepted document's `issuedAt` for the same type is rejected (per-type floors).

### 3.3 Grace

`graceUntil = issuedAt + maxOfflineDays × SECONDS_PER_DAY`, where `maxOfflineDays` is the per-license override or the product default. The 365-day ceiling applies at **verify time**, not only in the gate. Offline bundles use the same mechanism with operator-chosen `graceDays ≤ 365` (D-22).

## 4. Verified cache & monotonic clock floor

### 4.1 Cache record v3

`CACHE_VERSION = 3`. One Core-owned record per product; **signed artifacts only**, plus two unsigned hints that can only _tighten_ the gate:

```jsonc
{
  "v": 3,
  "trustJws": "<pkey-trust+jws>",
  "docs": { "license": "<jws>", "config": "<jws>" }, // per-service slices; absent = service unused
  "etags": { "license": "…", "config": "…" },
  "importedBundle": { "bundleId": "…", "importedAt": 1756252800 },
  "lastSyncUnauthorized": false,
  "blocked": {
    "reason": "version-too-old",
    "allowedRange": { "min": "2.0.0" },
  },
}
```

Rules (all **[C]** via reload-path corpus cases):

- Every load re-verifies everything: `trustJws` against **pins only** → build effective trust → each entry of `docs` against the effective set with `checkFreshness: false`. Any verification failure ⇒ that artifact is treated as absent (fail closed); a failed license doc ⇒ `needs-activation`, never a partial state.
- `v !== 3` ⇒ the record is **discarded, never migrated** (one network round-trip on upgrade; air-gapped installs re-import their bundle).
- Decoded state, bare keys, or plaintext counters must never be persisted.
- Writes are Core-mediated read-modify-write of the whole record; service modules never write the file directly.

### 4.2 Monotonic clock floor

```
highWaterMark = max(issuedAt of every currently-verified cached document, trustManifest.issuedAt)
effectiveNow  = max(systemClock, highWaterMark)
```

Both document sources and the trust manifest feed the floor; a config-document-only floor is provably inert and the corpus pins the defective form so it cannot silently return (`floor-config-doc-alone-does-not-stop-rollback`, carried from v2; new `floor-max-over-three-artifacts`). **[C]**

**Core owns trust refresh on its own schedule.** Trust refresh must not be a side effect of any single service's document fetch: a product with any service enabled still advances the independent signed clock. (v2's floor rode the `/config` fetch; that coupling is abolished.)

### 4.3 Revocation while offline

Unchanged semantics: a recorded hard 401 (`lastSyncUnauthorized`) yields `revoked` offline; a device that never reconnects learns nothing new and runs out at `graceUntil`. For bundle-activated installs the grace bound **is** the revocation lever — stated, not pretended otherwise.

## 5. Transport & gate placement

- **Documents:** `GET /<p>/license/document` and `GET /<p>/config/document`, `Authorization: Bearer pkeyt_…`, response `application/jwt`. Per-document `ETag`/`If-None-Match`; on 304, if `effectiveNow > doc.expiresAt − REFRESH_MARGIN_SECONDS` the client refetches unconditionally (the v2 half-life rule, applied per document). **[C]**
- **401 handling:** exactly one `POST /<p>/license/token` re-acquire attempt, then one retry of the failed fetch. (Registered-without-license devices re-register instead; same single-attempt rule.)
- **Build gate placement (D-20):** channel/version-window enforcement returns `403 {"error":{"code":"version_blocked"|"channel_not_allowed"},"allowedRange":{…}}` on **`/license/document`** (and identity's `/session`). The config document enforces device authentication only.
- **Client metadata headers** on every product-scoped call: `X-PKey-Device`, `X-PKey-Version`, `X-PKey-Channel`, `X-PKey-SDK`, `X-PKey-SDK-Version`, `X-PKey-Platform`, `X-PKey-Arch`.
- **Gate function** (client-side, shared implementation): input `{ licenseServiceEnabled, activation: "token"|"bundle"|null, doc, now, highWaterMark, lastSyncUnauthorized, blocked, lastVerifiedAt }` with `now := max(now, highWaterMark)`. `licenseServiceEnabled: false` ⇒ status **`not-applicable`**, `isUsable = true`. `activation: null` ⇒ `needs-activation`. Otherwise v2 state machine unchanged (`ok` → `grace` → `expired`; `revoked` on recorded 401; blocked states from the unsigned hint). **[C]** via gate-matrix v2.

## 6. Device principal

- **Token:** `pkeyt_` + 43 base64url chars (256-bit). Hash-stored server-side; KV hot record `{product, deviceId, licenseId | null}` — `licenseId` is null for registered-without-license devices. `pkeyt_` tokens are rejected (pre-launch, no migration).
- **Registration policy** (per product, manifest key `devices.registration`, default derived — `requires-license` if license enabled, else `requires-identity` if identity enabled, else `open`):
  - `open` — `POST /<p>/devices/register` (keyless, rate-limited, optional fingerprint) mints a token.
  - `requires-identity` — same endpoint, but only with a valid product identity session.
  - `requires-license` — the endpoint returns `403 registration_closed`; activation/enrollment are the only mint paths (today's behavior).
- **Device management:** `GET/PATCH/DELETE /<p>/devices[/:id]` (self-only for PATCH/DELETE) and `POST /<p>/devices/report` (facts/probes telemetry; best-effort, errors swallowed client-side) are Core surfaces available under every policy.

## 7. Offline bundles (`pkey-bundle+jws`)

Air-gapped activation (D-12) — classic request-code flow:

```jsonc
// payload (≤ 262 144 bytes)
{
  "bundleId": "…", // ULID; audit anchor
  "aud": "<product-slug>",
  "deviceId": "<the requesting device's id>", // operator copies it from the app's offline screen
  "issuedAt": 1756252800,
  "expiresAt": 1758844800, // import window for the bundle itself
  "docs": { "license": "<pkey-license+jws>", "config": "<pkey-config+jws>" }, // config optional
  "trust": "<pkey-trust+jws>",
}
```

The bundle's import window is `BUNDLE_IMPORT_WINDOW_SECONDS = 2 592 000` (30 days): `expiresAt = issuedAt + 30 d`, deliberately decoupled from and much shorter than `graceDays` — the import window bounds how long a stolen bundle _file_ stays useful, while `graceUntil` bounds how long the imported _install_ runs. Inner documents carry the ordinary `expiresAt = issuedAt + DOC_EXPIRY_SECONDS` (they are validated on the reload profile at import); stretching an inner `expiresAt` instead of `graceUntil` would pass _network_-path freshness for the whole grace period and is refused at mint. **[C]** via `bundleCases`.

`importBundle` validation order (**all-or-nothing**; any failure imports nothing) **[C]** via `bundleCases`:

1. Verify the bundle JWS against **pinned keys only**; `typ` must be `pkey-bundle+jws`; payload cap 262 144.
2. `aud` equals the product; `deviceId` equals the local device id; `issuedAt ≤ now + skew`; `now ≤ expiresAt + skew` (the bundle import window uses network-path freshness — a stale bundle is refused).
3. Verify `trust` against pins (reload profile); build the effective set.
4. Verify each entry of `docs` against the effective set with the **reload profile** (`checkFreshness: false` — inner docs carry long `graceUntil`, not long `expiresAt`).
5. Atomically write cache v3: `trustJws`, `docs`, `importedBundle: {bundleId, importedAt}`. No token is created.

State semantics: `importedBundle` present with a verified license doc ⇒ gate `activation: "bundle"`. If the device later activates online, the token path supersedes (`activation: "token"`). Fingerprint enforcement is skipped for bundle activation (no server to dedupe against). Server-side minting is an admin surface (`POST /manage/api/products/<slug>/bundles`), audit-logged, `graceDays ≤ 365` enforced at mint **and** verify.

`docs.license` is **optional by design**: a config-only product (D-08) air-gaps with a bundle carrying only `docs.config` + `trust`. Importing a bundle with no license document has **no activation effect** — for a license-enabled product the gate remains `needs-activation`; for a license-disabled product it is `not-applicable` as always. `activation: "bundle"` arises only from a bundle whose license document verified. A bundle with an EMPTY `docs` (no license, no config) is refused at import step 2 as vacuous.

## 8. Identifier registry

Amendment A1 (see the design spec) withdrew the interim `plrs` rebrand, so v3 carries the v2
identifier family forward unchanged apart from the two document types the split added. The
"withdrawn" column exists so a reader who saw the interim spelling in a draft, a branch or an old
plan knows it is not merely deprecated — no verifier, signer or store ever accepts it.

| Concern                  | v3 (normative)                                                             | Withdrawn (never accepted)                                |
| ------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| ISSUER (`iss`)           | `key.plrs.im`                                                              | `plrs.im`                                                 |
| Device token prefix      | `pkeyt_`                                                                   | `plrst_`                                                  |
| Client headers           | `X-PKey-*`                                                                 | `X-Polaris-*`                                             |
| License key prefix       | `pkey_<product>_…`                                                         | — (never changed)                                         |
| JWS `typ` values         | `pkey-license+jws`, `pkey-config+jws`, `pkey-trust+jws`, `pkey-bundle+jws` | the `plrs-*` spellings                                    |
| Manifest dir             | `.pkey/` — the ONLY directory, no fallback                                 | `.polaris/`                                               |
| Session domain tags      | `pkey.admin.v1\|`, `pkey.portal.v1\|`                                      | `plrs.admin.v1\|`, `plrs.portal.v1\|`                     |
| Session cookies          | `__Host-pkey_admin`, `__Host-pkey_portal`, `pkey_<p>_session`              | the `plrs_` spellings                                     |
| Keychain service (Swift) | `pkey:<product>`                                                           | `plrs:<product>`                                          |
| Config env prefix        | `PKEY_CONFIG_`                                                             | `PLRS_CONFIG_`                                            |
| Hash domains             | `pkey-hw`, `pkey-device:` (FROZEN at `fingerprintVersion` 1)               | — (never changed; a rename orphans every enrolled digest) |
| Serving host             | `key.plrs.im`                                                              | — (equal to the issuer, but checked separately)           |

`pkey-config+jws` and `pkey-trust+jws` are the v2 type strings REUSED for v3's config document and
trust manifest. The document _shapes_ changed; the type strings did not. That is safe only because
this is pre-launch and corpus v1 was deleted in the same wave, so no dual-shape artifact under
either string ever existed in the wild.

## 9. Rollout & versioning

Pre-launch, no live clients: v3 replaces v2 in one movement — no dual-accept window. `PROTOCOL_VERSION = 3`; cache v2 records are discarded on first v3 load (§4.1); djdl is re-seeded; the corpus lives at `corpus/v2/` and v1 has been deleted (its fifteen gate-matrix rows were inlined into the v2 generator first, so nothing it pinned was dropped). Version counters and their owners: `PROTOCOL_VERSION` (this contract), `corpusVersion = 2`, `gateMatrixVersion = 2`, `fingerprintVersion = 1` (unchanged), per-product catalog `schemaVersion` (orthogonal). The corpus drift gate remains the only automated cross-language enforcement; this document remains the normative source.

## 10. Divergence & hardening ledger (seeded from v2 §6)

All v2 divergence classes (alg confusion, oversize, duplicate keys, alphabet strictness, typ separation, freshness profiles, trust substitution, clock floor) carry into corpus v2 unchanged. New classes introduced by v3, each with corpus coverage: per-type anti-replay floors (§3), config-document-without-license issuance (§2.2), registration-policy token minting (§6), bundle all-or-nothing import (§7), bundle payload cap (§1), gate `not-applicable`/`activation` semantics (§5). Implementations must not add local tolerances beyond this document; any observed divergence gets a corpus case before a fix.
