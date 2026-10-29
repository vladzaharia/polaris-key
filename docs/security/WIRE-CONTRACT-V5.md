# Polaris Wire Contract v5

**Status:** Normative. Supersedes `WIRE-CONTRACT-V4.md` (CC-04.1), the way v4 superseded v3. v4 remains the record, including the amendment history in its header; everything v4 said that v5 does not change is restated here, so this document can be read on its own. v5 adds two signed documents and one new section, §15 (Cloud Connect), and nothing else changes on the wire. §12.11 (platform sign-in) is written. U-33.1 amends §13 (Cloud Sync): files on records (§13.2, §13.8), end-to-end push and pull (§13.3, §13.4), the new error codes (§13.9), and the new §13.10 (end-to-end encryption) and §13.11 (the key ring), with the identifiers (§8), counters (§9) and client machine (§11.5) that follow. Those amendments are unsigned and add no `typ`, claim or signed shape. The plans are `plans/CC-01.md` (R-1, R-3, R-8, R-9, R-11), `plans/CC-01-cloud-connect.md` and `plans/CC-01-cloud-sync.md`.
**PROTOCOL_VERSION:** `5` (`@polaris-key/protocol` `core.PROTOCOL_VERSION`).
**Scope:** Everything that crosses the wire or the disk boundary between the Polaris Worker, the CI that signs releases, and the client SDKs (Node, React, Python, Swift, Godot, Kotlin): JWS envelope and its strictness, the eight signed artifacts, trust distribution, the pinned release keys, device principal, offline bundles, verified cache, the monotonic clock floor and the feed `seq` floor. Server-internal behavior (D1 shapes, admin API) is out of scope except where it produces signed artifacts.
**Conformance:** `conformance/corpus/v2/` pins every rule marked **[C]** byte-for-byte across all implementations, within the representation limits declared in §10. `pnpm gen corpus --check` is the drift gate. The v4 plan is `docs/research/2026-09-29-godot-omniplatform/program/plans/P3-01.md`; its §2–§4 are the long form of §1–§4 and §11 here.

**What v5 changes, in one list.** Two signed documents: `pkey-peer+jws`, a device certificate, and `pkey-ring+jws`, the roster of an account's devices, both signed by the product key (§2, §15.2, §15.3). One new section, §15, which also pins the `pkey-peer/1` discovery, handshake, records, relay and device-key route and the new error kinds. `PROTOCOL_VERSION` is 5; `corpusVersion`, `DISCOVERY_VERSION` and `CACHE_VERSION` do not change (§9). The six v4 documents keep their shapes and bytes.

**What v4 changed, in one list (carried).** Two signed documents (`pkey-feed+jws`, the channel feed, signed by the product key; `pkey-release+jws`, the release record, signed by a CI-held release key and verified only against the release keys the app pins). One stricter verifier for all six `typ`s: Ed25519 strictness (§1.1) and an I-JSON profile with number and depth limits (§1.2). Every integer claim, v3's included, decided from its token (§3.1). The members that are not claims decide nothing (§3.2). Patterns match whole strings, lengths count bytes, presence is exact (§3.3). The four v3 documents keep their shapes and bytes.

Design spec: `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` (decision register D-01…D-24).

---

## 1. Trust model

Two tiers for **product keys**, strictly decreasing authority. The on-disk cache is **never** a key source.

1. **Pinned keys** — `TrustSet = Record<kid, base64url(raw Ed25519 pubkey)>` compiled into the host app. Terminal unless tombstoned (below): `mergeTrust(usablePins, discovered) = { ...discovered, ...usablePins }` (pins spread last; a manifest can never shadow a pin). The argument order is pinned first and the spread order is the reverse on purpose, in every implementation: `packages/client-core/src/trust.ts`, `sdks/python/src/polaris_key/core/trust.py` (`merge_trust`), `sdks/swift/Sources/PolarisKeyCore/Trust.swift` and `sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Trust.kt`. **[C]**
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

**Entry shapes and kids.** A manifest key's `kid` and `publicKey` are the entry's identity and its key material: either one missing, or not a string, refuses the WHOLE manifest and keeps the previous trust set. An entry without them is not a forward-compatible key but a malformed manifest, and the pinned-substitution rule cannot even be evaluated against it. `alg`, `kty` and `crv` are the opposite case: an entry that omits one, or carries it with the wrong JSON type, is skipped like one naming another algorithm, and is never fatal. A `kid` is an opaque string with no reserved values: `__proto__` and `constructor` are kids like any other and land in the discovered set, so an implementation whose maps inherit member names builds the set on a prototype-free map. **[C]** via `trust-key-missing-kid-is-fatal` and `trust-kid-proto-is-stored-not-dropped`.

**A third, separate input: the pinned release keys** (`pinnedReleaseKeys`, `pinned_release_keys` in Python and GDScript): `kid → raw 32-byte Ed25519 key, base64url`, the `TrustSet` encoding. Release records verify against these and nothing else. They are configured by the host, compiled into the app, and never persisted, merged or extended from the network. Two or more may be valid at once during a rotation. **A release key is never a product key**: a record whose selected release key's bytes are also in the effective product trust set is refused (§3.5), an SDK refuses options in which a pinned release key is also a trust pin (`invalid-options`), and the `.pkey/release` sync refuses a declared release key equal to any current or retired product signing key. Otherwise the Worker would hold the private half of a release key and the two-signer property would be gone without a trace. **[C]** via `releaseRecordCases`.

**Delegated content keys** (`plans/P4-19.md`). A pinned release key may delegate one **content key** through a CI-signed `kind: delegation` record (§2.5.4). A content key is never pinned, configured or persisted as a key: it is reached only through a delegation that verifies against the **pinned release keys** (never the product trust set, never another delegation), and only for a `kind: pack` record of a delegable type under the delegation's scope, inside its signing window (§3.5 steps 13 and 16). The delegated key's bytes must equal no pinned release key and no key of the effective product trust set. A delegated record names its delegation in its header `kid` (`pkd1-<delegation hash>`, `DELEGATED_KID_PATTERN`); an SDK refuses options that pin a release kid matching that pattern (`invalid-options`). Content keys never sign app records, revocations, delegations, pins, holds, embedded baselines or replacements. **[C]** via `delegationCases`.

JWS mechanics are unchanged from v3: compact JWS, `alg: "EdDSA"` (Ed25519) only, fixed header key order `{"alg","typ","kid"}`, header ≤ 1024 bytes decoded, payload ≤ 65 536 bytes decoded (encoded-length caps checked **before** any decode), strict, **canonical** base64url (reject `+ / =` and whitespace, a length of 1 mod 4, and any set bit among the last character's unused low bits: re-encoding the decoded bytes must give the input back; this applies to all three segments and to every trust-set key, pinned or published, where a non-canonical published key is skipped and a non-canonical pinned key verifies nothing), duplicate-JSON-key rejection in header and payload, signature verified over the raw encoded bytes **before** the payload is parsed, verification key selected only by header `kid` from the caller's trust set. **[C]**
Exception: the `pkey-bundle+jws` payload cap is **262 144 bytes** (it wraps up to three inner compact JWSs); the caller passes this cap explicitly to the verifier for that `typ` alone (§7). The cap and the type are ONE grant: the raise is raise-only (a requested cap below the frozen 64 KiB is inert), and a raise requested with no `typ` demanded is **refused outright**, never downgraded to 64 KiB, because a quarter-megabyte payload accepted untyped could be re-presented at an ordinary document call site with the raised cap already in force. **[C]** via `bundle-payload-raised-cap-without-typ`.

### 1.1 Ed25519 strictness [C]

A verifier applies these checks to the 64-byte signature `R ‖ S` and to the trusted key `A` **before** its backend's verify call:

1. `S`, read as a 256-bit little-endian integer, is less than `L = 2^252 + 27742317777372353535851937790883648493`.
2. `A` and `R` are canonical encodings: the 255-bit `y` (bit 255 cleared) is below `p = 2^255 − 19`, and the encoding is neither of the two "x = 0 with the sign bit set" strings, `01 00…00 80` and `ec ff…ff ff`.
3. Neither `A` nor `R` is one of the eight small-order encodings (`SMALL_ORDER_ENCODINGS`, lowercase hex): `0100…00` (order 1); `ecff…ff7f` (order 2); `0000…00` and `0000…0080` (order 4); `26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05`, its `…fc85` twin, `c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a` and its `…03fa` twin (order 8).
4. The equation is cofactorless, `[S]B = R + [k]A`. No prime-subgroup check is made, so a mixed-order key with a cofactorless-valid signature verifies.

Checks 1–3 are byte comparisons, so a lenient backend never accepts what a strict one refuses. Pinned by the `sig-*`, `pubkey-*` and `valid-pubkey-mixed-order` `jwsCases`.

### 1.2 Strict JSON, numbers and depth [C]

These rules apply to the decoded header (before the signature check) and to the decoded payload (after it), for all eight `typ`s:

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

Eight document types, domain-separated by `typ` (unknown or missing `typ` is rejected): **[C]**

| `typ`              | Artifact                   | Signed by                                                                                     | Verified against                                                              |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pkey-license+jws` | License document           | the product key (Worker)                                                                      | the effective product set                                                     |
| `pkey-config+jws`  | Config document            | the product key (Worker)                                                                      | the effective product set                                                     |
| `pkey-trust+jws`   | Trust manifest             | a pinned product key (Worker)                                                                 | the usable pinned product keys (§1)                                           |
| `pkey-bundle+jws`  | Offline activation bundle  | a pinned product key (Worker)                                                                 | the usable pinned product keys (§1)                                           |
| `pkey-feed+jws`    | Channel feed               | the product key (Worker)                                                                      | the effective product set                                                     |
| `pkey-release+jws` | Release record             | a release key (CI); a data-only pack record may be signed by a delegated content key (§2.5.4) | the pinned release keys (a content key only through a delegation they verify) |
| `pkey-peer+jws`    | Device certificate (§15.2) | the product key (Worker)                                                                      | the effective product set                                                     |
| `pkey-ring+jws`    | Device roster (§15.3)      | the product key (Worker)                                                                      | the effective product set                                                     |

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

The trust manifest, the feed and the roster are device-less; a device certificate names its device (§15.2). The release record carries no `iss`: `key.plrs.im` would be false, and the pinned `kid` already names the signer.

Normative constants (all **[C]**): `DOC_EXPIRY_SECONDS = 3600` · `CLOCK_SKEW_SECONDS = 300` · `MAX_GRACE_SECONDS = 31 536 000` (365 d) · `REFRESH_MARGIN_SECONDS = 1800` · `SECONDS_PER_DAY = 86 400` · `MAX_WIRE_INTEGER = 9 007 199 254 740 991` · `MAX_JSON_DEPTH = 64` · `FEED_TTL_SECONDS = 900` · `MAX_FEED_TTL_SECONDS = 3600` · `ROLLOUT_BUCKETS = 10 000` · `MAX_RECORD_JWS_BYTES = 88 844`.

### 2.1 License document (`pkey-license+jws`)

Envelope plus:

```jsonc
{
  "licenseId": "…",
  "profile": {
    /* DocProfile — optional signed greeting/holder block; absent or an object, never null */
    "name": "…",
    "firstName": "…",
    "email": "…",
    "activatedAt": 1756252800,
    "user": { "subject": "ps_…" }, // only while an account is signed in on this device (SP-54)
  },
  "entitlements": {
    /* JSONValue map */
  },
}
```

`name`, `firstName` and `email` are the **licence holder's**, as the licence records them. `user` is the person signed in **on this device**: the pairwise subject (`account_product_subjects`, one per account and product, §8) of the account whose sign-in bound the requesting device (`devices.subject`, §12.3). It carries no name, email or account id. The Worker writes it only when that binding is set and wholly matches `^ps_[A-Za-z0-9_-]{22}$`; a malformed stored value writes nothing and never fails the request. A key-entry or open-enrolment device, a signed-out device and every offline bundle (§7) get no `user`, and their documents are byte-identical to those before SP-54. The member appears at the device's first licence-document refresh after a sign-in and is gone from the first one after sign-out; a document already issued keeps what it was signed with until it expires.

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

**Clients that predate P4-19.** A delegated record's kid is not a pinned release key, so a v4 SDK built before P4-19 refuses it at step 13 (`jws`) and keeps what it runs; a required pack whose only release is delegated stays missing, as on a failed fetch. A `kind: delegation` record verifies as a reserved kind and is never fetched; a `revocations` entry with `kind: "delegation"` parses as before (unknown members are ignored) and its target is never in H. No field client half-accepts anything, so `PROTOCOL_VERSION` stays 5.

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

`profile.user` (§2.1, SP-54) is read only by `licenseUserOf`, which is total. It returns `{subject}` when `profile` is an object, its own `user` is an object, and that object's own `subject` is a string that wholly matches `^ps_[A-Za-z0-9_-]{22}$` (§3.3 rule 1: no trailing line terminator, ASCII classes only), and `null` otherwise. Unknown members of `user` are ignored. The member never refuses a document (`licenseDocCases` `license-profile-user-*`; `licenseUserCases` pins the reader).

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
- The two unsigned hints can only tighten the gate, and that is a claim about the **vocabulary**, so it is checked, not assumed. `blocked.reason` MUST be one of `version-too-old`, `version-too-new` or `channel-not-entitled` (`BLOCK_REASONS`). A value outside that set is **dropped** where a hint is read back (the cache reload, a session response: an unparseable hint is no hint) and **coerced to `version-too-old`** at the network ingress (a 403 whose body names no known reason still means blocked), and the gate coerces once more at its decision point. It is never coerced to a usable status: the gate returns the reason AS the `LicenseStatus`, so a permissive fallback is a licence bypass with no signature anywhere, and the hint is evaluated before the document, so it would not even need one. The activation and `licenseServiceEnabled` guards still precede the hint. **[C]** via the gate-matrix vocabulary rows (`license.blocked`).

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

| Header               | Value                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-PKey-Platform`    | `macos`, `ios` (iPadOS too), `tvos`, `visionos`, `watchos`, `android`, `windows`, `linux`, `web`                                                                                   |
| `X-PKey-Arch`        | `arm64`, `x86_64`, `armv7`, `wasm32`                                                                                                                                               |
| `X-PKey-SDK`         | the SDK id: `node`, `react`, `python`, `swift`, `godot`, `kotlin`, or a server core's `<language>-server` (§14.4); a later SDK registers its id in `conformance/parity/enums.json` |
| `X-PKey-SDK-Version` | the SDK's package version (unchanged)                                                                                                                                              |

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
document, claim, header or error code changes, and `PROTOCOL_VERSION` stays 5.

| Refusal (403)     | Routes                                                                                         | Link                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `device_limit`    | `POST /<p>/license/activate`, `POST /<p>/license/enroll`, `POST /<p>/identity/session/license` | attached licence: `<portal>/#/p/<slug>/free-device?license=<id>[&for=<label>]`      |
|                   |                                                                                                | floating licence: `<portal>/activate?product=<slug>&next=free-device[&for=<label>]` |
| `key_entry_limit` | `POST /<p>/license/activate`, `POST /<p>/identity/session/license` (§12.2)                     | `<portal>/activate?product=<slug>`                                                  |

1. **Shape.** `manageUrl` is an absolute `https` URL of at most `MANAGE_URL_MAX_LENGTH` (2048)
   characters on the customer origin: `CUSTOMER_ORIGIN` when it is set to a usable origin, else `CONSOLE_ORIGIN`, else the request's own origin (§12.9). The body keeps
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
stays 5 and `DISCOVERY_VERSION` stays 2, because every SDK's discovery parser ignores members it
does not know.

### 5.6 Commerce (CM-29)

Commerce is the service `commerce` and requires License.

1. **Discovery.** `services.commerce` is `{"enabled":false}` unless the product runs Commerce. When on, it is `{"enabled":true,"endpoints":{"binding":"<base>/commerce/binding","claim":"<base>/commerce/claim"}}`. It never names a store, product id or count, and a client that does not know the slug ignores it.
2. **Device routes.** `GET /<p>/commerce/binding` and `POST /<p>/commerce/claim` take a device token and P6-01's bodies. While Commerce is off, both answer `404 {"error":{"code":"not_found"}}`, byte-identical to an unknown route. `/<p>/distribution/commerce/*` does not exist.
3. **Store hooks.** `POST /<p>/distribution/hooks/app-store` and `…/play-rtdn` are Commerce's canonical, store-facing routes, not aliases. No SDK calls them, and `/<p>/commerce/hooks/*` does not exist.

### 5.7 The product page link (`core.portal`) [C]

Pinned by `portal-matrix.json` and `discovery-portal.json` (DISC-01).

```jsonc
"core": { …, "portal": { "enabled": true, "activate": "https://polaris.locker/activate?product=djdl" } }
"core": { …, "portal": { "enabled": false } }
```

1. **Presence.** Every discovery from a Worker that ships §5.7 carries `core.portal`, last in
   `core` (after `presentation`). `enabled` is the product's `portal.enabled` (default on), read
   once per document, so §12.6's `accountPortal` is present exactly when `enabled` is true. While
   it is false, the member is `{"enabled":false}` and nothing else.
2. **`activate`** is `<origin>/activate?product=<slug>`, `<origin>` the customer origin of §12.9.
   It is omitted when no origin is usable or the URL exceeds `MANAGE_URL_MAX_LENGTH` (2048).
3. **Parse** (`parsePortal(core)`). If `core` is not an object, `portal` is not an object, or
   `enabled` is not a boolean, the result is `null` ("unknown"). `enabled: false` gives
   `{enabled:false}`, and other members are ignored. `enabled: true` gives
   `{enabled:true, activate}`: `activate` is the member if it passes §5.3 rule 4, else `null`.
   Unknown members are ignored. The member never refuses discovery.
4. **Resolution** (`portalLink({served, portal, baseUrl, product})`), first match:
   1. `served`, the response's own link (a refusal's `manageUrl`), if it passes §5.3 rule 4;
   2. `portal` is `{enabled:false}`, or `{enabled:true, activate:null}`: `null`. This fails
      closed: never the legacy guess, because the Worker has answered;
   3. `portal.activate`;
   4. `portal` is `null` (an older Worker, or never discovered): the legacy link. Its origin is
      `https://key.plrs.im` mapped to `CUSTOMER_ORIGIN_DEFAULT` when the base with trailing slashes
      removed is `"https://" + ISSUER`, else that base. Then `/activate?product=` and the slug,
      percent-encoded (a slug that matches `PRODUCT_SLUG_RE` needs none). It is kept only if it
      passes §5.3 rule 4; with no product, the result is `null`.
5. **Source.** The member comes from this session's discovery, else the last one persisted by the
   client. A successful discovery always replaces it, and an absent member clears it.
6. **What a client may add: nothing.** Never `#key=`: that fragment is for a refusal's own link
   only (§5.3 rule 5), so a discovery-supplied host never receives a key. A client opens the link
   only on a user action or prints it (§5.3 rule 6). A terminal wraps it in OSC 8 only when it is
   https.

## 6. Device principal

- **Device id binding (desktop file stores).** On macOS, Windows and Linux the SDK derives the device id from the platform anchor (`deviceIdFromRaw(product, raw)`, §6.1) at every start. A stored id is used only when no anchor is readable. A stored id that disagrees with the derived one is discarded together with the token and the grant slices of the cache (`trustJws`, `docs`, `etags`, `bundle` and both hints): `deactivate()` without the network call. The update slices and `pinRevocations` are kept. The anchor probes run by absolute path (`/usr/sbin/ioreg`, `%SystemRoot%\System32\reg.exe`), never through `PATH`. Keychain and Keystore stores keep their stored id. The device re-activates once; the server coalesces the stale seat by hardware id.

- **Token:** `pkeyt_` + 43 base64url chars (256-bit). Hash-stored server-side; KV hot record `{product, deviceId, licenseId | null}` — `licenseId` is null for registered-without-license devices. `plrst_` tokens (the withdrawn spelling, §8) are rejected (pre-launch, no migration).
- **Registration policy** (per product, always derived from the enabled services — `requires-license` if License is enabled, else `requires-identity` if Identity is enabled, else `open`; it is not declared: the manifest key `devices.registration` that v3 described is removed in 0.9 and the validator refuses it):
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
2. `aud` equals the product; `deviceId` equals the local device id; `issuedAt ≤ now + skew`; `now ≤ expiresAt + skew` (the bundle import window uses network-path freshness — a stale bundle is refused). `now` here is `effectiveNow` (§4.2), not the raw system clock: winding the machine back must not reopen a lapsed import window. The floor only rises, and only from artifacts that just re-verified, so using it extends no window. The `now` of a `bundleCases` vector is that effective clock.
3. Verify `trust` against the usable pins (reload profile, the tombstone rule included); build the effective set.
4. Verify each entry of `docs` against the effective set with the **reload profile** (`checkFreshness: false` — inner docs carry long `graceUntil`, not long `expiresAt`). **Per-type floors:** each inner document must be strictly newer (`issuedAt`) than the verified cached document of its type, if one is held; otherwise the import is `inner-doc-rejected`. An old bundle cannot roll a device back.
5. Atomically write cache v3: `bundle` (the bundle JWS, verbatim), `trustJws`, `docs`, and the evidence for any pin the inner manifest tombstoned. The held `trustJws` is kept instead when its `issuedAt` is newer than the bundle's manifest, so an old bundle cannot re-teach a key the device has seen revoked. The update slices and `pinRevocations` are carried. No token is created.

**Profiles.** The steps above are the **import** profile. The **reload** profile re-verifies the cached `bundle` at every start: steps 1–3 without step 2's two import-window comparisons (a bundle imported on day 29 still activates on day 300, and a bundle stamped ahead of a wound-back clock still reloads), and step 4 with no floors (its documents are the cached ones). Every other check of step 2 still binds. A byte-identical re-import of the bundle an install runs on is a success with no write; this happens before step 1 and is outside the corpus.

State semantics: `bundle` verifying on the reload profile, with `docs.license` byte-identical to its licence document and no token held ⇒ gate `activation: "bundle"`. If the device later activates online, the token path supersedes (`activation: "token"`). Fingerprint enforcement is skipped for bundle activation (no server to dedupe against). Server-side minting is an admin surface (`POST /manage/api/products/<slug>/bundles`), audit-logged, `graceDays ≤ 365` enforced at mint **and** verify.

`docs.license` is **optional by design**: a config-only product (D-08) air-gaps with a bundle carrying only `docs.config` + `trust`. Importing a bundle with no license document has **no activation effect** — for a license-enabled product the gate remains `needs-activation`; for a license-disabled product it is `not-applicable` as always. `activation: "bundle"` arises only from a bundle whose license document verified. A bundle with an EMPTY `docs` (no license, no config) is refused at import step 2 as vacuous.

## 8. Identifier registry

Amendment A1 (see the design spec) withdrew the interim `plrs` rebrand, so the v2 identifier family carries forward unchanged apart from the document types v3 and v4 added. The "withdrawn" column exists so a reader who saw the interim spelling in a draft, a branch or an old plan knows it is not merely deprecated — no verifier, signer or store ever accepts it.

