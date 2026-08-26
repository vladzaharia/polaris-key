# Wire contract v2 — trust, verification, and cache integrity

> **Status:** normative spec, authored by the audit Lead. Five independent implementations
> consume this (TS shared core, Node SDK, Python SDK, Swift SDK, Worker signer). Implementations
> MUST NOT diverge from it, and the conformance corpus is the arbiter — if this document and the
> corpus disagree, that is a bug in one of them, not a licence to improvise.

## Why this exists

The audit found that the "frozen" wire contract was frozen only where the corpus happened to
look. Confirmed with passing proofs-of-concept:

| Ref           | Defect                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-01 / R4-02 | The on-disk cache can **substitute the key bytes behind a pinned `kid`** — the merge spreads cache _after_ pins.                                |
| R2-02 / R4-03 | Trust sets only ever grow and `key.status` is never read. Revocation by omission has **no effect** on a provisioned client.                     |
| R2-03 / R4-01 | The cached document is stored **decoded**; its signature is discarded and never re-checked.                                                     |
| R4-03         | `lastAcceptedIssuedAt` / `lastTrustIssuedAt` are unsigned fields in that same file — poisoning them **blocks genuine revocation while online**. |
| R2-04         | **No implementation caps the protected header.** Moving the payload into the header bypasses the 64 KiB cap (8 MiB parsed pre-verify).          |
| R2-06         | Duplicate JSON keys resolve **last-wins in TS/Python, first-wins in Swift** — the `alg` downgrade guard gives opposite answers per language.    |
| R2-05         | Python's `urlsafe_b64decode(validate=False)` silently discards out-of-alphabet bytes; Node and Swift reject them.                               |
| R2-07         | Python's signer omits `ensure_ascii=False`, producing **different signed bytes** than Node for non-ASCII payloads.                              |
| R2-08         | `verifyDoc` never checks `iss`, `expiresAt`, `schemaVersion`, `licenseId`; zero clock skew.                                                     |
| R2-10         | The product signing key signs **both** config docs and trust manifests, with no `typ` domain separator.                                         |
| R2-11         | `computeETag` excludes the time fields, so a stable config 304s forever and a **continuously online client drifts to `expired`**.               |

R2 and R4 independently reached the same conclusion: **R2-01/02/03 are one defect wearing three
hats and must be fixed together.** Reversing the merge order alone is worthless, because the same
file write bypasses verification entirely and anything installed is permanent.

## Design principle

> **Persist only signed artifacts. Derive all security state from re-verified content.**

Every previous defect above except the parser issues comes from storing _derived, unsigned_ state
next to signed state and then trusting it. If the only thing on disk is a compact JWS, and every
counter is recomputed from that JWS after re-verification against **pinned** keys, then there is no
unsigned field left to poison. This removes a class of bug rather than three instances of it.

---

## 1. Trust set

### 1.1 Key sources and precedence

A verifier holds three tiers, in strictly decreasing authority:

| Tier         | Source                                                      | Mutable at runtime? |
| ------------ | ----------------------------------------------------------- | ------------------- |
| **Pinned**   | `opts.trust.pinnedKeys`, compiled into the host application | No                  |
| **Manifest** | Keys learned from a verified `polaris-trust.jws`            | Yes                 |
| —            | _(nothing else. The cache is no longer a key source.)_      | —                   |

**Normative rules:**

1. A pinned `kid` MUST NOT be overridden by any other source. When a manifest presents a `kid`
   already present in the pinned set with **different** key bytes, the verifier MUST reject the
   whole manifest and keep the previous trust set. This is a substitution attempt, not an update.
2. Merge order MUST be `{...manifestKeys, ...pinnedKeys}` — pins terminal. (Today it is the
   reverse; that single transposition is R2-01.)
3. The cache MUST NOT persist bare key material. It persists the **compact JWS of the trust
   manifest**, which is re-verified on load per §3.

### 1.2 `key.status` is normative

`TrustManifestDoc.keys[].status` is one of `active | staged | retired | revoked`.

| Status    | May verify a document?                                                   | Retained on next refresh?                                 |
| --------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `active`  | **Yes**                                                                  | Yes                                                       |
| `staged`  | **Yes** — a key must be trusted before it signs, or rotation cannot land | Yes                                                       |
| `retired` | **Yes** — in-flight documents signed before rotation must still verify   | Yes                                                       |
| `revoked` | **No**                                                                   | **No — MUST be removed from the trust set and from disk** |

