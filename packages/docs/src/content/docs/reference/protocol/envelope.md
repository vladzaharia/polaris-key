---
title: "The envelope"
description: "Compact EdDSA JWS mechanics, size caps, strict decoding, the verify-before-parse order, the shared claims, and the two validation profiles."
sidebar:
  order: 6
---

Every Polaris Key artifact is a **compact JWS signed with Ed25519**. Three base64url segments,
two dots, no exceptions:

```
signingInput = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
signature    = Ed25519 over the ASCII bytes of signingInput
compact JWS  = signingInput "." base64url(signature)
```

The signature is verified over the encoded segments **exactly as received**. The payload is
never re-serialised before verification, which is what makes the construction byte-stable
across every SDK, each with its own JSON writer.

Spec references on this page: §1 (JWS mechanics), §2 (the envelope), §3 (claim validation).
Implementation: `packages/shared-jws/src/index.ts` and `packages/client-core/src/verify.ts`.

## The protected header

```json
{ "alg": "EdDSA", "typ": "pkey-license+jws", "kid": "pkey-test-prod-2026" }
```

Three members, in a **fixed key order**: `alg`, then `typ`, then `kid`. Key order is part of
the frozen encoding because the signature covers the encoded header bytes — a signer that
emits the same three members in a different order produces a different artifact.

- `alg` is always `EdDSA` (Ed25519). It is asserted **before any signature math**, so a
  `none` or HMAC downgrade is refused before a key is even selected.
- `typ` is the domain separator. See below.
- `kid` selects the verification key from the **caller's** trust set. Never from the document,
  never from a URL the document names, never from the cache.

Nothing else belongs in the header. A legitimate header is roughly 60 bytes.

:::note[Header order, if you are writing a signer]
Spec §1 fixes the order as `alg`, `typ`, `kid` — the order `signJws` emits and every signed
vector in `conformance/corpus/v2/` pins. For example
`eyJhbGciOiJFZERTQSIsInR5cCI6InBrZXktbGljZW5zZStqd3MiLCJraWQiOiJwa2V5LXRlc3QtcHJvZC0yMDI2In0`
decodes to `alg`/`typ`/`kid`. An earlier draft of §1 listed `alg`, `kid`, `typ`; it never
matched a single artifact and has been corrected. The corpus is byte-level and is what four
runners assert against, so it is the check that settles the question either way.
:::

### `typ` is mandatory

Four values, one per artifact kind (spec §2):

| `typ`              | Payload                              |
| ------------------ | ------------------------------------ |
| `pkey-license+jws` | License document — grants            |
| `pkey-config+jws`  | Config document — config and secrets |
| `pkey-trust+jws`   | Trust manifest — the key set         |
| `pkey-bundle+jws`  | Offline activation bundle            |

Once a call site names the `typ` it expects, a header carrying a **different** one and a
header carrying **none** are both rejected. Tolerating absence would leave every untyped
artifact replayable at whichever call site an attacker prefers — that cross-protocol replay is
the entire reason the field exists. The corpus pins both refusals as `typ-missing-rejected`
and `typ-wrong`, plus `trust-manifest-as-license` for the replay itself.

## Size caps, checked before decoding

| Cap                | Value                 | Applies to                                              |
| ------------------ | --------------------- | ------------------------------------------------------- |
| `MAX_HEADER_BYTES` | 1 024 decoded bytes   | Every artifact, always                                  |
| `MAX_DOC_BYTES`    | 65 536 decoded bytes  | Every artifact except a bundle                          |
| `MAX_BUNDLE_BYTES` | 262 144 decoded bytes | `pkey-bundle+jws` only, passed explicitly by the caller |

Both caps are enforced **twice**: once against the _encoded_ segment length before anything is
decoded, and once against the decoded byte length before anything is parsed. The encoded
pre-check is the one that matters for denial of service — it means an oversized blob is never
allocated in the first place:

```ts
const b64Cap = (bytes: number): number => Math.ceil((bytes * 4) / 3) + 4;
if (encHeader.length > b64Cap(1024)) return null;
if (encPayload.length > b64Cap(maxPayloadBytes)) return null;
```

The header cap exists because without it the payload cap is trivially bypassed: move the blob
into the header instead. An 8 MiB header was decoded and JSON-parsed pre-verification before
this cap landed.

### The bundle exception can only raise

A bundle wraps up to three inner compact JWSs, so it gets 262 144 bytes instead of 65 536. The
raise travels with the `typ` and with an explicit caller-supplied option — and the option is
**raise-only**:

