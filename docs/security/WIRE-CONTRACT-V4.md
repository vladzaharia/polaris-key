# Polaris Wire Contract v4

**Status:** Normative. Supersedes `WIRE-CONTRACT-V3.md`, the way v3 superseded v2. v3 remains the record; everything v3 said that v4 does not change is restated here, so this document can be read on its own. Amended for packs v1 by `plans/P4-01.md` (§2.5.1, §2.5.2, §2.6, §2.7, §3.7, §11.3, §11.4), inside v4: no new `typ`, no feed field, `PROTOCOL_VERSION` stays 4. Amended for chunk indexes by `plans/P4-10.md` (§2.5.1, §2.6, §3.1, §8, §9, §10, §11.4), also inside v4. Amended for content-key delegation by `plans/P4-19.md` (§1, §2, §2.4.1, §2.5, §2.5.3, §2.5.4, §2.8, §3.4, §3.5, §8, §9, §10), also inside v4: no new `typ`, claim, feed member or selector key. Amended for passthrough request metadata by `plans/PX-W13.md` (§5.4, §8, §12.7), also inside v4: no new `typ`, claim or signed shape, and `corpusVersion` stays 2. Amended for the built-in `dev` channel by `plans/P2-08.md` (§5.1), also inside v4: documentation only, no new `typ`, claim, header or signed shape. Amended for key-entry counting by `plans/PX-W9.md` (§5.3, §12, §12.2), also inside v4: one unsigned refusal code, one unsigned response member and one portal route, no new `typ`, claim, header or signed shape, and the signed corpus is unchanged. Amended for product presentation by `plans/HA-11.md` and `plans/HA-12.md` (§5.5, §9, §10), also inside v4: one unsigned discovery member and one unsigned client table. There is no new `typ`, claim, header, route or signed shape, and `PROTOCOL_VERSION` stays 4. Amended for trust custody and signed bundle custody (§1, §2.3, §3.2, §4.1, §6, §7, §9, §10), also inside v4: pinned keys can be tombstoned by another pin, key statuses are an allow-list, base64url must be canonical, the trust manifest can be fetched signed by a named key, and the cache keeps the imported bundle's signed JWS and the pin revocations' evidence (two additive slices). There is no new `typ`, claim or signed shape; one query parameter is added to an existing route. `PROTOCOL_VERSION` stays 4 and `corpusVersion` stays 2; one existing corpus verdict changes (`trust-member-shapes-ignored`: a key with no `status` is no longer trusted).
**PROTOCOL_VERSION:** `4` (`@polaris-key/protocol` `core.PROTOCOL_VERSION`).
**Scope:** Everything that crosses the wire or the disk boundary between the Polaris Worker, the CI that signs releases, and the client SDKs (Node, React, Python, Swift, Godot, Kotlin): JWS envelope and its strictness, the six signed artifacts, trust distribution, the pinned release keys, device principal, offline bundles, verified cache, the monotonic clock floor and the feed `seq` floor. Server-internal behavior (D1 shapes, admin API) is out of scope except where it produces signed artifacts.
**Conformance:** `conformance/corpus/v2/` pins every rule marked **[C]** byte-for-byte across all implementations, within the representation limits declared in §10. `pnpm gen corpus --check` is the drift gate. The v4 plan is `docs/research/2026-09-29-godot-omniplatform/program/plans/P3-01.md`; its §2–§4 are the long form of §1–§4 and §11 here.

**What v4 changes, in one list.** Two signed documents (`pkey-feed+jws`, the channel feed, signed by the product key; `pkey-release+jws`, the release record, signed by a CI-held release key and verified only against the release keys the app pins). One stricter verifier for all six `typ`s: Ed25519 strictness (§1.1) and an I-JSON profile with number and depth limits (§1.2). Every integer claim, v3's included, decided from its token (§3.1). The members that are not claims decide nothing (§3.2). Patterns match whole strings, lengths count bytes, presence is exact (§3.3). The four v3 documents keep their shapes and bytes.

Design spec: `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` (decision register D-01…D-24).

---

## 1. Trust model

Two tiers for **product keys**, strictly decreasing authority. The on-disk cache is **never** a key source.

1. **Pinned keys** — `TrustSet = Record<kid, base64url(raw Ed25519 pubkey)>` compiled into the host app. Terminal unless tombstoned (below): `mergeTrust(discovered, usablePins) = { ...discovered, ...usablePins }` (pins spread last; a manifest can never shadow a pin). **[C]**
2. **Manifest keys** — learned only from a verified trust manifest (`pkey-trust+jws`). The discovered set is **replaced wholesale** on every successful verification; absence of a previously-seen kid is revocation. **[C]**

The effective product trust set (usable pins ∪ manifest keys) verifies licence, config and feed documents. Trust manifests and bundles are always verified against the **usable pins only** — never against the effective (merged) set — on both the network path and the cache-reload path, so online and offline verification are identical. A manifest that presents a pinned `kid` with different key bytes is rejected in full (substitution attempt; previous trust kept). Manifest entries that are not `alg: "EdDSA"` / `kty: "OKP"` / `crv: "Ed25519"` are **skipped, not fatal**: a future-alg key in the manifest must not brick current verifiers. **[C]**

**Key status allow-list.** A manifest key enters the set only when its `status` is exactly `"active"`, `"staged"` or `"retired"` (`TRUST_LIVE_STATUSES`, `@polaris-key/protocol/trust`): `retired` and `staged` are trusted for verification, so in-flight documents still validate and a key is trusted before it signs. `"revoked"` drops the key and, for a pinned kid, applies the tombstone rule. Any other value — absent, not a string, an unknown string or a case variant (`"Active"`, `"REVOKED"`) — skips the entry and is never fatal. **[C]** via `trustCases`.

**Tombstone rule (pinned-key revocation).** **[C]** via `trustCases` and `bundleCases`.

1. A manifest that verifies against a usable pin S and lists another pinned kid R, with R's exact pinned bytes and `status: "revoked"`, **tombstones** R on that install. The manifest, verbatim, is the tombstone's evidence (`pinRevocations`, §4.1).
2. A manifest that lists its own signer as `revoked` is refused in full.
3. A tombstoned kid leaves the usable pins for every purpose: manifests, bundles and the effective set. It is permanent: a later manifest listing it as `active` with the same bytes does not restore it, and a manifest or bundle it signed is refused.
4. The usable pins are the pins minus the tombstones. A key cannot revoke itself, so the usable pins are never empty.
5. Listing a pinned kid with other bytes stays a substitution, `revoked` or not, and the whole manifest is refused.

Tombstones protect an honest install from a third party holding a pinned key; the cache is user-writable, so a willing user can delete them. The pinned release keys (`pinnedReleaseKeys`) are untouched by this rule.

**A third, separate input: the pinned release keys** (`pinnedReleaseKeys`, `pinned_release_keys` in Python and GDScript): `kid → raw 32-byte Ed25519 key, base64url`, the `TrustSet` encoding. Release records verify against these and nothing else. They are configured by the host, compiled into the app, and never persisted, merged or extended from the network. Two or more may be valid at once during a rotation. **A release key is never a product key**: a record whose selected release key's bytes are also in the effective product trust set is refused (§3.5), an SDK refuses options in which a pinned release key is also a trust pin (`invalid-options`), and the `.pkey/release` sync refuses a declared release key equal to any current or retired product signing key. Otherwise the Worker would hold the private half of a release key and the two-signer property would be gone without a trace. **[C]** via `releaseRecordCases`.

**Delegated content keys** (`plans/P4-19.md`). A pinned release key may delegate one **content key** through a CI-signed `kind: delegation` record (§2.5.4). A content key is never pinned, configured or persisted as a key: it is reached only through a delegation that verifies against the **pinned release keys** (never the product trust set, never another delegation), and only for a `kind: pack` record of a delegable type under the delegation's scope, inside its signing window (§3.5 steps 13 and 16). The delegated key's bytes must equal no pinned release key and no key of the effective product trust set. A delegated record names its delegation in its header `kid` (`pkd1-<delegation hash>`, `DELEGATED_KID_PATTERN`); an SDK refuses options that pin a release kid matching that pattern (`invalid-options`). Content keys never sign app records, revocations, delegations, pins, holds, embedded baselines or replacements. **[C]** via `delegationCases`.

