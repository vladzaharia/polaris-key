# Polaris Wire Contract v3

**Status:** Normative. Supersedes `WIRE-CONTRACT-V2.md` (v2 remains the historical record of the pre-suite contract; its §6 divergence findings seed §10 here).
**PROTOCOL_VERSION:** `3` (`@polaris-key/protocol` `core.PROTOCOL_VERSION`).
**Scope:** Everything that crosses the wire or the disk boundary between the Polaris Worker and the four client SDKs (Node, React, Python, Swift): JWS envelope, per-service signed documents, trust distribution, device principal, offline bundles, verified cache, and the monotonic clock floor. Server-internal behavior (D1 shapes, admin API) is out of scope except where it produces signed artifacts.
**Conformance:** `conformance/corpus/v2/` pins every rule marked **[C]** byte-for-byte across all implementations, within the one representation limit declared in §10. `pnpm gen:corpus -- --check` is the drift gate.

Design spec: `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` (decision register D-01…D-24).

---

## 1. Trust model (carried from v2, restated normatively)

Two tiers, strictly decreasing authority. The on-disk cache is **never** a key source.

1. **Pinned keys** — `TrustSet = Record<kid, base64url(raw Ed25519 pubkey)>` compiled into the host app. Terminal: `mergeTrust(discovered, pinned) = { ...discovered, ...pinned }` (pins spread last; a manifest can never shadow a pin). **[C]**
2. **Manifest keys** — learned only from a verified trust manifest (`pkey-trust+jws`). The discovered set is **replaced wholesale** on every successful verification; absence of a previously-seen kid is revocation. **[C]**

Trust manifests are always verified against **pinned keys only** — never against the effective (merged) set — on both the network path and the cache-reload path, so online and offline verification are identical. A manifest that presents a pinned `kid` with different key bytes is rejected in full (substitution attempt; previous trust kept). Keys with `status: "revoked"` are dropped; `retired` and `staged` are trusted for verification. Manifest entries that are not `alg: "EdDSA"` / `kty: "OKP"` / `crv: "Ed25519"` are **skipped, not fatal** (carried v2 semantics): a future-alg key in the manifest must not brick current verifiers. **[C]**

JWS mechanics are frozen and unchanged from v2: compact JWS, `alg: "EdDSA"` (Ed25519) only, fixed header key order `{"alg","typ","kid"}` (the order `signJws` emits and every corpus vector pins — an earlier draft of this section said `alg,kid,typ`, which never matched the artifacts), header ≤ 1024 bytes decoded, payload ≤ 65 536 bytes decoded (encoded-length caps checked **before** any decode), strict base64url alphabet (reject `+ / =` and whitespace), duplicate-JSON-key rejection in header and payload, signature verified over the raw encoded bytes **before** the payload is parsed, verification key selected only by header `kid` from the caller's trust set. **[C]**
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