| Concern                  | v5 (normative)                                                                                                                                                                                                                                                                   | Withdrawn (never accepted)                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| ISSUER (`iss`)           | `key.plrs.im`                                                                                                                                                                                                                                                                    | `plrs.im`                                                 |
| Device token prefix      | `pkeyt_`                                                                                                                                                                                                                                                                         | `plrst_`                                                  |
| Admin API token prefix   | `pkeya_`: the ADMIN API credential, not a wire credential. `Authorization: Bearer pkeya_…` on `/manage/api/*` only; `pkeya_` + 43 base64url characters (256 bits), stored only as `hashKey(token, KEY_HASH_PEPPER)`, shown once at mint; no signed document ever names it        | — (no interim spelling ever existed)                      |
| Client headers           | `X-PKey-*`                                                                                                                                                                                                                                                                       | `X-Polaris-*`                                             |
| License key prefix       | `pkey_<product>_…`                                                                                                                                                                                                                                                               | — (never changed)                                         |
| JWS `typ` values         | `pkey-license+jws`, `pkey-config+jws`, `pkey-trust+jws`, `pkey-bundle+jws`, `pkey-feed+jws`, `pkey-release+jws`, `pkey-peer+jws`, `pkey-ring+jws`                                                                                                                                | the `plrs-*` spellings                                    |
| Record hash              | lowercase hex SHA-256 over the exact ASCII compact JWS of the record                                                                                                                                                                                                             | —                                                         |
| Outlet kinds             | `direct`, `app-store`, `testflight`, `altstore`, `altstore-pal`, `play`, `play-testing`, `obtainium`, `fdroid-repo`, `ms-store`, `app-installer`, `steam`, `itch`, `flathub`, `snap`, `winget`, `web` (`unknown` is a detection result only)                                     | —                                                         |
| Version schemes          | `semver`, `semver+build`, `4part`                                                                                                                                                                                                                                                | —                                                         |
| Manifest dir             | `.pkey/` — the ONLY directory, no fallback                                                                                                                                                                                                                                       | `.polaris/`                                               |
| Session domain tags      | `pkey.admin.v1\|`, `pkey.portal.v1\|`                                                                                                                                                                                                                                            | `plrs.admin.v1\|`, `plrs.portal.v1\|`                     |
| Session cookies          | `__Host-pkey_admin`, `__Host-pkey_portal`, `pkey_<p>_session`                                                                                                                                                                                                                    | the `plrs_` spellings                                     |
| Keychain service (Swift) | `pkey:<product>`                                                                                                                                                                                                                                                                 | `plrs:<product>`                                          |
| Config env prefix        | `PKEY_CONFIG_`                                                                                                                                                                                                                                                                   | `PLRS_CONFIG_`                                            |
| Hash domains             | `pkey-hw`, `pkey-device:` (FROZEN at `fingerprintVersion` 1)                                                                                                                                                                                                                     | — (never changed; a rename orphans every enrolled digest) |
| Serving host             | `key.plrs.im`                                                                                                                                                                                                                                                                    | — (equal to the issuer, but checked separately)           |
| Pack id                  | `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, at most 64 bytes, never `app`: a pack record's `deliverable`, `pins[].pack`, `expects[].pack`, `builds[].embeds[]` (`isPackId`)                                                                                                              | —                                                         |
| Pack patterns            | `PACK_TYPE_PATTERN`, `VOCAB_TOKEN_PATTERN`, `OBJECT_FORMAT_PATTERN`, `HANDLER_PREFIX_PATTERN`, `ENTITLEMENT_PATTERN`, `VARIANT_AXIS_PATTERN`, `VARIANT_VALUE_PATTERN`, `ENGINE_PATTERN` (§2.5.1; `@polaris-key/protocol/packs`)                                                  | —                                                         |
| Pack formats             | `pkey-files/1`, `pkey-patch/1`, `pkey-marker/1`, `pkey-content/1`, `pkey-chunks/1` (`CHUNKS_FORMAT`); files `X.pkey.json`, `D/.pkey/pack.json`, `pkey-content.json`                                                                                                              | —                                                         |
| `treeDigest`             | lowercase hex SHA-256 of the UTF-8 lines `<sha256hex> <size> <path>\n`, sorted by path bytes (§2.6)                                                                                                                                                                              | —                                                         |
| Record kinds             | `app`, `pack`, `revocation`, `delegation` (`RECORD_KINDS`); `RESERVED_RECORD_KINDS` is empty                                                                                                                                                                                     | —                                                         |
| Delegation record        | a `pkey-release+jws` with `kind: "delegation"`, signed by a pinned release key; `deliverable` is the scope root (§2.5.4)                                                                                                                                                         | —                                                         |
| Delegated kid            | `pkd1-<delegation record hash>`, `DELEGATED_KID_PATTERN` `^pkd1-[0-9a-f]{64}$`                                                                                                                                                                                                   | —                                                         |
| Delegation limits        | `MAX_DELEGATION_TTL_SECONDS` = 31 622 400; `MAX_DELEGATION_TYPES` = 8; `MAX_DELEGATIONS_PER_CHECK` = 16; `DELEGABLE_PACK_TYPES` = `files.tree`, `data.json`, `l10n.table`                                                                                                        | —                                                         |
| Data-only rule           | `DATA_ONLY_EXTENSIONS` (14, §2.8); `DATA_ONLY_HEAD_BYTES` = 64; `DATA_ONLY_TAIL_BYTES` = 65 557                                                                                                                                                                                  | —                                                         |
| Revocation record        | a `pkey-release+jws` with `kind: "revocation"`, signed by a release key; its feed entry is the record's hash with its target's pin (§2.5.3)                                                                                                                                      | —                                                         |
| Revocation limits        | `MAX_FEED_REVOCATIONS` = 64 (per feed, and per check); `REVOCATION_REASON_MAX_BYTES` = 512; a device keeps at most 256 revoked targets (`MAX_STORED_REVOCATIONS`, a client limit)                                                                                                | —                                                         |
| Delta-menu limits        | `MAX_FEED_DELTAS` = 64 entries per feed; `MAX_FEED_DELTAS_PER_TARGET` = 4 per target payload (§2.4.2)                                                                                                                                                                            | —                                                         |
| `packSetId`              | lowercase hex SHA-256 of the UTF-8 lines `<packId> <recordSha256>\n`, sorted by pack-id bytes; null for an invalid pack id, a release not 64 lowercase hex, or a pack listed twice (`plans/P4-01.md` §2.9)                                                                       | —                                                         |
| Variant key              | a variant's `axis=value` pairs sorted by axis-name bytes, joined with `;`; the empty string for `{}` (`variantKey`)                                                                                                                                                              | —                                                         |
| Request handle           | `rq_` + 22 base64url characters, `REQUEST_HANDLE_PATTERN` `^rq_[A-Za-z0-9_-]{22}$`; lives `REQUEST_HANDLE_TTL_SECONDS` = 600 (§12.7.2; `@polaris-key/protocol/identity`)                                                                                                         | —                                                         |
| Device label             | `deviceName`, at most `DEVICE_LABEL_MAX_CODEPOINTS` = 64 code points after §12.7.1; display data only (§5.4)                                                                                                                                                                     | —                                                         |
| Pairwise subject         | `ps_` + 22 base64url characters (16 random bytes), `PAIRWISE_SUBJECT_PATTERN` `^ps_[A-Za-z0-9_-]{22}$`; one per account and product, never derived from the account id; signed as `profile.user.subject` (§2.1, §12.3; `@polaris-key/protocol/core`, re-exported by `/identity`) | —                                                         |
| Cloud Sync `clientId`    | `c_` + 22 base64url characters, `^c_[A-Za-z0-9_-]{22}$`: one per (install, partition), stored with its next `mutationId` (§13.3)                                                                                                                                                 | —                                                         |
| Cloud Sync HLC           | `editedHlc`, `^[0-9a-f]{12}:[0-9a-f]{4}$`: 48-bit milliseconds and a 16-bit counter, lowercase hex; the import floor is `000000000000:0000` (§11.5)                                                                                                                              | —                                                         |
| Cloud Sync cursor        | an integer from 0 to 2^53−1, the principal's change sequence; `0` asks for a snapshot (§13.4)                                                                                                                                                                                    | —                                                         |
| Cloud Sync key           | `^[A-Za-z0-9._:-]{1,128}$`: a setting key, a record id or a collection name (a collection may end in `.*`, §13.7)                                                                                                                                                                | —                                                         |
| Cloud Sync `ringId`      | `rg_` + 22 base64url characters, `^rg_[A-Za-z0-9_-]{22}$`: one key ring per (product, subject), with an `epoch` of at least 1 (§13.11)                                                                                                                                           | —                                                         |
| Cloud Sync `kid`         | 16 bytes, lowercase hex (32 characters) in JSON and raw in an envelope header: `HKDF(R, ∅, "pkey-sync/1 kid", 16)` (§13.10.2)                                                                                                                                                    | —                                                         |
| Cloud Sync blinded name  | `x:` + the base64url of a 32-byte HMAC (43 characters), `^x:[A-Za-z0-9_-]{43}$`: the E2E form of a person-chosen setting key, record id, member, field or element. Declared keys and collection names never start with `x:` (§13.10.3)                                           | —                                                         |
| Cloud Sync `uploadId`    | an opaque token minted by `begin`, in the key charset above; lives `SYNC_UPLOAD_TTL_SECONDS` = 86 400 (§13.8)                                                                                                                                                                    | —                                                         |
| Cloud Sync chunk id      | 64 lowercase hex characters: `HMAC-SHA256(K_cid(c), plainChunk)` in E2E mode, the plain SHA-256 in server mode (§13.8.3)                                                                                                                                                         | —                                                         |
| Cloud Sync formats       | `pkey-sync-value/1`, `pkey-sync-file/1`, `pkey-sync-chunk/1`, `pkey-sync-chunks/1` (manifest), `pkey-sync-cdc/1` (chunker), `pkey-sync-wrap/1` (§13.10, §13.11)                                                                                                                  | —                                                         |
| Keychain service (Sync)  | `pkey-sync:<product>`: the synchronizable item that backs up a root, account `<subject>:<ringId>` (§13.11.5). It is distinct from `pkey:<product>`                                                                                                                               | —                                                         |
| Backend header           | `X-PKey-License` (`HEADER_LICENSE`): the compact licence document, from an app to its developer's own backend, never to the Worker; at most 16 384 bytes (§14.1)                                                                                                                 | —                                                         |
| Backend challenge scheme | `PKey-License` (`BACKEND_AUTH_SCHEME`): `WWW-Authenticate: PKey-License realm="<slug>", error="<code>"` on a backend's 401 (§14.3)                                                                                                                                               | —                                                         |
| Server SDK ids           | `node-server`, `python-server`, `swift-server`, `kotlin-server`: the `X-PKey-SDK` a server core sends on its trust-manifest fetch (§14.4; `enums.json` `sdkId`)                                                                                                                  | —                                                         |
| Relay ticket prefix      | `pkeyrt_` + 32 base64url characters: a 60-second single-use WebSocket ticket (§15.7), never a document                                                                                                                                                                           | —                                                         |
| Peer protocol            | `pkey-peer/1` (prologue, adverts, handshake, records, §15.4–§15.6); relay subprotocol `pkey-relay.1` (§15.7)                                                                                                                                                                     | —                                                         |
| Peer service type        | `_pkeypeer._tcp` (§15.4)                                                                                                                                                                                                                                                         | —                                                         |
| Peer limits              | `PEER_CERT_SECONDS` = 604 800; `PEER_CERT_RENEW_SECONDS` = 302 400; `MAX_PEER_CERT_SECONDS` = 604 800; `RING_SECONDS` = 604 800; `MAX_RING_DEVICES` = 128; `MAX_PEER_MESSAGE_BYTES` = 1 048 576 (§15.2, §15.3, §15.6)                                                            | —                                                         |

`pkey-config+jws` and `pkey-trust+jws` are the v2 type strings reused for v3's config document and trust manifest; the document _shapes_ changed in v3, the type strings did not.

The outlet kind `direct` is presented as Polaris Key: the console, the download page and the docs label it "Polaris Key", while the identifier stays `direct` in every signed document, the corpus and every SDK (a prose change, not a contract change).

## 9. Rollout & versioning

v5 is additive on the wire: the six v4 documents keep their shapes and bytes, and no SDK enforces `protocolVersion`, so a deployed v4 SDK is unaffected. The two new `typ`s (§2) enter with the bump, as `pkey-bundle+jws` entered with v3 and `pkey-feed+jws` and `pkey-release+jws` with v4. An SDK that predates v5 never fetches or verifies either, and refuses an unknown `typ`. Every SDK's constant follows `PROTOCOL_VERSION` through `pnpm gen constants`; nothing else is required until its parity row for the Cloud Connect features (`connect.*`) flips. The new corpus sections and files (§15.9) are inert until then, because runners read named sections. Version counters: `PROTOCOL_VERSION` goes from 4 to 5. `corpusVersion` stays 2 (the sections are additive, as `feedCases` were), `DISCOVERY_VERSION` stays 2, and `CACHE_VERSION` stays 3: Connect state is its own store record, never the licence cache. The new counters are `noiseVectorsVersion = 1` and `peerMatrixVersion = 1`. The statements below that say a counter "stays 4" were written inside v4 and are restated for v5 with the new value.

v4 is additive on the wire: the four v3 documents keep their shapes and bytes, deployed v3 clients are unaffected (no SDK enforces `protocolVersion`), and v4 SDKs fall back to `update.check()` against a Worker without `update.endpoints.feed`. The stricter verifier (§1.1, §1.2, §3.1) accepts everything the Worker signs once its signer guard and write checks are deployed (P3-12), so no SDK release built on v4 is published before that Worker. Version counters and their owners: `PROTOCOL_VERSION = 5` (this contract), `corpusVersion = 2`, `gateMatrixVersion = 2`, `fingerprintVersion = 1`, `stageMatrixVersion = 3` (client boot behaviour outside this contract, owned by `client-core/src/stages.ts`), `headersVersion = 2` (§5.2; SP-08 turned the `visionOS` and `tvOS` rows from no value into canonical values), `configMatrixVersion = 1` (§2.2.1), `updateMatrixVersion = 1`, `outletMatrixVersion = 1` and `planMatrixVersion = 2` (§11), `contentCorpusVersion = 2` (§2.6, `content/cases.json`), `syncScenariosVersion = 2` (§11.5), and the per-product catalog `schemaVersion` (orthogonal). `CACHE_VERSION` stays 3. P4-13 changes none of these: it fills reserved slots (§2.4.1, §2.5.3, §2.5.2 holds) with members parsed beside the claims and appends new corpus sections, so `PROTOCOL_VERSION` stays 5, `corpusVersion` 2, `updateMatrixVersion` 1, `contentCorpusVersion` 1 and `PACK_STATE_VERSION` 1. P4-10 fills `variants[].chunks` (three claim checks, two integer paths) inside v4 and appends sections, so `contentCorpusVersion` and `planMatrixVersion` go to 2 (runners must handle or declare planned the new strategy and the optional `chunkIndex`); `PROTOCOL_VERSION`, `corpusVersion` and `CACHE_VERSION` are unchanged. P4-19 fills the reserved kind `delegation` and adds one optional member to a feed `revocations` entry and one to `PackInstall`, appending `delegationCases` and `dataOnlyCases`: every counter above is unchanged (`PROTOCOL_VERSION` 5, `corpusVersion` 2, `contentCorpusVersion` 2, `updateMatrixVersion` 1, `PACK_STATE_VERSION` 1), because a v4 SDK that predates it refuses a delegated record at step 13 and ignores the entry `kind` (§2.5.4). P4-29 fills the reserved feed member `deltas` (§2.4.2) with a member parsed beside the claims, appending `feedContentCases` and the new sections `feedDeltaCases` and `feedDeltaApplyCases`: every counter above is unchanged (`PROTOCOL_VERSION` 5, `corpusVersion` 2, `planMatrixVersion` 2, `contentCorpusVersion` 2, `updateMatrixVersion` 1, `CACHE_VERSION` 3, `PACK_STATE_VERSION` 1), because a v4 SDK that predates it ignores the member. HA-12 adds the unsigned discovery member `core.presentation` (§5.5) and the client table `presentation-matrix.json` (`presentationMatrixVersion = 1`). Every counter above is unchanged (`PROTOCOL_VERSION` 5, `DISCOVERY_VERSION` 2, `corpusVersion` 2, `CACHE_VERSION` 3), because an SDK that predates it ignores the member. The trust-custody amendment (§1, §2.3, §4.1, §7) changes no counter either (`PROTOCOL_VERSION` 5, `corpusVersion` 2, `gateMatrixVersion` 2, `CACHE_VERSION` 3): its two cache slices are additive, its corpus cases are appended, and its one changed verdict (`trust-member-shapes-ignored`) is a client tightening. I-09 adds the account routes (§12.3), `license_owned` on key entry (§12.2 step 3) and the identity fragment's account members (§12.6): the identity routes are additive within v4 and detected from discovery (a client uses a route only when the fragment advertises it), no signed document changes, and every counter above is unchanged (`PROTOCOL_VERSION` 5, `DISCOVERY_VERSION` 2, `corpusVersion` 2). Deployed SDKs keep the behaviour they shipped with: no SDK enforces `protocolVersion`, and an SDK that predates `?signer=` reads the default manifest as before. An install activated by a bundle through the old `importedBundle` marker re-imports after upgrading, and a bundle past its 30-day import window needs a fresh mint. Cloud Sync adds unsigned routes detected from `services.sync` (§13): every counter above is unchanged (`PROTOCOL_VERSION` 5, `DISCOVERY_VERSION` 2, `corpusVersion` 2, `CACHE_VERSION` 3), because Cloud Sync data is never signed, the config document keeps its shape and resolution (§2.2.1), and an SDK that predates it ignores `services.sync` and the catalog's `user` and `cloudSync` members. A new SDK on a Worker without the routes finds no `settings: true` and keeps `config.set` on the device. SP-53 changes no counter; it adds `backendMatrixVersion = 1` (§14, `backend-matrix.json`). Product backends add one request header to the developer's own backend and no Worker route, `typ`, claim or signed shape, so `PROTOCOL_VERSION` stays 5, `corpusVersion` 2, `DISCOVERY_VERSION` 2 and `CACHE_VERSION` 3. A deployed SDK never sends `X-PKey-License`, so a backend that adopts a drop-in before its apps update answers `license_required` until they do. SP-54 changes no counter: it adds one optional member inside the licence document's `profile` (`user`, §2.1), which §3.2 already leaves unchecked, appends three `licenseDocCases` and the section `licenseUserCases`, and adds no `typ`, claim or route, so `PROTOCOL_VERSION` stays 5, `corpusVersion` 2 and `CACHE_VERSION` 3. Every SDK that predates it ignores the member; a new reader against an older Worker reads `null`, and a backend that requires sign-in then answers `sign_in_required` until the Worker that signs the member is deployed. CM-29 adds the unsigned discovery member `services.commerce` and moves two device routes (§5.6). Every counter is unchanged, because an SDK that predates it ignores the member. DISC-01 adds the unsigned discovery member `core.portal` (§5.7) and the client table `portal-matrix.json` (`portalMatrixVersion = 1`); the terminal kits' ui-matrix goes to `uiMatrixVersion = 6`. Every other counter is unchanged (`PROTOCOL_VERSION` 5, `DISCOVERY_VERSION` 2, `corpusVersion` 2, `CACHE_VERSION` 3), because a shipped SDK ignores the member and keeps printing the link it printed before; nothing can change a shipped build. Cloud Sync files and end-to-end encryption (§13.2–§13.4, §13.8–§13.11) add unsigned routes, discovery members and one new cipher suite for stored data, and no `typ`, claim, header or signed shape. `PROTOCOL_VERSION` stays 5, `DISCOVERY_VERSION` 2, `corpusVersion` 2 and `CACHE_VERSION` 3. Two client tables move when their corpus lands: `syncScenariosVersion` goes from 2 to 3 (§11.5) and the new `sync-vectors.json` starts at `syncVectorsVersion = 1` (§13.10.8). A new SDK on a Worker that does not advertise `services.sync.encryption` stays local with status `unsupported` when the app requires E2E; an SDK that predates this amendment ignores every new member. The corpus drift gate remains the only automated cross-language enforcement; this document remains the normative source.

## 10. Divergence & hardening ledger

All v2 and v3 divergence classes (alg confusion, oversize, duplicate keys, alphabet strictness, typ separation, freshness profiles, trust substitution, clock floor, per-type anti-replay floors, config-document-without-license issuance, registration-policy token minting, bundle all-or-nothing import, bundle payload cap, gate `not-applicable`/`activation` semantics, channel vocabulary and aliases, fingerprint component derivations, client metadata header values, config resolution and environment values) carry into v4 unchanged. New classes introduced by v4, each with corpus coverage: Ed25519 strictness (§1.1, the `sig-*` and `pubkey-*` `jwsCases`); strict JSON, numbers and depth (§1.2, the `json-*` and `valid-*` `jwsCases`); integer claims decided from the token, with their minimums (§3.1, the v3 claim cases, `feedCases`, `releaseRecordCases` and every `nonWireIntegers` member); members outside the claims (§3.2); whole-string patterns, byte lengths and member presence (§3.3); the feed `seq` floor, its ceiling and the canonical channel that keys it (§4.4); record hash before signature (§3.5); and release keys that are never product keys (§1). Packs v1 (`plans/P4-01.md`) adds four: forward-compatible pack claims, where an unknown vocabulary value makes a thing unusable and never refuses the record (§3.2, the `pack-valid-*` `packRecordCases`); side-object integers, decided by the token rule inside the files index, the patch descriptor, the marker and the stamp (§2.6); marker parsing and its verification order (§3.7, `markerCases`); and decoder window limits, checked from the frame header before any delta is decoded (§2.6). P4-13 adds one: **content members parsed beside the claims** — the feed's `packSets`, `packFloors`, `revocations` and delta menu `deltas` (P4-29, §2.4.2), an app's `holds` and a revocation's body are read by usability functions (`feedContent`, `holdsOf`, `revocationOf`), so a malformed member is unusable and never refuses the feed or record (§2.4.1, `feedContentCases`, `revocationCases`, the holds `stampCases`). P4-19 adds two: **delegated signers** — a content key verifies only through a delegation verified against the pinned release keys, one level deep, inside its scope, types, tree layout and signing window, and never on a release-key surface (§1, §2.5.4, §3.5 steps 13 and 16, `delegationCases`); and the **data-only rule**, an extension allow-list over already-normalised paths with head and tail magic sniffs that fail closed (§2.8, `dataOnlyCases`). Implementations must not add local tolerances beyond this document; any observed divergence gets a corpus case before a fix.

The trust-custody amendment adds four: **canonical base64url** — segments and trust-set keys are refused, or a published key skipped, unless re-encoding the decoded bytes gives the input (§1, the `*-noncanonical-trailing-bits` and `segment-trailing-newline` `jwsCases`, `trust-pubkey-noncanonical-skipped`); **the key-status allow-list** (§1, `key-status-*` `trustCases` and `trust-member-shapes-ignored`); **pinned-key tombstones and their evidence order** (§1, §4.1, the `pin-*` and `manifest-signed-by-tombstoned-pin-refused` `trustCases`, `bundle-signed-by-tombstoned-pin-refused`); and **bundle floors and the reload profile** (§7, the `bundle-floor-*` and `bundle-reload-*` `bundleCases`). The signer retry is pinned by the `trust-signer-retry` transcript.

HA-12 adds one class: **display members parsed field by field**. `core.presentation` is read member by member. A malformed field is dropped and never refuses discovery, and icon bytes are shown only when their SHA-256 equals the hash the member names (§5.5; `presentation-matrix.json` `parseCases`, `pickCases` and `verifyCases`).

SP-53 adds one class: **a document presented to a third party**. A product backend decides `X-PKey-License` in a pinned order (§14.2, `backend-matrix.json` `verdict`): one element only, so a second or joined field is refused (`invalid-two-fields`, `invalid-joined-values`); the trust set chosen by the `aud` and the `aud` checked again, so one product's key never signs for another (`invalid-cross-product-key`); `X-PKey-Device` as a consistency check that cannot re-bind a document (`invalid-device-mismatch`); and freshness from the document or the backend's `maxAgeSeconds`, never past `graceUntil`. It keeps no anti-replay floor, so a captured document replays until it goes stale, about 65 minutes by default (§14.6, `ok-replayed-older-document`, `stale-replayed-after-window`); this is declared, not mitigated.

SP-54 adds one class: **the signed-in subject is read beside the claims**. `profile.user` names the account signed in on the device by its pairwise subject only, and `licenseUserOf` reads it totally: a malformed member is no signed-in user and never refuses the document (§2.1, §3.2; the `license-profile-user-*` `licenseDocCases` and `licenseUserCases`).

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

`core.portal` is parsed as a whole (§5.7). An invalid `activate` is no link, never repaired and never replaced by a guess.

Cloud Connect (§15) adds one class: **a certificate and a roster shown to third parties, and a handshake before consent**. A device certificate has no anti-replay floor, so its checks are lifetime, `aud`, `sub`, key shape and (in a session) key binding (§15.2). A roster replaces another only at a higher epoch with the same `aud` and `sub` (§15.3). A peer in a roster-lagging state is admitted or closed by the epoch rule, never by the clock. Low-order X25519 points and all-zero DH outputs are refused (§15.2 step 4, §15.5). A short authentication code is committed before it is shown, so a man in the middle cannot grind keys against it (§15.5). Modes `v` and `p` carry no identity before consent. Criticality is in the record type (§15.6), so an unknown critical record closes the session and an unknown non-critical one is ignored.

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

Client behaviour beside the Cloud Sync routes (§13; `plans/U-01.md` §2.3, §2.4, §4.1, as amended by `plans/U-01b.md` §2.5, §4 and its Revision 2; S-17 §5.4–§5.6). `sync-scenarios.json` (`syncScenariosVersion` 2; 3 with the end-to-end rules below) is literal data written by `tools/sync-scenarios.ts`, not computed by an implementation; `@polaris-key/client-core/cloud-sync` is its first implementation and every SDK replays it with a fake clock, a fake transport that answers from the scenario's `respond` steps, and a `clientId` source that returns `init.clientIds` in order. Version 2 renames the calls to the shipped `set` and `clear`, gives every pull body §13.4's `quota` and `usage`, routes the scenario catalog, pins the `sync` state, changes one expectation (`locked-key-refused`: a lock answers `managed_by_admin`, and an undeclared key is an open setting, not an error) and appends rules, scenarios, the `legacyLocal` init member and a `settingCases` section.

- **Routes.** The host derives one route per declared key with `@polaris-key/catalog` `syncedSettings(catalog)` and hands them to the machine as `CloudSyncCatalog.settings`: `{key, route: "synced", scope: "user" | "platform", policy, schema?}` for an Editable `config` key, or `{key, route: "local" | "locked" | "refused"}`. A key with no route is an **open setting**: scope `user`, `lastWrite`, no schema. `settingCases` pins the derivation (catalog entries in, routes out), so each SDK port re-implements it identically. The host runs the machine only while discovery says `services.sync.settings: true`; otherwise `config.set` keeps its shipped device-local path, with no 8 KiB limit and no `secret`/`flag` refusal.
- **Partitions.** The journal holds one partition per subject (`clientId`, `nextMutationId`, `cursor`, `pending`, `held`, the cloud snapshot) and the unbound `local` partition (one value per synced or open key, with its `editedHlc`). Nothing written in one partition is sent under another. `deviceLocal` holds the `local` keys; it is the SDK's existing `config.local` store and belongs to no partition. Reads are optimistic: the active partition's snapshot with its pending operations and debounced drafts applied by the key's policy (`max`/`min` keep the extreme, `merge` applies member ops), falling through to the rest of the resolution chain (`from: "document"`) when there is no value, when the stored value fails the key's schema (`invalid`), or when the current document marks the key `enforced` or `hidden`: a lock beats every synced and local value. A `local` key reads from `deviceLocal` (`from: "device"`). `settingState(key)` is `{sync, invalid, locked}`. `sync` is `local` with no principal or for a `local` key, `pending` while a draft or a journal operation for the key exists (a parked one included), and `synced` otherwise.
- **Edits.** `set(key, value)` and `clear(key)` answer in this order and journal nothing on a refusal: a `refused` key (a declared `secret` or `flag`) is `bad_request`; a `locked` key, or one the current document locks, is `managed_by_admin`; a value that fails the synced key's schema, or longer than 8,192 bytes of canonical JSON (`SYNC_MAX_VALUE_BYTES`), is `bad_request`. A `local` key is then written to `deviceLocal` at once; it never moves at sign-in and is never pushed. Any other key, an undeclared one included, stamps the HLC at the call and (re)starts a 2,000 ms per-key debounce. At commit (timer, `flush`, sign-in, sign-out or relaunch, keys in byte order) a signed-out device writes the local partition; a signed-in one appends `set`/`clear` with the target `{setting, scope}` (the route's scope; `user` for an open setting), or for a `merge` key one `setMember`/`removeMember` per changed member (members in byte order) against the view without the draft. `mutationId`s come from `nextMutationId` at append time. A commit of a key drops that key's parked operations (Results). Records: a `revision` `put` is not debounced; while a push carrying that record is in flight, later puts replace one held value (rule 3), and an unsent queued put is coalesced in place. A `lastWrite`, `max` or `min` record write is a `set` with `editedHlc` and no `baseVersion`. A `union` record sends `add`, and `remove` with `observedSeq`.
- **Import.** `importLocal(values)` runs once per install with the legacy `config.local` contents; a second call does nothing. A synced or undeclared key goes into the local partition (on a device already signed in, straight into the subject's journal as `moved` operations) stamped at the HLC floor `000000000000:0000`, without `preContact`, so rule 8 never re-stamps it. Any cloud value or tombstone beats the floor under `lastWrite`: the push gets `conflict` and the client takes the server copy, so a device that upgrades last cannot overwrite newer cloud data. A `max`/`min` key is decided by value. A `local` key goes into `deviceLocal`. A `locked` or `refused` key, and a value over 8,192 bytes, is not imported: it stays in `config.local`, read as before and never synced.
- **HLC.** Physical part `now + offsetMs`; a tick takes `(p, 0)` when `p` exceeds the last physical part, else increments the counter. `offsetMs = serverNow − now` from every `200`. An op stamped before the install's first `200` is marked `preContact`; while uncontacted, the first request is a pull, and if its offset exceeds 300,000 ms every pre-contact stamp (journal, local partition, drafts, and the last HLC) is shifted by the offset before any push.
- **Requests.** One at a time: a pull (`GET /<p>/sync?cursor=&clientId=`) while uncontacted or after `cursor_expired` (cursor 0), else a push of up to 100 pending operations that are not parked, in `mutationId` order, else a pull when one is wanted (start, sign-in, back online, `more`). A request-level failure (transport, `400`, `413`, `429`, `5xx`) changes nothing and waits for the next trigger. A `503` whose `error.code` is `writes_paused` on a push also leaves the journal unchanged, and sets `status.state: "paused"` (with `pending`), never `blocked`: it needs no `refresh`, the host's backoff honours `Retry-After` (300 s when absent), the next trigger retries, and the next `200` push clears it. Pulls are still served. A `401` blocks (`status.reason: "unauthorized"`) until `refresh` (a successful licence or config document fetch). A `403 attestation_required` blocks with `reason: "attestation"`, and any other `403` except `account_required` with `reason: "forbidden"`; both keep the journal and wait for `refresh`. `409 client_mismatch` regenerates the `clientId`, renumbers the pending operations from 1 and resends; `410 cursor_expired` keeps the journal, resets the cursor and pulls a snapshot before pushing again. A file route's `403` (§13.8) is that call's error and never blocks the machine.
- **Results.** Every processed result removes its mutation (rule 1), except a parked one. `ok` updates the snapshot (`renamedTo` names the server key; `dropped` changes nothing and reports `origin: "migration"`). A setting `conflict` takes the server copy and enqueues nothing (Q6), and so does a `lastWrite`, `max` or `min` record `conflict`. A `revision` record `conflict` takes the server copy and enqueues a new mutation on the server's version only for a held edit or a keep-local hook (rule 2); it is the only conflict an app is asked to resolve. A setting result `rejected` with `quota_exceeded` or `entitlement_required` **parks** the operation: it stays in the journal marked `parked: "quota"` or `"entitlement"`, is not sent, still applies to reads (so `sync` stays `pending`), sets `status.reason` to `quota` or `entitlement`, and emits no event. It is re-sent as a new mutation (a fresh `mutationId`, the original `editedHlc`) after a `200` whose `quota.bytes − usage.bytes` grew (quota-parked operations), or at sign-in to that subject (both kinds). A newer local edit of the key, or a change or tombstone with a later `editedHlc`, drops it. Every other `rejected` code (`value_invalid`, `setting_not_synced`, `op_invalid_for_policy`, `collection_unknown`) is terminal: the value reverts and `{type: "rejected", mutationId, code}` is emitted. A cursor-0 answer replaces the snapshot; `changes`, `tombstones`, `cursor` and `aliases` are then applied, and `quota` and `usage` are read only for the parked rule. Value changes emit `{type: "change", keys, origin}` grouped by origin (`local`, `remote`, `merge`, `migration`), keys in byte order; a key whose moved first-sign-in operation was resolved in that response reports `merge`.
- **Sign-in and sign-out.** Sign-in moves every local-partition setting into the subject's partition as ordinary operations marked `moved` (keeping `editedHlc` and `preContact`), empties the local partition in the same write and re-sends that partition's parked operations; `deviceLocal` is never moved. Sign-out commits drafts, flushes for up to 5,000 ms when online, then emits `{type: "signedOut", reason, unsynced}` (and `unsyncedData` when operations remain and were not discarded; parked ones count); under `onSignOut: clear` it wipes the snapshot and resets the cursor, keeping the pending operations in that partition. `403 account_required` (then `blocked` with `signInOffered`) and a response naming another subject are handled the same way with no flush. A signed-out partition expires 30 days after sign-out, checked at sign-in and at start. Cloud Sync never writes licence state, cached documents or `lastSyncUnauthorized`.
- **End-to-end mode (`syncScenariosVersion` 3).** Init gains `encryption: "e2e" | "server"`. The fake transport speaks plaintext, and sealing is the host codec's job, pinned by `sync-vectors.json` (§13.10.8). Four rules join the list: `e2e-client-policy`, `e2e-locked`, `encryption-pinned` and `encryption-since`.
  - **Locked.** A device with no root for the current ring is `locked`. `status.state` is `locked` with `reason: "keyring"`. Reads fall through to the rest of the resolution chain, an edit is journaled as a draft in the clear on the device (never sent), and nothing is pushed or pulled as plaintext. The journal is kept. When a root arrives (§13.11) the machine unlocks, seals the held operations and pushes them in `mutationId` order. A pull may run while locked, so the snapshot is stored sealed and opened at unlock.
  - **The encryption pin.** An app that requires E2E (its catalog says `e2e`, the default) never speaks to a Worker whose discovery says `encryption: "server"` or omits it: the machine stays local with `status.state: "unsupported"` and the client code `sync-encryption-pinned`. A downgrade after contact is the same refusal, and the journal and snapshot are kept. The mode is decided by discovery and the pull's `encryption`, never by a response body that carries `value`.
  - **Client policy.** `max` and `min` are decided by the client in E2E mode (§13.10.5). On `conflict` the client opens the server copy, keeps the better value, and re-pushes on the server's `version` with `origin: "merge"`. It never prompts. `merge` and `union` stay on the server over blinded names. A schema failure is `bad_request` on write and `invalid` on read.
  - **`encryptionSince`.** A pull carries `encryptionSince`, the store sequence from which every row is sealed. A row below it is legacy plaintext: an E2E client reads it, and re-seals it on its next write. A row at or above it that is not sealed is `invalid`. The client does not adopt each served value: it keeps the least value it has been served per partition, and never above the lowest version it has itself pushed sealed or opened sealed (§13.10.7).
  - **Scenarios** (`syncScenariosVersion` 3): `e2e-max-conflict-remerged`, `e2e-min-server-wins`, `e2e-merge-member-cells`, `e2e-locked-keeps-journal`, `e2e-unlock-pushes`, `e2e-downgrade-refused`, `e2e-legacy-plain-below-since` and `server-mode-unchanged`. `settingCases` gains E2E rows: each route carries `encryption`.
- **Files.** A file `begin`, part, chunk and `finalize` are driven by the host's transfer engine, not by the scenario machine. A file route's failure is that call's error (§13.8) and changes no journal state.
- **Error names.** The scenarios name canonical codes from `conformance/parity/errors.json`. Godot's `config.set_value` answers `invalid-options` for the refusal the scenarios call `bad_request` (a value that fails the schema, a `secret` or `flag` key), so its runner maps the canonical code to the native one; `errors.json` stays the arbiter. The client codes `setting-locked` and `setting-unknown` are not registered: `managed_by_admin` and `bad_request` already ship.

## 12. Accounts and Identity

There is one Polaris Key account per person, platform-wide; it is never a per-product toggle. A
product's `identity` service toggle gates only sign-in _through that product_
(`plans/I-04.md` §2.1). Nothing in this section is signed and nothing here enters the licence
document: `PROTOCOL_VERSION` stays 5. The licence document's claims and members are independent
of `licenses.account_id` and `devices.subject` until LX-09: attaching a licence, a sign-in binding,
a sign-out and a counted key entry leave every document a device verifies unchanged. §12.2 is
PX-W9's key entry with I-09's step 3 (`license_owned`). §12.3 (attach, subject and sign-out) and
the account members of §12.6 are I-09's; §12.4 (`authorize`, Continue and Cancel), §12.5
(`token`) and the issuer and endpoints of §12.6 are I-08's; the licence choice (§12.4.1, §12.5.1) is
I-08b's. §12.7 is PX-W13's passthrough request metadata and §12.8 is PX-W17's Identity-off
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
Nothing here is signed and no signed document changes: `PROTOCOL_VERSION` stays 5.

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
      login card, `<origin>/signin?product=<slug>` (`<origin>` is the customer origin: `CUSTOMER_ORIGIN` when it is set to a usable origin, else `CONSOLE_ORIGIN`, else the request's own origin),
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
5. **Sign-out.** Drops this device's binding, and no other device's, so its next licence document carries no `profile.user` (§2.1). `released` is true only
   when the sign-in bound the device (`bound_by = 'signin'`) to a licence of the account signing
   out: the device is then deauthorized and its token stops working. A device activated by key
   or enrolment keeps its licence and token. A client flushes Cloud Sync before it signs out
   (S-17 §5.4 rule 5) and drops its token when `released` is true.
6. **Not auth failures.** `account_required`, `license_owned` and `license_email_bound` keep the
   client's token and state.

### 12.4 Authorize, Continue and Cancel [C]

Pinned by `redirect-web-happy.json`, `redirect-web-errors.json` and `identity-request-hints.json`
(transcripts; their `browser` steps are the requests no SDK makes). The authorization server of
layer 1 is one per product: the issuer is `<origin>/<p>/identity`, discovery's `issuer`. Its one
client is the product's own public client: `client_id` is the product slug and PKCE `S256` is
mandatory; any other `client_id` is `invalid_client`. Only while the product's Identity service is
on (§12.8).

`GET /<p>/identity/authorize` is a browser navigation, never a `fetch`:

| Parameter                                              | Rule                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `response_type`                                        | Required, `code`                                                                                                                                                                                       |
| `client_id`                                            | Required, the product slug                                                                                                                                                                             |
| `redirect_uri`                                         | Required. Its origin is in the product's `web.origins` and its path in `identity.redirectPaths`, both matched exactly: no query, fragment, userinfo, wildcard, prefix, suffix or dot segment           |
| `state`                                                | Required, 16 to 512 characters                                                                                                                                                                         |
| `code_challenge`, `code_challenge_method`              | Required, 43 base64url characters and `S256`. `plain` and an absent method are refused                                                                                                                 |
| `scope`                                                | Optional, space-delimited `profile`, `email`, `cloudSync`. Absent: every one the product grants. Unknown values are ignored. `openid` is `invalid_scope` until I-21                                    |
| `nonce`                                                | Optional, at most 255 characters, kept for I-21                                                                                                                                                        |
| `login_hint`, `name_hint`, `purpose`, `license_choice` | Optional Polaris extensions. A hint prefills the card and verifies nothing, and one that does not normalise is dropped. `purpose` is `signin` or `attach`; `license_choice` is `card` or `app` (I-08b) |

1. **No redirect before both are valid.** `client_id` and `redirect_uri` are checked first. A bad
   `client_id` renders `invalid_client` (401) and a bad `redirect_uri` renders
   `redirect_uri_mismatch` (400) on a branded page; neither redirects, whatever else is wrong.
2. **Later errors** are `302 <redirect_uri>?error=…&state=…&iss=<issuer>` (RFC 6749 §4.1.2.1,
   RFC 9207): `invalid_request`, `invalid_scope`, `access_denied` (Cancel) or `server_error`.
   `state` is echoed only when it was sent.
3. **Success** stores the validated request under an opaque handle (§12.7.2) bound to this
   browser by the `__Host-pk_req` cookie, and answers `303 <origin>/signin?request=rq_…`, where
   `<origin>` is the customer origin: `CUSTOMER_ORIGIN` when it is set to a usable origin, else `CONSOLE_ORIGIN`, else the request's own origin. When that is not the API host's own origin, the cookie
   cannot be set here (it is host-only), so the request is bound to a fresh binder instead and the
   `303` goes through the bind hop (§12.9): `<origin>/signin?request=rq_…&bind=<token>`, with no
   `Set-Cookie`. Neither the app's `state`, its challenge nor its redirect URI is in either URL.
   60 calls a minute per client network.
4. **Continue** is `POST /api/signin/requests/<handle>/continue` (same-origin portal JSON) with
   the account session, the portal CSRF header and the binder cookie of the browser that started
   the request: this is the callback binding of R1-07 for the web redirect. The body is
   `{consent?: {claims}, choice?: LicenseChoiceInput, terms?}` (§12.4.1); `consent.claims` is a subset of the
   request's scope. Continue is always shown (there is no skip). It refuses without consuming
   anything with `409 terms_required` (the product's terms version was not accepted; `terms` names
   the version shown) and `409 license_choice_required` (the account holds licences for the
   product and `choice` names none of them). It then takes the request in one atomic consume,
   records app consent (`account_product_grants`: the claims granted and the hash of what the
   product asked) and answers `{"redirect": "<redirect_uri>?code=…&state=…&iss=<issuer>"}`.
   The code lives 60 seconds and is single use, bound to the product, `client_id`,
   `redirect_uri`, the PKCE challenge, the account and the granted scope. The device is not known
   here and binds at `token`.
5. **Cancel** is `POST …/cancel` under the same three credentials and answers
   `{"redirect": "<redirect_uri>?error=access_denied&state=…&iss=…"}`.
6. A handle that is unknown, expired, bound to another browser, already taken, or for a product
   whose Identity is off answers `404 not_found`, always in the same shape.

### 12.5 Token [C]

`POST /<p>/identity/token` redeems the code (`grant_type=authorization_code`). Pinned by
`redirect-web-happy.json` and `redirect-web-errors.json`.

1. **Request.** `application/x-www-form-urlencoded` with `grant_type`, `client_id`, `code`,
   `code_verifier` and optionally `redirect_uri` (compared exactly when sent) and `device_name`.
   A JSON body, a missing or repeated parameter is `invalid_request`. It needs `X-PKey-Device`;
   the metadata headers are read when present. The answer is `no-store`, and CORS answers the
   product's `web.origins` only, never with credentials. 30 a minute per client network and 10 a
   minute per device id, failing closed (`429 rate_limited` with `retryAfter`).
2. **The code.** It is redeemed against the challenge derived from the verifier in one atomic
   operation. Match or mismatch, the code ends, so a wrong verifier cannot be guessed at and a
   second redemption finds nothing. An unknown, expired, used or mismatching code, another
   `client_id`-bound code or another `redirect_uri` is `invalid_grant`. A `client_id` that is not
   the product's is `invalid_client` (401) and touches no code.
3. **A `200`** carries exactly `access_token` (the `pkeyt_` device token, not repeated as
   `token`), `token_type: "Bearer"`, `scope` (the granted subset), `schemaVersion`, `device`,
   `license` (`null` on a licence-less device) and `subject`. There is no `expires_in` and no
   `refresh_token` before I-21, and no `keyEntries` before I-08b.
4. **The device binds here.** With the licence chosen at Continue, the device claims a seat
   (seat-checked, `bound_by = 'signin'`, the pairwise subject written). With none to choose, it is
   bound licence-less. A device that presents its own live token in `Authorization: Bearer`
   keeps the licence it runs on: the account is bound to it where it stands and the answer is
   that token. A device id that already runs on a licence, without that proof, is never taken
   over: `409 license_choice_required`. A licence-less device id that already holds a credential
   is re-registered only by the device that presents it the same way; without the proof the
   answer is `403 not_entitled`. With `license_choice=app` and a choice due, `token` answers the
   pending sign-in of §12.5.1 instead and binds nothing.
5. **Errors** are flat (RFC 6749 §5.2): `400 invalid_request`, `401 invalid_client`,
   `400 invalid_grant`, `400 unsupported_grant_type`, `400 invalid_scope`; and the Polaris refusals
   beside them, as on `license/activate`: `403 not_entitled`, `403 device_limit` (with `limit`,
   `deviceCount`, `manageUrl`), `409 license_choice_required`, `429 rate_limited`.
   `interstitial_required` is answered only by the token-exchange grant (§12.11.3); refresh
   (I-21) answers `unsupported_grant_type` until then.
6. **Never a token in a URL.** The device token is in the body of this response only, and the
   redirect carries a code that is useless without the verifier.

### 12.4.1 The licence choice on the card [C]

Pinned by `redirect-web-choose.json`. Both reads need the portal session and the request's binder
(as the consent view does), are same-origin JSON with `cache-control: no-store`, and answer
`404 not_found` for a handle that is unknown, expired, bound to another browser or for a product
whose Identity is off. They are display data and authorise nothing: Continue and `token` re-read
the offer.

- `GET /api/signin/requests/<handle>/licenses` answers `LicenseChoiceView`: `state` (`choose` when
  the account holds a candidate, `autoIssue` when it holds none and the product's policy grants
  one, else `none`), `choices[]`, `keep` (never true here: a browser has no device), `preselected`,
  `create` (the explicit "Create a new license" row, only when every candidate is full) and
  `getLicense` (the no-licence state: `activateUrl`, `purchaseUrl`, `keyEntry`). A `LicenseChoice`
  is `{id, tierName, name, origin, access, seats {used, limit}, current, expiresAt, state,
blockedReason?, replace, freeDeviceUrl}`: `origin` is one of `purchase`, `store`, `key`, `free`,
  `developer`, `signin`; `access` is `account` for a licence issued by signing in (no key) and
  `seats` otherwise, never a displayed type; `state` is `free`, `full` (a full row offers Replace
  while the product's portal is on) or `blocked` (its tier needs a fingerprint a sign-in cannot
  present); `replace` is `{allowed, retryAfter}` on a full row and `null` otherwise.
- `GET /api/signin/requests/<handle>/licenses/<licenseId>/devices` answers `ReplaceView`:
  `{licenseId, seats, devices[{id, label, platform, deviceType, lastSeen, leastRecent, activeNow,
thisBrowser}], replace}`, the licence's seat-holding devices, least recently used first. One
  `404 not_found` for a licence that is unknown, another account's, not full, or whose portal is
  off.
- **Continue's `choice`** is `{kind: "license", licenseId, replaceDeviceId?}`, `{kind: "create"}`,
  or the earlier `{licenseId}`. With `license_choice=card` and candidates, a missing choice, a
  full licence without `replaceDeviceId`, a blocked one, `keep` (a browser has no device) and
  `key` (a key is never stored on a code) are `409 license_choice_required`; `create` is accepted
  only when the offer says so; an unknown `replaceDeviceId` is `404 not_found`. With no candidate
  and a policy that grants one, Continue mints the account's first licence (see below) and the code
  carries it. Nothing is consumed by a refusal. The code carries the choice; `token` binds it, and
  a Replace is executed there (§12.5.1).
- **The first automatic licence.** Minted by the press (Continue; `choice/complete` `create` in app
  mode), never by sign-in alone and never while a usable licence exists unless the choice is the
  explicit `create`. One licence per account and product: the press takes the `license-mint` claim
  (I-02's store, 30 s), re-reads the offer inside it and mints once; a press that loses the claim,
  or finds the licence already there, mints nothing and answers `409 license_choice_required`,
  and the card re-reads `licenses`. An unreachable store fails closed (`503 unavailable`). The
  licence is an account licence (origin `oidc`, held by the account, no key). Discover's add takes
  the same claim.

### 12.5.1 The pending sign-in grant [C]

Pinned by `redirect-web-choose-app.json`, `choice-replace-app.json`, `choice-key-app.json` and
`choice-grant-errors.json`. With `license_choice=app` on `authorize` (recorded on the request and
the code), the card has no licence step, and `token` answers `200`
`{"status": "choose", "grant": "sg_…", "expiresIn": 300, "choices": LicenseChoiceView}` instead of
the §12.5 body when a choice is due (the account holds a candidate or the device runs on a licence
outside the list; or it holds none, the policy grants none and the product accepts keys). Only the
`choose` body has a `status` member. With no choice due (the press minted the first licence, or
the product runs no License service), `token` answers as in §12.5. The grant is `sg_` and 43
base64url characters, bound to the product, the account, the pairwise subject and the redeeming
`X-PKey-Device`, lives 300 seconds and is consumed by `complete` or `cancel`.

The four routes are `POST /<p>/identity/choice/{licenses,devices,complete,cancel}`: JSON bodies
(at most 4 KiB), `no-store`, `X-PKey-Device` required, CORS for `web.origins` without credentials,
Identity on only. Errors are the nested Polaris body.

| Route      | Body                           | Answer                                                                        |
| ---------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `licenses` | `{grant}`                      | a fresh `LicenseChoiceView`                                                   |
| `devices`  | `{grant, licenseId}`           | `ReplaceView`                                                                 |
| `complete` | `{grant, choice, deviceName?}` | the §12.5 body (`TokenResponse`), plus `keyEntries {used, limit}` after a key |
| `cancel`   | `{grant}`                      | `204`; nothing is bound                                                       |

`choice` is `{kind: "license", licenseId, replaceDeviceId?}`, `{kind: "keep"}` (needs the device's
own token in `Authorization: Bearer`), `{kind: "create"}` or `{kind: "key", key}`.

1. **Replace.** `replaceDeviceId` names a seat-holding device of a FULL licence. The removal is the
   portal's Remove (same checks, the shared `portalDeviceDisconnect` budget of 20 per 60 s, the
   `portal.device.disconnect` audit row "to sign in <label>", the security email) and commits in
   one D1 batch with the new device's seat claim. `429 rate_limited` carries `retryAfter`. If the
   claim cannot join the batch the freed device stays freed and the answer is `403 device_limit`
   with `racedAfterFree: true`.
2. **Key.** The key is PX-W9's key entry on the `app` surface: counted exactly once, atomically
   with the seat claim, refused with `403 license_owned` (`signInUrl`) and `403 key_entry_limit`
   (`keyEntries`, `manageUrl`) as `license/activate` does; a key that is not an active licence key
   is `401 unauthorized`. The device stays key-bound and is also signed in to the account.
3. **Errors.** `400 invalid_grant` (malformed, unknown, expired, consumed, another product's or
   another device's grant; the grant of another device is not burned), `400 bad_request` (no or a
   malformed device id, a malformed choice), `404 not_found` (a licence outside the view, another
   account's, not replaceable, or an unknown device), `409 license_choice_required` (no choice, a
   choice that was not offered, a lost mint), `403 device_limit` (with `limit`, `deviceCount`,
   `manageUrl` and a fresh `view`), `403 not_entitled`, `403 fingerprint_required`,
   `409 hardware_mismatch`, `429 rate_limited`. A refusal the person can retry leaves the grant open
   for the time it has left.
4. **Budgets.** 30 reads per grant (`licenses`, `devices`, and each key attempt), 60 calls a minute
   per client network, failing closed.
5. **Device code never issues a grant.** The cross-device channel can be phished (R1-07); only the
   same-device channels (the web redirect here; loopback, scheme and claimed HTTPS by I-15; the
   native exchange by I-13) can.

### 12.6 Discovery

Pinned by `discovery-identity.json`. With Identity on, the identity fragment carries, beside its
sign-in endpoints:

- `"account": true`: the routes of §12.3 are served.
- `"keyEntryLimit": n`: the product's `identity.keyEntry.limit` read through the same resolver
  key entry enforces it with (§12.2 rule 5). Discovery is cached for 300 seconds, so it can lag;
  the refusal carries the live value.
- the endpoints `attach`, `subject` and `signout`, and `accountPortal` (`<origin>/#/p/<slug>`,
  the product's page in the customer portal, for `openAccount()`; `<origin>` is the customer origin: `CUSTOMER_ORIGIN` when it is set to a usable origin, else `CONSOLE_ORIGIN`, else the request's own origin), present
  while the product's portal is on. Only this value changes host: the issuer, `authorize`, `token`
  and every other endpoint stay on the API host.