3. A verifier MUST read `status` and MUST refuse to verify with a `revoked` key.
4. **Pruning is mandatory.** After verifying a manifest, the trust set becomes exactly
   `pinned ∪ {manifest keys whose status ≠ revoked}`. A `kid` absent from the new manifest and not
   pinned MUST be dropped. Absence is revocation; this restores the server's ability to revoke.
5. A pinned key is never pruned. Pinning is a deliberate act by the host application, and the
   escape hatch for a total control-plane compromise.

> **Server-side companion change.** To be precise about what is and is not broken: R11 verified
> that **server-side revocation works correctly today** — `listVerificationProductKeys`
> (`repo.ts:333`) excludes `revoked` and includes `retired` deliberately, as
> `0006_hardening.sql:10` documents. The defect is entirely client-side (R2-02): the server stops
> publishing a revoked key, and no client notices.
>
> Revoking by _omission_ nonetheless makes the client's job impossible, because absence is
> indistinguishable from a truncated or stale manifest. The server MUST therefore emit revoked
> keys **explicitly** with `status:"revoked"` for at least `2 × cacheSeconds`, giving clients a
> positive signal to act on before falling back to the prune-on-absence rule above.
>
> Separately, R11-07 found there is **no CHECK constraint on any status column**, and `retire`/
> `revoke` (`admin/handlers/products.ts:730`) have no status guard — so retiring the _active_
> signing key bricks the product, since `idx_product_keys_one_active` enforces at-most-one and
> never at-least-one. Add both the CHECK constraint and the guard.

---

## 2. JWS verification

### 2.1 Ordering (normative, all languages)

```
1. split on "." → exactly 3 segments, else FAIL
2. len(encHeader) > MAX_HEADER_B64  → FAIL          ← NEW (R2-04)
3. len(encPayload) > MAX_PAYLOAD_B64 → FAIL         ← NEW: cap the ENCODED form, before decode
4. strict base64url-decode header                   ← NEW: strict in every language (R2-05)
5. decoded header bytes > MAX_HEADER_BYTES → FAIL
6. parse header; reject duplicate keys              ← NEW (R2-06)
7. header.alg === "EdDSA", else FAIL
8. header.typ matches the expected type, else FAIL  ← NEW (R2-10)
9. typeof header.kid === "string", else FAIL
10. key = trustSet[kid]; absent or revoked → FAIL
11. strict base64url-decode signature
12. VERIFY signature over ASCII(encHeader + "." + encPayload)
13. only now: decode + parse payload, rejecting duplicate keys
```

Steps 12→13 are the important reordering: **no implementation may parse an unverified payload.**
Swift already had this right; TS and Python did not.

**Limits:**

| Constant                             | Value                   | Rationale                                                                           |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------- |
| `MAX_HEADER_BYTES`                   | `1024`                  | A legitimate header is ~60 bytes.                                                   |
| `MAX_DOC_BYTES`                      | `65536`                 | Unchanged.                                                                          |
| `MAX_HEADER_B64` / `MAX_PAYLOAD_B64` | `ceil(bytes × 4/3) + 4` | Checked on the _encoded_ string so an oversized blob is rejected before allocation. |

### 2.2 Duplicate keys

Duplicate object keys anywhere in the header or payload MUST cause failure. Not last-wins, not
first-wins — **rejection**, because any silent resolution is a differential across five
implementations.

- TS: parse with a reviver that tracks seen keys per container, or pre-scan.
- Python: `json.loads(..., object_pairs_hook=_reject_duplicates)`.
- Swift: decode via `JSONDecoder` only, and pre-scan the raw bytes for duplicates. **Do not use
  `JSONSerialization`** — its first-wins behaviour is what makes Swift disagree with the others.

### 2.3 Base64url

Strict in every language: the `-_` alphabet only, no `+/`, no whitespace, no `=` padding, and no
out-of-alphabet bytes. Python MUST stop using `validate=False` and MUST reject rather than discard.

### 2.4 Domain separation

The protected header gains a required `typ`:

| Document           | `typ`                                               |
| ------------------ | --------------------------------------------------- |
| `ManagedConfigDoc` | `"pkey-config+jws"`                                 |
| `TrustManifestDoc` | `"pkey-trust+jws"`                                  |
| Edge-mint tokens   | `"JWT"` (unchanged — a different audience entirely) |

Verifiers MUST assert the expected `typ` for the call site. This closes the cross-protocol replay
that R2-10 found currently fails only via a swallowed `TypeError` — i.e. by accident.