Unchanged from v2 in shape and semantics (`schemaVersion`, `aud`, `issuedAt`, `expiresAt`, `keys[{kid,publicKey,status}]`, `cacheSeconds`). Servers SHOULD emit revoked keys explicitly for ≥ 2 × cacheSeconds as a positive prune signal; clients MUST honour an explicit `revoked` entry but MUST NOT depend on ever seeing one — wholesale replacement (absence-is-revocation) is the mechanism that always applies. (The worker emits them: `product_keys.revoked_at` is stamped on revocation and `listVerificationProductKeys` includes keys revoked within the 2 × cacheSeconds window, listed with `status: "revoked"`, for the trust manifest only — JWKS and discovery never include a revoked key.)

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
- **Build gate placement (D-20):** channel/version-window enforcement returns `403 {"error":{"code":"version_blocked"|"channel_not_allowed"},"allowedRange":{…}}` on **`/license/document`** (and identity's `/session`). The config document enforces device authentication only. The channel names, the header normalisation and the entitlement predicate the gate applies are §5.1.
- **Client metadata headers** on every product-scoped call: `X-PKey-Device`, `X-PKey-Version`, `X-PKey-Channel`, `X-PKey-SDK`, `X-PKey-SDK-Version`, `X-PKey-Platform`, `X-PKey-Arch`.
- **Gate function** (client-side, shared implementation): input `{ licenseServiceEnabled, activation: "token"|"bundle"|null, doc, now, highWaterMark, lastSyncUnauthorized, blocked, lastVerifiedAt }` with `now := max(now, highWaterMark)`. `licenseServiceEnabled: false` ⇒ status **`not-applicable`**, `isUsable = true`. `activation: null` ⇒ `needs-activation`. Otherwise v2 state machine unchanged (`ok` → `grace` → `expired`; `revoked` on recorded 401; blocked states from the unsigned hint). **[C]** via gate-matrix v2.

### 5.1 Channel vocabulary

One set of channel names serves the licence build gate, the `entitled` release check
(`release`/`update` access mode) and every SDK's `X-PKey-Channel`. The constants live in
`@polaris-key/protocol/core` (`CHANNEL_*`, `CHANNEL_ALIASES`, `CHANNEL_NAME_PATTERN`,
`PR_CHANNEL_PATTERN`, `PR_NUMBER_MAX_DIGITS`). **[C]** via gate-matrix v2.

| Name      | What it is                                                               | Valid as                         |
| --------- | ------------------------------------------------------------------------ | -------------------------------- |
| `stable`  | the shipping channel; every grant holds it                               | header, selector, grant          |
| `beta`    | the pre-release channel                                                  | header, selector, grant          |
| `pr-<n>`  | one pull request; `<n>` is 1–7 digits, kept as written                   | header, selector, grant          |
| `pr`      | the PR family: as a grant it covers every `pr-<n>`                       | header, grant                    |
| `dev`     | the gate pseudo-channel of `0.0.0-dev*` builds (R3-01); Release has none | header, grant                    |
| manual    | a name from the product's `release.manualChannels`                       | header, selector, grant          |
| `staging` | the legacy alias of `beta`                                               | header, grant; selector (rule 6) |
| `latest`  | an alias of `stable`                                                     | header, selector                 |

1. **Alphabet.** Every name matches `^[a-z0-9][a-z0-9-]{0,63}$`: the intersection of the
   manifest's `CHANNEL_RE` and the feed routes' `^[a-z0-9-]+$`. The routes keep their own
   pattern, which every valid name passes.
2. **Build-implied channel**, `impliedChannel(version)`:

   | Version          | Channel                                             |
   | ---------------- | --------------------------------------------------- |
   | `0.0.0-dev*`     | `dev`                                               |
   | `0.0.0-beta*`    | `beta`                                              |
   | `0.0.0-staging*` | `beta`                                              |
   | `0.0.0-pr-?<d>*` | `pr-<d>`, or `pr` when `<d>` has more than 7 digits |
   | anything else    | `stable`                                            |

   Only the `0.0.0-<word>` sentinels carry a channel: `2.0.0-beta.1` is `stable`. An SDK's
   `channelForVersion` returns the coarse family (`stable`, `beta`, `pr`, `dev`) and sends it as
   its default `X-PKey-Channel`; only the server narrows `pr` to `pr-<n>`.

3. **Header**, `normalizeChannelHeader(header, version)`:

   | `X-PKey-Channel`               | Becomes                                             |
   | ------------------------------ | --------------------------------------------------- |
   | `stable`, `latest`             | `stable`                                            |
   | `beta`, `staging`              | `beta`                                              |
   | `dev`                          | `dev`                                               |
   | the literal `pr`               | the build's `pr-<n>` if it has one, else `pr`       |
   | `pr-<d>`, `pr<d>`              | `pr-<d>`, or `pr` when `<d>` has more than 7 digits |
   | any other name in the alphabet | itself                                              |
   | anything else                  | refused with `channel-not-entitled`                 |

   An unknown well-formed name is never a free pass: it must be granted by name (R3-01, R3-13).

4. **Predicate**, `channelEntitled(granted, channel)`, where `granted` is the `channels`
   entitlement (absent means `["stable"]`):
   - `stable` is always granted;
   - otherwise `granted` must contain the name exactly;
   - two exceptions widen a grant: `staging` also covers `beta`, and `pr` also covers `pr-<n>`.

   Nothing else widens one. `dev` and manual names are granted only by their exact name, and a
   `beta` grant never covers a manual channel named `staging`. Grants are matched as stored and
   are never rewritten.

5. **Gate order.** The server checks, in order:
   1. the dev bypass: `allowDevBuilds ?? granted includes "dev"`;
   2. the version window;
   3. a malformed header, which is refused;
   4. every channel in {build-implied, header} other than `stable`, each against rule 4.
6. **Release selectors keep their grammar:** `latest`, `stable`, `beta`, `pr-<1–7 digits>`, a
   manual name, or a pinned `X.Y.Z`. `staging` resolves as `beta`, and it is looked up **after**
   the manual names, so a declared manual `staging` channel wins. An aliased request keeps its
   requested spelling for the asset suffix, the enclosure, the feed title and the edge-cache key;
   resolution, floors and the `entitled` check go by the canonical channel.

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

Pre-launch, no live clients: v3 replaces v2 in one movement — no dual-accept window. `PROTOCOL_VERSION = 3`; cache v2 records are discarded on first v3 load (§4.1); djdl is re-seeded; the corpus lives at `corpus/v2/` and v1 has been deleted (its fifteen gate-matrix rows were inlined into the v2 generator first; gate-matrix v2 has since retired one of them, the pre-R3-01 dev-build bypass, through an approved plan with a named successor row, P0-04). Version counters and their owners: `PROTOCOL_VERSION` (this contract), `corpusVersion = 2`, `gateMatrixVersion = 2`, `fingerprintVersion = 1` (unchanged), `stageMatrixVersion = 1` (client boot behaviour outside this contract, owned by `client-core/src/stages.ts`), per-product catalog `schemaVersion` (orthogonal). The corpus drift gate remains the only automated cross-language enforcement; this document remains the normative source.

## 10. Divergence & hardening ledger (seeded from v2 §6)

All v2 divergence classes (alg confusion, oversize, duplicate keys, alphabet strictness, typ separation, freshness profiles, trust substitution, clock floor) carry into corpus v2 unchanged. New classes introduced by v3, each with corpus coverage: per-type anti-replay floors (§3), config-document-without-license issuance (§2.2), registration-policy token minting (§6), bundle all-or-nothing import (§7), bundle payload cap (§1), gate `not-applicable`/`activation` semantics (§5), channel vocabulary and aliases (§5.1, gate-matrix). Implementations must not add local tolerances beyond this document; any observed divergence gets a corpus case before a fix.

**Declared representation limit: U+0000 in decoded strings.** Some client platforms have a native string type that cannot hold U+0000. GDScript's `String` is one: Godot 4.4 drops the character and 4.7 replaces it. Such a platform is conformant only under this rule.

- It MUST decode the JSON escape `\u0000` as U+FFFD on every engine version, before its duplicate-key scan and its parse. Its decoded documents are then the same on every engine, and the loss stays visible.
- Verdicts do not change. The signature covers the encoded bytes (§1). Every value a verifier compares is ASCII (`typ`, `kid`, `iss`, `aud`, `deviceId`, channel names, versions), so a value that contains U+0000 fails the comparison on every platform alike.
- For each string value under a `jwsCases` `expect.doc` that contains U+0000, the generator writes `expect.docNulReplaced`. It maps the value's RFC 6901 pointer to the value with every U+0000 replaced by U+FFFD.
- A runner on such a platform compares those values against `docNulReplaced`, and the rest of the document as usual. Every other runner ignores the field.
- An object key that contains U+0000 is outside this entry. The corpus has none, the generator refuses to emit one, and no verdict for it is pinned yet (P3-01 decides it).

This is the only declared representation limit, and it covers no other character. **[C]**