`accountPortal` is present exactly when `core.portal.enabled` is true (§5.7). A client uses an account feature only when its endpoint is present and never builds one; a
client that predates them ignores them. With Identity off the fragment stays `{"enabled":false}`
(`discovery-capabilities.json` is unchanged). I-08 adds `"issuer"` (§12.4), the `authorize`
and `token` endpoints (§12.4, §12.5) and makes `"configured"` always `true`: the platform sign-in
needs no per-product identity-provider row. **`configured` says only that `authorize` and `token`
are served.** The legacy `auth/*` routes and the device-code sign-in still need the product's
identity-provider row and answer `404 disabled` without one, whatever `configured` says; a
client decides what it can offer by the endpoints present (`authorize`, `token`, `authDeviceStart`)
and never by `configured` alone. I-08b adds `choiceLicenses`, `choiceDevices`, `choiceComplete` and
`choiceCancel` (§12.5.1) beside `token`; an SDK sends `license_choice=app` only when all four are
present.

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
   `303 Location: <origin>/signin?product=<slug>&error=identity_disabled` (`<origin>` is the customer origin: `CUSTOMER_ORIGIN` when it is set to a usable origin, else `CONSOLE_ORIGIN`, else the request's own origin) with
   `Cache-Control: no-store`. A `*/*` or JSON `Accept` is never a navigation. The redirect runs
   in Core before dispatch, so no Identity code runs. `token` is a JSON route and answers the
   registry's `404`.
4. The portal's passthrough context answers `403 {"error":{"code":"identity_disabled"}}`
   (`IDENTITY_DISABLED_ERROR_PARAM` in `@polaris-key/protocol/identity`).
5. Licences still attach to accounts (Activate License, Discover, verified email), and an owned
   licence's key still activates a device. No device of the product carries a sign-in binding:
   turning Identity off clears every binding (no seat is released, documents are unchanged), and
   the Worker refuses to write one while the toggle is off.

This discloses nothing new: discovery already publishes `identity: {enabled:false}` for every
existing product, and an unknown slug keeps its 404. The transcript `identity-disabled.json`
pins rules 1 and 5 for the SDKs; the Worker suite (`test/surfaces/identityPerProduct.test.ts`) pins 2 to 4.

### 12.9 The customer host

While `CUSTOMER_ORIGIN` is set to a usable https origin that is not the console's (a hard cutover: there is
no switch), a second host is the customer site and serves the people-facing pages. Nothing
signed changes: `PROTOCOL_VERSION` 5, the issuer `key.plrs.im` and every signed document are
unchanged, and a client reads every value below as any https URL.