### 2.5 Canonical signing bytes

Signers MUST emit UTF-8 directly, never `\uXXXX` escapes. Python MUST pass
`ensure_ascii=False` and `separators=(",", ":")`. Corpus cases MUST include non-ASCII payloads so
CI can actually observe this (R2-07 — today the corpus is ASCII-only, so the divergence is
structurally invisible).

---

## 3. Claim validation (`verifyDoc`)

Checked in order; any failure returns "no document", never a throw:

| Claim           | Rule                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `typ`           | `"pkey-config+jws"` (§2.4). **Absent is accepted during the rollout window** — see §7 and the correction note below. |
| `schemaVersion` | Shape check only — see correction note.                                                                              |
| `aud`           | `=== expectedAud` (unchanged)                                                                                        |
| `iss`           | `=== expectedIss`, default `"key.plrs.im"` — **new**, was documented but never enforced                              |
| `deviceId`      | `=== opts.deviceId` (unchanged)                                                                                      |
| `issuedAt`      | `> lastAcceptedIssuedAt`, and `<= now + CLOCK_SKEW` — **new** upper bound rejects far-future stamps                  |
| `expiresAt`     | `> now - CLOCK_SKEW` — **new**. An expired doc is no longer accepted or cached.                                      |
| `graceUntil`    | `>= expiresAt` and `<= issuedAt + MAX_GRACE_SECONDS` — **new**, bounds a hostile server and a tampered file alike    |

`CLOCK_SKEW = 300` seconds, identical in all five implementations. Today it is zero everywhere,
so a device 61 minutes fast flips a freshly-signed document straight to `grace`.

### 3.1 Corrections found during implementation

Three clauses above were wrong as first drafted. The Node SDK implementation caught all three;
they are corrected here rather than quietly worked around, because four other implementations
read this document as normative.

1. **`schemaVersion` must NOT be allow-listed.** The draft said "must be a known version, unknown
   ⇒ fail closed." That conflated two unrelated fields: the config doc's `schemaVersion` is the
   **per-product catalog version** (`packages/worker/src/product.ts:114`), which increments every
   time an operator edits a catalog. An allow-list would reject every product that ever republished
   its schema. Verifiers do a **shape check only**. The _trust manifest's_ `schemaVersion` is a
   genuine wire version and **is** allow-listed.
2. **Freshness must not be re-checked on cache reload.** §4.2 said "re-verify `configJws` … with
   full §3 claim checks." Applying `expiresAt`/`issuedAt` freshness on the reload path deletes
   offline grace entirely — the feature the cache exists to provide. Signature, `typ`, `aud`,
   `iss` and `deviceId` are re-checked on reload; freshness applies on the **network** path only.
   Implementations carry an explicit `checkFreshness` flag, pinned by corpus case
   `doc-expired-reload-path`.
3. **`typ-missing` must be ACCEPTED during rollout.** §6's case table said reject, contradicting
   §7 step 2 and the reference `verifyJws`. §7 is correct: an absent `typ` is accepted while the
   Worker is still emitting v1 headers, and a _wrong_ `typ` is rejected immediately. The corpus
   pins `typ-missing ⇒ ok` and `typ-wrong ⇒ reject` for the rollout window; §7 step 4 flips
   `typ-missing` to reject once the Worker always emits it.

---

## 4. Cache integrity

### 4.1 What is stored

```jsonc
{
  "v": 2,
  "configJws": "<compact JWS>", // the SIGNED artifact, verbatim
  "trustJws": "<compact JWS>", // the SIGNED trust manifest, verbatim
  "etag": "...", // non-security hint
  "lastSyncUnauthorized": false, // fail-CLOSED hint only
  "blocked": null, // fail-CLOSED hint only
}
```

**Removed:** `doc`, `trustedKeys`, `lastAcceptedIssuedAt`, `lastTrustIssuedAt`, `lastVerifiedAt`.
Every one was an unsigned field that security decisions read.

### 4.2 On load

1. Re-verify `trustJws` against the **pinned** keys only. On failure, discard it and fall back to
   pins alone — never to whatever the file claimed.
2. Build the trust set per §1.
3. Re-verify `configJws` against that trust set, with full §3 claim checks.
4. **Derive** `lastAcceptedIssuedAt := verifiedDoc.issuedAt` and
   `lastTrustIssuedAt := verifiedManifest.issuedAt`. They are never read from disk.
5. Any failure ⇒ treat as no cache ⇒ `needs-activation`. Fail closed, never fall back to a
   partially-trusted state.