```ts
// effective cap = max(MAX_DOC_BYTES, requested)
```

A value _below_ the frozen 64 KiB default is inert rather than silently tightening one call
site out of step with the contract, and an absent or non-finite value is byte-identical to the
cap-less behaviour. The **header** cap is untouched by any `typ`; no artifact widens it.

The corpus pins all four boundaries: `payload-at-cap` / `payload-over-cap` and
`bundle-payload-at-cap` / `bundle-payload-over-cap`.

## Strict decoding

Two rules that look pedantic and are not — each of them is a case where SDKs disagreed about
which bytes are valid, which is the same as disagreeing about which documents are authentic.

**Strict base64url.** The unpadded `A–Z a–z 0–9 - _` alphabet and nothing else. `+`, `/`, `=`,
whitespace, and any other out-of-alphabet byte are rejected, not silently discarded. Python's
`urlsafe_b64decode(validate=False)` used to accept junk that Node and Swift refused, so one SDK
accepted wire bytes the others did not. Pinned as `base64url-payload-padding`,
`base64url-payload-trailing-data`, and the three `sig-out-of-alphabet-*` cases.

**Duplicate-key rejection**, in both the header and the payload. `JSON.parse` cannot help
here: it collapses duplicates before a reviver runs, and the languages disagree about which
one wins — TypeScript and Python keep the last, Swift's `JSONSerialization` keeps the first.
A header declaring `alg` twice (`none`, then `EdDSA`) therefore reads as `EdDSA` in two
languages and `none` in a third: the algorithm-downgrade guard returning opposite answers per
language. The only safe resolution is to reject the artifact, so every implementation agrees.
Pinned as `duplicate-key-header-alg` and `duplicate-key-payload`.

## Verify before parse

The order of operations is normative. This is the sequence `verifyJws` runs, and every step
before the signature check is deliberately cheap and total:

1. **Split** into exactly three segments. Two or four segments is a refusal.
2. **Bound the encoded segments** against the caps above. Nothing has been decoded yet.
3. **Header only**: strict base64url decode, bound the decoded length, parse with
   duplicate-key rejection. A non-object header (`"x"`, `1`, `null`) fails here rather than on
   property access.
4. **Algorithm, type, key selection** — `alg === "EdDSA"`, the expected `typ`, and `kid`
   looked up in the caller's trust set. All of it before any signature math.
5. **Verify the signature** over the ASCII bytes of `encHeader + "." + encPayload`.
6. **Only now** decode and parse the payload.

Everything after step 5 operates on authenticated bytes. Before this ordering landed, every
caller JSON-parsed attacker-controlled payloads for free; Swift already had it, TypeScript and
Python did not.

Two consequences worth internalising when you port this:

- **Failure is `null`, never an exception.** A malformed artifact, an unknown `kid`, a wrong
  `alg`, a WebCrypto rejection and a bad signature all produce the same "not a document"
  answer, so every call site fails closed identically.
- **The key comes from the caller.** `kid` is a _selector_ into a trust set the caller owns —
  see [Trust](/docs/build/wire/trust/). A document that names a key nobody trusts is simply
  not a document.

## The shared claims

License and config documents carry the same envelope (spec §2):

```jsonc
{
  "iss": "key.plrs.im", // FIXED string, never derived from the base URL
  "aud": "<product-slug>", // the product this document is scoped to
  "deviceId": "<32-char base64url device id>",
  "issuedAt": 1756252800, // unix SECONDS, never millis
  "expiresAt": 1756256400, // issuedAt + DOC_EXPIRY_SECONDS on the online path
  "graceUntil": 1758844800, // issuedAt + maxOfflineDays * SECONDS_PER_DAY
}
```

On top of that each type adds its own claims — `licenseId` / `profile` / `entitlements` for
`pkey-license+jws` (§2.1), `schemaVersion` / `config` / `secrets` for `pkey-config+jws`
(§2.2). The config document contains **no license fields**: a product with config enabled and
license disabled issues these to any registered device, which is the wire-level guarantee of
service independence.

Times are epoch **seconds** everywhere, matching the JOSE world the Worker signs in.

### Always enforced, on both profiles

These checks run on the network path and the cache-reload path alike, for both document types
(spec §3):