1. **Unsigned values that name the host.** `manageUrl` and `signInUrl` (§5.3, §12.2),
   `accountPortal` (§12.6), `verificationUri` and `verificationUriComplete` (device start),
   `freeDeviceUrl` and `getLicense.activateUrl`, `core.portal.activate` (§5.7), and the `Location` of `authorize` (§12.4 rule 3)
   and of §12.8 rule 3. With no usable `CUSTOMER_ORIGIN` they are what they were.
2. **Routes.** It serves `/`, `/activate`, `/signin`, `/device`, `/tv`, `/login[/…]`, `/callback`,
   `/logout`, `/magic/verify`, `/api/*`, `/media/*`, `/download/<token>`, `/assets/*`, its own
   `/.well-known/polaris-host.json` and `/robots.txt`. Everything else, the product routes and
   `/manage` included, is the plain `404`. The issuer, `authorize`, `token`, discovery and every
   signed document stay on the API host.
3. **The bind hop.** `authorize` cannot set the request's `__Host-pk_req` cookie on another host.
   It binds the request to a fresh binder and a single-use **bind token** (32 random bytes,
   stored by its peppered hash, 120 seconds) and answers
   `303 <customer>/signin?request=rq_…&bind=<token>` with no `Set-Cookie`. `GET /signin?request=&bind=`
   on the customer host redeems the token once, sets `__Host-pk_req` itself and answers
   `303 /signin?request=rq_…` with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The
   `Location` is built from the stored handle; nothing in the query is echoed. An unknown, used,
   expired, malformed or mismatched token is the plain `404`; `HEAD` does not redeem. A bind URL is
   worth what the `authorize` URL is worth: whoever opens it binds their browser to that request.
4. **The device page stays on the API host.** `/device` and `/tv` look a code up across products
   and answer `302` to `<api>/<p>/identity/auth/device?user_code=` (`<api>` from configuration,
   never the request). The confirmation, the IdP leg and the callback happen in one browser on one
   host, because the flow's binder must be set by the confirming browser (R1-07): a device
   confirmation never crosses hosts, and there is no bind token for it.
5. **No session crosses hosts.** Cookies are host-only on both hosts; a person signs in on the one
   they use.

The transcripts `locker-refusal-links.json`, `locker-discovery-identity.json`,
`locker-devicecode.json` and `locker-redirect-web.json` pin rules 1 and 3 for the SDKs; the Worker
suite (`test/surfaces/signInBind.test.ts`, `test/surfaces/customerDevicePage.test.ts`) pins the rest.

### 12.10 The device-code poll [C]

`POST /<p>/identity/auth/device/poll` (the device-code flow's poll; the request names `deviceCode`
and `deviceId`). Nothing here is signed: `PROTOCOL_VERSION` stays 5. The types are
`DevicePollResponse`, `DevicePollSlowDown` and `DevicePollUnavailable` in `@polaris-key/protocol/identity`; the transcripts
`devicecode-*.json` and `locker-devicecode.json` pin it.

| HTTP | Body                                                              | Meaning                                                                              | SDK result                               |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| 200  | `{"status":"pending"}`                                            | Not yet confirmed, signed in and approved                                            | keep polling                             |
| 429  | `{"status":"slow_down","interval":n}`                             | Polled inside `interval` (a state, not an error body)                                | lengthen the interval                    |
| 200  | `confirm` / `ready`                                               | Unchanged (I-37: `attachable` is always `false`)                                     | unchanged                                |
| 200  | `{"status":"timeout"}`                                            | The flow is gone: expired, redeemed, or dropped after a refusal                      | `expired`                                |
| 200  | `{"status":"error","reason":"access_denied"}`                     | A person refused: Deny, **Not you?**, the chooser's Cancel, or Deny on the code page | `sign-in-denied`                         |
| 503  | `{"error":"unavailable","message":"try again"}`, `Retry-After: n` | Approved, but the sign-in could not finish yet. The flow is kept                     | keep polling (`server-error`, transient) |
| 200  | `{"status":"error"}`                                              | The sign-in failed after approval and will not be retried; the cause is not said     | `sign-in-failed`                         |

1. `reason` appears only on `error`, and `access_denied` is its only value. A client reads an
   unknown `reason` as absent.
2. A refusal is sticky: the poll answers it until the flow lapses (600 s), then `timeout`.
3. Every refusal gets the same body, whichever page refused and whether or not the person had
   signed in.
4. No account, identity, provider or licence cause is ever named. These stay the bare `error`.
5. **The Worker retries a transient failure.**
   - Any failure after approval that is not a refusal answers the 503 and keeps the flow. That
     covers a database, store or vault error in the account check, the activation or the mint.
   - The first poll at or after `Retry-After` attempts the completion again. A poll before then
     gets the same 503 with the seconds left, and nothing is attempted.
   - There are four retries, at 2, 4, 8 and 16 s. The fifth failure answers the bare `error` and
     drops the flow, so the next poll answers `timeout`.
   - If the code lapses first, the poll answers `timeout`.
6. **A refusal is never a 503.** A seat, fingerprint, hardware or licence refusal at the mint
   answers the bare `error` once and drops the flow, then `timeout`. N9 and a refused activation
   already work this way.
7. **A client treats every 5xx on the poll as transient**, with or without a JSON body, the
   runtime's own 500 included. It keeps polling at its interval until the code lapses.
   `Retry-After` is advisory, because the Worker enforces the spacing.
8. The 503 names no cause, and rule 4 still holds. It does tell the holder of the device code that the failure was not a refusal, so the one fact a poller can read is transient (503) versus final (the bare `error`); which cause applies is never disclosed.

The route does not use RFC 8628's token-endpoint wire. It maps the RFC's codes to statuses:
`pending` stands for `authorization_pending`, `timeout` for `expired_token`, and `slow_down` keeps
the RFC's spelling. `reason: "access_denied"` is §3.5's `access_denied`, and the token §12.4
returns on Cancel. The member is not named `error`: the flat-error parsers read that key. A build
before this subsection ignores `reason` and treats every `error` as a refusal; the Worker deploys
first and nothing else changes for it. Every SDK since its first device-code build treats a 5xx on
the poll as transient, so a build that predates rule 5 completes on the retry. The Worker deploys
first, and nothing else changes for it.

### 12.11 Platform sign-in, the link offer and nearby approval

Written by I-13.1 (`plans/CC-01-auto-sign-in.md` §2). Nothing here signs a new document: `PROTOCOL_VERSION` stays 5 and `DISCOVERY_VERSION` 2. The Worker serves the subsections in the slices named below, and discovery names an endpoint only from the release that serves it (§12.6), so an SDK uses a rung only when its endpoint is present. The types are in `@polaris-key/protocol/identity`. The platform sign-in answers only while the product's Identity service is on; with it off every route here is `404 not_found` and discovery omits the members (§12.8).

#### 12.11.1 The device proof (`pkey-proof/1`)

Every route here that binds a device takes `proof`: an Ed25519 signature (64 bytes, base64url) by the device's signing key (P-1, §15.8) over UTF-8 lines joined by `\n`, with no trailing newline:

1. `pkey-proof/1`
2. the purpose
3. the product slug
4. the `X-PKey-Device` value
5. the purpose's value
6. the base64url SHA-256 of the presented provider token, or `-` when none

A field makes the proof invalid unless it is non-empty and every byte is in 0x21..0x7e (so a newline, a space, a control byte or a non-ASCII byte fails). Purposes are `keys`, `nonce`, `exchange`, `link`, `nearby-start`, `nearby-poll`, `nearby-approve`, `vouch` and `restore`. Keys are raw 32-byte public keys in base64url. A proof is one purpose only: one signed for another purpose, product or device does not verify. Its vectors are `device-proof.json` (§15.8). A bad proof is `400 invalid_grant` on `token`; no refusal names the field that failed. A purpose outside the nine is invalid. The signature is checked strictly (§1.1): canonical base64url of 64 bytes, `S` below `L`, and the signing key and `R` neither of small order nor non-canonical. The `keys` purpose (§15.8) also needs `issuedAt` strictly newer than the last one accepted for the device.

#### 12.11.2 The nonce

`POST /<p>/identity/nonce`: JSON `{signKey, agreeKey}`, `X-PKey-Device`, `no-store`. The answer is `200 {"nonce": "…", "expiresIn": 300}`. `nonce` is 32 random bytes in base64url (43 characters), held once under a peppered hash with the product, the device and the signing key's thumbprint. The exchange (§12.11.3) registers both keys through Core's device-key operation (§15.8) in its own press. A device row that already has a registered signing key must present that key here; any other key is refused. The route is limited to 30 a minute per client network and 10 a minute per device, failing closed (`429 rate_limited`).

The nonce is what the provider signs into its ID token. Both providers receive it as it is, with no hashing (Apple's `nonce` and Google's `nonce` request field alike). It cannot be replayed to another device, product or key, because the proof of §12.11.3 binds all three.

#### 12.11.3 The grant

`POST /<p>/identity/token`, form-encoded, as §12.5, with the RFC 8693 grant:

| Parameter             | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `grant_type`          | `urn:ietf:params:oauth:grant-type:token-exchange`                    |
| `client_id`           | the product slug                                                     |
| `subject_token`       | the provider's ID token                                              |
| `subject_token_type`  | `urn:ietf:params:oauth:token-type:id_token`                          |
| `nonce`               | the nonce of §12.11.2                                                |
| `device_key`, `proof` | the signing key and the `exchange` proof (§12.11.1); `X-PKey-Device` |
| `license_choice`      | `app` (default) or `card`, as §12.5.1                                |
| `device_name`         | as §12.7.1                                                           |