JWS mechanics are unchanged from v3: compact JWS, `alg: "EdDSA"` (Ed25519) only, fixed header key order `{"alg","typ","kid"}`, header ≤ 1024 bytes decoded, payload ≤ 65 536 bytes decoded (encoded-length caps checked **before** any decode), strict, **canonical** base64url (reject `+ / =` and whitespace, a length of 1 mod 4, and any set bit among the last character's unused low bits: re-encoding the decoded bytes must give the input back; this applies to all three segments and to every trust-set key, pinned or published, where a non-canonical published key is skipped and a non-canonical pinned key verifies nothing), duplicate-JSON-key rejection in header and payload, signature verified over the raw encoded bytes **before** the payload is parsed, verification key selected only by header `kid` from the caller's trust set. **[C]**
Exception: the `pkey-bundle+jws` payload cap is **262 144 bytes** (it wraps up to three inner compact JWSs); the caller passes this cap explicitly to the verifier for that `typ` alone (§7).

### 1.1 Ed25519 strictness [C]

A verifier applies these checks to the 64-byte signature `R ‖ S` and to the trusted key `A` **before** its backend's verify call:

1. `S`, read as a 256-bit little-endian integer, is less than `L = 2^252 + 27742317777372353535851937790883648493`.
2. `A` and `R` are canonical encodings: the 255-bit `y` (bit 255 cleared) is below `p = 2^255 − 19`, and the encoding is neither of the two "x = 0 with the sign bit set" strings, `01 00…00 80` and `ec ff…ff ff`.
3. Neither `A` nor `R` is one of the eight small-order encodings (`SMALL_ORDER_ENCODINGS`, lowercase hex): `0100…00` (order 1); `ecff…ff7f` (order 2); `0000…00` and `0000…0080` (order 4); `26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05`, its `…fc85` twin, `c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a` and its `…03fa` twin (order 8).
4. The equation is cofactorless, `[S]B = R + [k]A`. No prime-subgroup check is made, so a mixed-order key with a cofactorless-valid signature verifies.

Checks 1–3 are byte comparisons, so a lenient backend never accepts what a strict one refuses. Pinned by the `sig-*`, `pubkey-*` and `valid-pubkey-mixed-order` `jwsCases`.

### 1.2 Strict JSON, numbers and depth [C]

These rules apply to the decoded header (before the signature check) and to the decoded payload (after it), for all six `typ`s:

1. The bytes are well-formed UTF-8 (RFC 3629): no ill-formed sequences, no overlongs, no surrogate code points, nothing above U+10FFFF.
2. There is no byte order mark at the start.
3. The text is exactly one JSON object under RFC 8259's grammar: no `NaN`, `Infinity` or `-Infinity`, no comment, no trailing comma.
4. No string contains an unescaped U+0000–U+001F.
5. No escape is a lone surrogate: every `\uD800`–`\uDBFF` escape is immediately followed by a `\uDC00`–`\uDFFF` escape, and every `\uDC00`–`\uDFFF` escape immediately follows one (RFC 7493 §2.1).
6. No object has two members with the same name. Names compare as sequences of Unicode scalar values after unescaping (RFC 7493 §2.3), so the NFC and NFD spellings of "é" are two names.
7. No member name contains U+0000. Values keep §10's representation limit and its `docNulReplaced` annotation.
8. **Numbers.** Every number token, judged exactly from its decimal digits (no floating point; an exponent of more than six significant digits is out of range outright), is zero or has a magnitude of at least 10^−307 and below 10^308. So `1e400`, `1e-400`, `5e-324` and `1e4294967297` are refused, and `7`, `-0`, `7.0`, `7e0`, `7.5`, `1e-7`, `1e+21`, `1e-307`, `9.99e307` and `0e5` are not. How a number is spelled matters only in an integer claim (§3.1).
9. **Depth.** No object or array nests more than `MAX_JSON_DEPTH` = 64 levels deep, counting the top-level object as level 1.

Noncharacters (`\uffff` and the rest) are ordinary characters, escaped or raw. Each verifier reports, beside the payload, its **non-wire-integer pointers** (`nonWireIntegers`): the RFC 6901 pointer of every number token that cannot be a wire integer, because it has a fraction or an exponent part, or because its digits exceed 9007199254740991 in magnitude. Member names are unescaped, then `~` is written `~0` and `/` is written `~1`; array indices are decimal. Python needs no set (its `json.loads` returns an `int` exactly for a plain integer token), so its runner derives one from the payload's `float`s and over-large `int`s. **[C]** via the JSON `jwsCases` and every case's `nonWireIntegers` member.

## 2. Document envelope

Six document types, domain-separated by `typ` (unknown or missing `typ` is rejected): **[C]**

| `typ`              | Artifact                  | Signed by                                                                                     | Verified against                                                              |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pkey-license+jws` | License document          | the product key (Worker)                                                                      | the effective product set                                                     |
| `pkey-config+jws`  | Config document           | the product key (Worker)                                                                      | the effective product set                                                     |
| `pkey-trust+jws`   | Trust manifest            | a pinned product key (Worker)                                                                 | the usable pinned product keys (§1)                                           |
| `pkey-bundle+jws`  | Offline activation bundle | a pinned product key (Worker)                                                                 | the usable pinned product keys (§1)                                           |
| `pkey-feed+jws`    | Channel feed              | the product key (Worker)                                                                      | the effective product set                                                     |
| `pkey-release+jws` | Release record            | a release key (CI); a data-only pack record may be signed by a delegated content key (§2.5.4) | the pinned release keys (a content key only through a delegation they verify) |

Shared claims on license and config documents (**the envelope**):

```jsonc
{
  "iss": "key.plrs.im", // ISSUER — a FIXED string, never derived from the base URL (§8)
  "aud": "<product-slug>",
  "deviceId": "<32-char base64url device id>",
  "issuedAt": 1756252800, // unix seconds
  "expiresAt": 1756256400, // issuedAt + DOC_EXPIRY_SECONDS (3600) on the online path
  "graceUntil": 1758844800, // issuedAt + maxOfflineDays*86400, see §3.6
}
```

The trust manifest and the feed are device-less. The release record carries no `iss`: `key.plrs.im` would be false, and the pinned `kid` already names the signer.

Normative constants (all **[C]**): `DOC_EXPIRY_SECONDS = 3600` · `CLOCK_SKEW_SECONDS = 300` · `MAX_GRACE_SECONDS = 31 536 000` (365 d) · `REFRESH_MARGIN_SECONDS = 1800` · `SECONDS_PER_DAY = 86 400` · `MAX_WIRE_INTEGER = 9 007 199 254 740 991` · `MAX_JSON_DEPTH = 64` · `FEED_TTL_SECONDS = 900` · `MAX_FEED_TTL_SECONDS = 3600` · `ROLLOUT_BUCKETS = 10 000` · `MAX_RECORD_JWS_BYTES = 88 844`.

### 2.1 License document (`pkey-license+jws`)

Envelope plus:

```jsonc
{
  "licenseId": "…",
  "profile": {
    /* DocProfile — optional signed greeting/holder block; absent or an object, never null */
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

### 2.2.1 Resolution [C]

Pinned by `config-matrix.json`.

A client resolves a config key from the verified document's `config` map (absent before the
first document), the host's local overrides and the environment, in this order:
`enforced | hidden (remote) > local override > environment > remote default > fallback`. The
source is reported as `enforced`, `hidden`, `local`, `env`, `remote-default` or `fallback`. A
layer holding JSON `null` answers `null`; only `fallback` means that no layer answered. A layer
answers only for a key it holds itself, so a key named like a language built-in
(`constructor`, `toString`) is an ordinary key.

1. **Variable name.** The prefix (default `PKEY_CONFIG_`, §8), then the key with every `.`
   replaced by `__`. Nothing else changes, case included. A variable that is set counts even
   when it is empty. The SDK looks up exactly this name. A host's environment may match names
   more loosely (Windows ignores case), and Swift's environment map is covered in §10.
2. **Variable value.** It is the parsed value when the raw string is one RFC 8259 JSON text
   that meets every rule below, and otherwise the raw string, unchanged:
   - whitespace is only space, tab, LF and CR, so a leading byte order mark is not skipped.
     There is no trailing comma, `NaN`, `Infinity` or leading zero;
   - no object has two members of the same name, at any depth. Names compare as sequences of
     Unicode scalar values after unescaping (RFC 7493 §2.3). So `"a"` and `"\u0061"` are one
     name, and `"\u00e9"` and `"e\u0301"` are two;
   - no member name holds U+0000 (written `\u0000`), at any depth, as §1.2 rule 7 says for
     documents;
   - no string value or member name holds a lone surrogate (RFC 7493 §2.1). That covers an
     escaped one (`"\ud800"`), and a raw one where the host's strings can hold one: a JS
     string can, and Python's `os.environ` holds one for each byte it cannot decode. Swift's
     and Godot's strings cannot hold one;
   - noncharacters (U+FDD0 to U+FDEF, and U+FFFE and U+FFFF in every plane) are ordinary
     characters, escaped or raw. RFC 7493 §2.1 forbids them, but this rule does not, and
     neither does §1.2 for documents;
   - every number in range, judged exactly from its decimal digits, with no floating point.
     Its exponent part has at most six significant digits, and the number is zero or has a
     magnitude of at least 10^−307 and below 10^308 (§1.2 rule 8 for documents). So
     `9.99e307`, `1e-307` and `0e5` qualify; `1e308`, `1e-308`, `5e-324`, `1e400`, a 309-digit
     integer and `0e1000000` do not;
   - at most 64 arrays and objects open at any point (`[[1]]` nests 2 deep), so a deeper text
     is the raw string, whatever its length.

   Reading a variable never fails: every input has one of these two answers, decided from the
   text alone. The parsed value is pinned except in four cases:
   - an integer beyond ±(2^53 − 1) keeps the language's own number type;
   - Godot's number parser is not correctly rounded, so a number can read as another value
     there (§10);
   - a string value holding U+0000 (written `\u0000`) is read by Godot with U+FFFD in its
     place (§10);
   - of two canonically equivalent member names, Swift keeps only the first (§10).

3. **No environment.** A host with no environment layer resolves as though no variable were
   set. This covers React in a browser and in a desktop renderer.
4. **The user-visible list.** Every document entry except `hidden` ones, each with its resolved
   value. `enforced` is true exactly when the state is `enforced`. A key supplied only by a
   local override or by the environment is not listed. The order is not specified.

### 2.3 Trust manifest (`pkey-trust+jws`)

Unchanged in shape (`schemaVersion`, `aud`, `iss`, `issuedAt`, `expiresAt`, `keys[{kid,publicKey,status}]`, `jwksUrl`, `cacheSeconds`). Servers MUST emit a revoked key explicitly, with `status: "revoked"`, for `REVOKED_KEY_LISTING_SECONDS` = 34 560 000 (400 days: the 365-day grace plus the 30-day bundle import window) as a positive prune signal and as the signal that tombstones a pin (§1); clients MUST honour an explicit `revoked` entry but MUST NOT depend on ever seeing one — wholesale replacement (absence-is-revocation) is the mechanism that always applies. (The Worker emits them: `product_keys.revoked_at` is stamped on revocation and the trust manifest lists keys revoked within the window, for the trust manifest only — JWKS and discovery never include a revoked key.)

**Signers.** `GET /<p>/.well-known/polaris-trust.jws?signer=<kid>`: when `kid` is a product key whose status is `active`, `staged` or `retired`, the response is the same manifest signed by that key; otherwise (unknown, revoked, empty) the default manifest, signed by the active key, is served. Same body, `typ` and `cache-control`. A bundle mint takes the same choice (`signerKid`).

**Client fetch rule.** **[C]** via the `trust-signer-retry` transcript. When the default manifest is refused and its header `kid` is not a usable pin (a rotation the app's pins predate, or a revoked active key), the client retries with `?signer=<kid>` for each usable pin in ascending kid byte order (UTF-8 bytes), makes at most `MAX_TRUST_SIGNER_ATTEMPTS` = 4 such requests, and keeps the first manifest it accepts. A default manifest whose signer is a usable pin is never retried. Against a Worker that predates `?signer=` every retry answers the default manifest, which is the old behaviour.

### 2.4 Channel feed (`pkey-feed+jws`)

Signed by the product key (`signDoc(…, "pkey-feed+jws")`). It carries no device id, so every caller of a channel gets identical bytes. Payload cap 65 536 bytes. Every `integer` field is an integer claim (§3.1), checked at its RFC 6901 pointer (`/seq`, `/app/targets/0/release/seq`, …), and every pattern, length and member follows §3.3. **[C]** via `feedCases`.

| Field                                   | JSON type      | Req. | Verifier check (refusal reason)                                                                                                                                                                               |
| --------------------------------------- | -------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                         | integer        | yes  | `=== 1` (`claims`)                                                                                                                                                                                            |
| `iss`                                   | string         | yes  | `=== "key.plrs.im"` (`claims`)                                                                                                                                                                                |
| `aud`                                   | string         | yes  | `===` the product (`claims`)                                                                                                                                                                                  |
| `channel`                               | string         | yes  | matches `CHANNEL_NAME_PATTERN` (`claims`); is not `latest`, and equals the requested name or, when that name is an alias, `CHANNEL_ALIASES[requested]` (`channel`). The claim is the canonical channel (§4.4) |
| `selector`                              | object         | yes  | keys ⊆ {`platform`}; `platform`, when present, a string that equals the client's platform (`selector`). P4 may add keys; a v4 client refuses any key it does not know                                         |
| `seq`                                   | integer        | yes  | ≥ 1 (`claims`); against the floor (`not-newer`, `rollback`; §4.4)                                                                                                                                             |
| `issuedAt`                              | integer        | yes  | ≥ 0 (`claims`); network path: `issuedAt ≤ now + 300` (`freshness`)                                                                                                                                            |
| `expiresAt`                             | integer        | yes  | `issuedAt < expiresAt ≤ issuedAt + MAX_FEED_TTL_SECONDS` (`claims`); network path: `expiresAt > now − 300` (`freshness`)                                                                                      |
| `app`                                   | object         | yes  | the fields below (`claims`)                                                                                                                                                                                   |
| `app.deliverable`                       | string         | yes  | `=== "app"`                                                                                                                                                                                                   |
| `app.versionScheme`                     | string         | yes  | one of `semver`, `semver+build`, `4part`; every version below must parse under it (§11.1)                                                                                                                     |
| `app.targets`                           | array          | yes  | at most one item per `platform` value; when `selector.platform` is set, every item has that platform                                                                                                          |
| `targets[].platform`                    | string         | yes  | matches `FEED_PLATFORM_PATTERN` `^[a-z][a-z0-9-]{0,63}$`. Unknown values that match are allowed; a client reads only its own                                                                                  |
| `targets[].release`                     | object         | yes  | `{sha256, seq, version}`: 64 lowercase hex; integer ≥ 1; a version under the scheme. This is the pin                                                                                                          |
| `targets[].floor`                       | object \| null | yes  | present, and null or `{minVersion}` with a version that parses under the scheme and is not above the pin                                                                                                      |
| `targets[].critical`                    | boolean        | yes  | —                                                                                                                                                                                                             |
| `targets[].outlets`                     | object         | yes  | keys are product outlet ids, `OUTLET_ID_PATTERN` `^[a-z][a-z0-9-]{0,63}$`                                                                                                                                     |
| `outlets.*.kind`                        | string         | yes  | matches `OUTLET_ID_PATTERN` and is not `unknown`. A kind outside the 17 (§8) is allowed and never matches; the client then checks only the types and presence of that entry's other members                   |
| `outlets.*.live`                        | object \| null | yes  | present, and null or `{version, seq}` (a version under the scheme; integer ≥ 1)                                                                                                                               |
| `outlets.*.halted`                      | boolean        | yes  | —                                                                                                                                                                                                             |
| `outlets.*.rollout`                     | object         | no   | `{bp, salt}`: integer 0–10 000; exactly 32 lowercase hex. A present `null` is refused                                                                                                                         |
| `outlets.*.listingUrl`                  | string         | no   | for a known kind: 1–2048 bytes, each from 0x21 to 0x7E, starting byte for byte with one of `LISTING_URL_PREFIXES[kind]` (§11.2). A known kind without prefixes carries none                                   |
| `outlets.*.capabilities`                | object         | no   | any subset of the six capability fields, each in its vocabulary (§11.2); unknown keys are ignored                                                                                                             |
| `packSets`, `packFloors`, `revocations` | —              | no   | the content members (§2.4.1, P4-13): parsed by `feedContent` **beside** the claims, never a claim. A malformed member is unusable and never refuses the feed                                                  |
| `deltas`                                | —              | no   | the delta menu (§2.4.2, P4-29): parsed by `feedContent` beside the claims like the content members, never a claim. A malformed menu is unusable and never refuses the feed                                    |

One feed per (product, canonical channel), requested as `GET /{product}/update/{channel}/feed.jws?platform={platform}`: the Worker answers with the channel-wide document (`selector: {}`) while it fits in 65 536 bytes, and otherwise with the per-platform document for the requested platform (`selector: {platform}`). `seq` is per (aud, canonical channel), shared by every selector document, and bumped when the composed content changes. `expiresAt = issuedAt + FEED_TTL_SECONDS`. A feed is **stale** when `now ≥ expiresAt + CLOCK_SKEW_SECONDS` (`now` the effective clock); the decision then answers `none {stale}` and never updates automatically. Neither the feed nor the record raises the clock floor (§4.2).

### 2.4.1 The feed's content members [C]

P4-13 (`plans/P4-13.md` §2.2) fills the three members P3-01 reserved. They add **no claim**: a claim would change the verdict of existing cases, and a malformed content member must never stop app updates. Each is read by `feedContent(doc, nonWireIntegers) → {packSets, packFloors, revocations}`, which returns each member parsed (known members only) or `null` when it is absent or unusable. The three are independent: an unusable `packSets` leaves the floors and revocations in force. Unknown members are ignored at every level. **[C]** via `feedContentCases` (each a signed, valid feed with `expect.content`), and three appended `feedCases` that prove a v4 verifier that predates P4-13 still accepts populated members (`feed-valid-content-members-populated`, `feed-valid-content-members-per-platform`, `feed-valid-content-at-cap`).

```jsonc
"packSets": {
  "releases": { "<recordSha256>": { "pack": "diceroll.foes", "version": "1.3.4", "seq": 12 } },
  "sets":     { "<packSetId>": ["<recordSha256>", …] },          // members sorted by pack-id bytes
  "rows": [ { "contentApi": 3, "platform": "android", "engine": "godot-4.4", "variant": { "texture": "astc" }, "set": "<packSetId>" } ],
  "outlets":  { "<outletId>": { "pinned": ["diceroll.foes"],
                                "gates": { "<recordSha256>": { "halted": false, "rollout": { "bp": 2500, "salt": "<32 hex>" }, "fallback": "<recordSha256>" | null } } } }
},
"packFloors":  [ { "pack": "diceroll.foes", "contentApi": 3, "minVersion": "1.3.4", "versionScheme": "semver" } ],
"revocations": [ { "record": "<sha256>", "pack": "diceroll.foes", "target": "<sha256>", "version": "1.3.3", "seq": 10 } ]
```

A member is unusable when any rule below fails (patterns whole-string, lengths in bytes, §3.3):

| Member        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packSets`    | an object with `releases`, `sets`, `rows` (all required) and an optional `outlets`                                                                                                                                                                                                                                                                                                                                                                  |
| `releases`    | an object; each key 64 lowercase hex; each value `{pack: a pack id, version: §2.5's version pattern, seq: integer ≥ 1}`                                                                                                                                                                                                                                                                                                                             |
| `sets`        | an object; each key 64 lowercase hex; each value an array of strings, each a key of `releases`, with no pack named twice in one set (an empty set is valid)                                                                                                                                                                                                                                                                                         |
| `rows`        | an array of `{contentApi: integer ≥ 1, platform: FEED_PLATFORM_PATTERN, engine: "" or ENGINE_PATTERN, variant: 0–4 members (VARIANT_AXIS_PATTERN names, VARIANT_VALUE_PATTERN values), set: a key of sets}`; (contentApi, platform, engine, variant key) is unique; when `selector.platform` is set, every row has that platform                                                                                                                    |
| `outlets`     | absent, or an object keyed by `OUTLET_ID_PATTERN`; each value an object whose `pinned` is absent or an array of unique pack ids, and whose `gates` is absent or an object keyed by keys of `releases`, each `{halted: boolean, rollout?: {bp: integer 0–10 000, salt: 32 lowercase hex}, fallback: null or a key of releases}`                                                                                                                      |
| `packFloors`  | an array of `{pack, contentApi: integer ≥ 1, minVersion: version pattern, versionScheme: string}`, (pack, contentApi) unique. An entry whose `versionScheme` is not in `FEED_VERSION_SCHEMES` is **ignored** (a forward value), not fatal                                                                                                                                                                                                           |
| `revocations` | an array of `{record: 64 hex, pack: a pack id, target: 64 hex, version: version pattern, seq: integer ≥ 1, kind?}`; `record` unique (dropped entries included). `kind` (P4-19, §2.5.4): absent for a pack record target, `delegation` for a delegation target; any other `VOCAB_TOKEN_PATTERN` value drops that entry alone (a forward value); a `kind` that is not a string, or a string that is not a vocabulary token, makes the member unusable |

An optional member is absent or of its type; a present `null` is refused (§3.3). The integer members follow §3.1's token rule, read from the verifier's `nonWireIntegers`, at five pointers: `/packSets/releases/*/seq` (minimum 1), `/packSets/rows/*/contentApi` (1), `/packSets/outlets/*/gates/*/rollout/bp` (0, at most 10 000), `/packFloors/*/contentApi` (1) and `/revocations/*/seq` (1). A failure makes that member unusable, the way it does in a side object (§2.6); it is never a claims step.

A set's key is the `packSetId` (§8) of its members; the Worker and the generator assert it, clients do not check it.

**What the Worker puts there.** `rows` are the stored resolution rows (P4-12's `release_sets`, one per group) of the app deliverable on the canonical channel; an unsatisfied pack is simply absent from its row (P4-12's `unsatisfied` marker is not on the wire). `packFloors` holds, for each live level, `max(level-free min_supported, release_pack_floors)` per pack deliverable, pinned packs included. `outlets.<id>.pinned` lists the compatible and standalone packs whose transport on that outlet cannot float (`TRANSPORT_FLOATS[t] === false`, today only `play-pad`). `gates` are per-outlet pack rollouts and halts, composed by P4-14. `revocations` lists the revocations in force (§2.5.3), at most `MAX_FEED_REVOCATIONS` = 64, dropping a revocation only when no stored app release on the channel, live or not, pins, holds or embeds its target and no stored row lists it. A delegation revocation (P4-19) is listed with `kind: "delegation"` and `pack` = the delegation's scope root, is never dropped by that rule (a delegation hash is never pinned, held or listed) and ranks with the referenced revocations when the list is truncated or shed.

**Size.** The payload cap stays 65 536 bytes and `selector` gains no key (a v4 client refuses any selector key it does not know). The Worker signs the channel-wide document while it fits; otherwise the per-platform document with its own rows, only the sets and releases they reference, every floor and revocation, and its target's outlets. When that is still over the cap it sheds content in a fixed order, re-measuring and auditing each step: omit `packSets`; omit `packFloors`; keep only the revocations a stored app release on the channel pins, holds or embeds, or a row lists, plus every delegation revocation; omit `revocations`; and only then P3-03's `500 feed_not_composable`, which content can never cause on its own.

**Clients that predate P4-13.** A v4 SDK built before P4-13 verifies every feed carrying these members byte for byte as before, never fetches a revocation and **keeps mounting a revoked release until the host upgrades its SDK**; it never takes a compatible pack from the feed and runs pinned packs only.

### 2.4.2 The feed's delta menu [C]

P4-29 (`plans/P4-29.md` §2.2) gives the member P4-17 reserved a shape. Like the content members it adds **no claim** and changes no existing verdict: `feedContent(doc, nonWireIntegers)` returns a fourth member, `deltas`, which is `null` when absent or unusable. It is an object keyed by a target **payload** SHA-256 (`to`); each value lists the `payload`-scope deltas to that payload that the Worker offers beside the record's own (the `ready` lazy deltas of P4-17, never a CI delta). **[C]** via 28 appended `feedContentCases` (each with a sibling `expect.deltas`; the 48 older cases pin `null`), `plan-matrix.json#feedDeltaCases` and `content/cases.json#feedDeltaApplyCases` (§11.4).

```jsonc
"deltas": {
  "<to: target payload sha256>": [
    { "from": "<base payload sha256>", "method": "zstd-patch-from", "scope": "payload",
      "memBytes": 1048576, "artifact": { "sha256": "<frame sha256>", "bytes": 325258 } }
  ]
}
```

The member is unusable when any rule fails (patterns whole-string, §3.3):

| Rule                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| an object (a present `null`, an array or any other type is unusable); each key 64 lowercase hex                                                                                                                                   |
| each value an array of 1 to `MAX_FEED_DELTAS_PER_TARGET` (4) entries; the member holds at most `MAX_FEED_DELTAS` (64) entries in total                                                                                            |
| each entry an object: `from` 64 lowercase hex and not equal to its key; `method` and `scope` `VOCAB_TOKEN_PATTERN`; `memBytes` an integer ≥ 1; `artifact` an object with `sha256` (64 lowercase hex) and `bytes` (an integer ≥ 1) |
| `artifact.sha256` unique across the member; (`from`, `method`) unique within a key. Both caps and both uniqueness rules count dropped entries too                                                                                 |

An entry whose `scope` is not `payload` is **dropped alone** (a forward value), and a key whose entries are all dropped is left out. An unknown `method` is **kept**: the planner's `caps.patchMethods` decides, as for record deltas (§3.2). Unknown members are ignored at every level. The integer members follow §3.1's token rule at `/deltas/*/*/memBytes` and `/deltas/*/*/artifact/bytes` (minimum 1); a failure makes the member unusable. P4-17's `size` and `windowLog` are not on the wire: the target size is the record's `payload.size`, and the window comes from the frame header (§2.6).

**Authority.** The menu is inside the feed payload, so the product key's JWS covers it; it carries the Worker's authority, never CI's. A feed delta adds no trust: the applier checks the artifact against the entry, the base against `from`, §2.6's window against `memBytes`, and the output against the **record's** `payload` (§11.4), and falls back on any failure.

**What the Worker puts there.** For each pack record the document names (`packSets.releases`, and the pins and holds of the app records its targets pin), for each `container` variant, the `ready` rows of `release_lazy_deltas` whose `to` is the variant's `payload.sha256`, unless the variant already carries a delta from the same `from` and `method`, the descriptor fails the rules above, or its `windowLog` exceeds `max(10, min(30, ⌈log2(memBytes)⌉))`. Entries rank by the base's installed base, then newest first, then `artifact.sha256` bytes; at most 4 per key and 64 in all. Nothing is listed while `LAZY_DELTAS` is off or the product's `lazy_delta_settings.enabled` is 0. The set of candidate deltas is part of the hashed content, so a delta turning `ready` or `cold` bumps `seq`; a change of rank alone (the installed base moving) does not.

**Size.** The menu never displaces anything. The Worker chooses the document and runs §2.4.1's shedding order **without** `deltas`, then adds entries in rank order while the payload stays within 65 536 bytes, dropping the lowest-ranked first (audited `update.feed.deltas_trimmed`, or `update.feed.deltas_omitted` when none fit). It can never turn a channel-wide document into a per-platform one, shed a content member or cause `feed_not_composable`.

**Clients that predate P4-29.** They ignore the member (`feed-valid-unknown-fields-ignored`, and the appended `feedContentCases` keep `expect.content` to the three P4-13 members) and plan with record deltas only.

### 2.5 Release record (`pkey-release+jws`)

Signed in CI with a release key; the Worker never holds the private half and never signs one. Payload cap 65 536 bytes. It is the release descriptor moved into a signed payload, without the artifact locations (they change after signing) and with `minSupportedSeq`; an app record's `content` and `builds[].embeds` are the descriptor's, moved unchanged, and a `kind: pack` record has no descriptor (`plans/P4-01.md` decision 37). `aud` binds the record to one product even when one release key serves several. **[C]** via `releaseRecordCases`. The members below are common to every kind; a `kind: pack` record adds §2.5.1's and never carries `builds`, and a `kind: app` record's `content` and `builds[].embeds` follow §2.5.2. A record of any other kind keeps the common claims only, and a `content` or `embeds` member on it is ignored.

| Field                              | JSON type | Req.            | Verifier check (refusal step)                                                                                                                                                                                                                |
| ---------------------------------- | --------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                    | integer   | yes             | `=== 1` (`claims`)                                                                                                                                                                                                                           |
| `aud`                              | string    | yes             | `===` the product (`claims`)                                                                                                                                                                                                                 |
| `deliverable`                      | string    | yes             | `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, at most 64 bytes (`claims`); equals the pin's (`cross-check`)                                                                                                                                            |
| `kind`                             | string    | yes             | non-empty (`claims`); equals the pin's `kind`, `app` when the pin names none (`cross-check`). `app`, `pack` (§2.5.1), `revocation` (§2.5.3) and `delegation` (§2.5.4, P4-19) are acted on (`RECORD_KINDS`); `RESERVED_RECORD_KINDS` is empty |
| `version`                          | string    | yes             | `^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$` (`claims`); equals the pin's (`cross-check`). The record names no scheme: the pin's version already parses under the feed's                                                                              |
| `seq`                              | integer   | yes             | ≥ 1 (`claims`); equals the pin's (`cross-check`)                                                                                                                                                                                             |
| `issuedAt`                         | integer   | yes             | ≥ 0 (`claims`); informational otherwise: no freshness, no expiry, no clock floor                                                                                                                                                             |
| `minSupportedSeq`                  | integer   | no              | ≥ 1 (`claims`). The Worker folds it into the floor of each target that pins this record; clients do not evaluate it                                                                                                                          |
| `tag`, `channel`, `title`, `notes` | string    | no              | type only (display)                                                                                                                                                                                                                          |
| `provenance`                       | object    | no              | `{commit?, workflowRun?}` strings; type only                                                                                                                                                                                                 |
| `builds`                           | array     | for `kind: app` | 1–64 items; build ids unique (`claims`). Refused on `kind: pack` (§2.5.1)                                                                                                                                                                    |
| `builds[].id`                      | string    | yes             | matches `BUILD_ID_PATTERN` `^[a-z0-9][a-z0-9._-]{0,63}$` (`claims`)                                                                                                                                                                          |
| `builds[].platform`                | string    | yes             | non-empty; a value outside the platform enum is allowed and never eligible                                                                                                                                                                   |
| `builds[].arch`                    | string    | yes             | non-empty; an unknown string is allowed (never eligible); `universal` and `any` match every device arch                                                                                                                                      |
| `builds[].format`                  | string    | yes             | non-empty                                                                                                                                                                                                                                    |
| `builds[].buildNumber`             | string    | no              | a string when present; informational in v4                                                                                                                                                                                                   |
| `builds[].minOS`                   | string    | no              | type only; informational in v4                                                                                                                                                                                                               |
| `builds[].requires`                | object    | no              | absent or an object (a present `null` is refused). The decision reads `engine` (a string) and `minBinary` (a version under the feed's scheme); `contentApi`, `packs`, `textures` and `formatVersion` are reserved (P4)                       |
| `builds[].artifacts`               | array     | yes             | 0–32 items, at most one with `role: "payload"` (`claims`). An empty list is a store-only build; a build is eligible for self-installation only with exactly one `payload` artifact                                                           |
| `artifacts[].name`, `.role`        | string    | yes             | non-empty; v4 reads only `payload`                                                                                                                                                                                                           |
| `artifacts[].sha256`               | string    | yes             | 64 lowercase hex                                                                                                                                                                                                                             |
| `artifacts[].size`                 | integer   | yes             | ≥ 0                                                                                                                                                                                                                                          |
| `artifacts[].contentType`          | string    | no              | type only                                                                                                                                                                                                                                    |
| `builds[].embeds`                  | array     | no              | `kind: app` only: 0–64 unique pack ids (§2.5.1), the packs the build ships embedded (`claims`, §2.5.2)                                                                                                                                       |
| `content`                          | object    | no              | `kind: app` only: absent or §2.5.2's object (`claims`). Ignored on every other kind                                                                                                                                                          |

A feed pins a record by the **lowercase hex SHA-256 of its exact compact JWS** (ASCII). The record never says where bytes are: an SDK installs through Distribution's `builds` template (`distribution.endpoints.builds`, `{selector}` = the record's `version`, `{buildId}` = the build's `id`, each `encodeURIComponent`-encoded) and verifies the payload's `size` and SHA-256 against the record before staging.

### 2.5.1 Pack record (`kind: pack`) [C]

A pack release is one record with `kind: "pack"`, its variants inside; `deliverable` is the **pack id**. Every object it names is pinned by an **object ref** over the stored bytes, and per-file detail lives in hash-pinned side objects (§2.6), so a record's size never depends on its entry count. Claims check structure, patterns, presence, uniqueness and the integer rule only, and no claim relates two integer members; a value outside a v1 vocabulary makes the governed variant, delta or pack unusable on an SDK that lacks it, never the record invalid (§3.2). **[C]** via `packRecordCases`, whose 80 claim checks each have a case refused by that check alone.

| Field                   | JSON type  | Req.            | Verifier check (`claims` unless stated)                                                                                                                                                                                                                                            |
| ----------------------- | ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliverable`           | string     | yes             | §2.5's pattern, and a pack id: not `app` (§8)                                                                                                                                                                                                                                      |
| `builds`                | —          | absent          | refused when present                                                                                                                                                                                                                                                               |
| `type`                  | string     | yes             | `PACK_TYPE_PATTERN` `^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$`. v1 types: `godot.pck`, `files.tree`                                                                                                                                                                            |
| `formatVersion`         | integer    | yes             | ≥ 1 (per handler: the PCK header's format version for `godot.pck`, 1 for `files.tree`)                                                                                                                                                                                             |
| `handler`               | object     | no              | absent or an object                                                                                                                                                                                                                                                                |
| `handler.mountOrder`    | integer    | no              | ≥ 0                                                                                                                                                                                                                                                                                |
| `handler.prefixes`      | array      | no              | 1–32 unique strings, each `HANDLER_PREFIX_PATTERN` `^res://([A-Za-z0-9_][A-Za-z0-9 ._@+-]*/)+$`, at most 256 bytes                                                                                                                                                                 |
| `handler.activation`    | string     | no              | `VOCAB_TOKEN_PATTERN` `^[a-z][a-z0-9-]{0,31}$`. v1 values: `restart`, `hot`                                                                                                                                                                                                        |
| `entitlement`           | string     | no              | `ENTITLEMENT_PATTERN` `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`: the licence flag that gates the pack's objects, a snapshot of its delivery gate at publish                                                                                                                             |
| `variants`              | array      | yes             | 1–32 objects (`MAX_PACK_VARIANTS`); variant keys (§8) unique; every item declares the same axis names                                                                                                                                                                              |
| `variants[].variant`    | object     | yes             | 0–4 members; names `VARIANT_AXIS_PATTERN` `^[a-z][a-z0-9-]{0,15}$`; values strings matching `VARIANT_VALUE_PATTERN` `^[A-Za-z0-9][A-Za-z0-9-]{0,34}$`                                                                                                                              |
| `variants[].payload`    | object     | yes             | `size` an integer ≥ 0; `sha256` 64 lowercase hex: a container's payload file, or a tree's `treeDigest` (§2.6)                                                                                                                                                                      |
| `variants[].full`       | object ref | yes             | the whole payload as one object (a tree's files concatenated in index order). `full.size` equal to `payload.size` is a publish rule, not a claim                                                                                                                                   |
| `variants[].files`      | object     | yes             | `format` `OBJECT_FORMAT_PATTERN` `^[a-z][a-z0-9-]{0,31}/[1-9][0-9]{0,8}$`; `layout` `VOCAB_TOKEN_PATTERN`; and an object ref's four members, `bytes` and `size` ≥ 1. v1: `pkey-files/1`; layouts `container`, `tree`                                                               |
| `variants[].files.gaps` | object ref | by layout       | required on `container`, refused on `tree`, optional (an object ref when present) on any other layout                                                                                                                                                                              |
| `variants[].deltas`     | array      | no              | 0–16 objects (`MAX_VARIANT_DELTAS`); delta ids unique within the variant (a `payload` delta's id is `artifact.sha256`, a `files` delta's `patch.sha256`, another scope has none)                                                                                                   |
| `deltas[].method`       | string     | yes             | `VOCAB_TOKEN_PATTERN`. v1: `zstd-patch-from`                                                                                                                                                                                                                                       |
| `deltas[].scope`        | string     | yes             | `VOCAB_TOKEN_PATTERN`; `payload` is refused on a `tree` variant. v1: `payload`, `files`                                                                                                                                                                                            |
| `deltas[].from`         | string     | yes             | 64 lowercase hex: the base release's `payload.sha256`                                                                                                                                                                                                                              |
| `deltas[].memBytes`     | integer    | yes             | ≥ 1 (§2.6)                                                                                                                                                                                                                                                                         |
| `deltas[].artifact`     | object     | scope `payload` | `sha256` 64 lowercase hex, `bytes` an integer ≥ 1. Ignored on any other scope                                                                                                                                                                                                      |
| `deltas[].patch`        | object ref | scope `files`   | the `pkey-patch/1` descriptor; `bytes` and `size` ≥ 1. Ignored on any other scope                                                                                                                                                                                                  |
| `deltas[].data`         | object     | scope `files`   | `sha256` 64 lowercase hex, `bytes` an integer ≥ 1: the packed frames and blobs. Ignored on any other scope                                                                                                                                                                         |
| `variants[].requires`   | object     | no              | absent or an object; `engine`, when present, `ENGINE_PATTERN` `^godot-[0-9]+\.[0-9]+$`. Other members are not claims                                                                                                                                                               |
| `variants[].chunks`     | object ref | no              | absent or an object (check 81); `format` `OBJECT_FORMAT_PATTERN` (82); an object ref's four members, `bytes` and `size` ≥ 1; `params` absent or an object (83), informative. Other members are ignored. v2: `pkey-chunks/1` (`plans/P4-10.md` §2.2); valid but ignored on a `tree` |
| reserved                | —          | —               | `variants[].conflicts`, `requires.{contentApi, packs, features}`, record-level `provides` and `removes`, and `content`. Ignored by v1                                                                                                                                              |

An **object ref** is an object `{sha256, bytes, size, codec}`: `sha256` 64 lowercase hex and `bytes` an integer ≥ 0, the SHA-256 and length of the stored bytes; `size` an integer ≥ 0, the decoded length (a row may raise either minimum to 1); `codec` a `VOCAB_TOKEN_PATTERN` string. `zstd` means exactly one zstd frame with its content size; `none` means stored raw and is refused unless `bytes === size`. All four members are required, even for `none`. Every SDK checks object refs with one function (`objectRef` in client-core) at `full`, `files`, `gaps` and `patch`, so the corpus's object-ref cases on `full` stand for every site.

### 2.5.2 App record `content` and `builds[].embeds` [C]

These checks apply to `kind: app` records only. `content` is also the body of the content stamp (§2.7). **[C]** via `packRecordCases`.

| Field                  | JSON type | Req. | Verifier check (`claims`)                                                                                                          |
| ---------------------- | --------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `content`              | object    | no   | absent or an object                                                                                                                |
| `content.contentApi`   | integer   | yes  | ≥ 1                                                                                                                                |
| `content.pins`         | array     | yes  | 0–256 objects (`MAX_CONTENT_PINS`); `pack` unique                                                                                  |
| `pins[].pack`          | string    | yes  | a pack id (§8)                                                                                                                     |
| `pins[].release`       | object    | yes  | `sha256` 64 lowercase hex; `seq` an integer ≥ 1; `version` §2.5's version pattern: a feed target's `release`, naming a pack record |
| `content.expects`      | array     | yes  | 0–256 objects; `pack` unique                                                                                                       |
| `expects[].pack`       | string    | yes  | a pack id (§8)                                                                                                                     |
| `expects[].required`   | boolean   | yes  | a boolean                                                                                                                          |
| `expects[].delivery`   | string    | yes  | `VOCAB_TOKEN_PATTERN`. v1: `essential`, `prefetch`, `on-demand`; any other value is read as `on-demand`                            |
| `content.holds`        | array     | no   | not a claim: read by `holdsOf` beside the claims (below). A malformed list is unusable, never a claim failure                      |
| `content.packChannels` | —         | —    | the Worker's (P4-12); ignored by clients                                                                                           |
| `builds[].embeds`      | array     | no   | 0–64 unique pack ids (`MAX_BUILD_EMBEDS`): the packs the build ships embedded                                                      |

**Holds** (`plans/P4-13.md` §2.4). `holdsOf(content, nonWireIntegers, pointer) → ContentHold[] | null`: `holds` absent reads `[]`; otherwise it must be an array of 0–256 entries, each `{pack: a pack id, unique and not pinned, release {sha256: 64 lowercase hex, seq: integer ≥ 1 by the token rule at `<pointer>/holds/\*/release/seq`, version: §2.5's version pattern}, reason?: string}`; anything else reads `null`, which is **unusable**: the device then takes no feed target for any unpinned pack (`plans/P4-13.md` decision 9). The hold type is `ContentHold` in `@polaris-key/protocol/packs`. Holds reach a device in its content stamp (§2.7), where `parseContentStamp`'s result is unchanged and the caller applies `holdsOf` separately (pointer `""`, the stamp's own non-wire integers). CI writes them with `pkey release content-stamp --hold <packId>@<version>[=<reason>]`. **[C]** via four appended `stampCases`, each with `expect.holds` (a runner compares holds only when `expect.holds` is present).

Cross-record rules (every expected pack is pinned and every pin expected, `embeds` ⊆ pins, a required pack has no `entitlement`, a pin names a stored record of a declared pack) are publish rules, enforced by the CLI and by ingest, never by a client.

### 2.5.3 Revocation record (`kind: revocation`) [C]

A `pkey-release+jws` with `kind: "revocation"` (`plans/P4-13.md` §2.3). It is **signed in CI by a release key**, the same key `pkey release publish` uses. A product key cannot sign one (§3.5 step 13 refuses a release key whose bytes are in the product trust set), and a delegated content key cannot either (P4-19). The Worker can therefore withhold a revocation but never forge one, condemn content or substitute a release. The common claims (§2.5) are unchanged; `deliverable`, `version` and `seq` are the **target's**, so the record names exactly what it revokes:

```jsonc
{
  "schemaVersion": 1,
  "aud": "diceroll",
  "deliverable": "diceroll.foes",
  "kind": "revocation",
  "version": "1.3.3",
  "seq": 10,
  "issuedAt": 1760000000,
  "revokes": "<64 hex: the revoked pack record's hash>",
  "replacement": { "sha256": "<64 hex>", "seq": 11, "version": "1.3.4" }, // optional, same deliverable
  "reason": "Exploit in foes spawn tables", // 1–512 bytes, display only
}
```

`revocationOf(doc, nonWireIntegers)` reads the body beside the claims. It is usable when `kind` is `revocation`; `deliverable` is a pack id (an app build is revoked by License's compatibility window, not by this); `revokes` is 64 lowercase hex; `replacement` is absent or `{sha256: 64 hex, not equal to revokes; seq: integer ≥ 1 by the token rule at /replacement/seq; version: §2.5's version pattern}`; and `reason` is a string of 1 to `REVOCATION_REASON_MAX_BYTES` (512) bytes. `builds` and `content` are ignored.

`verifyRevocation(jws, {releaseKeys, productTrust, expectedAud, entry})` checks a revocation against a feed `revocations` entry: §3.5 steps 12–14 with `entry.record` as the pin hash (`hash`, `jws`, `claims`); step 15 with the pin `{kind: "revocation", deliverable: entry.pack, version: entry.version, seq: entry.seq}` (`cross-check`); and a new step 16, `revocation`: `revocationOf` is usable and `revokes === entry.target`. Keys come from the **pinned release keys** only, never the Worker's trust set.

**The replacement** is verified as a pack record: `verifyReleaseRecord(…, {expectedHash: replacement.sha256, pin: {kind: "pack", deliverable, version, seq}})`; a record of another deliverable fails `cross-check`. It is usable when it verifies, is not itself revoked, and `selectVariant` picks a variant for the host (engine and axes). The contentApi range is guaranteed at ingest, never checked by a client.

**Permanence and superseding.** Revocations are permanent: there is no un-revoke, and a wrong revocation is fixed by a newer release. CI may sign a further revocation of the same target that adds or changes `replacement` (or `reason`). Among revocations of one target the newest `issuedAt` wins, ties broken by the higher record hash by bytes: `newerRevocation(a, b)` in client-core `record.ts` (ported in every SDK) decides it on the device, and the Worker ranks superseding submits with the same function. **[C]** via `revocationCases` (release key `djdl-release-test-2026`): valid with and without a replacement, a 512-byte `reason`, the second (2027) key; signed by the product key and a non-pinned `kid` (`jws`); a body that does not match `entry.record` (`hash`); a wrong entry pack, version or `seq`, and `kind: app` (`cross-check`); `deliverable: "app"`, a missing, bad or mismatched `revokes`, `replacement.sha256 === revokes`, a `replacement.seq` token `1.0` or 0, a missing or 513-byte `reason` (`revocation`); replacement mode (another deliverable fails `cross-check`); and the superseding cases (`revocation-supersedes-replacement`, `revocation-supersede-tie`, `revocation-supersede-older-loses`). `releaseRecordCases` is untouched: `record-valid-kind-revocation-verify-only` still verifies as before.

### 2.5.4 Delegation record (`kind: delegation`) [C]

A `pkey-release+jws` with `kind: "delegation"` (`plans/P4-19.md` §2.2). It is **signed in CI by a pinned release key** and lets one content key sign tree-layout pack records of the data-only types under a pack-id scope, inside a signing window. Only a pinned release key verifies it, so the Worker can neither forge nor widen one. The common claims (§2.5) are unchanged; `deliverable` is the **scope root**, a pack id:

```jsonc
{
  "schemaVersion": 1,
  "aud": "diceroll",
  "deliverable": "diceroll.events", // the scope root: a pack id, not "app"
  "kind": "delegation",
  "version": "3", // the CLI writes the decimal seq; display only
  "seq": 3, // per (product, deliverable), ≥ 1
  "issuedAt": 1760000000, // the window opens
  "expiresAt": 1775552000, // the window closes; ≤ issuedAt + MAX_DELEGATION_TTL_SECONDS
  "delegate": { "publicKey": "<base64url, 32 raw Ed25519 bytes>" },
  "types": ["files.tree", "data.json"], // 1–MAX_DELEGATION_TYPES (8), unique
  "notes": "Events team, 2026", // optional, display
}
```

`delegationOf(doc, nonWireIntegers) → DelegationBody | null` reads the body beside the claims. It is usable when `kind` is `delegation`; `deliverable` is a pack id (`isPackId`); `delegate` is an object whose `publicKey` is strict base64url (§1) of exactly 32 bytes (43 characters, zero trailing bits); `types` is an array of 1–`MAX_DELEGATION_TYPES` (8) unique `PACK_TYPE_PATTERN` strings whose **effective types**, `types ∩ DELEGABLE_PACK_TYPES` in the record's order, are not empty; and `issuedAt` (minimum 0), `seq` (1) and `expiresAt` (1) are integers by §3.1's token rule with `issuedAt < expiresAt ≤ issuedAt + MAX_DELEGATION_TTL_SECONDS` (31 622 400, 366 days). Unknown and non-delegable `types` entries are ignored, so a later SDK that grows the list does not invalidate today's delegations. `builds`, `content` and unknown members are ignored. `DELEGABLE_PACK_TYPES` is `files.tree`, `data.json`, `l10n.table`: `godot.pck` and `godot.zip` mount scripts, `audio.bank` may be a Godot audio pack, `ml.model` may need custom-op runtimes and a `custom.*` handler may execute what it loads, so none of them is ever delegable.

**The delegated kid.** A pack record signed by the content key carries the header `kid` `pkd1-<the delegation's record hash>`, matching `DELEGATED_KID_PATTERN` `^pkd1-[0-9a-f]{64}$` (69 bytes, longer than any declared release-key kid, so the two can never collide). `delegationHashOf(jws)` reads it from the protected header alone and returns the hex, or null for any other kid. The device fetches the delegation by that hash from `release.endpoints.record`, verifies it, then verifies the record with the delegated key (§3.5). The chain never depends on a Worker-signed member, and the record's payload is parsed only after its own signature verifies.

`verifyDelegation(jws, {releaseKeys, productTrust, expectedAud, expectedHash})` runs §3.5 steps 12–14 on the delegation against the **pinned release keys only** (the ASCII bound, the hash, the product-key refusal, the signature, the claims), then `kind === "delegation"` and `delegationOf`. A delegation is never verified through another delegation: one level only, so a content key cannot re-delegate.

**Where the delegated path is allowed.** Only on a compatible or standalone pack's feed target (`packs.install`, `ensure()`) and on the reload of a stored delegated install (`PackInstall.delegation`, the delegation's compact JWS verbatim, whose hash must equal the record's kid hex). Never for an app record, a stamp or record pin, a hold, a revocation, a replacement, a marker or an embedded baseline: there no delegation is passed, so a delegated record fails step 13 (`jws`). A delegated release can satisfy a `required` pack through a feed target, which is why revoking a delegation can stop the boot (`revoked-content`).

**`recordRevoked(recordSha256, delegationSha256 | null, revoked) → "record" | "delegation" | null`** is the one rule for applying revocations to a release: `record` when the release's own hash is revoked, else `delegation` when the delegation it was signed under is (`pack-revoked`, detail `delegation`), else null. It is pure and ported to every SDK.

**Revocation and rotation.** A delegation is revoked by §2.5.3's record unchanged: `deliverable`, `version` and `seq` are the delegation's and `revokes` is its hash; a `replacement` is refused at ingest and ignored by a device. The feed entry carries `kind: "delegation"` (§2.4.1). Like every revocation it is permanent. One content key maps to one delegation (ingest refuses a key any stored delegation already names), so revoking a delegation revokes its key for every delegation the release-key holder has; rotation is a new key and a new delegation, then a revocation of the old one. Releases already installed under a delegation stay valid after its window closes; only a revocation stops them.

**Clients that predate P4-19.** A delegated record's kid is not a pinned release key, so a v4 SDK built before P4-19 refuses it at step 13 (`jws`) and keeps what it runs; a required pack whose only release is delegated stays missing, as on a failed fetch. A `kind: delegation` record verifies as a reserved kind and is never fetched; a `revocations` entry with `kind: "delegation"` parses as before (unknown members are ignored) and its target is never in H. No field client half-accepts anything, so `PROTOCOL_VERSION` stays 4.

**[C]** via `delegationCases` (46, release keys `djdl-release-test-2026` and `-2027`, a deterministic test content key): valid `files.tree` and `data.json` packs, the scope root itself, a delegation by the 2027 key, both window ends, ignored unknown types, a release kid that ignores a supplied delegation and the delegation verified as a record; `delegation` for an unpinned or product-key signer, a hash mismatch, an app record, a content-key signer, missing, ineffective, too many or duplicate `types`, a window over 366 days or inverted, an `expiresAt` token `1.8e9`, a malformed key, a key that is a release or product key, and `deliverable: "app"`; `jws` for no delegation supplied, a wrong signer, a malformed kid, a revocation signed by the content key and an app record on an app path; `scope` for `godot.pck`, an undelegated type, a container variant, a pack outside the scope or sharing only its characters (`djdl.eventsx`), a record outside the window, an app record and a delegation signed as a record; the delegation revocation (with and without a replacement) and `recordRevoked`; and three feeds for the entry `kind`.

### 2.6 Payload formats and byte rules [C]

Every pack object is a blob of the product's blob store, named by the SHA-256 of its stored bytes and served by `distribution.endpoints.blobs`. A device checks the stored SHA-256 and length against the object ref before it decodes anything, and the decoded length against `size`. Side objects, markers and stamps are parsed with §1.2's strict JSON, and every integer member in them is decided by §3.1's token rule, minimum 0 unless stated; a failure there is the side object's own code, never a claims step. **[C]** via the content corpus, `conformance/corpus/v2/content/cases.json` (`contentCorpusVersion` 2): `pathCases`, `filesIndexCases`, `chunkIndexCases`, `applyCases` (full, `payload` delta, `file` and `chunk` apply over a real v1 → v2 pair, with their negatives and counters) and `frameWindowCases`, over the committed blobs in `content/blobs/`. `plans/P4-01.md` §2.7 and §2.9 are the long form; the integrator-facing page is `/docs/build/wire/packs/` (`packages/docs/src/content/docs/build/wire/packs.md`).

- **`pkey-files/1`**, the files index: `{format, layout, payload {size, sha256}, files[]}` with at most `MAX_INDEX_FILES` = 100 000 entries, each `{path, size, sha256, blob {sha256, bytes, codec}}` plus `offset` in a container. A blob's `codec` is `zstd` or `none` (`none`: `bytes === size` and `blob.sha256 === sha256`); any other codec is a parse failure. Container entries are in non-decreasing offset order, each starting at or after the end of the one before, the last ending at or before `payload.size`, and `payload.size` − Σ `size` equals `gaps.size`. Tree entries are in strictly ascending path byte order and their sizes sum to `payload.size`. `parseFilesIndex` refuses, in order: a declared `size` above `MAX_FILES_INDEX_BYTES` = 33 554 432 (before anything is fetched or decoded), a stored or decoded mismatch against the ref, strict JSON or the integer rule, and the member rules (`files-index-invalid`); the path rules in index order (`files-unsafe-path`, `files-duplicate-path`, `files-case-collision`, `files-path-conflict`, with the path); the layout (`files-layout-mismatch`; a tree's order, total or `treeDigest`, `files-index-invalid`). The limit is not a claim: a later version may raise it, and a v1 SDK then finds the larger index unusable.
- **Path rules.** 1–1 024 UTF-8 bytes (`MAX_PACK_PATH_BYTES`); every character in U+0020–U+007E except `\ : * ? " < > |`; segments split on `/`, none empty, `.` or `..`, none ending in a space or `.`, none whose part before the first `.` is, ASCII-case-insensitively, `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` or `LPT1`–`LPT9`; and a first segment `.pkey` (any case) is refused, because a tree's marker lives there. In index order: an exact duplicate, an ASCII-case-insensitive duplicate, and a path that is a directory prefix of another (or has one as its prefix) are refused; the later path is reported. They run before any byte is written.
- **`treeDigest`**: the lowercase hex SHA-256 of the UTF-8 text made of one line `<sha256hex> <size> <path>\n` per file, sorted by path bytes; `size` in decimal without leading zeros; an empty tree hashes the empty string.
- **`pkey-patch/1`**, a `files`-scope delta set's descriptor: `{format, scope: "files", method, from, to, data {sha256, bytes}, entries[]}`, where `method`, `from` and `data` equal the record's delta and `to` the variant's `payload.sha256`; each entry `{path, op: "delta" | "blob", to, size, offset, length}` with `from` on a `delta` entry and `codec` on a `blob` entry. Entries cover exactly the target files whose hash is not in the base, in target index order, their byte ranges following the container layout rule within `data.bytes`. Any failure is `delta-artifact-mismatch`.
- **`pkey-chunks/1`**, the chunk index (`plans/P4-10.md` §2.3), binary and little-endian: a 64-byte header (`PKEYCHNK`, `version` u16 1, `recordSize` u16 48, `flags` u32 with bit 0 `fileAware`, `chunkCount` u32, `bundleCount` u32, `payloadSize` u64, `payloadSha256`), then `chunkCount` 48-byte records `id[32] | len u32 | clen u32 | bundle u32 | offset u32` in payload order (`id` the SHA-256 of the uncompressed chunk; `clen == len` stored raw, `clen < len` one zstd frame of content size `len`), then `bundleCount` 48-byte records `sha256[32] | size u64 | reserved u64`. **The u64 rule:** every SDK reads a u64 as `hi × 2^32 + lo` from two u32 reads, low word first, saturated at 2^53, never with a native 64-bit read, through a `DataView` or an aligned copy. `parseChunkIndex(stored, ref, payload | null)` returns the first failure in this order: `ref.size` above `MAX_CHUNK_INDEX_BYTES` (16 MiB, before anything is fetched), the stored SHA-256 or length, the decode or the decoded length (`chunks-ref-mismatch`); length < 64 (`chunks-bad-length`); magic, version, record size, flags (`chunks-bad-magic`, `-unsupported-version`, `-bad-record-size`, `-bad-flags`); length ≠ 64 + 48 × (chunkCount + bundleCount) in exact arithmetic (`chunks-bad-length`); each bundle's `reserved` ≠ 0 (`chunks-reserved-nonzero {bundle}`); each chunk's `len == 0`, `clen == 0 || clen > len`, `bundle ≥ bundleCount`, `offset + clen > bundles[bundle].size` (`chunks-zero-length`, `-bad-clen`, `-bad-bundle-ref`, `-bad-bundle-range`, each `{chunk}`); Σ len ≠ `payloadSize` (`chunks-size-mismatch`); with `payload`, a different `payloadSha256` or `payloadSize` (`chunks-payload-mismatch`). `MAX_CHUNK_BYTES` (4 MiB) bounds one chunk's `len`: the format does not refuse a longer chunk, and `planTarget` treats an index holding one as unusable (§11.4). Bundles are blobs; a device fetches a run with one single-range request and hashes every chunk before use. **[C]** via `chunkIndexCases` (22) and the eight `strategy: chunk` `applyCases` (`chunk-bundle-truncated`, `chunk-corrupt`, `payload-hash-mismatch`; applied by P4-11's SDKs).
- **Codec, publish and decode.** Every compressed object is exactly one zstd frame with the content-size flag, or stored raw. A `zstd-patch-from` frame is bare `zstd --patch-from` output, applied with raw-content prefix semantics (the whole base is the frame's prefix). `memBytes` is the most memory one frame needs: a `payload` delta's base size plus payload size; a `files` set's largest base entry plus new entry. CI never publishes a `zstd-patch-from` delta whose base starts with zstd's dictionary magic `37 A4 30 EC`. Before it decodes a delta frame an applier reads the frame header's window (`frameWindow`: RFC 8878 §3.1.1 from the bytes alone, Frame_Content_Size for a single-segment frame, else the Window_Descriptor; null for a bad magic, a set reserved bit or a short header; saturated at 2^32) and refuses a null window or one above 2^`windowLogMax` as `delta-apply-failed`, where `windowLogMax = max(10, min(P, ⌈log2(memBytes)⌉))` in integers (⌈log2(m)⌉ is the bit length of m − 1; P is 31 for a 64-bit decoder, 30 for a 32-bit or wasm32 one). No decoder parameter replaces the check, because libzstd enforces its own window limit only on its buffered streaming path (`plans/P4-01.md` §2.7 rule 3); `delta-whole-window-over-mem-bytes` and `file-delta-tree-small-window` pin the bound and its floor.

### 2.7 Marker and content stamp [C]

**Marker** (`pkey-marker/1`): `{format, packId, version, release}`, where `release` is the pack record's compact JWS; no new `typ`, the signature is the record's own. It sits beside a single-file payload `X` as `X.pkey.json`, and inside a tree payload rooted at `D/` as `D/.pkey/pack.json`, which no files index lists. One marker covers every variant: the device picks the variant whose `payload` its bytes match. Verified in §3.7's order. **[C]** via `markerCases`.

**Content stamp** (`pkey-content.json`, `pkey-content/1`): the app record's `content` plus `format`, written by CI before the export and embedded in every build, so the running build learns its own pins, `required` and `delivery` offline. It is parsed with strict JSON; `format === "pkey-content/1"`; its `contentApi`, `pins` and `expects` pass §2.5.2's claims; otherwise `content-stamp-invalid`. It is unsigned and exactly as trustworthy as the build that carries it (§10). **[C]** via the content corpus's `stampCases` (P4-04).

### 2.8 Data-only rule [C]

A release signed by a delegated content key passes **`dataOnlyRefusal(path, head, tail, full) → "extension" | "content" | null`** for every file of every variant it installs (`plans/P4-19.md` §2.5). It applies to delegated installs only; release-signed packs keep their own rules. `head` is the file's first `DATA_ONLY_HEAD_BYTES` (64) decoded bytes and `tail` its last `DATA_ONLY_TAIL_BYTES` (65 557 = the 22-byte zip end record plus its 65 535-byte comment); for a short file they are fewer and may overlap; `full` is the whole decoded file (Amendment A1). In order:

1. **The path is already normalised**: it passes the files index's path rules (§2.6: no empty, `.` or `..` segment, no leading or trailing `/`, no `\` or `:`, nothing ending in `.` or a space), so Godot's `simplify_path()` is the identity on it. Otherwise `extension` (normally the path rules refuse it first).
2. **Extension allow-list** (`DATA_ONLY_EXTENSIONS`): the final segment's text after its last `.`, ASCII-lowercased, is one of `json`, `csv`, `tsv`, `po`, `txt`, `png`, `jpg`, `jpeg`, `webp`, `ogg`, `wav`, `mp3`, `ttf`, `otf`; no extension is refused (`extension`). Godot chooses its resource loader by extension, so `.tres`, `.material`, `.theme`, `.translation`, `.res`, `.gd`, `.remap`, `.import` and every future loader extension are refused because they are not on the list. **The allow-list is the real control**; rules 3 and 4 are defence in depth that fail closed.
3. **Head sniff, by content, never by extension.** Skip a UTF-8 BOM and then ASCII whitespace inside `head`; the file is refused (`content`) when what remains starts with `RSRC`, `RSCC`, `GDPC`, `GDEC`, `GCPF`, `GDSC`, `[gd_`; `PK\x03\x04`, `\x7fELF`, `MZ`, the five Mach-O magics (`FEEDFACE`, `FEEDFACF`, `CEFAEDFE`, `CFFAEDFE`, `CAFEBABE`), `\0asm`; `#!`, `@tool`, or `extends` or `class_name` followed by a space or a tab. When `head` is a full window (64 bytes, which may cut the file), it is also refused when the skip reaches its end, or when the window's end cuts a refused head (what is visible is a prefix of a magic, or `extends`/`class_name` whose following byte lies beyond the window): Godot's text-resource loader and the GDScript tokenizer skip any amount of leading whitespace (`plans/P4-19.md` Amendment A1).
4. **Tail sniff (appended archives).** Refused (`content`) when `tail`'s last 4 bytes are `GDPC` (a PCK appended to another file, which `load_resource_pack` finds from the end), or `PK\x05\x06` (a zip end-of-central-directory record) appears anywhere in `tail`.
5. **Text rule** (Amendment A1), for the text extensions `json`, `csv`, `tsv`, `po`, `txt`, over `full` (`dataOnlyTextRefusal`): refused (`content`) when the bytes are not valid UTF-8 or hold a NUL; when the text, or the text with every backslash removed, holds any of the script markers `GDScript`, `CSharpScript`, `ScriptExtension`, `script/source`, `source_code` (P4-08's list); or when it holds a `\u` escape not followed by exactly 4 hex digits, a `\U` escape not followed by exactly 6 (VariantParser's form), or either decoding below 0x80 (an escape that could spell ASCII; escapes of non-ASCII characters, surrogate halves included, pass, because Python's `json.dumps` and .NET's `System.Text.Json` write one for every non-ASCII character). Ordinary text that mentions a marker (a string "Learn GDScript", a JSON key `source_code`) is refused too: publishers must rename such keys or reword such text. VariantParser readers (`str_to_var`, `ConfigFile`, `JSON.to_native` with objects) build an inline `Object(GDScript, "script/source": …)`, which compiles when set. Without `full`, a text file is refused.

**What the sniffs cover.** Binary and structured magics, a full window they cannot see past, and the text markers above. They cannot recognise GDScript in general (a script may begin with a comment, `func`, `var` and more). Apps must parse delegated text only with pure JSON or CSV parsers (`JSON.parse`, `JSON.parse_string`), never `str_to_var`, `ConfigFile` or `JSON.to_native(..., allow_objects)`, and must never write delegated bytes under a code extension.

**Where it runs.** On the device: the extension rule over the parsed files index before any payload object is fetched, and both sniffs on each file's decoded bytes as the applier writes it (full, file and delta strategies alike; a `noop` plan re-sniffs the install it reuses); a refusal aborts the plan, discards staging and raises `pack-not-data-only` (detail the rule, `path` the file). In the CLI lint, before signing, over the real files. At ingest, the extension rule over the parsed index paths (`delegation-data-only`). No SDK or handler ever passes a delegated file to `load_resource_pack` or any engine API that mounts or loads code; the rule cannot police what host code does with a JSON file. **[C]** via `content/cases.json`'s `dataOnlyCases` (76; a case is `head ‖ tail`, with `tailFill` for a long repeated tail, or a whole-file `content`): each extension accepted (and `A.JSON`), no extension and eleven loader or archive extensions refused, `x.json.gd` refused and `x.gd.json` accepted, each of the 20 heads refused inside a `.json`, a trailing `GDPC` and a zip end record in the tail refused, a zip end record just outside the tail accepted (the tail bound), a BOM and whitespace before `[gd_scene` refused, a full 64-byte window of whitespace refused (with or without `[gd_` after it) and 10 bytes of it accepted, `extends` cut by the window's end refused, an empty file accepted, nine paths that are not already normalised refused, and the text rule's cases (an inline script object, a backslash-split marker, `\u` and `\U` escapes that decode to ASCII or are malformed, invalid UTF-8 refused; non-ASCII escapes and a marker inside a `.png` accepted).

## 3. Claim validation

Two validation profiles per licence and config document, selected by `checkFreshness`: **[C]**

- **Network path** (`checkFreshness: true`): `now` is the **effective clock** (§4.2) in licence, config and trust-manifest verification, never the bare system clock. Reject if `now > expiresAt + CLOCK_SKEW_SECONDS` or `issuedAt > now + CLOCK_SKEW_SECONDS`. A stale or future-dated document must never enter the cache.
- **Reload path** (`checkFreshness: false`): the document is _expected_ to be past `expiresAt` (that is what offline operation is); only `graceUntil` bounds it, enforced by the gate against `effectiveNow` (§4.2). Used for cache reload **and bundle import** (§7).

**Required floor.** Every licence and config verify call names its per-type floor. "No floor" is an explicit `null` (`lastAcceptedIssuedAt: number | null`), never an omitted argument: a call that names no floor is a type error in a typed SDK and a rejection in an untyped one.

Always enforced on both paths, both document types **[C]**: `typ` matches expectation · `iss === "key.plrs.im"` · `aud` equals the expected product · `deviceId` equals the local device id · `graceUntil ≥ expiresAt` · `graceUntil ≤ issuedAt + MAX_GRACE_SECONDS` (a hostile signer cannot grant a century of grace) · anti-replay: a document with `issuedAt` lower than the currently-accepted document's `issuedAt` for the same type is rejected (per-type floors). The feed has the same two profiles (§4.4); the record has no freshness at all.

### 3.1 Integer claims [C]

The integer claims are every field typed `integer` in §2.4, §2.5, §2.5.1 and §2.5.2, and these v3 claims: `issuedAt`, `expiresAt` and `graceUntil` of the licence and config documents; `schemaVersion` of the config document and of the trust manifest; and `issuedAt` and `expiresAt` of the trust manifest and of the bundle. A verifier accepts an integer claim only when both hold:

1. its token is a **plain integer token**, `-?(0|[1-9][0-9]*)`, with no fraction part and no exponent part;
2. its value lies from the claim's minimum to `MAX_WIRE_INTEGER` = 2^53 − 1.

Only then does the claim's own check run (`=== 1`, `≥ 1`, the freshness window, …), and `true` or `false` is never a number. The verifier decides rule 1 from the token, never from the number a parser made of it: `7.0`, `17e8`, `7.5` and `7.0000000000000001` are all refused in an integer claim (`isWireInteger` in client-core, `_wire_int` in Python, `wireInteger` in Swift, `PKeyClaims.is_wire_integer` in GDScript). Every other number in a document (an entitlement or config value, a member of `requires`, an unknown member) is a value, and §1.2 rule 8 is its only constraint.

**Minimums.** Every timestamp's minimum is 0; every `schemaVersion` and `seq` is 1; `rollout.bp` is 0 (at most 10 000); `artifacts[].size` is 0:

| Path (`*` is any index or member)                                                                         | Minimum   |
| --------------------------------------------------------------------------------------------------------- | --------- |
| licence and config `issuedAt`, `expiresAt`, `graceUntil`                                                  | 0         |
| config `schemaVersion`; trust `schemaVersion`                                                             | 1         |
| trust `issuedAt`, `expiresAt`; bundle `issuedAt`, `expiresAt`                                             | 0         |
| feed `schemaVersion`, `seq`, `/app/targets/*/release/seq`, `/app/targets/*/outlets/*/live/seq`            | 1         |
| feed `issuedAt` (0), `expiresAt` (1), `/app/targets/*/outlets/*/rollout/bp` (0)                           | as listed |
| record `schemaVersion`, `seq`, `minSupportedSeq` (1); `issuedAt`, `/builds/*/artifacts/*/size` (0)        | as listed |
| pack `/formatVersion` (1), `/handler/mountOrder` (0)                                                      | as listed |
| pack `/variants/*/payload/size`, `/variants/*/full/bytes`, `/variants/*/full/size`                        | 0         |
| pack `/variants/*/files/bytes`, `/variants/*/files/size`                                                  | 1         |
| pack `/variants/*/files/gaps/bytes`, `/variants/*/files/gaps/size`                                        | 0         |
| pack `/variants/*/deltas/*/memBytes`, `…/artifact/bytes`, `…/patch/bytes`, `…/patch/size`, `…/data/bytes` | 1         |
| pack `/variants/*/chunks/bytes`, `/variants/*/chunks/size` (`plans/P4-10.md` §2.2)                        | 1         |
| app `/content/contentApi`, `/content/pins/*/release/seq`                                                  | 1         |

The content members (§2.4.1), the delta menu (§2.4.2), `holds` (§2.5.2) and the revocation's `/replacement/seq` (§2.5.3) apply the same token rule and minimums, but a failure there makes the member unusable; it is never a claim and is not counted among the 39 paths.

The corpus gives every one of the 39 paths a token case, a bound case (unless another check refuses every value above 2^53 − 1) and a minimum case (unless another check implies the minimum), and the generator proves each breaks its path alone. No claim relates two integer members, and every pack integer case's object refs use codec `zstd`, so each of the 18 pack and `content` paths has all three.

### 3.2 Members outside the claims [C]

A verdict depends only on the claims and on these member checks:

- licence: `licenseId` is a non-empty string; `entitlements` is an object; `profile` is absent or an object (a present `null` is refused);
- config: `config` and `secrets` are objects;
- trust manifest: `keys` is an array of objects with a string `kid` and `publicKey`, and anything else refuses the manifest. A key whose `alg`, `kty` and `crv` are not `EdDSA`, `OKP` and `Ed25519` is skipped, so is a key whose `publicKey` is not canonical base64url, and a key is kept only for `status` exactly `active`, `staged` or `retired` (`revoked` drops it and may tombstone a pin, §1; anything else skips it);
- bundle: `bundleId` is a non-empty string, `trust` a string, and `docs` an object whose `license` and `config` are each absent or a string, at least one present (a present `null` is refused). Every bundle member failure is `bundle-claims-rejected`.

Nothing else is checked: not an entry's `state`, `value` or `updatedAt`, not a profile's members, not the trust manifest's `jwksUrl` or `cacheSeconds`. A typed decoder (Swift's) reads them totally: a non-object entry reads `{state: default, value: null, updatedAt: 0}`, an unknown `state` reads `default`, a non-integer `updatedAt` or `activatedAt` reads 0, a non-string member reads "".

**Forward compatibility of pack records.** A pack record is refused only for §2.5.1's and §2.5.2's checks and the integer rule. Everything a later package extends is checked only for its pattern, and a value the SDK does not know makes the governed thing unusable while the record still verifies: an unknown `type`, `formatVersion` or `handler.activation` makes the pack unusable (`pack-type-unsupported`); an unknown `files.format` makes the index unusable; an unknown `files.layout` makes the variant unusable; an unknown object-ref `codec` makes that object unusable; an unknown delta `method` makes the delta infeasible and an unknown `scope` drops it; a variant on an axis the host has no preferences for is ineligible; an unknown `delivery` reads as `on-demand`. A member of the other delta scope is ignored, not refused, and `full.size` need not equal `payload.size` for a record to verify (such a `full` is unusable).

### 3.3 Patterns, lengths and presence [C]

1. **A pattern matches the whole string**, with nothing after the match, a line terminator included. JavaScript uses the pattern with no flags; Python `re.fullmatch`; Swift `\A…\z` (`wholeMatches`); GDScript `\A…\z` (`PKeyClaims.matches_whole`). Every class is ASCII: `[0-9]`, never `\d`.
2. **A length counts UTF-8 bytes.** Every bounded string in §2.4, §2.5, §2.5.1 and §2.5.2 is ASCII by its pattern, or must be (`listingUrl`).
3. **Presence.** A required member must be present; `null` satisfies it only where its type includes `null` (`targets[].floor`, `outlets.*.live`). An optional member is absent or of its type, and a present `null` is refused. A payload that verifies but does not decode into an SDK's types fails at the claims step with that family's claims reason, never at the signature step.

### 3.4 Feed verification order [C]

`now` is the effective clock (§4.2). Steps 3–8 are pinned by `feedCases` (each case's `reason`):

1. Read `update.endpoints.feed` and `release.endpoints.record` from discovery; if either is absent, refuse with `service-unavailable` before dialling (the host falls back to `update.check()`).
2. Fetch the feed with the requested name as `{channel}`; a body equal to the committed feed of a name step 5 binds to is no change.
3. `verifyJws` with the **effective** product trust set and `typ` `pkey-feed+jws`, §1.1 and §1.2 included (`jws`).
4. The claims of §2.4 (`claims`).
5. Channel binding: the `channel` claim is not `latest`, and equals the requested name or, when that name is an alias, `CHANNEL_ALIASES[requested]` (`channel`). From here on the claim is the canonical channel.
6. Selector (`selector`).
7. Network path only: freshness at `now` (`freshness`).
8. The `seq` floor of the canonical channel (§4.4): `seq > floor.seq`, or `seq == floor.seq` with `issuedAt > floor.issuedAt`, accepts; `seq == floor.seq` with `issuedAt ≤ floor.issuedAt` is `not-newer` (kept silently); `seq < floor.seq` is `rollback`.
9. Commit the feed under its claim; after an alias answer, remove the requested name's entry.

**Content steps 10–14** (`plans/P4-13.md` §2.5, informative; numbered as in that plan, and distinct from §3.5's record steps). P3-05's `runUpdateCheck` runs them after the record is fetched:

10. `feedContent` over the committed feed, with its verified `nonWireIntegers`.
11. **Relevant revocations.** H is the device's active pack records (installed or embedded), its stamp's pins and holds, and the feed targets §11.1 selects, gate fallbacks included. An entry with `kind: "delegation"` (P4-19) is also relevant when its target is the delegation hash of an active install, or its `pack` covers, by whole segments, a pack in H's pack set (the stamp's expects, pins and holds, active installs, feed targets). For each relevant `revocations` entry (`target` in H, or a relevant delegation entry) and that is not yet stored, or stored with a different `record` (a superseding revocation): fetch `release.endpoints.record` by `entry.record` (at most `MAX_FEED_REVOCATIONS` = 64 per check), run `verifyRevocation`, and on success store it when the target is new or its `issuedAt` wins under `newerRevocation`. A failed fetch retries at the next check; a failed verification is ignored and logged, never trusted.
12. For each stored revocation whose target is in H and that names a replacement: fetch it, verify it and run `selectVariant`; the result is `replacementUsable`. An unfetched replacement is neither usable nor judged unusable and retries at the next check, so a revoked required pack keeps blocking until it arrives; only one that fetched and failed verification or `selectVariant` is unusable for good.
13. The rollout bucket for each gate `salt`, with §11.1's formula.
14. `decideUpdate` with `content` (§11.1). `decideUpdate` and `update-matrix.json` are unchanged by P4-19: the caller adds to `content.revocations` one entry `{target: <recordSha256>, pack, replacement: null, replacementUsable: false}` for each release whose delegation `recordRevoked` names, covering every active install and every feed-target record already fetched and verified in this process (a feed target not yet fetched is refused at install, and is then known for the rest of the process).

**Applying a `packs` answer.** The boot's FETCH installs the entries of `packs.install` whose pack is `required` or `essential` before mount, with the usual consent and progress events, and the others in the background (activation per pack type). Packs in `packs.revoke` are deactivated and never mounted. The pack engine **refuses to activate or mount a release whose hash is revoked** (client code `pack-revoked`), embedded baselines and pinned packs included; the boot's FETCH treats such a pack as missing.

**Persistence: `revocations.json`.** Revocations live in a sibling document beside the pack state, never inside it, so an unparseable `state.json` cannot lose them and a lost revocation file cannot touch the install state. Its shape is `{v: 1, revoked: {[targetSha256]: {jws, pack, version, seq, record, issuedAt}}, relearn: [packId]}`: each entry is the winning revocation's compact JWS verbatim, the pin it was verified with, its hash and its `issuedAt`. It has its own atomic replace and the pack state's hardening:

- **Written only with a first entry.** The file is created when the first entry is stored, never empty; in the same write sequence `state.json` gains `revocationsStored: true` (written first; a crash in between leaves the flag and no file, which reads as empty). A product with no revocations has no file, no flag and no `relearn`, and its devices mount, activate and boot exactly as before P4-13, offline included.
- **Unreadable** (the store cannot read it): nothing is written to it for the life of the process; the engine refuses an embedded baseline a feed verified in this process lists as a verified target, and, when `revocationsStored` is set, refuses the embedded mount of every pack in the stamp's pins and embeds at every boot (online the pack is fetched instead; with no fetch possible the refusal is `pack-revoked`, detail `relearn`); without the flag it refuses nothing.
- **Torn** (it exists but does not parse): quarantined, then replaced by a fresh file whose `relearn` holds every pack in the stamp's pins and embeds.
- **Re-verified per entry on load** with `verifyRevocation` against the currently pinned release keys and the stored pin. A failing entry is dropped alone: when its key is no longer pinned (the recovery lever for a stolen release key) the target is forgotten; any other failure adds the entry's pack to `relearn`.
- **`relearn`** is persisted and cleared per pack only when step 11 has fetched, verified and stored every revocation of that pack it considers (the feed's entries whose target is in H) on a fresh, network-verified feed whose `revocations` member is present and usable; an entry for a release outside H (an older release the device does not hold) never keeps a pack in `relearn`, and a feed that omitted the member clears nothing. `recoverState()` clears it wholesale and releases a quarantined file. While a pack is in `relearn`, its embedded mounts are refused at every boot, online or offline (online the pack is fetched instead; when it cannot be, the refusal is `pack-revoked`, detail `relearn`); downloaded installs mount only if their hash is not revoked.
- **Bounded, never by H.** Entries are kept regardless of H, up to `MAX_STORED_REVOCATIONS` = 256 targets; beyond the cap the oldest by `issuedAt` is dropped (not added to `relearn`).
- **Unreadable `state.json`** keeps the pack state's own behaviour; within the process an embedded baseline is refused when a feed verified in this process lists its hash as a verified revocation target.

### 3.5 Record verification order [C]

Pinned by `releaseRecordCases` (each case's `step`):

12. **Hash before signature.** A body over `MAX_RECORD_JWS_BYTES` = 88 844 bytes (`verifyJws`'s own encoded caps, 1 370 + 1 + 87 386 + 1 + 86), or with any byte outside ASCII, is refused without hashing; otherwise the lowercase hex SHA-256 of the exact body bytes must equal the pin's `sha256` (`hash`).
13. Select the key by `kid` from the **pinned release keys only**; refuse when its raw bytes equal any key of the effective product trust set; then `verifyJws` with that one key and `typ` `pkey-release+jws` (`jws`). A supplied delegation is then ignored and the result's `delegation` is null. **Otherwise**, when the caller supplies `delegation` (only on §2.5.4's two surfaces) and the kid matches `DELEGATED_KID_PATTERN` (P4-19): (1) `verifyDelegation` with the kid's hex as `expectedHash`; (2) the delegated key's raw bytes equal no pinned release key and no key of the effective product trust set; (3) `verifyJws` with the delegated key alone. A failure in (1) or (2) is `delegation`, in (3) `jws`. An unpinned kid with no delegation supplied, or a malformed `pkd1-` kid, is `jws` as before. Without `delegation` the behaviour is byte-for-byte P4-13's.
14. The record claims of §2.5 (`claims`).
15. Cross-check against the pin: `kind` equals the pin's `kind`, `app` when the pin names none; `deliverable`, `version` and `seq` equal the pin's (`cross-check`). A feed's pin names an app record (`deliverable: "app"`); an app record's `content.pins[]` names a pack record, which the device fetches by its `sha256` from `release.endpoints.record` and checks with `pin: {kind: "pack", deliverable: <pack id>, version, seq}` (`packRecordCases`). A reserved or unknown `kind` verifies without a pin and is refused here where an app or pack record is expected.
16. **Scope** (a delegated record only, P4-19, `scope`): `kind === "pack"`; `deliverable` equals the delegation's scope root D or starts with `D + "."` (whole segments: `coversPack`); `type` is in the effective types; **every** variant's `files.layout` is `tree` (a container is never delegable, whatever its type); and `delegation.issuedAt ≤ record.issuedAt ≤ delegation.expiresAt`. Devices check the record against the signing window, never against their clock. (`verifyRevocation`'s own step 16, `revocation`, is §2.5.3's.)

**Bounds** (P4-19). Per record: two SHA-256s, at most two Ed25519 verifications, one delegation and one level only, the delegation subject to `MAX_RECORD_JWS_BYTES`. Per check: at most `MAX_DELEGATIONS_PER_CHECK` = 16 distinct delegations are fetched; a target beyond that waits for the next check. Verified delegations are cached in the process, keyed by the delegation hash **plus the trust inputs** (`expectedAud`, the pinned release keys and the effective product trust set), so a trust-manifest rotation misses the cache and verifies again. Pinned by `delegationCases`.

### 3.6 Grace

`graceUntil = issuedAt + maxOfflineDays × SECONDS_PER_DAY`, where `maxOfflineDays` is the per-license override or the product default. The 365-day ceiling applies at **verify time**, not only in the gate. Offline bundles use the same mechanism with operator-chosen `graceDays ≤ 365` (D-22).

_Informative (LX-07):_ `graceUntil` may be earlier when the licence expires sooner. A product that clamps grace to licence expiry (the default; `licensing.clampGraceToExpiry`) stamps `min(issuedAt + maxOfflineDays × SECONDS_PER_DAY, max(licence expiry, expiresAt))` on every document the licence grants, bundles included. Verifiers are unaffected: the value stays within `[expiresAt, issuedAt + MAX_GRACE_SECONDS]`.

### 3.7 Marker verification order [C]

Pinned by `markerCases` (each case's `step`). The marker's `release` is a compact pack record:

1. The marker file's bytes pass §1.2's strict JSON (`format`).
2. `format === "pkey-marker/1"`; `packId` is a pack id (§8); `version` matches §2.5's version pattern; `release` is a string (`format`).
3. Steps 12–14 with `release` as the body and its own SHA-256 as the pin hash: the 88 844-byte ASCII bound (`hash`), key selection from the pinned release keys and `verifyJws` (`jws`), the record claims (`claims`).
4. Cross-check: `kind === "pack"`, `deliverable === packId`, `version === version` (`cross-check`).

It returns the record and its SHA-256. The host then matches its bytes: a single-file payload's SHA-256 and size equal some variant's `payload`; a tree's `treeDigest`, computed from the files under its directory minus `.pkey/`, equals some variant's `payload.sha256`. When the content stamp pins that pack, the record's SHA-256 must equal the pin's `sha256`, or the embedded copy is not used. A refusal is the client code `marker-rejected` with `detail` set to the step.

## 4. Verified cache, clock floor and feed floor

### 4.1 Cache record v3

`CACHE_VERSION = 3`, unchanged: v4 adds four optional slices, which an older v3 loader ignores and a v4 loader treats as "no floor yet", "no bundle" and "no tombstone". One Core-owned record per product; **signed artifacts only**, plus two unsigned hints (`lastSyncUnauthorized`, `blocked`) that are for display: no verdict depends on them, because the document each answered for is deleted when the hint is set (§4.3):

```jsonc
{
  "v": 3,
  "trustJws": "<pkey-trust+jws>",
  "docs": { "license": "<jws>", "config": "<jws>" }, // per-service slices; absent = service unused
  "etags": { "license": "…", "config": "…" },
  "bundle": "<pkey-bundle+jws>", // the imported bundle, verbatim (§7)
  "lastSyncUnauthorized": false,
  "blocked": {
    "reason": "version-too-old",
    "allowedRange": { "min": "2.0.0" },
  },
  "feeds": { "<canonical channel>": "<pkey-feed+jws>" }, // v4, optional
  "releaseRecords": { "<lowercase hex sha256>": "<pkey-release+jws>" }, // v4, optional
  "pinRevocations": { "<revoked pinned kid>": "<pkey-trust+jws>" }, // §1 evidence, optional
}
```

Rules (all **[C]** via reload-path corpus cases):

- Every load re-verifies everything: `pinRevocations` against the pins (below) → the usable pins → `trustJws` against the **usable pins only** → build effective trust → each entry of `docs` against the effective set with `checkFreshness: false` → `bundle` on the bundle reload profile (§7). Each `feeds[k]` goes through §3.4 steps 3–6 with `k` as the requested name, no freshness and no floor, and its claim must equal `k`; each `releaseRecords[h]` through §3.5 steps 12–14 with `h` as the pin, kept only while a surviving feed pins it. Any verification failure ⇒ that artifact is treated as absent (fail closed); a failed license doc ⇒ `needs-activation`, never a partial state.
- **`pinRevocations`** maps each tombstoned pinned kid to the verified manifest that revoked it, verbatim. On load the entries are re-verified on the reload profile in ascending manifest `issuedAt` (ties: the revoked kid's byte order), each against the pins minus the tombstones already applied; an entry that fails, whose signer is already tombstoned, or whose manifest does not revoke the kid it is filed under, is dropped. A verified manifest that newly tombstones a pin (network, cache or a bundle's) is written as that pin's evidence in the same write as the manifest. It is security state, not a grant: carried through a bundle import's record replacement, a deactivation and a device-id re-binding, like `feeds`.
- **`bundle`** is the imported `pkey-bundle+jws`, verbatim. `activation: "bundle"` holds only when all three are true: no token is held; `bundle` verifies on the bundle **reload profile** (§7); and the cached `docs.license` is byte-identical to the bundle's `docs.license`. It replaced the unsigned `importedBundle: {bundleId, importedAt}` marker, which is no longer read at all.
- `v !== 3` ⇒ the record is **discarded, never migrated**.
- Decoded state, bare keys, floors or plaintext counters must never be persisted: the feed floors are derived from `feeds` on load.
- Writes are Core-mediated read-modify-write of the whole record; service modules never write the file directly.

### 4.2 Monotonic clock floor

```
highWaterMark = max(issuedAt of every currently-verified cached document, trustManifest.issuedAt)
effectiveNow  = max(systemClock, highWaterMark)
```

Both document sources and the trust manifest feed the floor; the v4 feed and release record do not (a feed's freshness is checked against the effective clock, so winding the system clock back cannot revive an expired feed); a config-document-only floor is provably inert and the corpus pins the defective form so it cannot silently return (`floor-config-doc-alone-does-not-stop-rollback`, carried from v2; new `floor-max-over-three-artifacts`). **[C]**

**Core owns trust refresh on its own schedule.** Trust refresh must not be a side effect of any single service's document fetch: a product with any service enabled still advances the independent signed clock. (v2's floor rode the `/config` fetch; that coupling is abolished.)

### 4.3 Revocation while offline

A hard 401 on `/license/document` or `/config/document`, after the single re-acquire or re-register, **removes that slice** (`docs.<slice>` and its ETag) in the same write that sets `lastSyncUnauthorized: true`. A 403 `version_blocked` or `channel_not_allowed` removes `docs.license` in the same write that sets `blocked`. The token is kept, so the gate still reports `revoked` or the block; the hints are display state. Clearing either hint therefore yields `needs-activation`, never a usable document. A device that never reconnects learns nothing new and runs out at `graceUntil`. For bundle-activated installs the grace bound **is** the revocation lever — stated, not pretended otherwise.

**Residual.** Restoring a full pre-revocation snapshot of the state directory and the token store works until `graceUntil`: the client holds no signed revocation state beyond what it was last told.

### 4.4 The feed `seq` floor, its ceiling, and the canonical channel [C]

A client keeps one floor per (aud, **canonical channel**), derived from `feeds[channel]` while that feed still passes §3.4 steps 3–6 against the current effective trust set: `floor = {seq, issuedAt}` of the committed feed. A committed feed whose key has left the set no longer verifies, so it is dropped with its floor. Switching selectors (today platform, in P4 `contentApi`) can never evade the floor, because every selector document of a channel carries the same `seq`.

**The canonical channel.** The Worker resolves the requested name as §5.1 rule 6 says — `stable` for `latest` and `stable`; `beta` for `beta`, and for `staging` unless the product declares a manual channel of that name; the name itself for `pr-<n>` and for a manual channel — and signs the result as `channel`. A client cannot tell the two `staging` cases apart, so the verified feed's `channel` claim **is** the canonical channel: it keys `feeds` and the floors, step 8 looks its floor up only after step 5 has bound it, it is the decision's channel, and the host records it as `staged.channel`. No SDK maps a requested name through `CHANNEL_ALIASES` to choose a key, a floor or a decision channel. A `latest` claim is refused. One residual is accepted: a request for `staging` binds to `staging` or to `beta`, so a network attacker can answer it with a genuine, unexpired `beta` feed of the same product, which is then checked against `beta`'s own floor (a `staging` grant already covers `beta`, §5.1 rule 4).

**The ceiling.** `seq` never exceeds `MAX_WIRE_INTEGER`: at the ceiling, a change of content is signed at the ceiling again with a newer `issuedAt`, which step 8 accepts. A signer that holds the product key can sign a fresh feed at the ceiling, which installs that fetch it commit and so refuse the recovered Worker's lower `seq` until they freeze (`none {stale}`). The recovery is product-wide and needs no client change: the operator runs the `feed:seq-ceiling` script, which sets the product's ceiling flag, raises every existing `seq` row of the product to `MAX_WIRE_INTEGER` and drops the stored documents. A new `seq` row starts at 1, or at `MAX_WIRE_INTEGER` when its product's ceiling flag is set, so a channel without a row at recovery time is covered too. The recovered Worker then signs every channel at the ceiling with the current `issuedAt`, which is newer than any `issuedAt` the attacker's feed can carry (a client refuses one more than 300 s ahead of its effective clock). Pinned by `feed-valid-seq-ceiling-recovery`.

## 5. Transport & gate placement

- **Documents:** `GET /<p>/license/document` and `GET /<p>/config/document`, `Authorization: Bearer pkeyt_…`, response `application/jwt`. Per-document `ETag`/`If-None-Match`; on 304, if `effectiveNow > doc.expiresAt − REFRESH_MARGIN_SECONDS` the client refetches unconditionally (the half-life rule, applied per document). **[C]**
- **Feeds and records:** `GET /<p>/update/{channel}/feed.jws?platform={platform}` and `GET /<p>/release/records/{sha256}`, both `application/jose`, both under the release `metadata` access mode, advertised as `update.endpoints.feed` and `release.endpoints.record` in discovery. The SDK always sends `platform`, so a per-platform split is invisible to it. The record route serves the stored bytes exactly, with `ETag: "<sha256>"`; an unknown hash is the plain 404.
- **401 handling:** exactly one `POST /<p>/license/token` re-acquire attempt, then one retry of the failed fetch. (Registered-without-license devices re-register instead; same single-attempt rule.)
- **Build gate placement (D-20):** channel/version-window enforcement returns `403 {"error":{"code":"version_blocked"|"channel_not_allowed"},"allowedRange":{…}}` on **`/license/document`** (and identity's `/session`). The config document enforces device authentication only. The channel names, the header normalisation and the entitlement predicate the gate applies are §5.1.
- **Client metadata headers** on every product-scoped call: `X-PKey-Device`, `X-PKey-Version`, `X-PKey-Channel`, `X-PKey-SDK`, `X-PKey-SDK-Version`, `X-PKey-Platform`, `X-PKey-Arch`. Their values are §5.2.
- **Gate input `licenseServiceEnabled`** is the build's declaration OR discovery's: `expectedServices` (default: licence and config) contains `license`, or a discovery loaded this session says `license.enabled: true`. Unsigned discovery can switch the licence gate **on**, never off. A config-only product names `expectedServices` without `license`. Discovery still governs sub-client availability (D-21).
- **Redirects.** For every product-scoped call a same-origin hop keeps the headers; a cross-origin hop drops `Authorization` and every `X-PKey-*` header and is followed only for GET and HEAD; a 307 or 308 on a non-GET to another origin, and any https to http hop, is refused with `insecure-redirect`; more than 5 hops is `too-many-redirects`.
- **Gate function** (client-side, shared implementation): input `{ licenseServiceEnabled, activation: "token"|"bundle"|null, doc, now, highWaterMark, lastSyncUnauthorized, blocked, lastVerifiedAt }` with `now := max(now, highWaterMark)`. `licenseServiceEnabled: false` ⇒ status **`not-applicable`**, `isUsable = true`. `activation: null` ⇒ `needs-activation`. Otherwise the state machine is unchanged (`ok` → `grace` → `expired`; `revoked` on recorded 401; blocked states from the unsigned hint). **[C]** via gate-matrix v2.

### 5.1 Channel vocabulary

One set of channel names serves the licence build gate, the `entitled` release check
(`release`/`update` access mode) and every SDK's `X-PKey-Channel`. The constants live in
`@polaris-key/protocol/core` (`CHANNEL_*`, `CHANNEL_ALIASES`, `CHANNEL_NAME_PATTERN`,
`PR_CHANNEL_PATTERN`, `PR_NUMBER_MAX_DIGITS`). **[C]** via gate-matrix v2.

| Name      | What it is                                                                                          | Valid as                         |
| --------- | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| `stable`  | the shipping channel; every grant holds it                                                          | header, selector, grant          |
| `beta`    | the pre-release channel                                                                             | header, selector, grant          |
| `pr-<n>`  | one pull request; `<n>` is 1–7 digits, kept as written                                              | header, selector, grant          |
| `pr`      | the PR family: as a grant it covers every `pr-<n>`                                                  | header, grant                    |
| `dev`     | built in, the top of the include chain; also the gate pseudo-channel of `0.0.0-dev*` builds (R3-01) | header, selector, grant          |
| manual    | a name from the product's `release.manualChannels`                                                  | header, selector, grant          |
| `staging` | the legacy alias of `beta`                                                                          | header, grant; selector (rule 6) |
| `latest`  | an alias of `stable`                                                                                | header, selector                 |

The built-in channels include one another as `dev` ⊇ `beta` ⊇ `stable` unless a product declares `includes` for one. That chain decides which builds a channel serves; it never widens a grant. "`dev` includes `beta`" is stored by the editors that write a grant (choosing `dev` stores `beta` with it) and is never inferred by the gate: rules 1–6 and `channelEntitled` are unchanged.

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
   resolution, floors and the `entitled` check go by the canonical channel. A channel feed's
   `channel` claim is that canonical channel, and a client never resolves an alias itself
   (§4.4).

### 5.2 Client metadata header values [C]

Pinned by `headers.json`.

`X-PKey-Platform` and `X-PKey-Arch` describe the running binary: the OS family and the CPU
architecture it was built for. For example:

- an x86_64 build under Rosetta 2 or Windows-on-Arm emulation sends `x86_64`;
- a Mac Catalyst build sends `macos`;
- an iPad app running on a Mac or on visionOS sends `ios`;
- a native visionOS build sends `visionos`.

| Header               | Value                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `X-PKey-Platform`    | `macos`, `ios` (iPadOS too), `tvos`, `visionos`, `watchos`, `android`, `windows`, `linux`, `web`                         |
| `X-PKey-Arch`        | `arm64`, `x86_64`, `armv7`, `wasm32`                                                                                     |
| `X-PKey-SDK`         | the SDK id: `node`, `react`, `python`, `swift`, `godot`; a later SDK registers its id in `conformance/parity/enums.json` |
| `X-PKey-SDK-Version` | the SDK's package version (unchanged)                                                                                    |

1. **Spellings.** An SDK reads its runtime's own report: Node `os.platform()` and `os.arch()`,
   Python `platform.system()` and `platform.machine()`, Swift's compilation conditions, Godot
   `OS.get_name()` and `Engine.get_architecture_name()`. It looks the report up in
   `PLATFORM_SPELLINGS` or `ARCH_SPELLINGS` (`@polaris-key/protocol/core`, generated into every
   SDK):
   - after ASCII case folding (A–Z only, never a locale-dependent lowercase);
   - with no trimming;
   - reading the table's own entries only.
2. **Omission.** A spelling the table lacks has no value, and the SDK omits the header rather
   than inventing one (`unknown`, `x86`, `freebsd`). A browser sends `web` and no `X-PKey-Arch`.
3. **Server.** The Worker stores:
   - the canonical value of any listed spelling;
   - the id for each pre-§5.2 SDK name (`@polaris-key/node`, `@polaris-key/react`,
     `polaris-key-python`, `PolarisKeySwift`, `polaris-key-godot`);
   - any other value as sent.

   It treats an empty value as absent. No server decision reads these headers.

4. A `POST /<p>/devices/report` body that carries `platform`, `arch` or `sdk` uses the same
   values. The `engine` object that an engine SDK adds carries an `id` of the form
   `<engine>-<major>.<minor>`, in lowercase ASCII, such as `godot-4.7`.
5. **Header vocabulary and update vocabulary** (`plans/SP-08.md`). `tvos`, `visionos` and
   `watchos` are header values only. The build and update vocabularies keep six values:
   `RELEASE_PLATFORMS`, `OUTLET_PLATFORMS.unknown`, the feed's `?platform=` and
   `targets[].platform`. An SDK's _update platform_ is its header value when that value is in
   its mirror of `OUTLET_PLATFORMS.unknown`, and no value otherwise. With no value, the SDK takes
   today's path for a platform without a canonical value: Swift throws `not_configured` unless
   `UpdateClientOptions.platform` is set, Python unless `update.platform` is set, and Godot
   uses `""`. A later package that ships tvOS or visionOS builds widens both vocabularies.

### 5.3 Refusal links (`manageUrl`) [C]

Pinned by `license-device-limit.json` (transcript) and the `readManageUrl`, `withManageReturn` and
`withManageKey` table that every SDK repeats (client-core `test/manage.test.ts`).

A seat refusal carries a link to the customer portal, so an app can offer **Replace a device**
instead of a dead end. It is one optional member of an unsigned flat refusal body. No signed
document, claim, header or error code changes, and `PROTOCOL_VERSION` stays 4.

| Refusal (403)     | Routes                                                                                         | Link                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `device_limit`    | `POST /<p>/license/activate`, `POST /<p>/license/enroll`, `POST /<p>/identity/session/license` | attached licence: `<portal>/#/p/<slug>/free-device?license=<id>[&for=<label>]`      |
|                   |                                                                                                | floating licence: `<portal>/activate?product=<slug>&next=free-device[&for=<label>]` |
| `key_entry_limit` | `POST /<p>/license/activate`, `POST /<p>/identity/session/license` (§12.2)                     | `<portal>/activate?product=<slug>`                                                  |

1. **Shape.** `manageUrl` is an absolute `https` URL of at most `MANAGE_URL_MAX_LENGTH` (2048)
   characters on the portal origin: `CONSOLE_ORIGIN`, else the request's own origin. The body keeps
   `limit` and `deviceCount` beside it. An attached licence is one with an account; the licence
   named is the device's anchor licence.
2. **Presence.** The Worker emits it only while the product's customer portal is on, and omits it
   otherwise. A client treats its absence as "no link" and shows the refusal as before.
3. **Never in the link.** The licence key, an account id, a subject or holder hint, a hostname, a
   device id or an IP. `for` is a coarse `"<Platform> <arch>"` label built from the §5.2 headers
   (for example `macOS arm64`), at most `MANAGE_FOR_MAX_LENGTH` (64) characters, omitted without
   metadata. It is display text only.
4. **Client validation.** A client keeps the member (top level, else nested under `error`) only if
   it is an absolute `https` URL, or `http` to `localhost`, `127.0.0.1` or `[::1]`, written
   `<scheme>://` with a host, no `@` (userinfo) or `\` in the authority, no whitespace or control
   characters, and within the length limit. Anything else is dropped, never repaired. Every SDK
   applies this rule itself rather than trusting a platform URL parser, which may be laxer.
5. **What a client may add.** Only two things, each spelled with the
   `application/x-www-form-urlencoded` byte serializer:
   - `return=<app URL>`: into the query inside the fragment when the fragment holds a portal
     route (`#/…`), otherwise into the URL's query, replacing an earlier `return`. The portal
     accepts it only against the product's declared return targets.
   - `#key=<key>`, on an `/activate` link only, and only when the link opens in a browser on the
     same device (a button). A fragment never reaches a server or a log, but the browser keeps it
     in history, so the portal page drops it with `history.replaceState` once read (PX-17). A
     link drawn as a QR code never carries the key: anyone who can see the screen can scan it,
     so the phone's `/activate` page asks for the key instead (THREAT-MODEL.md, PX-W8).
6. **Not an auth failure.** A client never wipes state, retries or opens the link on its own; it
   offers the link behind a user action (a button, or a QR code where a joypad is the only input).

### 5.4 The device label is display data [C]

Pinned by `device-label.json`.

`deviceName` on `POST /<p>/identity/auth/device/start`, `POST /<p>/license/activate` and
`POST /<p>/devices/register` is the device label (§12.7.1): what the sign-in page, the customer
portal and the console call the device. No server decision reads it, and no signed document
carries it. Every SDK normalises it before sending and the Worker normalises it again on receipt;
neither ever rejects one.

### 5.5 Product presentation (`core.presentation`) [C]

Pinned by `presentation-matrix.json` (`presentationMatrixVersion` 1: `parseCases`, `pickCases`
and `verifyCases`) and `discovery-presentation.json` (transcript). No matrix row holds U+0000
(Godot reads it as U+FFFD, §10) or a lone surrogate (JSON decoders differ on one); each SDK pins
the lone-surrogate rule in its own tests.

Discovery's `core` block may carry `presentation`: the product's name, developer, accent colours
and icon, so a UI kit can show the product with no integrator code. It is unsigned display data.
No gate, entitlement or trust decision reads it, and no signed document, claim, header, route or
error code changes.

**The member**, in its normalised form: what the Worker emits, what a client's parse returns, and
what the matrix and the transcript compare as canonical JSON (keys sorted).

```jsonc
"core": { "registration": …, "compat": …, "endpoints": …,
  "presentation": {                                         // absent ⇒ today's behaviour
    "name": "DJDL",                                         // always present
    "developerName": "Vlad Zaharia",                        // present only when valid
    "accent": "#2ed6e6", "accentDark": "#5ee6f0",           // lower-case; each optional
    "icon": {                                               // present only when valid
      "sha256": "<64 hex>", "contentType": "image/png",
      "width": 1024, "height": 1024,                        // present only when known
      "original": "https://img.plrs.im/djdl/a/<sha256>",
      "url": "https://img.plrs.im/djdl/a/<sha256>/{w}.webp", // present iff sizes is non-empty
      "sizes": [{ "w": 64, "sha256": "<64 hex>" }, …]       // always present; [] with no ladder
    } } }
```

A client reads an absent `sizes` as `[]`.

The limits are generated into every SDK from `@polaris-key/protocol/core`:
`PRESENTATION_TEXT_MAX_BYTES` (1024), `PRESENTATION_URL_MAX_BYTES` (2048),
`PRESENTATION_MAX_ICON_SIZES` (8), `PRESENTATION_MAX_ICON_WIDTH` (4096),
`PRESENTATION_ICON_MAX_DIMENSION` (16384), `PRESENTATION_ICON_MAX_BYTES` (10485760),
`PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS` (10), `PRESENTATION_CACHE_MAX_FILES` (4) and
`PRESENTATION_ICON_TYPES` (`image/avif`, `image/gif`, `image/jpeg`, `image/png`, `image/webp`).

**Emission (the Worker).**

- `name` is the Distribution listing's `name`, else the product's name.
- `developerName` is the listing's `developerName`.
- `accent` is `.pkey/product` `presentation.accent`, else the listing's `tintColor`. `accentDark`
  is `presentation.accentDark`. Both are lower-cased.
- `icon` is the hosted copy of the `presentation.icon` slot, else of `listing.icon` (locale
  `''`): exactly the copy the image host serves for its `/icon` alias. `original` is the copy's
  content-addressed image-host URL, `url` is `<original>/{w}.webp`, and `sizes` lists the copy's
  WebP width variants, each with its own hash, ascending, at most `PRESENTATION_MAX_ICON_SIZES`.
- The Worker runs the candidate through the parse rule below, so it never emits a field a client
  would drop.
- The member is emitted only when `developerName`, `accent`, `accentDark` or `icon` resolves.
  Otherwise it is absent.

| Icon slot state                                                                    | `icon` in discovery                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| A hosted copy of `presentation.icon`                                               | that copy                                   |
| No copy there, but a hosted copy of `listing.icon`                                 | the `listing.icon` copy                     |
| No hosted copy in either slot (never resynced since hosting, a first pull pending) | omitted                                     |
| An empty ladder (no image-resizing binding)                                        | the original, with `sizes: []` and no `url` |
| A failed or stale re-pull                                                          | the last good copy                          |
| Hosting switched off, or no image host configured                                  | omitted                                     |

The rest of the member stays in every row.

**Never in the member:** the manifest's `presentation.icon` reference (an https URL or a
repository path), a developer's host, a `/media/…` proxy URL, the image host's `/icon` alias (a
redirect, which clients refuse to follow), or any device or licence fact.

**Parse (every client).** Unknown members are ignored at every level. A malformed field is
dropped and never refuses discovery.

1. **Not an object.** The member is treated as absent.
2. **Text.** `name` and `developerName` must be strings of 1 to `PRESENTATION_TEXT_MAX_BYTES`
   UTF-8 bytes (bytes, never code points or UTF-16 units) containing no C0 control
   (U+0000–001F), DEL (U+007F), C1 control (U+0080–009F) or lone surrogate. An invalid field is
   dropped whole, never repaired. An invalid `developerName` is dropped. An invalid `name` falls
   back to the document's top-level `name` when that passes the same rule, then to the slug
   (`product`). Bidi and zero-width characters are kept, so a
   right-to-left name that uses LRM or RLM survives; a kit renders both fields in a
   bidi-isolated run (`<bdi>` or `dir="auto"` on the web, FSI…PDI elsewhere).
3. **Colours.** `accent` and `accentDark` must match `^#[0-9A-Fa-f]{6}$`. They are lower-cased;
   anything else is dropped. Either may appear without the other.
4. **Icon.** `icon` is dropped unless `sha256` matches `^[0-9a-f]{64}$`, `contentType` is one of
   `PRESENTATION_ICON_TYPES`, and `original` is a usable URL (rule 5). Within a kept icon:
   - `width` and `height` are integers from 1 to `PRESENTATION_ICON_MAX_DIMENSION`, or they are
     dropped.
   - `sizes` has at most `PRESENTATION_MAX_ICON_SIZES` entries, each `{w, sha256}`: `w` an integer
     from 1 to `PRESENTATION_MAX_ICON_WIDTH`, strictly ascending, and `sha256` matching
     `^[0-9a-f]{64}$`. If any entry is bad, `sizes` reads as `[]`, `url` is dropped, and the
     original stays.
   - `url` must be at most `PRESENTATION_URL_MAX_BYTES` bytes with exactly one `{w}`; it must
     begin, ASCII case-insensitively, with `original`'s origin followed by `/` or `?`, so the
     `{w}` sits after the authority and no width can change the host or the port; and it must be
     a usable URL on that origin once its `{w}` is replaced by a width (`1`). Otherwise, or when
     `sizes` is empty, `url` is dropped and `sizes` reads as `[]`.
5. **Usable URL.** Deliberately portable, with no URL parser, so every SDK (GDScript included)
   applies the same test:
   - 1 to `PRESENTATION_URL_MAX_BYTES` characters, each printable ASCII (U+0021–007E: no space,
     no control, nothing non-ASCII), and no `#` (no fragment) and no `\`;
   - it begins `https://`, or `http://` (both ASCII case-insensitive);
   - its authority, from after `://` to the first `/` or `?` or the end, ASCII-lower-cased, is a
     host followed by an optional `:port`, where the port is 1 to 5 digits and at most 65535;
   - the host is `[::1]` (the only bracketed address, and nothing but a `:port` may follow its
     `]`), `127.0.0.1`, or dot-separated labels of 1 to 63 characters in `[a-z0-9-]` whose last
     label is neither all digits nor `0x` followed by hex digits (WHATWG's ends-in-a-number
     test). So there is no userinfo (`@`), no `%`, no empty label and no other IP literal;
   - with `http`, the host is `localhost`, `127.0.0.1` or `[::1]`.

   The one place a WHATWG URL parser can be stricter: an `xn--` label is not checked as valid
   Punycode, because that is not portable to GDScript. A WHATWG client may refuse such a host, and
   then the icon fetch fails. That is safe: origins still map one to one, so no template can
   reach another host.

   A URL's origin is its scheme and authority, ASCII-lower-cased, and two origins are the same
   only when they are equal as strings (an explicit default port differs from none). There is no
   pinned host: production serves images from `img.plrs.im`, and staging and dev from
   `img-staging` and `img-dev`.

**Size choice** (`pickCases`). The input is `(icon, px, scale, decodable)`, and
`need = max(1, ceil(px × scale))`.

1. If `sizes` is non-empty and `image/webp` is decodable, take the smallest `w ≥ need`, else the
   largest `w`. Replacing `url`'s `{w}` with that `w` gives the URL.
2. Use the original instead when it is decodable, its `width` is known and exceeds the largest
   `w`, and `need` exceeds the largest `w`.
3. With no usable size, take the original if it is decodable.
4. Otherwise, take none.

The result is `{source: "size", w, sha256, url}`, `{source: "original", sha256, url}` or
`{source: "none"}`.

**Verification** (`verifyCases`). Bytes are shown only if their lower-case hex SHA-256 equals the
chosen `sha256` exactly (so an upper-case expectation never matches). Bytes that do not match are
neither shown nor cached.

**Fetch** (unit-tested in each SDK; I/O, so not corpus).

- A plain `GET` with no `Authorization`, no cookies or credentials, and no `X-PKey-*` headers:
  the image host is public, and a header would only leak a device id.
- Redirects are not followed, so any `3xx` fails. Only `200` succeeds.
- The timeout is `PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS`, and the body cap is
  `PRESENTATION_ICON_MAX_BYTES` (the icon slot's own cap).
- A failure surfaces no error and is not retried; the next discovery refresh may try again. The
  client keeps today's output (the kit's monogram) meanwhile.
- The bytes are stored under the SDK's data directory as `presentation/<sha256>`, and the last
  parsed member beside them as `presentation.json`, so a cold boot with no network still shows
  the product. After each successful discovery, files the current member no longer names are
  removed, keeping at most `PRESENTATION_CACHE_MAX_FILES`.
- None of it enters the Core cache record (§4.1 keeps signed artifacts only), so
  `CACHE_VERSION` stays 3.

**Signing.** The member is unsigned on purpose (S-20 owner decision 10). It carries no
authority, and the icon's integrity comes from the `sha256` in the same TLS response, against
content-addressed bytes the image host serves immutably. A party that can rewrite discovery can
already turn services off, so changing a logo adds nothing; a signature would need a new `typ`
and a key every SDK pins, and buy nothing over discovery's existing trust. `PROTOCOL_VERSION`
stays 4 and `DISCOVERY_VERSION` stays 2, because every SDK's discovery parser ignores members it
does not know.

## 6. Device principal

- **Device id binding (desktop file stores).** On macOS, Windows and Linux the SDK derives the device id from the platform anchor (`deviceIdFromRaw(product, raw)`, §6.1) at every start. A stored id is used only when no anchor is readable. A stored id that disagrees with the derived one is discarded together with the token and the grant slices of the cache (`trustJws`, `docs`, `etags`, `bundle` and both hints): `deactivate()` without the network call. The update slices and `pinRevocations` are kept. The anchor probes run by absolute path (`/usr/sbin/ioreg`, `%SystemRoot%\System32\reg.exe`), never through `PATH`. Keychain and Keystore stores keep their stored id. The device re-activates once; the server coalesces the stale seat by hardware id.

- **Token:** `pkeyt_` + 43 base64url chars (256-bit). Hash-stored server-side; KV hot record `{product, deviceId, licenseId | null}` — `licenseId` is null for registered-without-license devices. `pkeyt_` tokens are rejected (pre-launch, no migration).
- **Registration policy** (per product, manifest key `devices.registration`, default derived — `requires-license` if license enabled, else `requires-identity` if identity enabled, else `open`):
  - `open` — `POST /<p>/devices/register` (keyless, rate-limited, optional fingerprint) mints a token.
  - `requires-identity` — same endpoint, but only with a valid product identity session.
  - `requires-license` — the endpoint returns `403 registration_closed`; activation/enrollment are the only mint paths (today's behavior).
- **Device management:** `GET/PATCH/DELETE /<p>/devices[/:id]` (self-only for PATCH/DELETE) and `POST /<p>/devices/report` (facts/probes telemetry; best-effort, errors swallowed client-side) are Core surfaces available under every policy.

### 6.1 Hardware fingerprint components

A native SDK MAY present a fingerprint with activation, enrolment and registration. Each
component is read on the device, omitted when unreadable (never substituted), and hashed as
`base64url(sha256("pkey-hw:<product>:<component>:<raw>"))[0..22]` (`fingerprintVersion` 1).
The Worker drops unknown names, recomputes `hwid`, and matches component-wise.

| Component              | macOS                             | Windows                                 | Linux                            | iOS, iPadOS, tvOS, visionOS, watchOS |
| ---------------------- | --------------------------------- | --------------------------------------- | -------------------------------- | ------------------------------------ |
| `machineUuid` (anchor) | `IOPlatformUUID`                  | registry `MachineGuid`                  | rule 2                           | `identifierForVendor`                |
| `boardSerial`          | `IOPlatformSerialNumber`          | `Win32_BaseBoard.SerialNumber` (rule 1) | not read                         | not read                             |
| `cpuModel`             | CPU brand `:` logical cores       | same                                    | same                             | not read                             |
| `primaryMac`           | lowest non-internal, non-zero MAC | same                                    | same                             | not read                             |
| `bootVolumeUuid`       | boot volume UUID                  | `vol C:` serial                         | `findmnt -no UUID /`             | not read                             |
| `ramBucket`            | rule 3                            | rule 3                                  | rule 3                           | rule 3                               |
| `machineModel`         | `hw.model`                        | `Win32_ComputerSystem.Model` (rule 1)   | `/sys/class/dmi/id/product_name` | `hw.machine`                         |

The table is informative except where it cites a rule. `cpuModel` and `primaryMac` are read
differently by different SDKs today; only stability within one SDK is promised for them.

1. **Windows CIM** (`windowsCim`, `windowsCimCommand`). One PowerShell call, with stdin on the
   null device, prints `{"boardSerial": …, "machineModel": …}` for the last instance of each
   class, with non-ASCII escaped. The parser strips one leading U+FEFF, requires a JSON object,
   and keeps a value only if it is a string that is non-empty after trimming ASCII whitespace
   (U+0009–U+000D, U+0020, and nothing else) at both ends. It keeps vendor placeholders verbatim
   and ignores other keys. Anything else yields neither component. **[C]**
2. **Linux anchor** (`linuxAnchor`). The first of `/etc/machine-id` and `/var/lib/dbus/machine-id`
   whose content, trimmed of ASCII whitespace as in rule 1, is non-empty and not
   `uninitialized`. No DMI file is read; a host where neither file qualifies has no anchor. The
   same value is the device id's raw input on Linux. **[C]**
3. **RAM bucket** (`ramBuckets`). `g = floor(bytes / 2^30)`. Omitted when `g = 0`, otherwise the
   largest power of two not above `g`, in decimal. Divide before any logarithm. **[C]**

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

1. Verify the bundle JWS against the **usable pins only** (§1); `typ` must be `pkey-bundle+jws`; payload cap 262 144.
2. `aud` equals the product; `deviceId` equals the local device id; `issuedAt ≤ now + skew`; `now ≤ expiresAt + skew` (the bundle import window uses network-path freshness — a stale bundle is refused).
3. Verify `trust` against the usable pins (reload profile, the tombstone rule included); build the effective set.
4. Verify each entry of `docs` against the effective set with the **reload profile** (`checkFreshness: false` — inner docs carry long `graceUntil`, not long `expiresAt`). **Per-type floors:** each inner document must be strictly newer (`issuedAt`) than the verified cached document of its type, if one is held; otherwise the import is `inner-doc-rejected`. An old bundle cannot roll a device back.
5. Atomically write cache v3: `bundle` (the bundle JWS, verbatim), `trustJws`, `docs`, and the evidence for any pin the inner manifest tombstoned. The held `trustJws` is kept instead when its `issuedAt` is newer than the bundle's manifest, so an old bundle cannot re-teach a key the device has seen revoked. The update slices and `pinRevocations` are carried. No token is created.

**Profiles.** The steps above are the **import** profile. The **reload** profile re-verifies the cached `bundle` at every start: steps 1–3 without step 2's two import-window comparisons (a bundle imported on day 29 still activates on day 300, and a bundle stamped ahead of a wound-back clock still reloads), and step 4 with no floors (its documents are the cached ones). Every other check of step 2 still binds. A byte-identical re-import of the bundle an install runs on is a success with no write; this happens before step 1 and is outside the corpus.

State semantics: `bundle` verifying on the reload profile, with `docs.license` byte-identical to its licence document and no token held ⇒ gate `activation: "bundle"`. If the device later activates online, the token path supersedes (`activation: "token"`). Fingerprint enforcement is skipped for bundle activation (no server to dedupe against). Server-side minting is an admin surface (`POST /manage/api/products/<slug>/bundles`), audit-logged, `graceDays ≤ 365` enforced at mint **and** verify.

`docs.license` is **optional by design**: a config-only product (D-08) air-gaps with a bundle carrying only `docs.config` + `trust`. Importing a bundle with no license document has **no activation effect** — for a license-enabled product the gate remains `needs-activation`; for a license-disabled product it is `not-applicable` as always. `activation: "bundle"` arises only from a bundle whose license document verified. A bundle with an EMPTY `docs` (no license, no config) is refused at import step 2 as vacuous.

## 8. Identifier registry

Amendment A1 (see the design spec) withdrew the interim `plrs` rebrand, so the v2 identifier family carries forward unchanged apart from the document types v3 and v4 added. The "withdrawn" column exists so a reader who saw the interim spelling in a draft, a branch or an old plan knows it is not merely deprecated — no verifier, signer or store ever accepts it.

| Concern                  | v4 (normative)                                                                                                                                                                                                                               | Withdrawn (never accepted)                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| ISSUER (`iss`)           | `key.plrs.im`                                                                                                                                                                                                                                | `plrs.im`                                                 |
| Device token prefix      | `pkeyt_`                                                                                                                                                                                                                                     | `plrst_`                                                  |
| Client headers           | `X-PKey-*`                                                                                                                                                                                                                                   | `X-Polaris-*`                                             |
| License key prefix       | `pkey_<product>_…`                                                                                                                                                                                                                           | — (never changed)                                         |
| JWS `typ` values         | `pkey-license+jws`, `pkey-config+jws`, `pkey-trust+jws`, `pkey-bundle+jws`, `pkey-feed+jws`, `pkey-release+jws`                                                                                                                              | the `plrs-*` spellings                                    |
| Record hash              | lowercase hex SHA-256 over the exact ASCII compact JWS of the record                                                                                                                                                                         | —                                                         |
| Outlet kinds             | `direct`, `app-store`, `testflight`, `altstore`, `altstore-pal`, `play`, `play-testing`, `obtainium`, `fdroid-repo`, `ms-store`, `app-installer`, `steam`, `itch`, `flathub`, `snap`, `winget`, `web` (`unknown` is a detection result only) | —                                                         |
| Version schemes          | `semver`, `semver+build`, `4part`                                                                                                                                                                                                            | —                                                         |
| Manifest dir             | `.pkey/` — the ONLY directory, no fallback                                                                                                                                                                                                   | `.polaris/`                                               |
| Session domain tags      | `pkey.admin.v1\|`, `pkey.portal.v1\|`                                                                                                                                                                                                        | `plrs.admin.v1\|`, `plrs.portal.v1\|`                     |
| Session cookies          | `__Host-pkey_admin`, `__Host-pkey_portal`, `pkey_<p>_session`                                                                                                                                                                                | the `plrs_` spellings                                     |
| Keychain service (Swift) | `pkey:<product>`                                                                                                                                                                                                                             | `plrs:<product>`                                          |
| Config env prefix        | `PKEY_CONFIG_`                                                                                                                                                                                                                               | `PLRS_CONFIG_`                                            |
| Hash domains             | `pkey-hw`, `pkey-device:` (FROZEN at `fingerprintVersion` 1)                                                                                                                                                                                 | — (never changed; a rename orphans every enrolled digest) |
| Serving host             | `key.plrs.im`                                                                                                                                                                                                                                | — (equal to the issuer, but checked separately)           |
| Pack id                  | `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, at most 64 bytes, never `app`: a pack record's `deliverable`, `pins[].pack`, `expects[].pack`, `builds[].embeds[]` (`isPackId`)                                                                          | —                                                         |
| Pack patterns            | `PACK_TYPE_PATTERN`, `VOCAB_TOKEN_PATTERN`, `OBJECT_FORMAT_PATTERN`, `HANDLER_PREFIX_PATTERN`, `ENTITLEMENT_PATTERN`, `VARIANT_AXIS_PATTERN`, `VARIANT_VALUE_PATTERN`, `ENGINE_PATTERN` (§2.5.1; `@polaris-key/protocol/packs`)              | —                                                         |
| Pack formats             | `pkey-files/1`, `pkey-patch/1`, `pkey-marker/1`, `pkey-content/1`, `pkey-chunks/1` (`CHUNKS_FORMAT`); files `X.pkey.json`, `D/.pkey/pack.json`, `pkey-content.json`                                                                          | —                                                         |
| `treeDigest`             | lowercase hex SHA-256 of the UTF-8 lines `<sha256hex> <size> <path>\n`, sorted by path bytes (§2.6)                                                                                                                                          | —                                                         |
| Record kinds             | `app`, `pack`, `revocation`, `delegation` (`RECORD_KINDS`); `RESERVED_RECORD_KINDS` is empty                                                                                                                                                 | —                                                         |
| Delegation record        | a `pkey-release+jws` with `kind: "delegation"`, signed by a pinned release key; `deliverable` is the scope root (§2.5.4)                                                                                                                     | —                                                         |
| Delegated kid            | `pkd1-<delegation record hash>`, `DELEGATED_KID_PATTERN` `^pkd1-[0-9a-f]{64}$`                                                                                                                                                               | —                                                         |
| Delegation limits        | `MAX_DELEGATION_TTL_SECONDS` = 31 622 400; `MAX_DELEGATION_TYPES` = 8; `MAX_DELEGATIONS_PER_CHECK` = 16; `DELEGABLE_PACK_TYPES` = `files.tree`, `data.json`, `l10n.table`                                                                    | —                                                         |
| Data-only rule           | `DATA_ONLY_EXTENSIONS` (14, §2.8); `DATA_ONLY_HEAD_BYTES` = 64; `DATA_ONLY_TAIL_BYTES` = 65 557                                                                                                                                              | —                                                         |
| Revocation record        | a `pkey-release+jws` with `kind: "revocation"`, signed by a release key; its feed entry is the record's hash with its target's pin (§2.5.3)                                                                                                  | —                                                         |
| Revocation limits        | `MAX_FEED_REVOCATIONS` = 64 (per feed, and per check); `REVOCATION_REASON_MAX_BYTES` = 512; a device keeps at most 256 revoked targets (`MAX_STORED_REVOCATIONS`, a client limit)                                                            | —                                                         |
| Delta-menu limits        | `MAX_FEED_DELTAS` = 64 entries per feed; `MAX_FEED_DELTAS_PER_TARGET` = 4 per target payload (§2.4.2)                                                                                                                                        | —                                                         |
| `packSetId`              | lowercase hex SHA-256 of the UTF-8 lines `<packId> <recordSha256>\n`, sorted by pack-id bytes; null for an invalid pack id, a release not 64 lowercase hex, or a pack listed twice (`plans/P4-01.md` §2.9)                                   | —                                                         |
| Variant key              | a variant's `axis=value` pairs sorted by axis-name bytes, joined with `;`; the empty string for `{}` (`variantKey`)                                                                                                                          | —                                                         |
| Request handle           | `rq_` + 22 base64url characters, `REQUEST_HANDLE_PATTERN` `^rq_[A-Za-z0-9_-]{22}$`; lives `REQUEST_HANDLE_TTL_SECONDS` = 600 (§12.7.2; `@polaris-key/protocol/identity`)                                                                     | —                                                         |
| Device label             | `deviceName`, at most `DEVICE_LABEL_MAX_CODEPOINTS` = 64 code points after §12.7.1; display data only (§5.4)                                                                                                                                 | —                                                         |
| Pairwise subject         | `ps_` + 22 base64url characters (16 random bytes), `PAIRWISE_SUBJECT_PATTERN` `^ps_[A-Za-z0-9_-]{22}$`; one per account and product, never derived from the account id (§12.3; `@polaris-key/protocol/identity`)                             | —                                                         |

`pkey-config+jws` and `pkey-trust+jws` are the v2 type strings reused for v3's config document and trust manifest; the document _shapes_ changed in v3, the type strings did not.

The outlet kind `direct` is presented as Polaris Key: the console, the download page and the docs label it "Polaris Key", while the identifier stays `direct` in every signed document, the corpus and every SDK (a prose change, not a contract change).

## 9. Rollout & versioning

v4 is additive on the wire: the four v3 documents keep their shapes and bytes, deployed v3 clients are unaffected (no SDK enforces `protocolVersion`), and v4 SDKs fall back to `update.check()` against a Worker without `update.endpoints.feed`. The stricter verifier (§1.1, §1.2, §3.1) accepts everything the Worker signs once its signer guard and write checks are deployed (P3-12), so no SDK release built on v4 is published before that Worker. Version counters and their owners: `PROTOCOL_VERSION = 4` (this contract), `corpusVersion = 2`, `gateMatrixVersion = 2`, `fingerprintVersion = 1`, `stageMatrixVersion = 3` (client boot behaviour outside this contract, owned by `client-core/src/stages.ts`), `headersVersion = 2` (§5.2; SP-08 turned the `visionOS` and `tvOS` rows from no value into canonical values), `configMatrixVersion = 1` (§2.2.1), `updateMatrixVersion = 1`, `outletMatrixVersion = 1` and `planMatrixVersion = 2` (§11), `contentCorpusVersion = 2` (§2.6, `content/cases.json`), and the per-product catalog `schemaVersion` (orthogonal). `CACHE_VERSION` stays 3. P4-13 changes none of these: it fills reserved slots (§2.4.1, §2.5.3, §2.5.2 holds) with members parsed beside the claims and appends new corpus sections, so `PROTOCOL_VERSION` stays 4, `corpusVersion` 2, `updateMatrixVersion` 1, `contentCorpusVersion` 1 and `PACK_STATE_VERSION` 1. P4-10 fills `variants[].chunks` (three claim checks, two integer paths) inside v4 and appends sections, so `contentCorpusVersion` and `planMatrixVersion` go to 2 (runners must handle or declare planned the new strategy and the optional `chunkIndex`); `PROTOCOL_VERSION`, `corpusVersion` and `CACHE_VERSION` are unchanged. P4-19 fills the reserved kind `delegation` and adds one optional member to a feed `revocations` entry and one to `PackInstall`, appending `delegationCases` and `dataOnlyCases`: every counter above is unchanged (`PROTOCOL_VERSION` 4, `corpusVersion` 2, `contentCorpusVersion` 2, `updateMatrixVersion` 1, `PACK_STATE_VERSION` 1), because a v4 SDK that predates it refuses a delegated record at step 13 and ignores the entry `kind` (§2.5.4). P4-29 fills the reserved feed member `deltas` (§2.4.2) with a member parsed beside the claims, appending `feedContentCases` and the new sections `feedDeltaCases` and `feedDeltaApplyCases`: every counter above is unchanged (`PROTOCOL_VERSION` 4, `corpusVersion` 2, `planMatrixVersion` 2, `contentCorpusVersion` 2, `updateMatrixVersion` 1, `CACHE_VERSION` 3, `PACK_STATE_VERSION` 1), because a v4 SDK that predates it ignores the member. HA-12 adds the unsigned discovery member `core.presentation` (§5.5) and the client table `presentation-matrix.json` (`presentationMatrixVersion = 1`). Every counter above is unchanged (`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2, `CACHE_VERSION` 3), because an SDK that predates it ignores the member. The trust-custody amendment (§1, §2.3, §4.1, §7) changes no counter either (`PROTOCOL_VERSION` 4, `corpusVersion` 2, `gateMatrixVersion` 2, `CACHE_VERSION` 3): its two cache slices are additive, its corpus cases are appended, and its one changed verdict (`trust-member-shapes-ignored`) is a client tightening. I-09 adds the account routes (§12.3), `license_owned` on key entry (§12.2 step 3) and the identity fragment's account members (§12.6): the identity routes are additive within v4 and detected from discovery (a client uses a route only when the fragment advertises it), no signed document changes, and every counter above is unchanged (`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2). Deployed SDKs keep the behaviour they shipped with: no SDK enforces `protocolVersion`, and an SDK that predates `?signer=` reads the default manifest as before. An install activated by a bundle through the old `importedBundle` marker re-imports after upgrading, and a bundle past its 30-day import window needs a fresh mint. The corpus drift gate remains the only automated cross-language enforcement; this document remains the normative source.

## 10. Divergence & hardening ledger

All v2 and v3 divergence classes (alg confusion, oversize, duplicate keys, alphabet strictness, typ separation, freshness profiles, trust substitution, clock floor, per-type anti-replay floors, config-document-without-license issuance, registration-policy token minting, bundle all-or-nothing import, bundle payload cap, gate `not-applicable`/`activation` semantics, channel vocabulary and aliases, fingerprint component derivations, client metadata header values, config resolution and environment values) carry into v4 unchanged. New classes introduced by v4, each with corpus coverage: Ed25519 strictness (§1.1, the `sig-*` and `pubkey-*` `jwsCases`); strict JSON, numbers and depth (§1.2, the `json-*` and `valid-*` `jwsCases`); integer claims decided from the token, with their minimums (§3.1, the v3 claim cases, `feedCases`, `releaseRecordCases` and every `nonWireIntegers` member); members outside the claims (§3.2); whole-string patterns, byte lengths and member presence (§3.3); the feed `seq` floor, its ceiling and the canonical channel that keys it (§4.4); record hash before signature (§3.5); and release keys that are never product keys (§1). Packs v1 (`plans/P4-01.md`) adds four: forward-compatible pack claims, where an unknown vocabulary value makes a thing unusable and never refuses the record (§3.2, the `pack-valid-*` `packRecordCases`); side-object integers, decided by the token rule inside the files index, the patch descriptor, the marker and the stamp (§2.6); marker parsing and its verification order (§3.7, `markerCases`); and decoder window limits, checked from the frame header before any delta is decoded (§2.6). P4-13 adds one: **content members parsed beside the claims** — the feed's `packSets`, `packFloors`, `revocations` and delta menu `deltas` (P4-29, §2.4.2), an app's `holds` and a revocation's body are read by usability functions (`feedContent`, `holdsOf`, `revocationOf`), so a malformed member is unusable and never refuses the feed or record (§2.4.1, `feedContentCases`, `revocationCases`, the holds `stampCases`). P4-19 adds two: **delegated signers** — a content key verifies only through a delegation verified against the pinned release keys, one level deep, inside its scope, types, tree layout and signing window, and never on a release-key surface (§1, §2.5.4, §3.5 steps 13 and 16, `delegationCases`); and the **data-only rule**, an extension allow-list over already-normalised paths with head and tail magic sniffs that fail closed (§2.8, `dataOnlyCases`). Implementations must not add local tolerances beyond this document; any observed divergence gets a corpus case before a fix.

The trust-custody amendment adds four: **canonical base64url** — segments and trust-set keys are refused, or a published key skipped, unless re-encoding the decoded bytes gives the input (§1, the `*-noncanonical-trailing-bits` and `segment-trailing-newline` `jwsCases`, `trust-pubkey-noncanonical-skipped`); **the key-status allow-list** (§1, `key-status-*` `trustCases` and `trust-member-shapes-ignored`); **pinned-key tombstones and their evidence order** (§1, §4.1, the `pin-*` and `manifest-signed-by-tombstoned-pin-refused` `trustCases`, `bundle-signed-by-tombstoned-pin-refused`); and **bundle floors and the reload profile** (§7, the `bundle-floor-*` and `bundle-reload-*` `bundleCases`). The signer retry is pinned by the `trust-signer-retry` transcript.

HA-12 adds one class: **display members parsed field by field**. `core.presentation` is read member by member. A malformed field is dropped and never refuses discovery, and icon bytes are shown only when their SHA-256 equals the hash the member names (§5.5; `presentation-matrix.json` `parseCases`, `pickCases` and `verifyCases`).

**Chunk-index arithmetic** (`plans/P4-10.md` §2.3). The index length is compared in exact (64-bit) arithmetic, so a `chunkCount` whose 48× wraps in 32 bits is still refused (`chunks-bad-length-wrap`); a u64 is two u32 reads saturated at 2^53, so a GDScript `int`, a JS double and a 64-bit integer agree (`chunks-size-high-word`, `chunks-bundle-size-saturated`). With `MAX_CHUNK_INDEX_BYTES` the sum of lengths stays below 1.5 × 10^15, so a saturated value never compares equal by accident.

**U+0000 in member names is now refused everywhere** (§1.2 rule 7), which closes v3 §10's open entry for signed documents. U+0000 in a string value keeps the representation limit below.

**Declared representation limit: U+0000 in decoded strings.** Some client platforms have a native string type that cannot hold U+0000. GDScript's `String` is one: Godot 4.4 drops the character and 4.7 replaces it. Such a platform is conformant only under this rule.

- It MUST decode the JSON escape `\u0000` as U+FFFD on every engine version, before its duplicate-key scan and its parse. Its decoded documents are then the same on every engine, and the loss stays visible.
- Verdicts do not change. The signature covers the encoded bytes (§1). Every value a verifier compares is ASCII (`typ`, `kid`, `iss`, `aud`, `deviceId`, channel names, versions), so a value that contains U+0000 fails the comparison on every platform alike.
- For each string value under a `jwsCases` `expect.doc` that contains U+0000, the generator writes `expect.docNulReplaced`. It maps the value's RFC 6901 pointer to the value with every U+0000 replaced by U+FFFD.
- A runner on such a platform compares those values against `docNulReplaced`, and the rest of the document as usual. Every other runner ignores the field.
- Environment values (§2.2.1 rule 2) follow the same rule. Such a platform reads `\u0000` in a
  string value as U+FFFD, and `config-matrix.json` compares no such value. A member name
  holding U+0000 keeps the variable's raw string on every platform, so such a platform
  decides it on the raw text, before the replacement.
- In a signed document, a member name that contains U+0000 is refused (§1.2 rule 7, `json-nul-escape-in-key`), so no verdict depends on representing one; a platform that cannot represent U+0000 decides it on the raw text, before the replacement. A raw string in `config-matrix.json` spells such a key as an escape, which is ASCII text, so no corpus file holds a decoded one.

**Declared representation limit: canonically equivalent names in Swift.** Swift's `String`
equality and hashing are canonical equivalence. Swift holds a decoded object as
`[String: JSONValue]` and the environment as `[String: String]`, so two names that differ but
are canonically equivalent are one key. Swift is conformant only under this rule.

- **Member names in an environment value (§2.2.1 rule 2).** `"\u00e9"` and `"e\u0301"` are two
  names, and Swift keeps the first. The verdict does not change, because Swift's duplicate scan
  compares scalar values, so the text is parsed as everywhere else. `config-matrix.json` pins
  that verdict in one row whose two members hold equal values. The generator refuses any row
  where such members hold different values.
- **Variable names (§2.2.1 rule 1).** Swift reads a variable whose name is canonically
  equivalent to the built name as that name. With an ASCII prefix this happens only through
  U+212A KELVIN SIGN, which is equivalent to `K` (in `PKEY_CONFIG_`, and allowed in keys). No
  row holds a variable name outside ASCII.
- **Member names in a signed document.** The verifier compares names by scalar value (§1.2 rule 6), so `valid-canonically-equivalent-member-names` verifies in Swift as everywhere else; Swift's `JSONValue` then keeps only the first, which is why that case carries no `doc`. P3-12's write checks keep the Worker from signing such a pair.

**Declared representation limit: number values in Godot.** Godot's JSON parser
(`built_in_strtod`) is not correctly rounded. It keeps the first 18 digits of a number,
leading zeros included, as an integer, and multiplies or divides that integer by a power of
ten built from inexact factors. Godot is conformant only under this rule. Measured on 4.7.2:

- a number with a fraction or an exponent can differ in its last bits: `1e-307` reads as
  1.0000000000000001e-307, and `9007199254740991.0` as 9007199254740990;
- a number whose first 18 digits are all zeros reads as 0 (`0.00000000000000000001`), or as
  NaN when the power of ten passes 10^308 (`0e999`,
  `0.00000000000000000000000000000000000000001e348`);
- a number divided by a power of ten above 10^308 reads as 0 (`100000000000000000e-309`, which
  is 10^−292).

The verdict of §2.2.1 rule 2 does not depend on any of this, because every SDK judges each
number from its digits. Every SDK, Godot included, reads a number as the nearest double when
it has at most 18 digits before its exponent part (leading zeros included), those digits form
an integer of at most 2^53, and its exponent minus its count of fraction digits is within
±22. `config-matrix.json` compares the value only of such numbers.

In a signed document the same holds for every number **value** (an entitlement or config
value, an unknown member): Godot's reading can differ in its last bits, and Python reads `7.0`
as a `float`. The verdict agrees, because §1.2 rule 8 is judged from the digits, and an integer
claim (§3.1) is always exact because its token is checked. `valid-number-forms` and
`valid-number-integral-spellings` therefore carry no `doc`.

These are the only declared representation limits. The first covers no character but U+0000. **[C]**

## 11. Client behaviour pinned beside the contract (informative)

These are client behaviour outside the wire contract, like the stage machine; their tables live in the corpus directory and are guarded by the same drift gate. The plan (`plans/P3-01.md` §2.8–§2.10, §4.6–§4.8) is their long form.

### 11.1 The update decision (`update-matrix.json`)

`decideUpdate` is a pure, synchronous function over the verified feed and record, the installed build, the outlet (`{id, kind}` from `resolveUpdateOutlet`), the host's update methods, the staged update, the skipped version and the rollout bucket. It answers `none`, `code-ready`, `binary`, `store`, `platform`, `blocked` or `packs`, and `bootDecision` maps the answer onto the stage machine's `decide.done`. Versions compare under the feed's scheme with `compareVersions` — `semver` is SemVer 2.0's own grammar with ASCII classes and §11 precedence on unbounded integers, `semver+build` breaks a tie with numeric build metadata, `4part` compares four unbounded integers — and a version that does not parse compares as null. The rollout bucket is `u32_be(SHA-256(UTF-8(salt) ‖ UTF-8(installId))[0..4]) mod 10000`, and a device is in the rollout iff its bucket is not null and below `bp`. `update-matrix.json` pins 25 version cases, 10 capability cases, 12 outlet cases, 6 bucket vectors, 65 decision rows and 44 `contentRows`, each recomputed by the generator's reference implementation.

**Floors never stop play; a CI revocation of required content can** (`plans/P4-13.md` decision 4, amending P3-01 decision 1). `bootDecision`:

| Answer                                                                            | Boot value |
| --------------------------------------------------------------------------------- | ---------- |
| `blocked {revoked-content}`, or any answer with `contentBlock: "revoked-content"` | `required` |
| `packs`                                                                           | `none`     |
| `blocked {content-floor}`, and any answer with `contentBlock: "content-floor"`    | `optional` |
| `none`, and a `platform` answer that is not mandatory                             | `none`     |
| everything else (a mandatory offer, `blocked {app-floor}`, …)                     | `optional` |

`required` stops the boot at a confirmed `blocked {update-required}`, with no rollback loop. It fires only for a **required** pack (stamp `expects[].required`) revoked with no usable replacement, so it can never be produced without a CI-signed revocation. A revoked optional pack is unmounted and play continues (`packs.revoke`). For a `required` boot caused by `revoked-content`, the host shows its own text — "Some of this game's content was withdrawn by its developer and can't be used. Update the app to keep playing." — with the offer's button when the answer is an offer and none for `blocked`.

**The content decision** (`plans/P4-13.md` §2.6). `UpdateDecisionInput` gains an optional `content` `{stamp (with holds from holdsOf, null when unusable), active (the pack state's active installs, embedded baselines included), axes (VariantPrefs.axes), revocations ([{target, pack, replacement, replacementUsable}], one per target), buckets ({[salt]: integer | null})}`; without it every rule and answer is P3-01's. The caller does every fetch, hash and signature check.

- **Row selection.** The level L is `stamp.contentApi`, the platform `installed.platform`, the engine E `installed.engine ?? ""`. Candidate rows have (L, platform) and `engine === E` exactly, with no fallback to `""` rows. They are grouped by sorted axis names; in each group the row `selectVariant`'s rule picks (every axis in `axes`, the lowest tuple of preference indexes) is selected (`selectPackRows`). A pack's feed target is the release the selected rows' sets name; a pack named by two selected rows gets none. On the install's outlet entry, a pack in `packSets.outlets[id].pinned` gets no feed target, and a gate keyed by the target replaces it with `fallback` when `halted` or out of its rollout (a null bucket is out).
- **Composition, per pack.** `base` is the stamp's pin, else its hold, else null when the pack is narrowed, holds are unusable, `dataUpdates` is false or `packSets` is null, else the feed target. `cand` is `base` with a revoked release replaced by its revocation's usable replacement (usable only with `dataUpdates` and not narrowed), or null; when cand is null and the active release is revoked, cand is the active release's replacement. A pack installs cand when it differs from the active release, the pack is active, required or essential, and it is pinned or held, or the active release is absent or revoked, or `cand.seq` is higher: **a feed target never downgrades a pack**. A pack is revoked without a fix when cand is null and its active release is revoked (or its revoked base has no active release). A floor blocks when a known-scheme `packFloors` entry for (pack, L) exists, the pack is active or required and not revoked without a fix, and its effective release is absent or below `minVersion`. The block is `revoked-content` when a required pack is revoked without a fix, else `content-floor` when a floor blocks.
- **Prestage.** When the offered record has `content` with a different `contentApi` L′, `binary.prestage` lists the required and essential packs of L′'s `expects` not in the chosen build's `embeds`, each at the record's pin, else its hold, else the feed target at (L′, platform, the build's `requires.engine` or E), after replacement, when that differs from the active release; sorted by pack-id bytes. Otherwise `prestage` is `[]`.
- **Order.** With A the P3-01 answer: (1) on `none {stale}` or `none {unknown-version}`, the composition runs with no feed target and answers `blocked {revoked-content}` when a required pack is revoked without a fix, else A (floors are not evaluated); (2) `blocked {app-floor}` keeps A, adding `contentBlock`; (3) an offer with a block becomes mandatory with `contentBlock`, and without one a mandatory offer or any `binary` wins (the binary supersedes content), `binary` always carrying `prestage`; (4) a block answers `blocked {reason}`; (5) `code-ready` is A; (6) with `dataUpdates` and a non-empty install or revoke list, `packs`; (7) otherwise A. This is P3-01's order: `blocked(app-floor)` → mandatory offers → `blocked(revoked-content)` → `blocked(content-floor)` → `binary` with `prestage` → `packs` → `none`; a non-mandatory store or platform offer yields to `packs`.
- **Outputs.** `packs {install: [{pack, release}], revoke: [packId], set: [{pack, sha256}], discardStaged}`, lists sorted by pack-id bytes; `binary`, `store`, `platform` gain an optional `contentBlock`; `blocked.reason` ∈ `app-floor`, `content-floor`, `revoked-content`, with `contentBlock` on `app-floor` only. `UPDATE_ACTIONS` gains `packs`; `BLOCKED_REASONS` gains `content-floor` and `revoked-content`. A `packs` row also carries `expect.packSetId`, the `packSetId` of `decision.set`.

### 11.2 Outlet kinds, capabilities and detection (`outlet-matrix.json`)

Capabilities (`binaryUpdates` none < store < self, `codeUpdates`, `dataUpdates`, `channelSwitch`, `commerce`, `downloadedScripts`) default per outlet kind (`OUTLET_CAPABILITY_DEFAULTS` in `@polaris-key/protocol/distribution`), narrowed first by the platform (`PLATFORM_NARROWING`: an iOS `direct` install opens its web-distribution page and never loads code), then by the subkind (`SUBKIND_NARROWING`: a package-managed `direct` install is updated by its manager), then by the feed entry's `capabilities`. Booleans narrow by AND, `binaryUpdates` to the narrower value, `commerce` only to `none`; nothing widens. A feed's `listingUrl` may only start with the kind's `LISTING_URL_PREFIXES`, byte for byte. Detection (`detectOutlet`) applies S-06's precedence rules over 25 signals; `outlet-matrix.json` pins the tables, the signal vocabulary with each signal's confidence and evidence, and 48 detection rows, each recomputed by the generator's reference.

### 11.3 Boot confirmation and pack fetches (`stage-matrix.json` version 3)

A launch is confirmed, resetting `failedBoots` to 0, the first time the machine's outcome is `waiting`, `blocked` or `offline` (`now`), or has been `ready` for `BOOT_OK_SECONDS` = 10 with the process alive or the game calls `confirmBoot()` (`after-ok-seconds`). `running` and `error` never confirm. `bootConfirmation(outcome)` is the pure part; the timer and `confirmBoot()` are host-side. Version 2 left the stage machine itself unchanged.

Version 3 (`plans/P4-01.md` §2.10) adds the pack rows. A new option, `essentialPacks` (default `[]`), names the packs the boot wants before `ready` but can play without; `requiredPacks` stays the ones it cannot. In `fetch`, `fetch.consent {bytes, metered}` (an integer ≥ 0 and a boolean) moves the outcome to `waiting` and emits `consent_needed`, the size disclosure and the cellular choice; `fetch.progress {done, total}` (integers, `0 ≤ done ≤ total`) runs again and emits `fetch_progress`; `fetch.done` is accepted while consent waits and gains the result `declined`. With a required pack missing, `offline` stops at `offline {canPlayOffline: false}`, `declined` at `blocked {reason: "content-declined"}` (never `error`, so declining is a confirmed boot, not a failed one) and anything else at `error {fetch-failed}`; with every required pack present and an essential one missing, `offline` stops at `offline {canPlayOffline: true}`, where `play-offline` goes to `mount`; otherwise the fetch mounts. `BootState.canPlayOffline` is true only at that playable stop. Every version 2 row keeps its expectation; the 13 new rows, the `fetch:waiting` and `offline:playable` keys of `accepts` and two new probes pin the rest.

### 11.4 The install planner, variant selection and target mapping (`plan-matrix.json`)

`plan(input)` picks how to install a pack release: `noop`, `platform`, `delta`, `chunk`, `file` or `full`, by the cost `bytes + requests × PLAN_REQUEST_WEIGHT` (16 384) among the candidates the host's capabilities, memory budget and free disk allow, listing the others as `fallbacks`; `full` costs its `requests` (1 for a container, 2 for a tree, whose index it needs). Its refusals, `plan-transport-unsupported`, `plan-insufficient-disk` and `plan-no-strategy`, are verdicts it returns, never throws. `selectVariant` picks the variant: usable, its `requires.engine` absent or the host's, every axis it declares in the host's preference lists, the lowest tuple of preference indexes over the axis names in byte order; none is `pack-no-variant`. `planTarget` maps a variant and its files index onto the planner's input, dropping what a v1 SDK cannot use (an unknown codec, layout, format, scope, or an index above `MAX_FILES_INDEX_BYTES`). `planTarget`'s fourth argument, the parsed chunk index, maps `chunks` to `{indexBytes: chunks.bytes, records}` only for a usable `container` whose `chunks.format` is `pkey-chunks/1`, codec usable, `size` ≤ `MAX_CHUNK_INDEX_BYTES`, the index bound to the payload and no record's `len` above `MAX_CHUNK_BYTES`; otherwise `chunks` is null (`plans/P4-10.md` §2.5). A device fetches the target index before planning only when `chunks` is usable, `chunk` is in its strategies and it stores a seed index. A chunk run is one single-range request with `If-Range: "<bundle sha256>"`; for `Range: bytes=o-e` the `206` must say `bytes o-e/<size>`, and a `206` clipped at the object's end makes the records past it `chunk-bundle-truncated`; any other answer fails the strategy. `plan-matrix.json` (`planMatrixVersion` 2) pins 28 planner rows (A7's 23, rebuilt on the content set where they are real, two tree rows and P4-10's three `plan-real-chunk-*` rows), 11 variant cases and 22 target cases (eight with `chunkIndex`), each recomputed by the generator's reference; chunk targets stay inline, so the planner never parses an index. `plans/P4-01.md` §2.9 and §4.5 are the long form.

**Feed-offered deltas** (`plans/P4-29.md` §2.4). `withFeedDeltas(variant, deltas) → {variant, feedIds}` merges the feed's menu (§2.4.2) into the planner's input: when `deltas` is non-null, the variant is usable, its layout is `container` and the menu has a key equal to `variant.payload.sha256`, each entry of that key is appended, in feed order, to a copy of `variant.deltas` as a `payload` delta, unless its `artifact.sha256` equals an existing delta id (a record delta wins); otherwise the variant is returned unchanged. `feedIds` lists the appended artifact hashes. `planTarget` and `plan` are then unchanged, so a feed delta is a candidate only when `delta` is in `caps.strategies`, its method is in `caps.patchMethods`, its `from` is installed, `memBytes ≤ caps.memBudget` and the disk check passes, and record deltas keep the lower `ord`: CI wins a cost tie. `applyDelta` is unchanged: the artifact against the entry (`delta-artifact-mismatch`), the base against `from` (`delta-base-mismatch`), §2.6's window against `memBytes`, and the output against the **record's** `payload` (`delta-apply-failed`). The engine reads the menu of the most recently committed feed of the canonical channel, fresh or stale, and tries **at most one feed-offered delta per install**: once one fails (a fetch error, a 404 or any verdict above) the remaining `feedIds` are skipped, while record deltas, `chunk`, `file` and `full` continue. `plan-matrix.json#feedDeltaCases` pins the merge and the plan (`withFeedDeltas` → `planTarget` → `plan`, compared by canonical JSON); `content/cases.json#feedDeltaApplyCases` pins the target-hash check.

### 11.5 The Cloud Sync client state machine (`sync-scenarios.json`)

Client behaviour beside the Cloud Sync routes (`plans/U-01.md` §2.3, §2.4, §4.1; S-17 §5.4–§5.6). `sync-scenarios.json` (`syncScenariosVersion` 1) is literal data written by `tools/sync-scenarios.ts`, not computed by an implementation; `@polaris-key/client-core/cloud-sync` is its first implementation and every SDK replays it with a fake clock, a fake transport that answers from the scenario's `respond` steps, and a `clientId` source that returns `init.clientIds` in order.

- **Partitions.** The journal holds one partition per subject (`clientId`, `nextMutationId`, `cursor`, `pending`, `held`, the cloud snapshot) and the unbound `local` partition (one value per setting with its `editedHlc`). Nothing written in one partition is sent under another. Reads are optimistic: the active partition's snapshot with its pending operations and debounced drafts applied by the key's policy (`max`/`min` keep the extreme, `merge` applies member ops), falling through to the rest of the resolution chain (`from: "document"`) when there is no value, when the stored value fails the key's schema (`settingState.invalid`), or when the current document marks the key `enforced` or `hidden`.
- **Edits.** `setConfig`/`clearConfig` refuse a key without a `user` block (`setting-unknown`) or a locked key (`setting-locked`), journalling nothing; otherwise they stamp the HLC at the call and (re)start a 2,000 ms per-key debounce. At commit (timer, `flush`, sign-in, sign-out or relaunch, keys in byte order) a signed-out device writes the local partition; a signed-in one appends `set`/`clear`, or for a `merge` key one `setMember`/`removeMember` per changed member (members in byte order) against the view without the draft. `mutationId`s come from `nextMutationId` at append time. A `revision` record `put` is not debounced; while a push carrying that record is in flight, later puts replace one held value (rule 3), and an unsent queued put is coalesced in place.
- **HLC.** Physical part `now + offsetMs`; a tick takes `(p, 0)` when `p` exceeds the last physical part, else increments the counter. `offsetMs = serverNow − now` from every `200`. An op stamped before the install's first `200` is marked `preContact`; while uncontacted, the first request is a pull, and if its offset exceeds 300,000 ms every pre-contact stamp (journal, local partition, drafts, and the last HLC) is shifted by the offset before any push.
- **Requests.** One at a time: a pull (`GET /<p>/sync?cursor=&clientId=`) while uncontacted or after `cursor_expired` (cursor 0), else a push of up to 100 pending operations in `mutationId` order, else a pull when one is wanted (start, sign-in, back online, `more`). A request-level failure (transport, `400`, `413`, `429`, `5xx`) changes nothing and waits for the next trigger; a `401` blocks (`status.reason: "unauthorized"`) until `refresh` (a successful licence or config document fetch); `409 client_mismatch` regenerates the `clientId`, renumbers the pending operations from 1 and resends; `410 cursor_expired` keeps the journal, resets the cursor and pulls a snapshot before pushing again.
- **Results.** Every processed result removes its mutation (rule 1). `ok` updates the snapshot (`renamedTo` names the server key; `dropped` changes nothing and reports `origin: "migration"`). A setting `conflict` takes the server copy and enqueues nothing (Q6). A record `conflict` takes the server copy and enqueues a new mutation on the server's version only for a held edit or a keep-local hook (rule 2). `rejected` emits `{type: "rejected", mutationId, code}`. A cursor-0 answer replaces the snapshot; `changes`, `tombstones`, `cursor` and `aliases` are then applied. Value changes emit `{type: "change", keys, origin}` grouped by origin (`local`, `remote`, `merge`, `migration`), keys in byte order; a key whose moved first-sign-in operation was resolved in that response reports `merge`.
- **Sign-in and sign-out.** Sign-in moves every local-partition setting into the subject's partition as ordinary operations marked `moved` (keeping `editedHlc` and `preContact`) and empties the local partition in the same write. Sign-out commits drafts, flushes for up to 5,000 ms when online, then emits `{type: "signedOut", reason, unsynced}` (and `unsyncedData` when operations remain and were not discarded); under `onSignOut: clear` it wipes the snapshot and resets the cursor, keeping the pending operations in that partition. `403 account_required` (then `blocked` with `signInOffered`) and a response naming another subject are handled the same way with no flush. A signed-out partition expires 30 days after sign-out, checked at sign-in and at start. Cloud Sync never writes licence state, cached documents or `lastSyncUnauthorized`.

## 12. Accounts and Identity

There is one Polaris Key account per person, platform-wide; it is never a per-product toggle. A
product's `identity` service toggle gates only sign-in _through that product_
(`plans/I-04.md` §2.1). Nothing in this section is signed and nothing here enters the licence
document: `PROTOCOL_VERSION` stays 4. The licence document's claims and members are independent
of `licenses.account_id` and `devices.subject` until LX-09: attaching a licence, a sign-in binding,
a sign-out and a counted key entry leave every document a device verifies unchanged. §12.2 is
PX-W9's key entry with I-09's step 3 (`license_owned`). §12.3 (attach, subject and sign-out) and
the account members of §12.6 are I-09's; §12.4, §12.5 and the rest of §12.6 are reserved for I-08
(the passthrough sign-in, Continue, callback binding and `authorize`) and are written when it
lands. §12.7 is PX-W13's passthrough request metadata and §12.8 is PX-W17's Identity-off
behaviour. The plan is `plans/I-09.md`.

### 12.1 What the toggle scopes

| Surface                                                                                                                                                                                                            | Scope                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| The account, its links, the login card, Library, Discover, Activate License, portal licence attach, pairwise subjects (`ps_…`) and the licence owner's subject, the account override layer, the console Users page | **Platform-wide**, every product |
| Passthrough sign-in through the product (device code, web redirect, native redirect, exchange); "Continue to <App>" grants; `attach`, `subject`, `signout`; the identity fragment's account members                | **Identity toggle on**           |
| Key-entry counting and its refusals; the Users page's sign-in columns; layer 2                                                                                                                                     | **Identity toggle on**           |
| Cloud Sync: `requires: [config, identity]`; principal `devices.subject` only                                                                                                                                       | **Identity and Cloud Sync on**   |

A developer-facing surface names an account only by its pairwise subject for that product, never
by the global account id (S-16 §5.1).

### 12.2 Key entry [C]

Pinned by `keyentry-limit.json`, `keyentry-refusals-off.json`, `keyentry-identity-off.json` and
`keyentry-owned.json` (transcripts). The long forms are `plans/PX-W9.md` and `plans/I-09.md`.
Nothing here is signed and no signed document changes: `PROTOCOL_VERSION` stays 4.

A **key entry** is a person typing a licence key to use it. On a product whose Identity toggle is
on, the Worker counts key entries per licence and, past the product's limit, may refuse the key to
a new device and point the person at an account instead (PORTAL §4.6).

1. **Surfaces.** A key entry happens on one of three surfaces, on a product with Identity on:
   - `app`: `POST /<p>/license/activate`;
   - `browser`: `POST /<p>/identity/session/license`;
   - `portal`: `POST /api/claim/license-key`, once the licence's attach to the account commits.
2. **Enrolled.** A device is enrolled on a licence when the `devices` row for
   `(product, device_id)` has that `license_id` and `status = 'authorized'`. A browser session's
   device is `browser:<licenseId>`, so the `browser` surface counts at most once per enrolment.
3. **Order on the two device routes.**
   1. The rate limit, the key and the licence, unchanged.
   2. An enrolled device is answered as before: never refused, never counted.
   3. When `identity.keyEntryRefusals` is on and the licence is usable and in an account
      (`licenses.account_id IS NOT NULL`): the flat
      `403 {"error":"license_owned","message":…,"signInUrl":…}`. `signInUrl` is the product's
      login card, `<origin>/signin?product=<slug>` (the console origin, else the Worker's own),
      present whatever the product's portal settings say: the card is platform-level. It never
      carries the key and names nothing about the account. Nothing is written but the refusal log
      (reason `license_owned`). The device reaches the licence by signing in to the account that
      holds it, never by the key (S-16 D24). An unusable licence keeps its `401` from step 5, so
      the refusal never describes a licence the key cannot use.
   4. When `identity.keyEntryRefusals` is on, the licence is usable (an unusable one keeps its
      `401` from step 5) and in no account (rule 6), and `used ≥ limit`: the flat
      `403 {"error":"key_entry_limit","message":…,"manageUrl":…,"keyEntries":{…}}`. `manageUrl`
      is the §5.3 link, omitted while the product's customer portal is off. Nothing is written
      but the refusal log.
   5. Otherwise the device is authorised as before (seat, fingerprint, hardware). A new
      authorisation that takes a seat records exactly one entry, in the same database batch as
      the seat claim: a refused or failed authorisation records none, and of concurrent calls
      from one device only one records.
4. **Never counted:**
   - a refused or failed attempt;
   - an enrolled device entering the key again;
   - token refresh (`license/token`), offline grace and every document fetch;
   - `license/enroll`, store bindings and sign-in activation (OIDC, device code);
   - choosing a licence at sign-in, and **Replace a device**;
   - a portal claim of a licence the account already holds (`already_yours`), and a refused
     claim;
   - the signed-out key preview (rule 8).
5. **The member** `keyEntries: {"used": n, "limit": n}`.
   - `used` is the licence's count of recorded entries. It may exceed `limit`: after concurrent
     entries at the last free one, after portal claims, and after a period with refusals off.
   - `limit` is the product's effective `identity.keyEntry.limit`: an integer from 1 to 100,
     default 10. There is no unlimited value while Identity is on.
   - A client shows `max(0, limit − used)` entries left.
   - It is present on every key-entry 2xx of an Identity-on product, an enrolled device's
     included (`200` on `license/activate`, beside `token`; `201 {"ok":true,"keyEntries":…}` on
     `session/license`), and on `key_entry_limit`. It is absent otherwise, and always absent
     with Identity off.
6. **Whom the limit applies to.** Every successful key entry is counted, whatever the licence's
   holder. Step 4 refuses only a licence in no account (`licenses.account_id IS NULL`), floating
   or assigned and waiting for its email. A licence in an account meets step 3's
   `license_owned` first. While the switch is off neither step refuses: a licence in an account is
   counted and admitted like any other.
7. **Not an auth failure.** A client never wipes state, retries or opens the link on its own: it
   shows the refusal and offers the link behind a user action (§5.3 rule 6). On `license_owned`
   a client that supports sign-in offers it for the same product (device code, or the redirect
   in a browser), with `signInUrl` as the fallback; a client that predates I-09 reports
   `refused` with the code.
8. **The portal.**
   - `POST /api/activate/preview` (signed in) answers `keyEntries`, or `null`, where it answered
     `entries: null`. The claim answers `keyEntries` beside the licence.
   - The signed-out, read-only `POST /api/key/preview` answers
     `{product, verdict, license, keyEntries, upgrade}`. `verdict` is `addable`,
     `license_owned` (the key's licence is in an account, never whose) or `portal_off`.
     `license` is `{tierName, term}` (`term`: `perpetual`, or the licence's end in epoch seconds)
     or `null`. `upgrade` is `forced` exactly when step 4 would refuse a new device (the verdict
     is `addable`, the licence is usable, refusals are on and `used ≥ limit`), else
     `skippable`. It never answers an email, a masked email, a licence id,
     devices or an account. A string that is not a licence key answers `422`, an unknown key
     `401`, and the per-network budget (10 a minute) `429`.
9. **Identity off.** Nothing is counted, nothing is refused and no member is sent. Entries
   recorded earlier are kept and ignored.

### 12.3 Attach, subject and sign-out

Pinned by `identity-attach.json`, `identity-attach-errors.json` and
`identity-subject-signout.json` (transcripts). Three device routes, on a product with Identity on:

| Route                        | Body                | Answer                                                          |
| ---------------------------- | ------------------- | --------------------------------------------------------------- |
| `POST /<p>/identity/attach`  | `{"confirm": bool}` | the preview, or the activation response with `subject` (rule 3) |
| `GET /<p>/identity/subject`  | none                | `{"subject": "ps_…" \| null}`                                   |
| `POST /<p>/identity/signout` | none                | `{"released": bool}`                                            |

1. **Credentials.** `Authorization: Bearer pkeyt_…` and `X-PKey-Device`, and the token must be
   that device's. No cookie, session or account id is ever read, and nothing in the request
   names an account, a subject or a licence. CORS answers the product's `web.origins` without
   credentials. Every answer is `cache-control: no-store`. Errors are the nested
   `PolarisErrorBody`. With Identity off the routes do not exist (§12.8 rule 1). Rate limits per
   client network: attach 30 a minute (failing closed), subject and sign-out 60 a minute.
2. **The holder.** The account an attach adds the licence to is the account of the device's
   binding `devices.subject`, which only a completed sign-in writes (resolved through merge
   aliases, while the account is active). Never the request, and never the licence's owner. The
   licence is the one the device runs on.
3. **Attach.** In order: `400 bad_request` (no device header, or `confirm` is not a boolean),
   `401 unauthorized` (the token, or the device's licence is no longer usable),
   `403 account_required` (no account is signed in on the device), `404 not_found` (the device
   holds no licence), `403 license_owned` (the licence is in another account; no link and
   nothing about that account), `403 license_email_bound` (the licence carries a buyer email the
   signed-in account has not verified, and the product does not set
   `identity.keyEntry.claimByKey`).
   - `confirm: false` answers `200 {"status":"confirm","license":{"id","tierId","name"}}` and
     writes nothing. It refuses exactly what `confirm: true` would.
   - `confirm: true` puts the licence in the account by one compare-and-set
     (`account_id IS NULL`), so the first claim wins and a concurrent loser gets
     `license_owned`. It rotates the device token and answers the activation response
     (`token`, `schemaVersion`, `device`, `license`) plus `subject` and `"attached":"claimed"`.
     When the licence is already in this account the answer is the same without `attached`.
   - Attach never changes the device's licence (it never re-anchors), never sets the binding and
     never changes a signed document. The licence's history gains `license.attach` (the subject,
     the device, `via: device`), and the licence's own email is told when the account has not
     verified it.
4. **Subject.** The pairwise subject of the account signed in on the device, after merge
   aliases; `null` when none is or it was deleted. Never the account id.
5. **Sign-out.** Drops this device's binding, and no other device's. `released` is true only
   when the sign-in bound the device (`bound_by = 'signin'`) to a licence of the account signing
   out: the device is then deauthorized and its token stops working. A device activated by key
   or enrolment keeps its licence and token. A client flushes Cloud Sync before it signs out
   (S-17 §5.4 rule 5) and drops its token when `released` is true.
6. **Not auth failures.** `account_required`, `license_owned` and `license_email_bound` keep the
   client's token and state.

### 12.6 Discovery

Pinned by `discovery-identity.json`. With Identity on, the identity fragment carries, beside its
sign-in endpoints:

- `"account": true`: the routes of §12.3 are served.
- `"keyEntryLimit": n`: the product's `identity.keyEntry.limit` read through the same resolver
  key entry enforces it with (§12.2 rule 5). Discovery is cached for 300 seconds, so it can lag;
  the refusal carries the live value.
- the endpoints `attach`, `subject` and `signout`, and `accountPortal` (`<origin>/#/p/<slug>`,
  the product's page in the customer portal, for `openAccount()`), present while the product's
  portal is on.

A client uses an account feature only when its endpoint is present and never builds one; a
client that predates them ignores them. With Identity off the fragment stays `{"enabled":false}`
(`discovery-capabilities.json` is unchanged). I-08 adds its members beside these.

### 12.7 Passthrough request metadata

These are the Identity service's browser-facing shapes: same-origin portal JSON and the device
label the SDKs send. None of them is signed, and none changes a signed document. The types live
in `@polaris-key/protocol/identity`. The long form is `plans/PX-W13.md` §2. The card behind
"<App> wants you to sign in" (PORTAL.md §4.7, G28) must be trustworthy, so it reads the app's
presentation from a server-side client record through an opaque request handle, never from
display query parameters.

#### 12.7.1 The device label [C]

Pinned by `device-label.json` (`deviceLabelVersion` 1). The wire name is `deviceName`; the stored
and rendered value is the device label. Each SDK applies these steps before sending, and the
Worker applies them on receipt:

1. Map U+0009–000D, U+0085, U+00A0, U+2028, U+2029 and U+3000 to U+0020.
2. Delete U+0000–001F, U+007F–009F, U+061C, U+200B–200F, U+202A–202E, U+2060–2064, U+2066–2069
   and U+FEFF. This removes bidi overrides and zero-width characters.
3. Collapse runs of U+0020 to one, then trim.
4. Keep at most 64 code points (`DEVICE_LABEL_MAX_CODEPOINTS`), counting code points rather than
   UTF-16 units, and trim a trailing U+0020 the cut exposes.
5. If the result is empty, the label is absent: the SDK omits the member, and the Worker stores
   NULL.

There is no Unicode normalisation step, because Godot has no normaliser. Nothing is rejected.
No corpus row holds U+0000, because a Godot `String` cannot; the rule still deletes it.

When the host passes no label, the SDK sends a platform default: Node `os.hostname()` and
Python `platform.node()` without a trailing `.local`, `.lan` or `.home`; Swift
`Host.current().localizedName` on macOS and `UIDevice.current.name` on the iOS family; Kotlin
`Settings.Global.DEVICE_NAME`, else `Build.MODEL`, on Android and the JVM host name elsewhere;
Godot the device model, else the OS name. React sends none: a browser has no device name. A host
overrides the default in its configuration or per call, and opts out with an empty string (Godot:
`PKeyOptions.send_device_name = false`).

`POST /<p>/identity/auth/device/start` answers `deviceName`: the stored label, or `null`. An
older Worker omits the member, and an SDK then shows the label it sent. `license/activate` and
`devices/register` store the label only while the device row has none, so a console or portal
rename always wins.

#### 12.7.2 Client record and request handle

- **Client record.** `{product, kind, appName, developerName, iconUrl, origins, services,
nameVerified}`, with `kind` one of `web`, `native` and `device`. `appName` and
  `developerName` come from the product's listing, `iconUrl` is the same-origin
  `/media/<product>/icon`, `origins` are the registered `web.origins`, and `services` is
  `{license, cloudSync}`. A render-time check of the display-name rules replaces a failing app
  name with the product slug and sets `nameVerified: false`.
- **Request handle.** `rq_` and 16 random bytes in base64url, stored under its peppered hash for
  600 s, and bound to the browser that created it. The binder lives in the `__Host-pk_req` cookie
  (HttpOnly, Secure, SameSite=Lax, Path=/), and its hash lives in the record. The record holds the
  product, the kind, the label, the user code, the origin and a flow reference. The device-code
  confirmation page creates handles. There is no public creation route.
- **`GET /api/signin/requests/:handle`** answers `{request, client, deviceLabel, userCode,
expiresAt}` to the binding browser, with `cache-control: no-store`. An unknown, expired or
  unbound handle answers `404 not_found`, and so does a handle for a product whose Identity toggle
  is off. No display query parameter is read: `appName`, `name`, `icon`, `developer`, `origin`
  and `device` are all ignored.

#### 12.7.3 App consent

`GET /api/signin/requests/:handle/consent` needs the account session and the binder. It answers
`{request, person, items, scopeHash, firstTime, changed}`:

- `items` lists, in order:
  - the licence line `{kind: "license", anchor, more}`. `anchor` is a dry-run choice that writes
    nothing, and `more` is 0 under `licensing.entitlementModel: legacy`;
  - `{kind: "cloudSync"}`, only when the product runs Cloud Sync;
  - `{kind: "profile", claims: ["name", "picture", "email"]}`.
- `scopeHash` is the lowercase hex SHA-256 of the canonical JSON `{"claims":[…],"services":[…],"v":1}`,
  with both arrays sorted.
- `firstTime` and `changed` compare `scopeHash` with `account_product_grants.scope_hash`. Only a
  change of claims or services asks again. "App consent" is that table's name for the concept; it
  is not S-19's grants.

### 12.8 A product with Identity off

1. Device and JSON routes under `/<p>/identity/*` answer the registry's nested
   `404 {"error":{"code":"not_found"}}`. An SDK reports it as `service-unavailable`
   (`service-disabled` in React), keeping its device token and licence state.
2. `POST /<p>/devices/register` keeps its single `registration_closed` body: the JSON API never
   tells "Identity is off" from "absent".
3. A **navigation** — `GET` or `HEAD` with `Sec-Fetch-Mode: navigate`, or an `Accept` header that
   lists `text/html` with a non-zero quality — to `/<p>/identity/<entry>`, where `<entry>` is one
   of `authorize`, `auth/start`, `auth/device` or `auth/device/verify`
   (`IDENTITY_NAVIGATION_ENTRIES`), answers
   `303 Location: <origin>/signin?product=<slug>&error=identity_disabled` with
   `Cache-Control: no-store`. A `*/*` or JSON `Accept` is never a navigation. The redirect runs
   in Core before dispatch, so no Identity code runs; I-21 appends `oauth/authorize`.
4. The portal's passthrough context answers `403 {"error":{"code":"identity_disabled"}}`
   (`IDENTITY_DISABLED_ERROR_PARAM` in `@polaris-key/protocol/identity`).
5. Licences still attach to accounts (Activate License, Discover, verified email), and an owned
   licence's key still activates a device. No device of the product carries a sign-in binding:
   turning Identity off clears every binding (no seat is released, documents are unchanged), and
   the Worker refuses to write one while the toggle is off.

This discloses nothing new: discovery already publishes `identity: {enabled:false}` for every
existing product, and an unknown slug keeps its 404. The transcript `identity-disabled.json`
pins rules 1 and 5 for the SDKs; the Worker suite (`test/identityPerProduct.test.ts`) pins 2 to 4.