`blocked` and `lastSyncUnauthorized` may remain unsigned: they only ever make the gate _stricter_,
so clearing them gains an attacker nothing they could not achieve by deleting the file.

### 4.3 Monotonic time floor

The gate MUST use `effectiveNow = max(systemClock, highWaterMark)`, where `highWaterMark` is
derived from re-verified signed content and never read from an unsigned field. This gives
clock-rollback resistance without requiring a trusted local clock, and costs nothing when the
clock is honest.

> **⚠ CORRECTION — as first drafted this clause was inert, and it is NOT yet fixed in code.**
>
> The draft derived `highWaterMark` from `configJws` alone. The Python engineer showed that is a
> no-op: with one cached document `highWaterMark === doc.issuedAt` by construction, and
> `graceUntil = issuedAt + maxOfflineDays × 86400` is _always_ greater. The floor therefore can
> never push `effectiveNow` past `graceUntil`, so rolling the clock back still extends grace
> indefinitely — precisely the attack (R4-04) the clause exists to stop. It does still prevent
> replaying an _older_ document, so it is not worthless; it simply does not do the job it was
> written for.
>
> **Correct design:** raise the mark from the **trust manifest's** `issuedAt` as well. The
> manifest is signed, skew-bounded, cached separately, and — unlike the polling timer —
> `trustRefresh` is **on by default**, so it advances independently of the config document. A
> client that verified a manifest yesterday cannot then credibly claim it is last month:
>
> ```
> highWaterMark = max(verifiedConfigDoc.issuedAt, verifiedTrustManifest.issuedAt)
> ```
>
> **Status: specified, not implemented.** The Python engineer implemented it, then reverted to
> stay in lockstep with Node rather than let one of five implementations diverge on a shared
> contract — the right call. Landing it means re-opening all four SDKs plus the corpus, so it is
> recorded here as the top follow-up rather than half-applied. Until it lands, treat
> clock-rollback protection as **absent**, not merely weak, and do not claim it in user-facing
> documentation.

---

## 5. ETag (R2-11)

`computeETag` MUST continue to exclude `issuedAt`/`expiresAt`/`graceUntil` — that part is right,
and it is what makes re-licensing detectable. The bug is on the **client**: a `304` MUST be treated
as _"content unchanged, freshness renewed"_. On `304` the client MUST re-request a full document
when `now > expiresAt - REFRESH_MARGIN`, and MUST NOT allow a continuously-online client to drift
into `grace`. Conditional requests were an optimisation; they must not become a lockout timer for
paying customers.

---

## 6. Conformance corpus additions (mandatory)

R2-16 found the corpus covers **none** of the divergences above. New cases, each of which every
runner must agree on:

| Case                                                      | Expect                                   |
| --------------------------------------------------------- | ---------------------------------------- |
| `header-oversized`                                        | reject (8 MiB header)                    |
| `payload-at-cap` / `payload-over-cap`                     | accept / reject                          |
| `duplicate-key-header-alg` (`alg` twice: `none`, `EdDSA`) | **reject** in all languages              |
| `duplicate-key-payload`                                   | reject                                   |
| `sig-out-of-alphabet` (`***`, `\n`, `====`)               | reject (Python currently accepts)        |
| `valid-non-ascii-payload`                                 | identical signed bytes across signers    |
| `typ-missing` / `typ-wrong`                               | reject                                   |
| `trust-manifest-as-config`                                | reject (cross-protocol)                  |
| `key-status-revoked`                                      | reject                                   |
| `doc-expired`                                             | reject at verify, not merely at the gate |
| `iss-mismatch`                                            | reject                                   |
| `issued-far-future`                                       | reject                                   |

---

## 7. Rollout

The wire format changes (`typ`, explicit `revoked`), so this is a genuine version step.

1. **Worker first** — emit `typ` and explicit `revoked` entries; keep accepting v1 input.
2. **Verifiers accept both** for one release: `typ` absent ⇒ treat as `pkey-config+jws` when the
   call site expects a config doc. All other v2 rules (caps, duplicate rejection, strict base64,
   claim checks, cache format) apply **immediately** — they are strictly rejections of things that
   were never legitimate.
3. **Cache migration:** a `v:1` cache record is discarded, not migrated. The client re-fetches. A
   one-network-round-trip cost is the correct price for not carrying poisoned state forward.
4. **Require `typ`** in the following release.

Steps 1 and 2 ship together; a client that prunes revoked keys before the server emits them would
lose keys on every refresh.