The value of an `exchange` proof is `<nonce>.<device_key>`, and its sixth line is the SHA-256 of `subject_token`. The provider is picked from the token's unverified `iss` and then verified strictly. Every one of these checks refuses with the same `400 invalid_grant`, so a caller learns nothing about which failed: the signature (against the provider's keys), `iss`, `aud` among the product's audiences, `azp` among the product's client ids when the token carries one, `exp`, `iat` no more than 5 minutes old, `nonce` equal to the one presented, the nonce record unspent and bound to this product, device and key, and the proof. A nonce is spent by the first attempt that reaches it, whether or not the rest passes. An audience that equals a platform built-in client (the card's Google client, the Polaris Services ID) is never a product audience.

| Provider | `aud`                                                                           | `azp`                               | Link key (issuer, tenant scope, subject)                                                                              |
| -------- | ------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Google   | the product's Google server client id                                           | its Google client ids, when present | `(https://accounts.google.com, '', sub)`, then `(https://accounts.google.com, 'google-client:<serverClientId>', sub)` |
| Apple    | a bundle id the product declares, or one of its App Store or TestFlight outlets | none                                | `(https://appleid.apple.com, 'apple-team:<teamId>', sub)`                                                             |

The lookup finds an existing link and never creates an account. It is never by email: an address in the token joins nothing.

**Answers.**

| HTTP | Body                                                                                                 | Meaning                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 200  | `TokenResponse` (§12.5) plus `issued_token_type: "urn:polaris-key:token-type:device"`                | The link and the person's consent for this product exist and no choice is due          |
| 200  | `{"status":"confirm","grant":"sg_…","expiresIn":300,"consent":ExchangeConsentView}`                  | The link exists, but the person has not consented to this app, or what it asks changed |
| 200  | `{"status":"choose","grant":"sg_…","expiresIn":300,"choices":LicenseChoiceView}`                     | A licence choice is due and consent stands (§12.5.1)                                   |
| 403  | `{"error":"interstitial_required","reason":"no_link","url":"…","linkHandle":"lh_…","expiresIn":600}` | No link exists for this token. Sign in the regular way, then offer the link            |
| 403  | `{"error":"interstitial_required","reason":"terms","url":"…"}`                                       | The product's terms version is unaccepted; only the card takes acceptance              |
| 403  | `not_entitled`, `device_limit`, `license_choice_required` (409), `rate_limited` (429)                | As §12.5                                                                               |

1. **`status: "confirm"`.** The `grant` is §12.5.1's pending sign-in grant, with the same bounds (bound to the product, the account, the pairwise subject and the redeeming device; 300 seconds; consumed by `complete` or `cancel`). `ExchangeConsentView` is `{client: {appName, developerName, iconUrl, nameVerified}, as: {provider, email | null}, items: ConsentItem[], scopeHash, firstTime, changed}`. `as.email` is the token's own address, so the app learns nothing it did not already hold. `scopeHash` and `ConsentItem` are §12.7.3's. `confirm` is answered when the account has no `account_product_grants` row for this product, or its `scopeHash` differs.
2. **`complete` takes consent.** `choice/complete` (§12.5.1) takes `{grant, choice, consent?: {claims}, deviceName?}`. `consent` is required on a grant that was issued with `confirm`, and its absence is `400 bad_request` with the grant left open. The consent row is written right after the device is bound (and, for `create`, the licence minted), before the token is returned. `cancel` writes nothing.
3. **`confirm` carries no licence view.** Before the person consents the app learns nothing about the account beyond what the token already showed. A client that gets `confirm` shows the consent, then sends it to `complete` alone. If a licence choice is due, `complete` refuses with `license_choice_required` and the view (§12.5.1), the grant stays open, and the client sends the choice with the consent.
4. **`interstitial_required`.** `reason` is `no_link` or `terms`; a client reads an unknown `reason` as `no_link`. `url` is the sign-in card for this product. `linkHandle` is `lh_` and 43 base64url characters, held 600 seconds, and bound to the product, the device and the key. It is used once, by the link offer (§12.11.4), so the app does not ask the provider for a second token. This answer registers no device key: a client that links by handle first registers its keys with `PUT /<p>/devices/keys` (§15.8), because the link proof is checked against the device's registered signing key.
5. **The grant is same-device.** A grant issued here follows §12.5.1 rule 5: the exchange is a same-device channel. Device code and nearby approval never issue one.
6. **Never a token in a URL**, and a `subject_token` is never logged or audited. Audit carries the provider kind and the outcome only.

#### 12.11.4 The link offer

A signed-in device offers to add a platform identity to the person's account, so the next launch signs in silently.

- **Step-up.** The offer needs a same-device sign-in at most 300 seconds old on this device. The web redirect, the loopback, scheme and claimed-HTTPS channels (I-15) and the card's `choice/complete` after one of them make one. The device code, nearby approval, restore and the exchange never do.
- `GET /<p>/identity/link` (device bearer): `{"offer":[{"kind":"google"|"apple","reach":"global"|"developer"|null}]}`. `kind` is one of the product's declared kinds with no link on the account in its scope. `reach` is what a link would cover, `null` while that is not known before a token. The list is empty without a live step-up.
- `POST /<p>/identity/link` (device bearer), JSON `{linkHandle, proof}` or `{subjectToken, nonce, signKey, agreeKey, proof}`; the proof's purpose is `link`. A link by handle needs the device's signing key to be registered already (`PUT /<p>/devices/keys`, §15.8); without one it is refused. It consumes the step-up, then links. Answers: `200 {"linked":{"kind","reach"}}`; `401 step_up_required`; `409 link_conflict`; `400 invalid_grant` (nested); `404 not_found` (an unknown or spent handle).
- **Scope of an app-made link.** The link is global (tenant scope `''`) only when the provider vouches for the token's email and that address is already verified on this account. Otherwise it is scoped to the developer: `google-client:<serverClientId>`. An Apple link is always `apple-team:<teamId>`. An app that supplies a token of its own therefore cannot link an identity the person did not prove they own to the account everywhere: a token for someone else's Google account lands in the developer's scope, where it recognises that person only inside this developer's products, and can never sign in to the card or another developer's app. That holds because a scope belongs to one product: a Google web client id or an Apple team id that one product declares is refused (at the settings write, at manifest ingest and at resync) for every other live product. Sharing one id across a developer's own products needs a verified-ownership model first.
- **Game links.** `kind` may also be `gamecenter` or `pgs` (§12.11.7). Their `reach` is always `developer`, known before any token, and the token branch of `POST link` takes an optional `subjectTokenType` that defaults to the `id_token` type.
- The link adds an audit row `identity.link.added` with `via: app`. The "sign-in method added" email goes to the account's primary address and to the linked identity's verified address, and names the app.

#### 12.11.5 Nearby approval

A device with no way to sign in (D) is approved by a signed-in device nearby (M). It is the server half of the mode `v` handshake (§15.5, §15.6), and it replaces the device code for this case because a code a person can type is the proof a victim can be talked into reading out.

| Route                   | Caller            | Body                                                                       | Answer                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST …/nearby/start`   | D                 | `{signKey, agreeKey, deviceName?, proof}` (purpose `nearby-start`)         | `201 {"request":"nr_…","expiresIn":300,"interval":3}`; `400 invalid_grant`; `400 device_keys_invalid`; `404 not_found` (off); `429 rate_limited`                                                                                                                                                                    |
| `POST …/nearby/approve` | M (device bearer) | `{request, signKey, agreeKey, decision:"approve"\|"deny", choice?, proof}` | `200 {"status":"approved","deviceLabel"}`; `200 {"status":"choose","choices"}` (nothing written); `204` (deny); `400 invalid_grant`; `400 bad_request`; `403 not_nearby`; `403 device_limit`; `403 account_required`; `404 not_found`; `409 device_keys_required`; `409` (a lost mint, §12.4.1); `429 rate_limited` |
| `POST …/nearby/poll`    | D                 | `{request, proof}` (purpose `nearby-poll`)                                 | `200 {"status":"pending"}`; `429 {"status":"slow_down","interval"}`; `200 {"status":"timeout"}`; `200 {"status":"error","reason":"access_denied"}`; `200` `TokenResponse` once; `503 {"error":"unavailable"}` with `Retry-After`; `400 invalid_grant`                                                               |

All three live under `/<p>/identity`. The request handle is `nr_` and 22 base64url characters, held 300 seconds. The `poll` interval is 3 seconds.

1. **Proofs.** Each route carries a `pkey-proof/1` proof (§12.11.1) and a failed proof is `400 invalid_grant` with one body on every route, whatever the cause. The `nearby-start` value is `<signKey>.<agreeKey>` (the body's two keys), checked with the body's `signKey`. The `nearby-poll` value is `<request>`, checked with the `signKey` D sent on `start`; line 4 must be D's device id from `start`. The `nearby-approve` value is `<request>`, checked with M's registered signing key. The `approve` proof does not bind the decision, the choice or the keys: those are protected by TLS and M's bearer.
2. **Keys on `start`.** The key rules of §15.8 apply: both keys are well formed, and a device row that already has a registered signing key must present that key. An `agreeKey` held by another device of the product is refused. Each refusal is `400 device_keys_invalid`. A device id that already holds a credential must prove the device, by its own bearer or by its registered signing key; otherwise `400 device_keys_invalid`. Its credential is replaced at the poll.
3. **Keys on `approve`.** The `signKey` and `agreeKey` M sends must equal D's start keys, which M learned from D's authenticated `VOUCH_REQ` (§15.6). Keys that differ are `404 not_found`, the same answer as an unknown request; the mismatch counts against the request, and the third ends it. Approval registers D's keys through Core's device-key operation (§15.8).
4. **Proximity.** The client network of `approve` must equal that of `start` (IPv4 exact, IPv6 /64), or the answer is `403 not_nearby`. Nothing is written and the request stays open. The device code is the fallback for a person who is not nearby.
5. **Approver.** M must be signed in on the product and sign with its registered signing key (purpose `nearby-approve`). A device with no sign-in is `403 account_required`. A device with no registered signing key is `409 device_keys_required`: it registers its keys with `PUT /<p>/devices/keys` (§15.8) and retries. M cannot approve its own request.
6. **One decision.** An approval or a denial is final for its request. A request that is unknown, expired, already decided, or from another product is `404 not_found`. `choice`, when sent, is `{kind:"license", licenseId}` or `{kind:"create"}` and nothing else; any other kind or member is `400 bad_request`, and there is no Replace in this version. `create` follows §12.4.1. A full licence is `403 device_limit` on M. `choose`, `device_limit`, `license_choice_required` and `rate_limited` leave the request open.
7. **No `choice`.** When no choice is due, or exactly one candidate licence has a free seat, `approve` binds it with no further tap. Otherwise it answers `choose` and writes nothing. `create` happens only when it is sent.
8. **`deviceLabel`** is D's stored label, or `null` when D sent none.
9. **D never holds a grant** (§12.5.1 rule 5). Approval binds the seat, writes D's device row with its keys and leaves D a device that holds a credential, so M can `PUT /<p>/devices/keyring/wraps/{deviceId}` (§13.11) as soon as `approve` answers `approved`. The tap on M is D's consent: D's token carries the claims of the account's standing consent for the product, and with none it carries the scope asked, the consent row being written in the same press and audited `signin.consent.granted` with `via: nearby`. The credential minted at approval is stored as a hash only. D's first valid poll replaces it with a new one and answers that token, once. After that, or when D was removed or rebound after the approval, the poll answers `timeout`. A denial is sticky and the poll answers it as §12.10 rule 2 does.
10. **Poll.** §12.10 rules 1 to 3, 5 and 7 apply to `poll`: a poll inside the interval is `429 slow_down`, and a store failure is `503 unavailable` with `Retry-After`, which keeps the request. An unknown or expired request is `timeout`.
11. **No key material.** No nearby route takes or returns a key other than D's two public keys. The sync wrap for D travels only over §13.11.
12. **Budgets.** `nearby/start` 10 a minute per client network; `approve` 10 a minute per device and 5 an hour per subject, the latter charged on decisions only (a denial, or an attempt to bind); `poll` by its `interval`, with a coarse 60 a minute per client network. All fail closed (`429 rate_limited`).
13. **Off.** With `identity.nearby` off, or the operator gate `launch.identityNearby` off, the three routes answer `404 not_found` and discovery omits `nearby` and the three endpoints (§12.11.6).
14. Audit rows `identity.nearby.approved` and `identity.nearby.denied` carry the label only. Approval emails the account's primary address that the app signed in on a device with that label.

#### 12.11.6 Discovery and errors

- **Discovery** (identity fragment): `exchange: {"kinds":("google"|"apple")[], "google"?: {"serverClientId"}}`, present only when the product declares a kind; `nearby: true`; the endpoints `nonce`, `link`, `nearbyStart`, `nearbyApprove` and `nearbyPoll`. `nearby` and its three endpoints are present only while Identity, the product setting `identity.nearby` (on by default) and the operator gate `launch.identityNearby` (off by default) all allow it. Unsigned and additive. A client that finds none of them starts at the regular sign-in.
- **Game kinds** (§12.11.7). `exchange.kinds` may also hold `gamecenter` and `pgs`, and `exchange.pgs` is `{"serverClientId"}`. A client ignores a kind it does not know: it is never a decode failure.
- **Errors.** Two new Worker codes: `interstitial_required` (403, flat, on the exchange) and `not_nearby` (403, nested, on `nearby/approve`). One new client-only code: `platform-identity-unavailable` (no Play services, no declared kind, or the OS refused). The rest are existing codes: `invalid_grant`, `bad_request`, `device_keys_invalid`, `device_keys_required` (widened: Core, not only Cloud Connect, §12.11.5 rule 5), `step_up_required`, `link_conflict`, `device_limit`, `license_choice_required`, `account_required`, `not_found`, `rate_limited`, `cancelled` and `sign-in-denied`. The registry is `conformance/parity/errors.json`.
- **Deployed clients and workers.** The Worker deploys first. A client that predates this subsection ignores the discovery members and never sends the grant. A client of this version against an older Worker sees no `exchange` member and starts at the regular sign-in; an `unsupported_grant_type` is treated as a failed rung. Pending nonces, handles and requests expire within 600 seconds.

#### 12.11.7 Game Center and Play Games (I-14)

Two more platform identities use the exchange. This subsection is unsigned and additive: no signed document, proof or route changes, there is no new error code, and `PROTOCOL_VERSION` stays 5, `DISCOVERY_VERSION` 2 and `corpusVersion` 2.

**The grant.** It is §12.11.3's grant with two differences. `nonce`, `device_key` and the `exchange` proof are unchanged: the proof's value is `<nonce>.<device_key>`, and its sixth line is the SHA-256 of `subject_token`.

| Parameter            | Game Center                                         | Play Games                                                                |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `subject_token_type` | `urn:polaris-key:token-type:gamecenter-signature`   | `urn:polaris-key:token-type:pgs-server-auth-code`                         |
| `subject_token`      | the `gc1.` token                                    | the server auth code, exactly as the platform returned it                 |
| Link key             | `(gamecenter, 'apple-team:<teamId>', teamPlayerID)` | `(pgs, 'pgs-app:<applicationId>', player_id)`, then `alternate_player_id` |

**The Game Center token.** `gc1.<publicKeyURL>.<signature>.<salt>.<timestamp>.<teamPlayerID>.<bundleId>`: the prefix `gc1`, then six fields. Every field but the timestamp is base64url without padding over its bytes, with strings encoded as UTF-8. The timestamp is plain decimal. The whole token is at most 4096 characters. The client adds `teamPlayerID` and the main bundle id to what Apple's identity-verification call returns, and never presents Game Center's sign-in view at launch: a player who is not signed in fails the rung (`platform-identity-unavailable`).

**The Play Games code.** The client asks for a server-side access code for the `serverClientId` of discovery's `exchange.pgs`, with no extra scopes, and never starts Play Games' sign-in at launch.

**Checks.** The checks run where §12.11.3's run, after the nonce is spent. Every failure is the one `400 invalid_grant`, with no oracle.

- **Game Center.** The product has Game Center on, a team id, and the bundle id among its Apple bundle ids (declared and outlets). The signature's timestamp is Apple's, in milliseconds, and satisfies `now − 120 s ≤ timestamp ≤ now + 30 s`. The key URL is an `https://static.gc.apple.com/public-key/*.cer` address, fetched without redirects, and its certificate chain must reach a pinned DigiCert root through a pinned intermediate, with the leaf issued to `Apple Inc.` for code signing. The signature is RSASSA-PKCS1-v1_5 with SHA-256 over `teamPlayerID ‖ bundleId ‖ u64be(timestamp) ‖ salt`. One signature is accepted once, for 180 seconds.
- **Play Games.** The product has `playGames.applicationId` and `playGames.serverClientId` set and a server credential present. The Worker redeems the code once at Google's token endpoint with the product's client id and secret, then calls `applications.verify` for the application with the access token. Both answers must succeed. The access token is discarded, and no refresh token or ID token is kept or read.

**Subject.** Game Center's subject is `teamPlayerID`, the only player id Apple signs, and it is per team. Play Games' subject is `player_id` from `applications.verify`, per application; when no link is found and Google sent `alternate_player_id`, the lookup tries it too. Both links carry no email and `reach` `developer`.

**No nonce.** Neither platform API takes our nonce, so it cannot be signed into the token. The 120-second window and the single use of a Game Center signature, Google's single redemption of a code, `applications.verify`, and the `exchange` proof (which binds SHA-256 of `subject_token` to our single-use nonce and the device key) bind the token instead.

**Answers.** The same as §12.11.3: a token, `confirm`, `choose`, or `interstitial_required` with `no_link` or `terms`. `ExchangeConsentView.as` is `{provider: "gamecenter" | "pgs", email: null}`. Apple's key host unreachable, or Google unreachable, is `503 unavailable`.

**Discovery.** `exchange.kinds` gains `gamecenter` when the product has Game Center on, a team and at least one Apple bundle id, and `pgs` when Play Games is set and its credential is present. `exchange.pgs` is `{serverClientId}`.

**Gate.** The platform launch gate `launch.gameSignIn` is off by default. While it is off, the two token types answer `400 invalid_request` as an unknown type does, and discovery omits both kinds.

**Errors.** No new code. `invalid_grant` covers a refused signature or code, `invalid_request` an unknown token type or the gate being off, `unavailable` an unreachable Apple or Google host, and the client-only `platform-identity-unavailable` a player who is not signed in to Game Center or Play Games.

**Deployed clients and workers.** The Worker deploys first with the gate off. A client of this version against an older Worker, or with the gate off, sees no game kind in discovery and skips the rung; a game token sent anyway is `400 invalid_request`, a failed rung. Links with issuer `gamecenter` or `pgs` stay inert after a rollback, and single-use records expire within 600 seconds.

## 13. Cloud Sync (HTTP, additive)

Cloud Sync stores a signed-in person's synced settings and records, any of which may carry one file, for one product. Nothing in this section is signed: there is no new `typ`, claim, header or signed shape, `PROTOCOL_VERSION` stays 5 and `DISCOVERY_VERSION` 2 (§9). Every route is unsigned, lives under `/<p>/sync`, and is detected from `services.sync` (§13.5). Each subsection names the package that serves it. A subsection is normative from the release that serves it, and discovery names an endpoint only from then, so no SDK calls one earlier. The long form is `plans/U-01.md` as amended by `plans/U-01b.md`; §11.5 is the client state machine.

### 13.1 Principal, gating and quota (U-05)

- **Principal.** Every route takes `Authorization: Bearer pkeyt_…` and `X-PKey-Device`, resolved by `validateDeviceToken`. The principal is the device's `subject`: the product's pairwise subject of the account signed in on the device (`resolveSyncPrincipal`), with no owner line. No route accepts a subject or an account id. Each (product, subject) has one store.
- **No principal.** `403` with `{"error":{"code":"account_required","message":"Sign in to use Cloud Sync.","signInUrl":"<origin>/signin?product=<slug>"}}`. There is no Cloud Sync without sign-in.
- **Licence state.** A Cloud Sync response never changes licence state, cached documents or `lastSyncUnauthorized`. A `401` on `/sync*` pauses Cloud Sync until the next licence or config document fetch (§11.5).
- **Browsers.** A browser device sends the bearer token, from an origin in `core.web.origins`. `Access-Control-Allow-Credentials` is never sent and the session cookie is not accepted.
- **Gating.** Cloud Sync off, or Config or Identity off, answers `404 not_found`. Cloud Sync can be turned on only while Config and Identity are on; turning either off turns Cloud Sync off in the same audited write, and turning it back on does not turn Cloud Sync back on. Reads of one's own data are always allowed.
- **Device trust.** Writes are the trust-policy operation `cloudSyncWrite` (Core's trust policy; default `basic`, log-only until `enforce`). An enforced refusal is `403 attestation_required` for the whole request, so the client keeps its journal.
- **Operator controls.** The platform setting `cloudSync.writesPaused` pauses every write on the deployment: a push answers `503 writes_paused` with `Retry-After`, and pulls are still served. The product setting `cloudSync.ceiling.bytes` (default 50 GiB) bounds the product's total; past it a write that grows usage is `quota_exceeded` with `scope: "product"`.
- **Quota.** A person's quota is the entitlement `pkey.cloudSync.bytes`, resolved per request from the **requesting device's** anchor licence:
  - with License off: the platform default, `cloudSync.quota.defaultBytes` (256 MiB unless an operator changed it), files allowed;
  - with a usable anchor licence: that licence's resolved `pkey.cloudSync.bytes`, else the platform default, files allowed;
  - with no usable licence: the product's Anonymous devices tier, read the same way, when the product has one; otherwise 1 MiB, and files are refused.

  The result is clamped to the per-person ceiling (`CLOUD_SYNC_CEILINGS.perPerson.bytes`, about 1.06 GiB). Entitlements come from the anchor licence only. `0` means reads only.

- **Usage is per person; the quota is per device.** Two devices of one person can therefore get different quotas. A device whose quota is below the person's usage gets `quota_exceeded` on every write that grows usage (a clear or a delete always passes), and a file refusal when its quota has `files: false`. In effect, an unlicensed device is read-only against data a licensed device wrote.
- **Quota never deletes.** Lowering a tier's value, a licence's value, the platform default or the product ceiling removes nothing.
- **Budgets** (platform constants, `CLOUD_SYNC_DEFAULTS`). Declared and open settings share one budget of 256 keys and 64 KiB per person, inside the quota; an open setting's value is at most 8 KiB of canonical JSON. A record is at most 64 KiB, a collection holds at most 10,000 records, a catalog declares at most 32 collections, and `saves` has 16 slots. A file is at most 32 MiB unless its collection says otherwise (at most 1 GiB), with 5 older versions kept. A push carries at most 100 mutations and 256 KiB; a device makes at most 60 pushes a minute and 30 file transfers an hour. A product has at most 100,000 people with Cloud Sync data and 2,000 pushes a second.

### 13.2 Routes

All routes live under `/<p>/sync` and take the device bearer (§13.1). `{collection}` is a declared collection name, and `{id}` is a record id (the blinded id in E2E mode, §13.10.3). Every file body is the bytes as stored: ciphertext in E2E mode.

| Route                                                     | Package | Body → answer                                                                                                                                                                                          |
| --------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /<p>/sync?cursor=&clientId=`                         | U-05    | Pull since `cursor` (absent or `0`: a snapshot); strong ETag `"<seq>.<lastMutationId>"`, `304`                                                                                                         |
| `POST /<p>/sync/ops`                                      | U-05    | Push a batch; the `200` body also carries a pull since the request's `cursor`                                                                                                                          |
| `POST /<p>/sync/files/{collection}/{id}/begin`            | U-10    | `{size, sha256, format: "whole"\|"chunks", enc: "e2e"\|"none", baseVersion}` → `200 {uploadId, mode: "single"\|"multipart"\|"chunks", partBytes?, expiresAt}`; checks the quota and reserves the bytes |
| `PUT /<p>/sync/files/{collection}/{id}/upload/{uploadId}` | U-10    | Mode `single`: the bytes, with `Content-Length` and `Content-Digest: sha-256=:…:` → `204`                                                                                                              |
| `PUT …/{id}/upload/{uploadId}/parts/{n}`                  | U-10    | Mode `multipart`: part `n` (from 1), exactly `partBytes` except the last, with `Content-Digest` → `204`. Resending a part replaces it                                                                  |
| `GET …/{id}/upload/{uploadId}`                            | U-10    | → `{mode, size, partBytes?, received: [n…]?, missing: [chunkId…]?, expiresAt}`                                                                                                                         |
| `DELETE …/{id}/upload/{uploadId}`                         | U-10    | → `204`: aborts the upload and releases its reservation                                                                                                                                                |
| `POST …/{id}/upload/{uploadId}/chunks`                    | U-37    | Mode `chunks`: `{chunks: [[chunkId, storedBytes]…]}`, at most 1,024 a call, accumulated → `{missing: [chunkId…], present: [[chunkId, storedBytes]…]}`; reserves the missing bytes                      |
| `PUT …/{id}/upload/{uploadId}/chunks/{chunkId}`           | U-37    | One chunk object with `Content-Digest`, create-only → `204`                                                                                                                                            |
| `POST /<p>/sync/files/{collection}/{id}/finalize`         | U-10    | `{uploadId}` → `200 {version, size, sha256, format}`; idempotent per `uploadId`                                                                                                                        |
| `GET /<p>/sync/files/{collection}/{id}[?version=]`        | U-10    | The stored file (the whole ciphertext, or the manifest in `chunks` format): `application/octet-stream`, `Content-Disposition: attachment`, `Range`/`206`, `ETag "<sha256>"`, `Repr-Digest`             |
| `GET /<p>/sync/files/{collection}/{id}/revisions`         | U-10    | → `{revisions: [{version, size, sha256, format, createdAt}]}`: the kept versions                                                                                                                       |
| `GET /<p>/sync/files/{collection}/chunks/{chunkId}`       | U-37    | One chunk object, only when the person's store lists it for that collection                                                                                                                            |

Every answer is `no-store` except the pull's ETag revalidation. Deleting a file is its record's `delete` operation. There is no slot-list route: a pull of `saves` lists the slots. `/<p>/sync/live` is not reserved. Collection names and record ids use the key charset (§8). A browser device may `PUT`: the CORS allow-list carries `PUT` and `Content-Digest`, and exposes `Repr-Digest`, `Content-Range` and `Retry-After`.

**Key ring routes.** The key ring (§13.11) is served by Core under `/<p>/devices/keyring`, not under `/<p>/sync`. It answers `404` unless Cloud Sync is on and in E2E mode (or another service that needs a ring says so).

**Discovery.** `services.sync` gains `encryption: "e2e" | "server"` and `endpoints.keyring` (`<base>/devices/keyring`, E2E mode only). The member is absent on a Worker that cannot take `ct`; an SDK that requires E2E then stays local with status `unsupported` (§11.5).

### 13.3 Push (U-05, U-09)

Body: `{"clientId":"c_…","cursor":N,"atomic":false,"mutations":[{"mutationId":41,"target":{"setting":"audio.music.volume","scope":"user"},"op":"set","value":0.6,"editedHlc":"0190f3a2c1b4:0003"}]}`. More than 100 mutations is `400 bad_request`; more than 256 KiB is `413 body_too_large`.

- **Setting targets** are `{setting, scope}`, `scope` `user` or `platform` (the server derives the platform family from the device row). The server classifies the key against the active catalog with `syncedSettings`. A declared key that is not a `config` key, or a `local` key, is `rejected` with `setting_not_synced`; this is a backstop, because the client never sends one. A synced key pushed with another scope than its route's is refused the same way, and so is an open setting pushed with `platform`. A declared key is validated against its entry (`value_invalid`). An undeclared key is an open setting: `lastWrite`, schema-less, at most 8 KiB (`value_invalid` beyond). The server never refuses a key for a lock, because locks differ per device.
- **Record targets** are `{record: [collection, id]}`. An undeclared collection is `collection_unknown`; a collection whose `requires` the anchor licence does not grant is `entitlement_required`.

| Target policy                  | Operations (any other is `rejected` with `op_invalid_for_policy`)                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Setting `lastWrite`            | `set`, `clear`, each with `editedHlc`                                                                                     |
| Setting `max`, `min`           | `set` (the server keeps the larger or smaller), `clear` (a reset at its clock; older `set`s are ignored)                  |
| Setting `merge`                | `setMember {member, value}`, `removeMember {member}`, `clear`, each with `editedHlc`                                      |
| Record `revision`, `lastWrite` | `set`, `delete` with `baseVersion` (a number is compare-and-swap, `"*"` create-only, absent unconditional) or `editedHlc` |
| Record `max`, `min`            | `set`, `delete`, each with `editedHlc`; the server compares the record's `conflictField`                                  |
| Record `merge`                 | `setField`, `removeField`, `delete`, each with `editedHlc`                                                                |
| Record `union`                 | `add {element}`, `remove {element, observedSeq}`, `delete`                                                                |

A `setMember` or `removeMember` whose `member` is longer than 1 KiB of UTF-8 (`SYNC_MAX_UNION_ELEMENT_BYTES`) is `rejected` with `value_invalid`, whatever the quota: a removal is never refused for quota, so the name is what bounds it.

The `200` body is `{subject, serverNow, results, lastMutationId, …the pull members of §13.4}`. Each result is `{mutationId, status}`:

- `ok` with `version` (and `renamedTo`, or `dropped: true`, when a catalog migration applied);
- `conflict` with `server {value, version, editedHlc, members?}`: a compare-and-swap mismatch, a `lastWrite` write older than the stored clock, or a `max`/`min` write the stored value beats. The client takes the server copy (§11.5);
- `rejected` with `code`: `value_invalid`, `setting_not_synced`, `op_invalid_for_policy`, `collection_unknown`, `entitlement_required`, or `quota_exceeded` with `scope` (`user`, `collection` or `product`);
- `duplicate` (at or below the client's last processed `mutationId`), or `aborted` (the rest of a failed atomic batch).

**End-to-end mode (§13.10).** In E2E mode `ct` replaces `value`, and every person-chosen name is blinded:

```json
{"mutationId":42,"target":{"setting":"x:3q2…","scope":"user"},"op":"set","ct":"AQ…","editedHlc":"0190f3a2c1b4:0003"}
{"mutationId":43,"target":{"setting":"game.bestLap","scope":"user"},"op":"set","ct":"AQ…","baseVersion":7,"editedHlc":"…"}
{"mutationId":44,"target":{"record":["saves","x:Zk…"]},"op":"set","ct":"AQ…","baseVersion":3}
```

- `ct` is a `pkey-sync-value/1` envelope in canonical base64url (§13.10.4). A `value` on an E2E product, or a `ct` on a server-mode product, is `rejected` with `encryption_mismatch`. So is an undeclared setting key that is not blinded, and a record id, member, field or element that is not blinded, because it would leak a name.
- The server checks only the envelope's shape: canonical base64url, byte 0 equal to 1, and `(length − 49) mod 64 = 0`, under the caps. It stores the `kid`. A malformed envelope is `value_invalid`.
- Member, field and element operations carry blinded names: `setMember {member: "x:…", ct}`, `setField {field: "x:…", ct}` and `add {element: "x:…", ct}`. `removeMember`, `removeField` and `remove` take the blinded name alone.
- `max` and `min` settings are a compare-and-swap register in E2E mode: `set` carries `baseVersion`, and the client decides the better value (§11.5, §13.10.5).
- **The register (U-09.1).** A `max` or `min` `set` in E2E mode is decided by `baseVersion` alone, never by value. A number must equal the row's current `version` (a missing row, or any other version, is a `conflict`); `"*"` is create-only (a `conflict` while the key is live); absent falls back to the `editedHlc` order of `lastWrite`. A cleared key keeps its `version`, so a client re-pushes on the `version` a `conflict` carries. A `baseVersion` that is neither `"*"` nor a non-negative integer is `value_invalid`. `clear` is unchanged.
- **Conflict copy.** A `conflict` on a sealed row carries `server {ct, version, editedHlc}` in place of `value`; a sealed `merge` row carries `server {members: [{member, ct, editedHlc}], version, editedHlc}`. A row below `encryptionSince` (legacy plaintext) still carries `value`.
- **Charges.** The quota charges the stored bytes (the `ct` string, quoted, plus the key); the budgets (256 keys, 64 KiB) charge `envelopeBytes − 113` per value. An open setting is at most 8 KiB on that count (`value_invalid` beyond); a blinded name is a fixed 45 characters.

Push and journal rules 1–8 are normative as S-17 §5.4 states them. Rule 1: the last processed `mutationId` advances past every processed mutation, and only a request-level failure leaves it (transport error, `5xx`, `400`, `401`, `403`, `409 client_mismatch`, `413`, `429`, `503 writes_paused`). Rule 4: `clientId` matches §8's pattern, one per (install, partition), stored with the next `mutationId` (an integer from 1 to 2^53−1, strictly increasing) in one atomic journal write. The HLC orders writes, with `clientId` as the final tie-break. The server clamps an `editedHlc` later than `serverNow + 300 000 ms` to `serverNow` and accepts every earlier stamp, the import floor `000000000000:0000` included.

### 13.4 Pull (U-05)

`{"subject","serverNow","cursor","more","lastMutationId","catalogVersion","aliases":{…},"quota":{"bytes":268435456,"files":true},"usage":{"bytes":0,"settings":0,"records":0,"files":0},"changes":[…],"tombstones":[…]}`.

- `quota` is the requesting device's resolved quota (§13.1). `usage` is the person's totals across their devices: bytes, settings, records and files.
- `empty: true` appears only on a cursor-0 answer for a principal with no settings, records, files or tombstones; otherwise the member is absent. With it, a client uploads its first-sign-in data without asking.
- A change is `{setting, scope, value, version, editedHlc, updatedBy, members?}` or `{record: [collection, id], value, version, editedHlc?}`; a tombstone is `{setting}` or `{record: [collection, id]}` with its `editedHlc`. Pages hold at most 500 changes, with `more: true` while more remain.
- A cursor older than the 90-day tombstone horizon is `410 cursor_expired`.
- A `subject` other than the client's partition key, like `403 account_required`, is a principal change, handled exactly like sign-out (§11.5).
- **End-to-end pull.** A change carries `ct` in place of `value`, and a merge setting's members are `[{member, ct, editedHlc}]` with blinded `member`. The pull gains `encryption` (`"e2e"` or `"server"`) and `encryptionSince`, the store sequence from which every row is sealed (§11.5, §13.10.7). The server never decodes a `ct`.
  - **No separate `seq`.** A change's `version` is its row's store sequence, so an E2E client reads legacy data as `version < encryptionSince`. `SyncChange` carries no other sequence member, and a client host derives the `seq` it reports to its machine (§11.5) from `version`, in its own open result; a host that reports none reads every plaintext row as `invalid`.
  - **Merge settings.** A sealed `merge` change carries `members` and no `ct`; its `value` is absent.
  - **`encryption`** is present only while the operator's launch gate `launch.syncE2e` is on, and `encryptionSince` only in `e2e` mode. With the gate off the Worker serves server mode and says nothing of E2E (§13.5).

### 13.5 Discovery (U-05)

`services.sync` is `{"enabled":false}` when Cloud Sync is off, and otherwise `{"enabled":true,"settings":…,"collections":…,"saves":…,"endpoints":{"pull":…,"push":…,"files":…}}`. Each capability turns true, and its endpoint stops being `null`, only from the release that serves it: `settings`, `pull` and `push` with U-05, `collections` with U-09, `saves` and `files` with U-10. There is no `limits` member: the quota depends on the requesting device's licence, so the pull carries it, and the platform numbers are generated constants. Collection labels are not in discovery. An SDK uses an endpoint only when discovery names it.

**Encryption (U-09.1).** `services.sync.encryption` is `"e2e"` or `"server"`, the product's mode from its catalog (`cloudSync.encryption`, `"e2e"` when absent), and `endpoints.keyring` is `<base>/devices/keyring` for an `e2e` product. Both appear only while the operator's launch gate `launch.syncE2e` is on. With the gate off the members are absent, `ct` is `encryption_mismatch`, and an app that requires E2E stays local with `unsupported` (§11.5).

### 13.6 The stores and the conflict vocabulary

Two stores share one principal.

- **Synced settings** ride the shipped `config.*` API. Every Editable catalog `config` key (no `managementDefault` of `enforced` or `hidden`) is a synced setting, with an optional `user` block for tuning; an undeclared key is an open setting. A synced value fills §2.2.1's `local` slot: it beats every unlocked server value and loses to any lock. It never enters the server merge, no server path reads it, and Cloud Sync writes no server layer.
- **Records** live in collections the catalog declares, with `owner` access only. Any record may carry one file (§13.8). `saves` and `session` are record templates (§13.7).

One conflict vocabulary serves both stores, and the server applies it:

| Policy       | Settings                            | Records                                       | The server keeps                                                                     | The client on `conflict`                      |
| ------------ | ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `lastWrite`  | yes (default; open settings always) | yes                                           | the higher `editedHlc`, with `clientId` breaking ties                                | takes the server copy and enqueues nothing    |
| `max`, `min` | a number schema                     | with `conflictField` naming a number property | the larger or smaller value (a record by its field); a tie falls back to `lastWrite` | takes the server copy                         |
| `merge`      | an object schema, member ops        | per-field ops                                 | each member by `lastWrite`                                                           | takes the server copy                         |
| `union`      | refused                             | an array with `uniqueItems` (an OR-set)       | the observed-remove set                                                              | none (no conflicts)                           |
| `revision`   | refused                             | yes (default for records and `saves`)         | compare-and-swap on `baseVersion`                                                    | `cloudSync.onConflict`; otherwise push rule 2 |

A set held in a setting is an object of booleans with `merge`; a list setting gets `lastWrite` only.

- **The server decides; the client never merges.** A `lastWrite` loser takes the server copy. A losing plain value is not kept, because `lastWrite` means the last write wins; data that must not be lost uses `revision`. A record's losing file stays as a revision for `keepRevisions`.
- `max` and `min` need a numeric `conflictField`; a missing or non-numeric field is `op_invalid_for_policy`. A device can claim a larger value, so a field policy is not anti-cheat.
- `revision` never resolves itself; it is the only case an app is asked about.
- **No write is lost without a trace.** `403`, `5xx`, `429`, `503 writes_paused` and `410` keep the journal, and a `quota_exceeded` or `entitlement_required` setting is parked on the device and retried (§11.5).
- **A policy or scope change on live data rewrites nothing.** The server reads the policy at push time; values stored under another scope stay dormant until the person clears them or deletes their Cloud Sync data.
- A delete is a tombstone with `editedHlc`, and a later edit wins over it. Tombstones last 90 days.

### 13.7 Records and templates (U-09)

A catalog declares collections in `cloudSync.collections`: `name` (the key charset, or a `prefix.*` pattern), `label`, `template`, `access` (`owner`, the only value), `conflict` (default `revision`, or the template's), `conflictField` (with `max` and `min` only), `schema`, `maxRecords` (at most 10,000), `files {maxBytes, keepRevisions}` (`maxBytes` at most 1 GiB) and `requires` (an entitlement the anchor licence must grant, else `entitlement_required`). A declaration's own members override its template's, except a `saves` collection's `maxRecords`, which is pinned at 16 slots: no declaration or entitlement raises it.

| Template  | Label     | Conflict    | Records | File                     | Schema                                                                                                                                        |
| --------- | --------- | ----------- | ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `saves`   | "Saves"   | `revision`  | 16      | 32 MiB, 5 older versions | `playtime` (a number ≥ 0), `progress` (0–1), `chapter` (text, ≤ 128), `formatVersion` (an integer), `thumbnail` (base64, ≤ 43,692 characters) |
| `session` | "Session" | `lastWrite` | 16      | 8 MiB, 1 older version   | none                                                                                                                                          |

A record, its metadata included, is at most 64 KiB; a thumbnail (about 32 KiB decoded) is a field, not a second file, so a pull of 16 slots is at most about 1 MiB. At the first sign-in a client pushes its local records as ordinary create-only mutations (`baseVersion: "*"`); there is no attach prompt.

### 13.8 Files on records (U-10, U-37)

Any record may carry one file. A file travels in one of three modes, chosen by the server at `begin` from the size and the collection, and every mode ends in the same idempotent `finalize`.

#### 13.8.1 Begin, upload, finalize

`begin` takes `{size, sha256, format, enc, baseVersion}`. `format` is `whole` (the file is one stream) or `chunks` (the file is a manifest over chunks, §13.8.3). `enc` is `e2e` or `none` and must match the product's mode (§13.10.1): otherwise `400 encryption_mismatch`. `sha256` is the hash of what is stored, which in E2E mode is the ciphertext: the server never sees a plaintext hash. `baseVersion` is a number (compare-and-swap), `"*"` (create-only) or absent. `begin` answers `{uploadId, mode, partBytes?, expiresAt}`, checks the quota and the collection's `files.maxBytes`, and reserves the bytes. `finalize` charges what was stored, points the record at the new file and returns `{version, size, sha256, format}`. It is idempotent per `uploadId`. The previous file stays as a revision for the collection's `keepRevisions`, and a file is collected once nothing points at it. Downloads go through the Worker, never a public or presigned URL.

| Mode        | When                                                                  | Bytes                                                                                                                                                   | Verified                                                                                              |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `single`    | the whole file is at most `SYNC_SINGLE_PUT_MAX_BYTES` (16 MiB)        | one `PUT`                                                                                                                                               | at the `PUT`: a size or digest mismatch is `400 upload_mismatch` and nothing is stored                |
| `multipart` | the whole file is over 16 MiB (at most 1 GiB)                         | parts of `partBytes` = `max(8 MiB, ⌈size / 9,999⌉ rounded up to 1 MiB)`, at most 64 MiB, the last shorter. Parts go in any order, at most 4 in parallel | each part by its `Content-Digest`; at `finalize` the server streams the whole object against `sha256` |
| `chunks`    | the collection has `files.delta: true` and the file is at least 1 MiB | content-defined chunks (§13.8.3); only the chunks the person lacks are uploaded                                                                         | each chunk by its `Content-Digest`; `finalize` checks that every declared chunk exists with its size  |

#### 13.8.2 Resume, expiry and limits

- **Resume.** `GET …/upload/{uploadId}` answers the parts received (`multipart`) or the chunk ids still missing (`chunks`). A client resends only those.
- **Expiry.** An upload lives `SYNC_UPLOAD_TTL_SECONDS` (86,400 s), and its quota reservation with it. An expired upload answers `410 upload_expired`; the server aborts it and deletes what it stored.
- **Limits.** At most 4 open uploads per person (`SYNC_MAX_OPEN_UPLOADS`; the next `begin` is `429 rate_limited`), 30 file transfers per device an hour (`begin` and whole-file `GET`), 600 part and chunk requests per device a minute (`SYNC_CHUNK_REQUESTS_PER_MINUTE`), at most 16,384 chunks per file (`SYNC_MAX_CHUNKS_PER_FILE`), and 1,024 chunk ids per plan call.
- **Quota.** `begin` reserves, `finalize` charges what was stored, and expiry or `DELETE` releases the reservation. Kept revisions count against the person's usage.

#### 13.8.3 Patched (delta) files: `pkey-sync-cdc/1`

- **Chunker.** Cut points follow `fastcdc-2016-nc1` over the whole plaintext, with the gear table of the pack chunker (seeded `0x9e3779b9`), average 256 KiB, minimum 64 KiB and maximum 1 MiB. Every implementation cuts at the same offsets (`cdcCases`, §13.10.8). The byte-level choices are pinned: the gear table is 256 steps of xorshift32 from the seed (`x ^= x << 13; x ^= x >> 17; x ^= x << 5`, all 32-bit), minimum and maximum are `avg / 4` and `avg * 4`, and `bits = round(log2(avg))` gives a strict mask of the top `bits + 1` bits and a loose mask of the top `bits - 1`. For each chunk the hash starts at 0 at offset `min` and is `h = (h << 1) + gear[byte]` (32-bit); up to offset `avg` a cut falls after the first byte where `h & strict = 0`, after it where `h & loose = 0`, and else at `max` or at the end of the input. A remainder of at most `min` bytes is one chunk. The scan of a chunk never reads past `max` bytes, so an implementation streams and holds at most `max` bytes of the file.
- **Chunk id.** In E2E mode `hex(HMAC-SHA256(K_cid(c), plainChunk))`; in server mode the plain SHA-256. Chunks are deduplicated per person and per collection, never across people, so the server learns only which chunks repeat inside one person's collection.
- **Chunk object** (`pkey-sync-chunk/1`, E2E mode): `0x01 ‖ codec ‖ nonce(12) ‖ AES-256-GCM(K_chunk, nonce, aad = 0x01 ‖ codec ‖ id, body)`. `K_chunk` is derived per chunk id (§13.10.2), but one id can be sealed with different bodies (raw or zstd, or two zstd encoders), so the key does not seal one plaintext and a constant nonce would reuse a key and nonce. The nonce is therefore synthetic: `nonce = HMAC-SHA256(K_chunk, 0x01 ‖ codec ‖ body)[0:12]`. The same key and nonce then imply the same `codec` and `body`, and sealing the same body twice gives the same object. The nonce is stored in the object so a reader has it before decrypting. The object is `2 + 12 + len(body) + 16` bytes, at least 30. `id` in the aad and as the `K_chunk` salt is the 32 raw bytes of the chunk id. `codec` 0 is raw and 1 is one zstd frame that declares its content size, at most 1 MiB. A reader checks, in order: length (at least 30 bytes), version, codec, the tag (`auth`; the nonce is read from bytes 2 to 13), that the nonce equals `HMAC-SHA256(K_chunk, 0x01 ‖ codec ‖ body)[0:12]` of the opened body (`nonce`), the frame (`decode`; a declared size over 1 MiB is `size`), and last that the chunk id of the plaintext equals `id` (`chunkCases`). A writer may compress; a reader must decode both. Chunk objects are create-only and self-describing. The format is not yet released: the object carries version `0x01` with this layout and no object of an earlier layout exists.
- **The manifest is the file.** In `chunks` format the stored file is a `pkey-sync-chunks/1` manifest, sealed as a `pkey-sync-file/1` stream (§13.10.4): a 64-byte little-endian header (`PKSYNCCH`, `version` u16 1, `recordSize` u16 48, `flags` u32 0, `chunkCount` u32, reserved u32, `plainSize` u64, `plainSha256` 32 bytes), then `chunkCount` records of `id[32] ‖ plainLen u32 ‖ flags u32 ‖ reserved u64` in file order. A reader refuses the first violation, in this order (`manifestCases`): length under 64, magic, `version`, `recordSize`, header `flags`, header `reserved`, `chunkCount` over 16,384, the byte length (64 + 48 × `chunkCount`), `plainSize` over 1 GiB, then each record in file order (non-zero `flags` or `reserved`, then a `plainLen` of 0 or over 1 MiB), and last that the `plainLen` values add up to `plainSize`. `plainSha256` binds the reassembled file and is checked by whoever reassembles it.
- **A new version costs only what changed.** An upload carries the changed chunks and the manifest; a download fetches only the chunks missing from the device's cache.

#### 13.8.4 Errors

`409 revision_conflict` on a stale `baseVersion` (with the server's `version`), at `begin` and at `finalize`. `400 upload_mismatch` on a `sha256`, size or digest mismatch. `400 encryption_mismatch` for a wrong `enc`. `409 upload_incomplete` at `finalize` with `missing` (the parts or chunk ids). `410 upload_expired`. `413 file_too_large` over `files.maxBytes`. `403 quota_exceeded` with `scope`, and `403 entitlement_required` for a collection's `requires` or a quota with `files: false`. `400 collection_unknown`. A file route's `403` is that call's error: it never blocks the client state machine (§11.5).

### 13.9 Errors

Each code is registered in `conformance/parity/errors.json` by the package that first emits it. `upload_mismatch`, `revision_conflict`, `quota_exceeded`, `entitlement_required`, `collection_unknown`, `rate_limited`, `not_found` and `body_too_large` are reused by the file routes.

| Code                                     | Kind and HTTP                 | Package    | Note                                                                                       |
| ---------------------------------------- | ----------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `account_required`                       | wire 403                      | I-09       | no principal; `signInUrl` additive                                                         |
| `cursor_expired`                         | wire 410                      | U-05       | the cursor is older than the 90-day tombstone horizon                                      |
| `client_mismatch`                        | wire 409                      | U-05       | the `clientId` belongs to another device                                                   |
| `value_invalid`, `op_invalid_for_policy` | wire result                   | U-05       |                                                                                            |
| `setting_not_synced`                     | wire result                   | U-05       | a declared non-`config` or `local` key, or the wrong scope                                 |
| `quota_exceeded`                         | wire result, or 403 for files | U-05       | `scope` is `user`, `collection` or `product`                                               |
| `writes_paused`                          | wire 503                      | U-05       | `cloudSync.writesPaused` is on; `Retry-After` gives the seconds to wait (300 when absent)  |
| `attestation_required`                   | wire 403                      | U-05       | the existing Core code, now also for a Cloud Sync write                                    |
| `collection_unknown`                     | wire result                   | U-09       |                                                                                            |
| `entitlement_required`                   | wire result, or 403 for files | U-09, U-10 | a collection's `requires`, or files under a quota with `files: false`                      |
| `revision_conflict`                      | wire 409                      | U-10       |                                                                                            |
| `upload_mismatch`                        | wire 400                      | U-10       |                                                                                            |
| `encryption_mismatch`                    | wire result, or 400 on begin  | U-09, U-10 | `ct` on a server product, `value` or an unblinded name on an E2E product, or a wrong `enc` |
| `upload_expired`                         | wire 410                      | U-10       | the upload outlived `SYNC_UPLOAD_TTL_SECONDS`                                              |
| `upload_incomplete`                      | wire 409                      | U-10, U-37 | `finalize` with parts or chunks missing; `missing` lists them                              |
| `file_too_large`                         | wire 413                      | U-10       | the file is over its collection's `files.maxBytes`                                         |
| `keyring_conflict`                       | wire 409                      | U-36       | a ring or a wrap already exists (§13.11)                                                   |
| `sync-locked`                            | client                        | U-33       | the device holds no root for the current ring (§11.5)                                      |
| `recovery-code-invalid`                  | client                        | U-33       | the recovery code's checksum or its unwrap failed (§13.11.4)                               |
| `sync-encryption-pinned`                 | client                        | U-33       | the app requires E2E and the Worker offers server mode (§11.5)                             |

No longer used: `setting_unknown` (open settings have no unknown key; `setting_not_synced` replaces it), `store_requires_flag` (`entitlement_required` replaces it), `access_denied` (its three reasons are gone), and the client codes `setting-locked` and `setting-unknown` (`managed_by_admin` and `bad_request` already ship).

### 13.10 End-to-end encryption

Cloud Sync stores a person's data either as ciphertext the server cannot read (`e2e`, the default) or in the clear, validated and merged by the server (`server`). One AEAD serves every layer: **AES-256-GCM**. Nothing in this section is signed.

#### 13.10.1 Mode and what the server sees

The mode is per product, set by the catalog's `cloudSync.encryption` and advertised as `services.sync.encryption` (§13.2). In `e2e` mode the server sees:

- declared names in the clear: catalog setting keys and collection names;
- sizes, versions, HLCs, timestamps, policies, ciphertext SHA-256s, chunk counts and `kid`s;
- every person-chosen name only blinded (open-setting keys, record ids, member, field and element names);
- every value only as ciphertext.

A product's mode is changed only by publishing a catalog that says so. Neither direction rewrites stored data: a switch to `e2e` leaves legacy plaintext rows readable (§13.10.7), and a switch to `server` leaves sealed rows that no client can open without a root.

#### 13.10.2 Key hierarchy

All derivations are HKDF-SHA256 (RFC 5869). `R` is the 32-byte root of a ring (§13.11). Labels are ASCII, `‖` is concatenation, `∅` is an empty salt, and the last argument is the output length (32 unless shown).

```
kid       = HKDF(R, ∅, "pkey-sync/1 kid", 16)                    in every envelope header, in the clear
K_coll(c) = HKDF(R, ∅, "pkey-sync/1 coll\0" ‖ c)                 c = "$settings" or the concrete collection name
K_names   = HKDF(R, ∅, "pkey-sync/1 names")
K_cid(c)  = HKDF(R, ∅, "pkey-sync/1 chunk-id\0" ‖ c)
K_msg     = HKDF(K_coll(c), salt16, "pkey-sync/1 value")         one per value
K_file    = HKDF(K_coll(c), salt32, "pkey-sync/1 file")          one per file version
K_chunk   = HKDF(K_coll(c), chunkId, "pkey-sync/1 chunk")        one per chunk id
K_rec     = HKDF(code16, ringId, "pkey-sync/1 recovery")
K_adopt   = HKDF(R, ∅, "pkey-sync/1 adopt")
```

Every symmetric key seals one plaintext, so the nonce is a constant (12 zero bytes, or the segment counter in a file) and there is no nonce-reuse or message-count limit, with one exception: `K_chunk` is per chunk id, not per body, so a chunk object carries a synthetic nonce (§13.8.3). `K_msg` and `K_file` rest on a fresh random `salt` per sealed value or file stream (16 and 32 random bytes from the platform generator, never derived from the content); a writer that reuses a salt reuses the key. There is no `K_disc` derived from `R`: the server delivers the discovery key. The corpus pins every label (`hkdfCases`, §13.10.8).

#### 13.10.3 Blinded names

`blind(kind, ctx, n) = "x:" ‖ base64url(HMAC-SHA256(K_names, kind ‖ 0x00 ‖ ctx ‖ 0x00 ‖ n))`, with `kind` one of `setting`, `member`, `record`, `field` and `element`. `ctx` is the declared setting key or collection name that scopes the name, and `n` is the person-chosen name (an element is its canonical JSON). A declared key or collection name that starts with `x:` is refused at publish time (`cloud_sync_reserved_prefix`), so a blinded name never collides with a declared one. The server compares blinded names by bytes and never learns the plaintext.

**Canonical JSON** is the text of an element name (`blind("element", c, canonicalJson(e))`) and of `P` in §13.10.4, so every SDK writes it byte for byte alike (`canonicalJsonCases`, §13.10.8). Object keys are sorted by UTF-16 code unit at every level; there is no whitespace; a string is escaped as ECMAScript `JSON.stringify` does (only `"`, `\` and the C0 controls, as `\b \t \n \f \r` or lowercase `\u00xx`; `/`, DEL, U+2028 and non-ASCII text stay raw). A number is an IEEE double written as ECMAScript `Number::toString`: the shortest digits that round-trip, decimal for 1e-6 ≤ |x| < 1e21 and `e+N` / `e-N` with no padding otherwise, an integral value as an integer (`1e-5` is `0.00001`, `1e-7` is `1e-7`, 2^60 is `1152921504606847000`, `1e21` is `1e+21`) and `-0` as `0`. A writer refuses, rather than spells differently: a number that is not finite (NaN, ±Infinity), a string or key that holds a lone surrogate, and, in a language with an integer type, an integer whose magnitude is over 2^53 (no JavaScript number holds it; Python raises `ValueError`, client-core raises `RangeError` for the first two).

#### 13.10.4 Formats

**`pkey-sync-value/1`** seals one setting, record, member, field or element value:

```
0x01 ‖ kid(16) ‖ salt(16) ‖ AES-256-GCM(K_msg, nonce 0¹², aad = the first 33 bytes, P)
```

`P` is the UTF-8 canonical JSON `{"k": name, "v": value}` padded with `0x80 0x00…` to a multiple of 64 bytes. The reader checks that `k` equals the expected name or one of its `aliases` sources; otherwise the value is `invalid`. A merge member's `k` is `setting ‖ U+0000 ‖ member` (the names, not the blinded forms), so the server cannot swap members between settings that share a member name, and an open key's `k` is the key. The envelope is `33 + len(P) + 16` bytes, which is why the server's shape check is `(length − 49) mod 64 = 0`. `SYNC_E2E_OVERHEAD_BYTES` is 113 (49 of envelope and at most 64 of padding): budgets (256 keys, 64 KiB, 8 KiB, §13.1) are charged on `envelopeBytes − 113`, so they keep their meaning, while the quota charges the stored bytes.

**`pkey-sync-file/1`** seals a file as a stream of segments:

- a 64-byte little-endian header, like `pkey-sync-chunks/1`: `PKSYNCF1`, `version` u16 1, `flags` u16 0, `segmentBytes` u32 (1 MiB), `kid` 16 bytes, `salt` 32 bytes. Only the nonce counter below is big-endian;
- segment `i` is `AES-256-GCM(K_file, nonce = u8(last) ‖ 0³ ‖ u64be(i), aad = header, segment)`;
- every segment but the last holds exactly `segmentBytes` of plaintext, and the last holds 1 to `segmentBytes`. Only the empty file has an empty last segment, and it is then the only segment. A truncated stream, a reordered segment or a missing last flag is refused.

A reader refuses the first violation, in this order (`fileStreamCases`): under 64 bytes (`shape`), `magic`, `version`, a non-zero `flags`, a `segmentBytes` other than 1 MiB (`segmentSize`), and a `kid` that is not this ring's (`kid`); then the body: no segment, or a tail shorter than a tag (`shape`); an empty last segment after others (`size`); and a segment that fails its tag (`auth`, which covers truncation, reordering, a missing last flag and a tampered header).

Segments allow ranged downloads and resume. **`pkey-sync-chunk/1`** and **`pkey-sync-chunks/1`** are in §13.8.3.

#### 13.10.5 Conflict policies in E2E mode

| Policy       | Behaviour                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lastWrite`  | The server, unchanged: HLC order over ciphertext                                                                                                                                                                      |
| `merge`      | The server, per member or field, last write wins on **blinded** names, each member a sealed value. It compares HLCs, never values, so it needs no plaintext                                                           |
| `union`      | The server's observed-remove set on blinded element ids, `blind("element", c, canonicalJson(e))`                                                                                                                      |
| `revision`   | The server's compare-and-swap, unchanged; it is the case that prompts                                                                                                                                                 |
| `max`, `min` | **The client.** The server keeps a compare-and-swap register. On `conflict` the client opens the server copy, keeps the better value and re-pushes on the server's `version` with `origin: "merge"`; it never prompts |
| schema       | The client: `bad_request` on write, `invalid` on read                                                                                                                                                                 |
| `mapValues`  | Refused for an E2E catalog (`cloud_sync_e2e_map_values`): a migration cannot rewrite values the server cannot read                                                                                                    |

#### 13.10.6 Pinning and downgrade

An app requires E2E unless its catalog says `server`. It never sends plaintext to a Worker that advertises `encryption: "server"` or omits the member (§11.5, `sync-encryption-pinned`). A server-mode product is unchanged from §13.3 and §13.4.

#### 13.10.7 Legacy rows

The pull's `encryptionSince` is the store sequence from which every row is sealed. An E2E client reads a plaintext row below it as legacy data and re-seals it on its next write; a plaintext row at or above it is `invalid`. The client's boundary is the least value it has been served for the partition, held at or below the lowest version it has itself pushed sealed or opened sealed; it is stored with the partition and never raised, so a later, higher served value changes nothing. Whether a row was sealed or unopenable is the host's own open result, never a member of the body, and a host that does not derive `seq` from `version` reads every plaintext row as `invalid`. A Worker that turns E2E on for a product with existing plaintext data sets `encryptionSince` to the sequence at that moment. The object fixes it at the first sealed push, to the store sequence plus one; until then a pull answers that same number. It is set once and never moves, so a switch back to `server` leaves sealed rows that no client can open (§13.10.1), and a later switch to `e2e` does not re-sort them.

#### 13.10.8 Corpus

`sync-vectors.json` (`syncVectorsVersion` 1) is a client table written by `tools/corpus/syncVectors.ts` with an independent reference implementation, and mirrored for Godot. Its sections: `hkdfCases` (every label above), `envelopeCases` (seal, open, tamper, wrong `k`, alias, padding), `blindCases`, `wrapCases`, `recoveryCodeCases`, `adoptCases`, `cdcCases`, `chunkCases` (ids, objects and a pair of codecs sealed under one id), `fileStreamCases`, `manifestCases`, `canonicalJsonCases` and `transferPlanCases` (mode, `partBytes` and part count from size and collection). The scenario machine's fake transport speaks plaintext, so `sync-vectors.json` is the only table that pins sealing. A runner reads named sections only, so the table is inert to an SDK that has not implemented `sync.e2e`.

### 13.11 The key ring

One ring holds the root `R` of a person's E2E data for one product. The ring is Core's, not Sync's: it is served under `/<p>/devices/keyring`, and Cloud Sync is its first client. Cloud Sync's E2E mode never needs Cloud Connect, and no Sync key crosses a Cloud Connect session in mode `a`, the mode that admits a peer on a Worker-signed certificate (§15.6).

#### 13.11.1 The ring and its wraps

- **Ring.** `ringId` (§8), `epoch` (at least 1), `rootKid` (the `kid` of `R`, §13.10.2), a state, and the creation time. There is one ring per (product, subject). A device accepts a root only when `kid(R)` equals the ring's `rootKid`, and once it holds a root for (`ringId`, `epoch`) it never replaces it.
- **Wrap to a device** (`pkey-sync-wrap/1`): RFC 9180 HPKE `mode_base` with KEM 0x0020 (X25519), KDF 0x0001 (HKDF-SHA256) and AEAD 0x0002 (AES-256-GCM). `info = "pkey-sync/1 wrap\0" ‖ product ‖ 0x00 ‖ deviceId ‖ 0x00 ‖ ringId ‖ 0x00 ‖ u32be(epoch)`, `aad = kid`, and the plaintext is `R`. The wrap carries its `kem`, so a later key type changes one field. `kem` is the HPKE KEM id as a JSON integer (`32` for 0x0020; a P-256 key would be `16`), `enc` is the 32-byte encapsulated key and `ct` is `R` sealed with its 16-byte tag (48 bytes); a reader refuses any other `kem`, an `enc` that is not 32 bytes and an all-zero DH output. Sequence 0 is the only message, so the nonce is the key schedule's `base_nonce`. `product` is the product slug, `deviceId` and `ringId` are their text forms (§8) and the PSK is empty. `wrapCases` and `hpkeAnchor` (the RFC 9180 vector for this suite) pin all of it.
- **Server view.** The server stores wraps (`{epoch, kid, kem, enc, ct, by}` per device) and the sealed recovery blob. It holds no key that opens either.

#### 13.11.2 Routes

Device bearer, `no-store`, CORS enabled, and `404` unless the ring is enabled for the product (§13.2).

| Route                                          | Body → answer                                                                                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<p>/devices/keyring`                     | → `{ring: null \| {ringId, epoch, rootKid, state, createdAt, recovery: {set, createdAt}, adopted: [{ringId, epoch, kid, ct}], previous?: {ringId, kid, until}}, wrap: null \| {epoch, kid, kem, enc, ct, by}}` |
| `POST /<p>/devices/keyring`                    | create: `{ringId, rootKid, wrap: {kem, enc, ct}, recovery?: {ct}}` → `201`; `409 keyring_conflict` when a ring exists                                                                                          |
| `PUT /<p>/devices/keyring/wraps/{deviceId}`    | `{epoch, kid, kem, enc, ct}` → `204`. The target must be a live device of the same subject. Create-only: `409 keyring_conflict` if a wrap exists                                                               |
| `DELETE /<p>/devices/keyring/wraps/{deviceId}` | → `204`, for the device's own wrap only                                                                                                                                                                        |
| `PUT /<p>/devices/keyring/recovery`            | `{ct, epoch, kid}` → `204`; audited, and the account is emailed "recovery code changed"                                                                                                                        |
| `GET /<p>/devices/keyring/recovery`            | → `{ct, epoch, kid}`; at most 5 a day per device, audited, and the account is emailed "Recovery started on <device label>"                                                                                     |
| `POST /<p>/devices/keyring/adopt`              | `{fromRingId, epoch, kid, ct}` → `204`: a foreign or previous root sealed under `K_adopt`                                                                                                                      |
| `POST /<p>/devices/keyring/reset`              | `{ringId, rootKid, wrap, recovery?}` → `201`. The old ring becomes `previous` for 30 days. Audited and emailed                                                                                                 |

A removed device loses its wraps with its token. A device whose key changes loses its wrap and fetches a new one (Core subscribes to the device lifecycle). Deleting a person's Cloud Sync data, a product or an account deletes the ring rows and the recovery blob: with the ciphertext still stored, that is the last key material on the server (crypto-shredding).

#### 13.11.3 Delivery to a new device

A new device obtains `R` in exactly one of two ways. Both end in the device writing no `R` to the server.

- **Nearby approval.** A signed-in device that holds `R` wraps it to the new device's agreement key and sends it as `KEYRING_WRAP` (0x0030, §15.6) over the nearby channel, then `PUT`s the same wrap to `/devices/keyring/wraps/{deviceId}`. `KEYRING_WRAP` is legal only in mode `v`, after the code and the server's approval. The code both screens show is the commit-reveal short code of §15.6 (`SAS_COMMIT`, `SAS_NONCE`, `SAS_REVEAL`, §15.6), never a value derived from an agreement key, so a man in the middle cannot grind keys to a matching code. Mode `a` never carries a Sync key. There is no wrap path without the nearby channel, and no remote approval: a browser unlocks only with the recovery code.
- **Recovery code or platform backup** (§13.11.4, §13.11.5).

A device with no root is `locked` (§11.5). It reads the ring (`GET`) to learn `rootKid` and whether a wrap exists for it.

#### 13.11.4 The recovery code

- **Code.** 16 random bytes and a 4-byte SHA-256 checksum make 32 Crockford base32 characters, shown as 8 groups of 4. The parser ignores case, spaces and hyphens, and maps `I` and `L` to `1` and `O` to `0`. The checksum is the first 4 bytes of SHA-256 of the 16 code bytes; the 20 bytes are read as one big-endian 160-bit number, five bits per character from the most significant, over the alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. The groups are joined by hyphens and shown in upper case. A bad checksum or a failed unwrap is the client code `recovery-code-invalid`. There is one code per product.
- **Recovery blob.** `recoveryWrap = 0x01 ‖ n12 ‖ AES-256-GCM(K_rec, n, aad = "pkey-sync/1 recovery" ‖ ringId ‖ u32be(epoch) ‖ kid, R)`, stored by the server as `recovery.ct`. 128 random bits cannot be brute-forced offline, so the server learns nothing from the blob; the rate limit and the email guard against a stolen device token.
- **Reset.** `reset` makes a new ring and a new code. The old ring is kept read-only for 30 days and a device that still holds its root can `adopt` it (re-seal under the new root). After 30 days the server deletes rows whose `kid` belongs to the abandoned ring.
- **Account merge.** The absorbed subject's ring becomes an `adopted` candidate. A device that holds both roots seals the adoption under `K_adopt`. The `ct` of `POST /<p>/devices/keyring/adopt` has the recovery blob's layout: `0x01 ‖ n12 ‖ AES-256-GCM(K_adopt, n, aad = "pkey-sync/1 adopt" ‖ fromRingId ‖ u32be(epoch) ‖ kid, R_old)`, where `K_adopt` is derived from the current root, and `epoch`, `kid` and `fromRingId` name the ring and root being adopted (the request's members). The `recoveryWrap` and adopt blobs are exactly 61 bytes, and a blob of another length or version is refused. `n` is random per blob. `recoveryCodeCases` and `adoptCases` pin both.

#### 13.11.5 Platform backup

On by default, with a developer opt-out, a device keeps `R` in a synchronizable platform item so a new device of the same person restores silently.

- **Apple:** an iCloud Keychain item (`kSecAttrSynchronizable`), service `pkey-sync:<product>`, account `<subject>:<ringId>`.
- **Android:** Block Store with `setShouldBackupToCloud(true)`, only when `isEndToEndEncryptionAvailable()`.

A sign-out keeps the root backup item: deleting a synchronizable keychain item deletes it on every device of that Apple ID. Only Reset encryption, Start over or account deletion removes it. A platform without a backup API (web, Node, Python, JVM desktop) relies on the recovery code and nearby approval.

#### 13.11.6 Rotation

There is no automatic rotation. A lost device is removed (its wraps and token go), and "Reset encryption" is a manual action that makes a new epoch and a new code.

## 14. Product backends (SP-53)

An app can call its developer's own backend with the licence document it already holds, and the backend decides the request offline. The Worker plays no part in the request: it never reads the header below, and nothing in this section is a Worker route. The long form is `plans/SP-53.md`, which executes the framework drop-ins plan (`docs/research/2026-10-08-framework-drop-ins/README.md` §5, §6, §9.1). `backend-matrix.json` (`backendMatrixVersion` 1) pins §14.2, §14.3 and §14.5. Server cores replay `verdict` and `problem`; client halves replay `client`. There is no new `typ`, claim or signed shape, and every counter in §9 is unchanged.

### 14.1 Headers [C]

| Header           | Value                                                   | Rule                                                                                                              |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `X-PKey-License` | the compact `pkey-license+jws` the app holds, unchanged | Required on a gated route. At most `BACKEND_LICENSE_MAX_BYTES` = 16 384 bytes.                                    |
| `X-PKey-Device`  | the device id                                           | Optional. When sent, it must equal the document's `deviceId`. It is a consistency check, not proof of possession. |

- **A header's elements.** A backend reads every field with the header's name (names are case-insensitive), splits each value at `,`, trims spaces and tabs from each element and drops the empty ones. A JWS and a device id never hold a comma, so a proxy that joins repeated fields into one value changes nothing.
- **Never read.** `Authorization` stays the app's own: a backend reads neither it nor a cookie nor a query parameter. The app never sends its `pkeyt_` token or its config document to a backend.
- **CORS.** `POLARIS_REQUEST_HEADERS` (`X-PKey-License`, `X-PKey-Device`) is the list for the app's own allow-list. The drop-ins set no CORS header. The credential is a header, so it is not ambient, and a cross-site request cannot carry it without a preflight.
- **Constants** (`@polaris-key/protocol/core`): `HEADER_LICENSE`, `BACKEND_AUTH_SCHEME` = `PKey-License`, `BACKEND_LICENSE_MAX_BYTES`, `BACKEND_TRUST_REFRESH_SECONDS` = 900 and `POLARIS_REQUEST_HEADERS`.

### 14.2 The verdict [C]

Inputs: the request's header fields, `now` (the server's clock, epoch seconds), the backend's options and a trust set per configured product (§14.4). The options are `products` (the product slugs it serves, in order), `maxAgeSeconds` (absent, or an integer from 0) and the route's requirements in order, each an entitlement name or sign-in. The steps run in order; the first that fails decides.

1. `X-PKey-License` has no element → `license_required` (401).
2. It has more than one element, or the element is longer than 16 384 bytes, or it is not three non-empty base64url segments joined by `.` → `license_invalid` (401).
3. For a configured product `p` whose slug is the document's `aud`, the document passes §1's strict verifier with `typ` `pkey-license+jws` and `p`'s trust set, and §3's licence claims with no anti-replay floor and freshness not asserted: `iss` is `key.plrs.im`, `deviceId` is a non-empty string equal to the `X-PKey-Device` element when there is one, and `issuedAt ≤ now + 300`. Otherwise, or when `X-PKey-Device` has more than one element → `license_invalid` (401). One product's key never verifies a document for another: `p`'s trust set is chosen by the `aud`, which is checked again after verification.
4. **Freshness.** Without `maxAgeSeconds`: `now ≤ expiresAt + 300`. With it: `now − issuedAt ≤ maxAgeSeconds + 300`, and never past `graceUntil` (`now ≤ graceUntil`). Otherwise → `license_stale` (401).
5. **The shared gate.** `licenseState` (§5) over the document at `now`, with the licence service on and the device activated, must be usable (`ok` or `grace`) → otherwise `license_stale` (401).
6. **The route's requirements**, in the order the route lists them:
   - an entitlement `n`: `entitlements` has its own member `n`, an object whose `value` is `true` (whatever its `state`) → otherwise `not_entitled` (403, the existing wire code);
   - sign-in: `profile.user.subject` is a string matching the pairwise-subject pattern `^ps_[A-Za-z0-9_-]{22}$` (§8) → otherwise `sign_in_required` (403).

When every step passes, the request goes on with this context; on a step-6 refusal the context is still attached:

```ts
interface BackendContext {
  license: {
    product: string; // the document's aud
    id: string; // licenseId
    deviceId: string;
    tier: string | null; // entitlements["license.tier"].value when a string
    issuedAt: number;
    ageSeconds: number; // max(0, now - issuedAt)
    holder: { name: string; email: string } | null; // when the profile has both as strings
  };
  user: { subject: string } | null; // profile.user.subject when it matches the pattern
}
```

`profile.user` is SP-54's member (§2.1), read by `licenseUserOf` (§3.2). A document from a Worker that predates it names no account, so every sign-in requirement refuses it; the reader is total, so an absent or malformed member is simply no account.

### 14.3 The problem body and challenge [C]

A refusal answers `application/problem+json` with `Cache-Control: no-store`, and a 401 adds `WWW-Authenticate: PKey-License realm="<realm>", error="<code>"`, where the realm is the first configured product's slug. The body is `{type, title, status, detail, code}`:

- `type` is `https://key.plrs.im/docs/reference/error-codes/#<code>`;
- `title` and `detail` are the code's `title` and `message` in `conformance/parity/copy.<locale>.json`.

The locale comes from `Accept-Language`, among the eight copy locales (`en`, `de`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`):

1. Split the value at `,`. Each element is a range and its parameters, split at `;` and trimmed of spaces and tabs. The first `q` parameter (by its name, in any case) is the weight, 1 without one. A weight outside the qvalue grammar (`0` to `1` with at most three decimals) drops the element; so does a weight of 0 or an empty range.
2. Try the ranges by weight, highest first; equal weights keep their order.
3. A range maps onto a locale after ASCII case folding: `*` is `en`; an exact match of a locale tag is that locale; `zh` with any second subtag but `tw`, `hk`, `mo` or `hant` is `zh-Hans`; `pt` with any region is `pt-BR`; `en`, `de`, `es`, `it`, `ja` and `ko` with any region are themselves. Any other range matches nothing, and the next one is tried.
4. With no match, the locale is `en`.

The body never names the step that refused, the header, the document or a claim. A debug log may name the step, the `kid`, the `aud` and an eight-character hash of the device id; no log line, error message or serialisation carries the header, the JWS or the holder's name and email.

### 14.4 Trust (informative)

A backend's trust set per product is the pins from its configuration plus the keys of the last trust manifest it verified. It fetches `<baseUrl>/<p>/.well-known/polaris-trust.jws` at start, every `BACKEND_TRUST_REFRESH_SECONDS` (900 s), and on an unknown `kid` at most once a minute, and verifies it against the pins only (§1). A failed fetch keeps the last verified set, and pinned keys always verify, so an outage of Polaris Key never refuses a document a pinned key signed. Configured without refresh, it runs on the pins alone. The fetch sends `X-PKey-SDK: <language>-server` (`node-server`, `python-server`, `swift-server`, `kotlin-server`; §8). A backend may cache a verified document, keyed by the SHA-256 of the header value and dropped whenever its trust set changes; a cache may skip step 3's signature check for a value it verified before, and never skips steps 4 to 6. None of this is pinned by the corpus, because it is I/O.

### 14.5 The client rule [C]

A client half (`client.backend` in each SDK) sends `X-PKey-License` when it holds a licence document, and `X-PKey-Device`. With `now` its effective time (the clock floor applied, §4.2):

- **Before sending**, if it holds a document and `now > expiresAt − REFRESH_MARGIN_SECONDS` (1 800 s), it syncs the licence document first (`refresh-then-send`; concurrent callers share one sync), then sends the document it holds, whether or not the sync succeeded. Otherwise it sends (`send`).
- **On a 401 whose problem `code` is `license_stale` or `license_invalid`**, it forces a sync and retries once (`refresh-and-retry`). If the sync fails, or the retry is refused again, it returns the backend's response and the gate shows its own state.
- **Everything else is surfaced** (`surface`): `license_required`, `not_entitled` and `sign_in_required` are never retried, and a response with another status or no problem code is the backend's own.

### 14.6 Declared limits

- **Replay.** Device binding is a consistency check, not proof of possession: anyone who captures a document can replay it from any device until it goes stale, by default until `expiresAt + 300` (65 minutes after it was signed, since `expiresAt = issuedAt + 3600`) or `maxAgeSeconds + 300` when set. A backend keeps no anti-replay floor (`ok-replayed-older-document`, `stale-replayed-after-window`). TLS and the client's refresh rule keep the window short; a device-bound proof is a later question (framework drop-ins plan §13 Q3).
- **Revocation.** A revoked, expired or disabled licence stops getting documents from the Worker, so its last one fails `license_stale` within that same window: about 65 minutes by default. A backend learns of nothing sooner.
- **Holder data.** The document carries the holder's name and email to the developer's own backend (docs/PRIVACY.md).

## 15. Cloud Connect

Cloud Connect lets the devices of one signed-in person find each other and talk over an encrypted channel, on the local network or through the relay. It adds two signed documents, `pkey-peer+jws` and `pkey-ring+jws`, signed by the product key, and the `pkey-peer/1` protocol between SDKs. The Worker never sees a channel's plaintext: the relay forwards ciphertext it cannot read.

### 15.1 Constants and scope

Normative constants (all **[C]**): `PEER_CERT_SECONDS = 604 800` · `MAX_PEER_CERT_SECONDS = 604 800` · `PEER_CERT_RENEW_SECONDS = 302 400` · `RING_SECONDS = 604 800` · `MAX_RING_DEVICES = 128` · `MAX_PEER_MESSAGE_BYTES = 1 048 576` · `CLOCK_SKEW_SECONDS = 300` (§2).

- The certificate and the roster use the §1 trust model, §1.1 Ed25519 strictness, §1.2 strict JSON and §3.1 integer claims unchanged. A release key or a content key never signs either.
- The cipher is AES-256-GCM everywhere; the hash is SHA-256.
- Device keys are two per device: an Ed25519 `signKey` and an X25519 `agreeKey`. Raw hardware values never appear (§6, `docs/PRIVACY.md`).

### 15.2 `pkey-peer+jws`: the device certificate

Header `{"alg":"EdDSA","typ":"pkey-peer+jws","kid"}`. It is signed by the product key and verified
against the effective product set (§1).

```jsonc
{
  "iss": "key.plrs.im",
  "aud": "<product-slug>",
  "sub": "ps_<22>", // pairwise subject; never the account id
  "deviceId": "<32 b64url>",
  "signKey": "<43 b64url, raw Ed25519 public>",
  "agreeKey": "<43 b64url, raw X25519 public>",
  "ringEpoch": 7, // the ring epoch at issue, integer ≥ 1
  "issuedAt": 1761300000,
  "expiresAt": 1761904800, // issuedAt + PEER_CERT_SECONDS (604800)
}
```

**Verify** (strict JSON §1.2; integer claims from the token, §3.1; unknown members ignored, §3.2):

1. `typ` is `pkey-peer+jws`, and the signature verifies under the effective set. A release key or a
   content key never signs one.
2. `iss` is the fixed issuer, and `aud` is the app's product.
3. `sub` matches `^ps_[A-Za-z0-9_-]{22}$` and `deviceId` matches §6's pattern.
4. `signKey` and `agreeKey` are canonical base64url of exactly 32 bytes.
   - `signKey` passes §1.1 checks 2–3.
   - `agreeKey` is not one of the X25519 low-order points (the list is in `noise-vectors.json`).
   - The issuer (the Worker, at registration and at signing) also refuses a non-canonical `agreeKey`: bit 255 set, or `u ≥ 2^255 − 19`. X25519 masks and reduces those spellings, so they name a key under a second string. A verifier stays lenient and accepts them, so no certificate the issuer signs carries one.
5. `1 ≤ expiresAt − issuedAt ≤ MAX_PEER_CERT_SECONDS` (604800).
6. Against the effective clock (§4.2): `issuedAt ≤ now + 300` and `now ≤ expiresAt + 300`.
7. In a session, `agreeKey` equals the Noise remote static key. In mode `a`, `sub` equals the
   verifier's own subject and `deviceId` differs from its own.

There is no anti-replay floor: the certificate is shown to third parties, as for a document presented to a third party (§14).
Renewal happens when less than `PEER_CERT_RENEW_SECONDS` (302400) is left, or when the ring epoch
moves.

### 15.3 `pkey-ring+jws`: the roster

The roster is device-less, like trust and feed. It is signed by the product key and verified
against the effective set.

```jsonc
{
  "iss": "key.plrs.im",
  "aud": "<product>",
  "sub": "ps_…",
  "epoch": 7,
  "issuedAt": 1761300000,
  "expiresAt": 1761904800, // + RING_SECONDS (604800)
  "devices": [{ "deviceId": "…", "signKey": "…", "agreeKey": "…" }],
}
```

`devices` holds 1 to `MAX_RING_DEVICES` (128) entries, sorted by `deviceId` bytes, with unique ids
and keys checked as in §15.2 step 4. At 128 entries the payload is about 20 KiB, under the 64 KiB cap.

**Lifetime.** A roster's `expiresAt − issuedAt` is 1 to `RING_SECONDS` (604 800), and the Worker issues every roster at exactly `RING_SECONDS`. The signer refuses to sign one whose `expiresAt` precedes or equals `issuedAt`, or whose span is longer than `RING_SECONDS`, so a roster cannot outlive the horizon on which a removed device's certificate expires (§15.2 step 5 sets the same bound for a certificate). A verifier refuses a roster whose `expiresAt − issuedAt` is outside 1 to `RING_SECONDS` (reason `lifetime`), checked after the integer and subject checks and before the device list; the corpus pins it (`ring-lifetime-*`, `ring-valid-span-*`) and so does the certificate bound (`peer-lifetime-*`).

**Held ring and replacement.** The held ring R is replaced by R′ only when all of these hold:

- R′ verifies;
- R′ has the same `aud` and `sub`;
- `R′.epoch > R.epoch`;
- R′ is not expired.

A roster is expired once `now > expiresAt + 300`, the certificate's clock skew (§15.2 step 6). An expired held ring counts as no ring at all. That is safe, because the certificates of removed
devices expire on the same horizon.

**The client's own identity.** A client holds its certificate C and roster R together, and accepts a fetched pair only when `C.ringEpoch == R.epoch`, C names this device and its keys, and R lists this device. A fetched R′ with the **same** epoch as the held R replaces it only when its `devices` list is identical (a reissue that extends `expiresAt`, so a stable roster does not lapse after `RING_SECONDS`); a same-epoch R′ with different devices is refused and the held pair is kept. A refused answer writes nothing.

**Peer admission** with certificate C:

1. C verifies (§15.2).
2. If R exists and `R.epoch > C.ringEpoch`, then `(deviceId, signKey, agreeKey)` must be in R.
   Otherwise the session closes with `peer_revoked`.
3. If `R.epoch ≤ C.ringEpoch`, or there is no R, admit the peer. When `C.ringEpoch > R.epoch`, send
   or request `RING`.

### 15.4 Discovery adverts

| Advert         | Instance (`_pkeypeer._tcp`, a random port each listen)                                                                                                                                                                                                                                                                                                       | TXT                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Account (`a`)  | `p1-` + base32lower(HMAC-SHA256(K_disc, "pkey-peer/1 disc"‖0x00‖u64be(⌊now/900⌋)‖deviceId))[0..16]                                                                                                                                                                                                                                                           | `v=1`, `m=a`               |
| Approver (`v`) | `p1-` + 16 random base32 characters, advertised by **M, the signed-in approver** (D connects out, so D needs no listener and no firewall prompt); only when signed in, `identity.nearby` is on and the Local Network permission was already granted, otherwise after the person picks "Approve a nearby device"; renewed every 300 s while in the foreground | `v=1`, `m=v`, `h=<16 hex>` |
| Pair (`p`)     | `p1-` + 16 random base32 characters, both sides open pairing (unchanged), only while the screen is open, at most 300 s                                                                                                                                                                                                                                       | `v=1`, `m=p`, `h=<16 hex>` |

- **Product tag.** `h` = hex(HMAC-SHA256(SHA-256("pkey-peer/1 salt"‖0x00‖slug), "pkey-peer/1
  pair"‖0x00‖u64be(epoch)))[0..16]. Anyone who knows the slug can recognise the product; the
  privacy docs say so.
- **Browsing.** A browser tests the current and previous 15-minute epoch, under both delivered
  discKeys, for every roster `deviceId`: at most 512 HMACs per result.
- **Nothing else.** No label, id, model or subject appears anywhere in the advert.
- **K_disc.** It is 32 random bytes per `(product, subject)` per ring epoch, stored in
  `connect_rings`. `GET /connect/identity` delivers the current key and the previous one (for 24 h
  after a bump). A device advertises only under the newest key.
  The previous key is delivered only when every device of the earlier epoch is still a member: a bump in which a device left drops it, so a removed device has no window. A bump caused by a device rotating its keys is treated as a leave and drops it too. A bump that only adds devices keeps it.
  Clients treat the delivered previous key as authoritative but SHOULD stop using it 24 h after first seeing it, and drop it at once on a local leave or when a fetched roster lost or re-keyed a device compared with the held one. A client does not know the bump time, so its bound can exceed the Worker's window by up to 24 h; the Worker's rule above is what closes a removed device's window.
- **Why server-delivered.** This keeps L-13's server-delivered key over a root-key derivation.
  Connect then works without Cloud Sync E2E, and rotation is trivial.
- **Byte-level choices (`peer-matrix.json` `adverts`).** `deviceId` in the HMAC is the 24 bytes the 32 base64url characters decode to. The instance suffix is the first 16 characters of the RFC 4648 base32 alphabet in lower case (`a-z2-7`), unpadded, of the 32-byte MAC. A browser matches an instance against the current epoch and the one before, newest key first, and against no other. A TXT entry splits at its first `=`; an entry without `=` and a key this section does not define are ignored; keys are case-sensitive; a repeated key refuses the whole advert. `v` must be `1`; `m` must be `a`, `v` or `p`; `h` is read for `v` and `p` only and must be 16 lower-case hex characters.

- **Addresses (`peer-matrix.json` `lanAddresses`; §15.4.1 is the rule).** A responder we ship names its host `<instance>.local`. It answers with an A record for its RFC 1918 IPv4 address and an AAAA record for its `fe80::/10` address, both for the interface the response leaves on. OS responders (Apple, Android) may publish more addresses. A browser that reads the records itself believes an A or AAAA record only when its address equals the packet's source address; a link-local address takes the arrival interface as its zone. That equality is the whole of learning: there is no address filter when a record is learned, and the dial-time check of §15.4.1 (`lanVerdict`) decides what may be dialled. An IPv4-mapped source (`::ffff:a.b.c.d`) is judged as its IPv4 address, as in §15.4.1, so an A record for `a.b.c.d` matches it and an AAAA record never does. An address record with a TTL of 0 removes that address (the same text, with the same zone) when it passes the same equality test; a PTR goodbye removes none. Names compare case-insensitively by ASCII fold (`A` to `Z` only) and are held in lower case. A name keeps at most 4 addresses, of any family, in first-seen order. mDNS runs on `224.0.0.251` and on `ff02::fb` on each multicast-capable interface (at most 8), port 5353. TXT and the instance name are unchanged. The vectors for these answer rules, `mdnsAnswers`, follow in their own section.

### 15.4.1 LAN addresses

`lanVerdict(remote, local, allowLoopback)` answers `{dial, key}`. It applies to a dialled socket, checked on the connected socket before its first byte, and to an accepted socket, checked before it takes a slot among the sockets that have not finished the handshake. `remote` is the peer address of the connected socket and `local` the socket's own address; `local` may be unknown.

- A zone (`%en0`) is ignored by the verdict and by the key. An empty zone, a zone on an IPv4 address and text that is not an address are refused.
- An IPv4-mapped address (`::ffff:0:0/96`) is judged as its IPv4 address.
- **IPv4.** `10/8`, `172.16/12` and `192.168/16` are allowed. `127/8` is allowed only with `allowLoopback`. Anything else is refused, among it `169.254/16`, `100.64/10`, public addresses, `0/8` and multicast. Octets are decimal with no leading zero.
- **IPv6.** `::1` is allowed only with `allowLoopback`. `fe80::/10` and `fc00::/7` are allowed. An address in `2000::/3` is allowed when `local` is IPv6 (not mapped) in the same /64, and the address is outside `2001::/32` (Teredo) and `2002::/16` (6to4). Anything else is refused, among it `::`, `fec0::/10`, `ff00::/8` and `64:ff9b::/96`.
- **Why a global address needs the same /64.** A host that is not on the link cannot finish the TCP handshake with a source on the local /64, because the reply goes on-link. Teredo and 6to4 share a /64 across the internet, so they never qualify. This is the same granularity as the Worker's "same network" check (§12.11.5): the LAN's address family is not part of that check, and a dual-stack false negative stays its residual.
- **The key.** `key` is the dotted IPv4 address or the RFC 5952 lower-case IPv6 text without its zone, or `null` when `dial` is false. It is the full address, not the /64, because every neighbour on the LAN shares the /64. The per-key count of unauthenticated sockets is 4, the total 32, and a socket has 30 s from accept to the transport (§15.6); the total and the time bound limit a neighbour that rotates addresses.
- **Listener.** One port serves both families: a dual-stack `::` socket, falling back to `0.0.0.0` where IPv6 is unavailable. The SRV record carries that one port.
- **Dialling.** A device with several learned addresses for a name tries them in first-seen order, at most 2 attempts in flight and 250 ms apart (RFC 8305). The first connection that passes the verdict wins, and the others close before a byte is sent. An SDK that leaves the race to its platform (Swift, Android) still applies the verdict to the winner.

### 15.5 Handshake

| Mode | Noise protocol name                     | Static keys                 | PSK                                                  | Handshake payload, messages 2 and 3          |
| ---- | --------------------------------------- | --------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `a`  | `Noise_XXpsk0_25519_AESGCM_SHA256`      | device `agreeKey`           | HKDF-SHA256(K_disc, "", "pkey-peer/1 psk"‖0x00‖slug) | `{"v":1,"cert":"<jws>","ring":7,"caps":[…]}` |
| `v`  | `Noise_XX_25519_AESGCM_SHA256`          | one-time keys on both sides | none                                                 | `{"v":1,"caps":[…]}`                         |
| `p`  | `Noise_XX_25519_AESGCM_SHA256`          | one-time keys on both sides | none                                                 | `{"v":1,"caps":[…]}`                         |
| `c`  | `Noise_XXpsk0_…` (a later contact mode) | device `agreeKey`           | the contact secret                                   | `{"v":1,"caps":[…]}`                         |

**Prologue and payloads:**

- The prologue is `"pkey-peer/1"‖0x00‖slug‖0x00‖mode‖0x00`. A version, product or mode mismatch
  fails by construction.
- The mode-a PSK is `HKDF-SHA256(salt = empty, ikm = K_disc, info = "pkey-peer/1 psk"‖0x00‖slug)`
  at 32 bytes. The argument order is pinned by `noise-vectors.json`: an empty salt (HashLen zero
  bytes, RFC 5869), the 32-byte discovery key as the input keying material and the label as info.
- Message 1's payload is `{"v":1}`.
- Payloads are strict JSON of at most 8 KiB.
  - **Payload rules (`peer-matrix.json` `handshakePayloads`).** A payload is one JSON object under §1.2 (no byte order mark). Message 1 needs `v` = 1 and no `cert`. Messages 2 and 3 need `v` = 1 and `caps`; in mode `a` also a non-empty string `cert` and an integer `ring` of at least 1 that is a safe integer; in modes `v` and `p` a `cert` refuses. Unknown members are ignored. The session's capabilities are the entries both sides list, once each, in byte order.
- `caps` holds at most 32 entries matching `^[a-z0-9]+/[0-9]+$`. v1 defines `ring/1`, `trust/1`,
  `cand/1`, `vouch/1` and `app/1`. The session uses the intersection.

**Responder rules:**

- In mode `a`, the responder tries at most two PSKs, the current and previous discKeys. A failed
  tag closes the connection silently.
- Any DH output of all zeros aborts the handshake.

**SAS (modes `v` and `p`), commit-reveal .** A code taken straight from the handshake hash
can be forged by a man in the middle on the LAN who grinds its static key (about 10^6 X25519
operations). Each side therefore commits before the code is shown:

1. D sends `SAS_COMMIT` (0x8014) `{c: SHA-256(nD)}`, where nD is 32 random bytes.
2. M sends `SAS_NONCE` (0x8015) `{nM}`.
3. D sends `SAS_REVEAL` (0x8016) `{nD}`; M checks c.
4. `sas = u32be(HKDF-SHA256(salt=h, ikm=nD‖nM, info="pkey-peer/1 sas"‖0x00‖mode)[0..4]) mod 10^6`,
   shown as "123 456" on both screens.

An approver accepts at most 5 handshakes a minute per advert, so a man in the middle succeeds with
probability about 10^-6 per attempt. The vectors go in `peer-matrix.json` `sas`, with commit and
reveal rows.

**Encodings (`peer-matrix.json` `sas`).** `h` is the 32-byte Noise handshake hash. The code is shown as six digits, zero-padded, with a space between the triples (`058 429`). `nD`, `nM` and `c` are 32 bytes written as 43 canonical base64url characters, in a compact JSON object with the one member `c`, `nM` or `nD`; anything else (another length, padding, a hex spelling) refuses and closes the session with `peer_bad_frame`. The reveal is valid when SHA-256 of the decoded `nD` equals the decoded `c`.

**No identity before consent.** Modes `v` and `p` carry no certificate in the handshake.

### 15.6 Records and framing

- **TCP framing.** A frame is `u16be len ‖ Noise message`, with len from 1 to 65,535.
- **Record.** One Noise transport plaintext is `u16be type ‖ u8 flags ‖ body`.
  - Flag bit 0 is `MORE`: the record continues in the next one of the same type. Any other flag
    bit set closes the session with `peer_bad_frame`.
  - A reassembled record is at most `MAX_PEER_MESSAGE_BYTES` (1 MiB).
  - A type with bit `0x8000` set is critical. An unknown critical type closes the session with
    `peer_unknown_critical`; an unknown non-critical type is ignored.
  - A type not allowed in the session's mode closes it with `peer_not_allowed`.
  - **Order of checks (`peer-matrix.json` `records`).** Per record: the flag bits, then a record of another type while a `MORE` chain is open (`peer_bad_frame`), then the type (unknown critical, then the mode), then the running size over 1 MiB (`peer_bad_frame`), and on a chain's last record a fixed body length (`PING` and `PONG` 8 bytes, `REKEY` empty; `peer_bad_frame`). An unknown non-critical type is dropped with its whole chain. A frame whose length is zero closes with `peer_bad_frame`.

  - **Chains.** A chain of more than 18 records closes with `peer_bad_frame` (`ceil(1 MiB / 65 516) + 1`: a full message in the largest records the Noise limit allows, plus one). An empty `MORE` record stays legal (`peer-matrix.json` `more-empty-parts`), so this count is what bounds a chain's cost.
  - **CANDIDATES addresses.** An IPv4 entry is `a.b.c.d:port`; an IPv6 entry is `[addr]:port` in RFC 5952 text with no zone. A link-local address is never sent, because it means nothing off its link. The receiver judges each entry by §15.4.1 before it dials. A v1 SDK neither sends nor reads the record (CC-08R), so this spelling is fixed before anyone uses it.

  - **Session rules (client-core `peer/session.ts`).** The first record each way is `HELLO`; a first record of any other type, and a second `HELLO`, close the session with `peer_bad_frame`. A failure before the transport exists (a bad tag, payload or certificate) ends the connection without sending anything; after it, the closing side sends `CLOSE` with its code. A `CLOSE` whose code is not one of the codes in §15.9 is read as `peer_bad_frame`. Deadlines: 30 s from the first byte to the transport, and in modes `v` and `p` 120 s from the first byte to the person's confirmation; either closes with `peer_timeout`. An approver (responder in `v` or `p`) admits at most 5 handshakes a minute per advert and 4 sessions waiting on a code, counted when a session starts and against a monotonic clock; a refused one closes with `peer_busy` and sends nothing. In modes `v` and `p` a record other than `HELLO`, `SAS_*`, `PING`, `PONG`, `REKEY`, `CLOSE` is held (at most 16, then `peer_busy`) and is delivered only after this side's person confirms the code, and this side sends none before; `CONFIRM` is sent by the confirmation itself. `SAS_*` out of order (a commit to the initiator, a reveal before a nonce, a repeat) or a reveal that does not match its commit closes with `peer_bad_frame`. In mode `a` a held roster that is expired, unverifiable or of another account refuses the peer (the host fetches a fresh one); only a device with no roster admits on the certificate alone. A roster received in a `RING` record replaces the held one only for this device's own subject and a higher epoch, and the peer is admitted again against it (`peer_revoked` if dropped). The session closes with `peer_expired` when the peer's certificate expires. `TRUST` is handed to the host unverified. `HELLO` fields are display data from an unauthenticated peer in modes `v` and `p`: the label is NFC-normalised, stripped of control, zero-width and bidi characters and cut to 64 code points. A host closes on an unknown type in `0x8100`-`0xFFFD`.

| Type                         | Name                                    | Modes | Body                                                                                                                                                               |
| ---------------------------- | --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0x8001                       | HELLO (first record each way)           | all   | `{label?, platform, app, maxMessage}`. The label is display data (§5.4)                                                                                            |
| 0x0002                       | RING                                    | a     | `{"ring":"<pkey-ring+jws>"}`                                                                                                                                       |
| 0x0003                       | TRUST                                   | a     | `{"trust":"<pkey-trust+jws>"}`. The receiver verifies it against its usable pins (§1); it heals a peer that missed a key rotation                                  |
| 0x0004 / 0x0005              | PING / PONG                             | all   | 8 bytes                                                                                                                                                            |
| 0x0006                       | CANDIDATES                              | a     | `{"addrs":["ip:port","[addr]:port"…≤8]}`, sent over the relay, for a direct upgrade (§15.4.1)                                                                      |
| 0x8010                       | VOUCH_REQ (requester to approver)       | v     | `{v: 1, request, signKey, agreeKey, label, platform, sig}`. `sig` is `pkey-proof/1` purpose `vouch`, value `<b64url h>.<request>` (§15.8). No `userCode`, no `pop` |
| 0x8011                       | VOUCH_RESULT                            | v     | `{"status":"approved"\|"denied"\|"expired"\|"not_nearby"\|"device_limit"}`. For display only; the server is the authority                                          |
| 0x8014                       | SAS_COMMIT                              | v, p  | `{c}`                                                                                                                                                              |
| 0x8015                       | SAS_NONCE                               | v, p  | `{nM}`                                                                                                                                                             |
| 0x8016                       | SAS_REVEAL                              | v, p  | `{nD}`                                                                                                                                                             |
| 0x8012                       | CONFIRM                                 | p     | `{}`. This side's person confirmed the SAS                                                                                                                         |
| 0x0013                       | CONTACT                                 | p     | `{agreeKey, label}`, after both CONFIRMs. It never carries a `sub` or a certificate (a later contact mode)                                                         |
| 0x0020–0x0025                | OFFER, ACCEPT, CHUNK, ACK, DONE, CANCEL | a, c  | Direct Transfer (`xfer/1`)                                                                                                                                         |
| 0x0030                       | KEYRING_WRAP                            | v     | `{ringId, epoch, kid, kem, enc, ct}`: an HPKE wrap to the agreeKey from VOUCH_REQ. Owned by Sync; legal only in mode v after the code and the server approval      |
| 0x0031–0x003F                | reserved for Cloud Sync                 | v     | owned by Cloud Sync (§13)                                                                                                                                          |
| 0x0100–0x7FFF, 0x8100–0xFFFD | APP                                     | a, c  | the developer's opaque bytes (`app/1`)                                                                                                                             |
| 0x80FE                       | REKEY                                   | all   | empty. The sender rekeys after sending, the receiver after reading. Sent every 2^20 messages or 3600 s                                                             |
| 0x80FF                       | CLOSE                                   | all   | `{"code":"peer_*"}`                                                                                                                                                |

### 15.7 Relay

**Ticket.** The relay-ticket prefix is `pkeyrt_` (§8). `POST /<p>/connect/relay/ticket` (bearer and `X-PKey-Device`) answers
`{ticket:"pkeyrt_<32>", url, protocol:"pkey-relay.1", expiresAt}`. The ticket lives 60 s in the
`relay-ticket` single-use kind and is bound to `(product, subject, deviceId)` and the resolved
quota.

**Connect.** The client opens `GET /<p>/connect/relay` with `Sec-WebSocket-Protocol: pkey-relay.1,
pkeyrt_…`. The Worker consumes the ticket, then forwards the request to
`CONNECT_RELAY.idFromName("<p>:<subject>")`. The DO echoes `pkey-relay.1`.

One binary message is an envelope. The DO **stamps `from`** from the admission and never reads it
from the client.

| Direction    | Op   | Layout                                               |
| ------------ | ---- | ---------------------------------------------------- |
| client to DO | 0x01 | SEND: `to(24) ‖ session u32be ‖ noise`               |
| client to DO | 0x02 | LIST (empty)                                         |
| client to DO | 0x03 | PING: 8 bytes                                        |
| DO to client | 0x81 | RECV: `from(24) ‖ session ‖ noise`                   |
| DO to client | 0x82 | MEMBERS: `n ‖ n×24`                                  |
| DO to client | 0x83 | RING: `u64be epoch`                                  |
| DO to client | 0x84 | PONG                                                 |
| DO to client | 0x85 | GONE: `device(24)`                                   |
| DO to client | 0x86 | LIMIT: `u8` 1 rate · 2 person · 3 product · 4 paused |

**Byte-level choices (`peer-matrix.json` `relayEnvelopes`).** A device is its 24 decoded device-id bytes. `MEMBERS` carries its count `n` as one byte. `PONG` echoes the 8 bytes of the `PING` it answers. The limit of 65,564 bytes is the whole message: the op, 24, 4 and a Noise frame of at most 65,535 bytes. A message that does not match its layout exactly, an op in the wrong direction and a `LIMIT` outside 1 to 4 are refused.

**Refused envelopes.** A message that fails its layout is never answered: the receiver closes the WebSocket (a client with 1002, the Room with 1008) and treats any frames after it as lost. The 4001 to 4009 codes above are the Room's own.

**Close codes:** 4001 bad ticket · 4003 not a member · 4008 limit · 4009 replaced.

**Limits:**

- 2 sockets per device; a third replaces the oldest.
- 32 sockets per room.
- A message is at most 65,564 bytes.
- 200 messages per second per socket, with a burst of 400.

**Rooms and modes.** In v1 a room is always an account room. Mode `v` never crosses the relay
(LAN only), and neither does `p` (L-9).

### 15.8 Device keys (Core)

**Route.** `PUT /<p>/devices/keys` (bearer) takes `{signKey, agreeKey, issuedAt, sig}` and answers
`{keySeq}`.

**Proof of possession.** `sig` is `pkey-proof/1` with purpose `keys`; the value is `<signKey>.<agreeKey>.<issuedAt>`, with `|issuedAt − now| ≤ 300`. The value names the presenting `signKey` and a valid `agreeKey` (§15.2 step 4: canonical X25519 spelling, not low-order); `issuedAt` is a decimal integer with no leading zero, no sign and no fraction; line 6 is `-`. Its vectors are `device-proof.json`: every purpose valid, and a refusal for each rule above.

**Rules:**

- §15.2 step 4 applies to both keys.
- `agreeKey` is unique per product.
- A registration whose `agreeKey` is not the canonical X25519 spelling is refused (§15.2 step 4).
- A proof that changes the keys must carry an `issuedAt` strictly newer than the last one accepted for the device, so a captured proof cannot be replayed inside its window. The Worker keeps that floor, and the highest `keySeq`, in a row that outlives the device's keys.
- `keySeq` only increases: after the device is deauthorized and registers again it continues from its last value.
- A device may rotate at most 4 times a day (a rate limit).
- A rotation bumps the device's `keySeq` and raises a device-change event of kind `keys` inside the Worker.
- When a device is removed or purged, its row goes too; the floors above stay until the device row or the product is erased.

**Registration.** A device's keys are registered by one Core operation with three entry points: this route, the platform sign-in exchange (§12.11) and nearby approval (§12.11). Every registration carries both keys. The route is matched before `/devices/{deviceId}`.

**Generation and use.** Keys are generated on first need: Connect, or the platform sign-in's
device-bound nonce (§12.11). They are not generated at launch.

**Discovery.** `core.endpoints.deviceKeys` is added (unsigned, additive; `DISCOVERY_VERSION` stays 2).

### 15.9 Conformance and the rest of the wire

**Corpus.** `cases.json` gains the sections `peerCertCases`, `ringCases` and `peerAdmissionCases` (§15.2, §15.3). Two new files sit beside it: `noise-vectors.json` (X25519 and AES-256-GCM known answers, the low-order points, the three handshake modes with fixed ephemerals, rekey, and external `Noise_XX_25519_AESGCM_SHA256` anchors) and `peer-matrix.json` (adverts, prologue, PSK, SAS with commit and reveal rows, TCP frames, records, relay envelopes and handshake payloads). `noiseVectorsVersion` and `peerMatrixVersion` are 1. The device proof (§15.8) is `device-proof.json`. These are generated by CC-03.4, CC-04.3 and CC-05; `corpusVersion` stays 2, and a runner that does not name a section ignores it.

**LAN addresses.** `peer-matrix.json` gains the section `lanAddresses` (§15.4.1): `rows` of `{id, remote, local?, allowLoopback, dial, key}` that every runner applies to `lanVerdict`. `peerMatrixVersion` stays 1, because the file is append-only and a runner ignores a section it does not name. The generator's reference is `tools/corpus/reference/lanAddress.ts`.

**mDNS answers.** `peer-matrix.json` also gains the section `mdnsAnswers` (§15.4, Addresses): `rows` of `{id, packet, source, zone, prior?, learned}`. `packet` is one mDNS response as hex, `source` its source address, `zone` the arrival interface (null: none), `prior` the addresses already held for a name (in first-seen order), and `learned` the table after the packet. `source` may be an IPv4-mapped IPv6 address, an address record with TTL 0 removes the address it names, records apply in packet order, and `learned` holds names in lower case. Only an SDK with its own DNS codec runs it (Node, Python, Kotlin on the JVM, Godot GDScript); Swift and Android leave address learning to the OS resolver and name the section as skipped. The generator's reference is `tools/corpus/reference/mdns.ts`.

**Errors.** One new error kind, `peer`, sent between SDKs in a `CLOSE` record and never emitted by the Worker: `peer_revoked`, `peer_expired`, `peer_bad_frame`, `peer_unknown_critical`, `peer_not_allowed`, `peer_busy`, `peer_timeout`, `peer_bye`. Worker (`wire`) codes: `device_keys_invalid` (400), `device_keys_required` (409), `ring_too_large` (409, more than 128 devices), `relay_disabled` (403), `relay_paused` (503 with `Retry-After`), `relay_quota_exceeded` (429, `scope` person or product) and `relay_ticket_invalid` (401; WebSocket close 4001). Client-only codes: `connect-unavailable`, `nearby-permission-denied`, `nearby-unsupported`, `peer-handshake-failed`, `peer-cert-invalid`, `peer-closed`. The registry is `conformance/parity/errors.json`, which lists a code before any implementation uses it.

**Discovery.** `services.connect` is `{"enabled":false}` when the service is off. When on, it is `{"enabled":true,"lan":bool,"relay":bool,"interAccount":bool,"endpoints":{"identity","devices","ticket"}}`, and an endpoint is `null` until the release that serves it. The member is unsigned and additive; `DISCOVERY_VERSION` stays 2.

**Routes.** `PUT /<p>/devices/keys` (Core), `GET /<p>/connect/identity`, `GET /<p>/connect/devices`, `POST /<p>/connect/relay/ticket` and `GET /<p>/connect/relay` (101 Upgrade). Their request and response shapes are in `openapi/polaris-key.v3.yaml`; the signed shapes are this section.

**Privacy.** An advert carries no label, id, model or subject (§15.4). The product tag lets anyone who knows a product's slug recognise its adverts; `docs/PRIVACY.md` says so. The LAN is never metered; the relay is.