- `typ` matches the caller's expectation.
- `iss === "key.plrs.im"`.
- `aud` equals the configured product slug.
- `deviceId` equals the local device id.
- `issuedAt`, `expiresAt`, `graceUntil` are all numbers.
- `graceUntil >= expiresAt`.
- `graceUntil <= issuedAt + MAX_GRACE_SECONDS` — a hostile signer cannot grant a century of
  offline grace, and the ceiling bites at **verify** time, not only in the gate.
- **Anti-replay floor, per type**: a document whose `issuedAt` is not strictly greater than
  the currently-accepted document of the same type is rejected. License and config carry
  independent floors, and the floor is _derived_ from the document currently held — never read
  from a counter on disk.

## Constants

All normative, all identical in every implementation.

| Constant                 | Value        | Meaning                                                          |
| ------------------------ | ------------ | ---------------------------------------------------------------- |
| `DOC_EXPIRY_SECONDS`     | `3600`       | Signed-document lifetime on the online path — one hour           |
| `CLOCK_SKEW_SECONDS`     | `300`        | Tolerance applied to every clock comparison — five minutes       |
| `MAX_GRACE_SECONDS`      | `31 536 000` | Ceiling on a signed offline window — 365 days                    |
| `REFRESH_MARGIN_SECONDS` | `1800`       | Half-life at which a `304` escalates to an unconditional refetch |
| `SECONDS_PER_DAY`        | `86 400`     | The unit `maxOfflineDays` and `graceDays` multiply by            |

`CLOCK_SKEW_SECONDS` exists because v1 had no tolerance anywhere: a device 61 minutes fast
flipped a freshly-signed document straight into `grace`.

`REFRESH_MARGIN_SECONDS` is half of `DOC_EXPIRY_SECONDS`, and it fixes a subtler failure. The
`ETag` deliberately excludes `issuedAt`/`expiresAt`/`graceUntil`, so a content-stable document
returns `304` forever; left alone, a continuously online, continuously authenticated client
coasts into `grace` at `expiresAt` and `expired` at `graceUntil` behind an unchanged validator.
So on a `304`, when `effectiveNow > expiresAt - REFRESH_MARGIN_SECONDS`, the client re-asks
**unconditionally** and the server re-signs the window. In v3 this rule applies **per
document** — license and config carry independent ETags (spec §5).

## The two validation profiles

One flag, `checkFreshness`, selects between them (spec §3). Everything in "always enforced"
above runs either way; only the freshness window differs.

```ts
// network path — the default
if (doc.issuedAt > now + CLOCK_SKEW_SECONDS) return null;
if (doc.expiresAt <= now - CLOCK_SKEW_SECONDS) return null;
```

| Profile     | `checkFreshness` | Used for                                                                                                                                   | Why                                                                                                                                                                                                      |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network** | `true`           | A document that just arrived from `/license/document`, `/config/document` or the trust manifest route; a **bundle's own claims** at import | A stale or future-dated document must never enter the cache. A stale bundle file must be refused.                                                                                                        |
| **Reload**  | `false`          | Cache reload; the trust manifest _inside_ a bundle; each inner document of a bundle                                                        | A cached document is _expected_ to be past its one-hour `expiresAt` — that is what offline operation is. Its signed outer bound is `graceUntil`, enforced by the gate against the monotonic clock floor. |

Asserting `expiresAt` on the reload path would delete offline grace outright. Conversely,
skipping it on the network path lets a replayed expired document install itself. The corpus
pins both directions per document type: `license-expired` (network, reject) alongside
`license-expired-reload-path` (reload, accept), and the same pair for config.

The skew tolerance shows up in the corpus as the near-miss cases —
`license-expired-within-skew` and `license-issued-future-within-skew` accept, while
`license-expired` and `license-issued-far-future` reject.

:::note[Freshness is not the grace bound]
`expiresAt` answers "should I refetch?". `graceUntil` answers "may this install still run?".
They are separate questions with separate enforcement points: `expiresAt` in the verifier on
the network path, `graceUntil` in the gate against `effectiveNow`. Stretching `expiresAt` to
cover an offline window — instead of stretching `graceUntil` — produces a document that passes
_network_ freshness for the whole window, which is exactly what a replay wants.
:::

## Where to go next

- [Trust](/docs/build/wire/trust/) — where the `kid` lookup set comes from, and how a key is
  revoked.
- [Cache and clock](/docs/build/wire/cache-and-clock/) — what `now` actually is once the
  monotonic floor is applied.
- [The conformance corpus](/docs/build/wire/corpus/) — the 36 raw-JWS vectors and 34 document
  vectors that pin everything on this page.
