---
title: "Trust and signing"
description: "Per-product Ed25519 keys, JWKS, the signed trust manifest, pinned-key verification, replace-not-merge revocation, and why Core owns refresh scheduling."
sidebar:
  order: 4
---

Every product has its own Ed25519 keys. Every private half is envelope-encrypted at rest in D1
under the platform **KEK** (a single worker secret) and never leaves the worker. The public
halves are published two ways, and only one of them is a trust root.

## The two tiers

A verifier holds exactly two tiers of keys, in strictly decreasing authority, and nothing else:

1. **Pinned keys** — a `kid → base64url(raw Ed25519 public key)` map compiled into the host
   application. Terminal.
2. **Manifest keys** — learned only from a verified trust manifest (`pkey-trust+jws`).

They merge with the pins spread **last**:

```ts
mergeTrust(pinned, discovered) === { ...discovered, ...pinned };
```

so a manifest can never shadow a pin. Spreading these the other way round was a real
vulnerability: one planted entry replaced the key bytes behind a kid the application had
explicitly pinned in source.

The on-disk cache is **never** a key source. It persists the manifest's compact JWS, never bare
`kid → key` JSON, so a file write can neither add a kid nor swap the bytes behind one.

## Two key classes: the anchor and the document keys

A product's keys are split by **purpose**, and the split is what keeps a key rotation an
operation rather than an application release.

| Class        | Signs                                                    | Rotation cadence             | Pinned by clients |
| ------------ | -------------------------------------------------------- | ---------------------------- | ----------------- |
| **anchor**   | `pkey-trust+jws` — the trust manifest, and nothing else  | Rare; an application release | **Yes**           |
| **document** | `pkey-license+jws`, `pkey-config+jws`, `pkey-bundle+jws` | Freely, on operator cadence  | No                |

A product has at most one active key of each class. The anchor is published in the manifest and
in JWKS like any other verification key — what makes it the anchor is that it is the key host
applications **pin**, and the only key the server will use to sign a manifest.

The split exists because manifests verify against pins only. Before it, the manifest was signed
by the same active key that signed documents, so the first document-key rotation made every
already-installed client reject every subsequent manifest: trust refresh died, the clock floor
stopped advancing, and — worst of the three — revocation died, for exactly the population a
compromise needs to reach. With the split, rotating a document key changes nothing a client
verifies a manifest with.

**The two classes are roles, not necessarily two keys.** For a product that predates the split,
one key holds both roles, because that is the key deployed clients already pin; it signs its
documents with its anchor until the first document-key rotation separates them. This is a
server-side detail and changes nothing a verifier does — a client must never reject a document
because its `kid` happens to match the pinned anchor.

Manifest entries may carry `role: "anchor" | "document"`, and it is **advisory only**. No
verifier may use it in any verification decision — not to decide what may sign a manifest, not
to prune. A verifier that let the manifest's own `role` field decide what may sign a manifest
would be letting the manifest introduce the key that verifies it, which is the pinned-shadowing
vulnerability through a new door. The property is enforced structurally instead: only the anchor
is pinned, and manifests verify against pins only.

Operator-side rotation procedure lives in
[Secrets and keys](/docs/admin/secrets-and-keys/).

## `GET /<p>/.well-known/jwks.json`

The product's public key set in ordinary JWKS shape — one entry per verification key, each
`kty: "OKP"`, `crv: "Ed25519"`, `use: "sig"`, `alg: "EdDSA"`, with `kid` and `x`. Served with
`cache-control: public, max-age=300`.

This exists so SDKs can _optionally_ discover keys during rotation. It is unsigned, so it is a
convenience, not an authority: clients still pin a trust set by default, and nothing in the
verification path treats a JWKS response as a key source.

## `GET /<p>/.well-known/polaris-trust.jws`

The signed trust manifest — `typ: "pkey-trust+jws"`, `content-type: application/jose`, served
with `cache-control: public, max-age=300`. Its payload:

```jsonc
{
  "schemaVersion": 1,
  "aud": "<product-slug>",
  "iss": "key.plrs.im",
  "issuedAt": 1756252800,
  "expiresAt": 1756253100, // issuedAt + TRUST_CACHE_SECONDS
  "jwksUrl": "https://<host>/<product>/.well-known/jwks.json",
  "cacheSeconds": 300,
  "keys": [
    {
      "kid": "…",
      "alg": "EdDSA",
      "kty": "OKP",
      "crv": "Ed25519",
      "publicKey": "…",
      "status": "active",
      "role": "anchor", // advisory; never an input to a verification decision
    },
  ],
}
```

`TRUST_CACHE_SECONDS` is **300**, and it sets three things at once: the manifest's own lifetime,
the advertised `cacheSeconds`, and the HTTP `max-age`. `jwksUrl` is built from the origin the
request actually arrived on, so the manifest advertises the host it was fetched from, while
`iss` is the fixed `key.plrs.im` string and is never derived from the host.

`typ` is mandatory in v3. The key classes above separate the manifest from the documents by
_purpose_, but they do not separate the documents from each other, and for a product that has
not yet rotated a document key one key still signs all three — so `typ` is the only thing
standing between them. Without it a config document could be replayed into a call site
expecting a license document and verify perfectly. An untyped manifest is rejected outright,
which means the signing side had to start emitting it too.

The same signing function produces the manifest embedded inside an offline bundle, so the served
artifact and the bundled one cannot drift in shape.

### Which keys are published

The manifest is built from the product's verification keys — `active`, `staged`, and `retired`,
in that priority order. `retired` and `staged` keys are trusted for **verification**; only the
two active keys sign, each within its own class.

**Plus recently revoked keys, deliberately.** `loadPublicSigningKeys` is called with
`now − 2 × TRUST_CACHE_SECONDS`, so the manifest also lists every key revoked inside that
window, carrying `status: "revoked"`. Every client that could still be holding such a key
cached therefore reads a **positive removal signal** rather than having to infer one from
absence — which matters because 2× the cache window is long enough that any client refreshing
on schedule sees at least one manifest naming the revoked kid. Once a revocation ages out of
the window the entry disappears and absence takes over, which the replace-wholesale merge
already handles identically. This is what the wire contract's §2.3 requires, and this worker
implements it: see `signTrustManifest` in `packages/worker/src/core/trust.ts`.

:::caution[A revoked key in the manifest is not a trusted key]
`status: "revoked"` entries appear in the manifest so clients can **prune** on them. A verifier
must drop them from the discovered set — never add them — and the check is deliberately ordered
_before_ the algorithm check so that a revoked entry is pruned whatever else is wrong with it.
The unsigned surfaces are different: JWKS and discovery build **trusted** key sets, so they omit
revoked keys entirely and never pass the revocation window.
:::

## How a manifest is verified

Always against **pinned keys only** — never against the effective (merged) set — on both the
network path and the cache-reload path, so online and offline verification are identical.
Verifying against the effective set was the amplifier in an earlier design: a single planted key
could sign a manifest minting further keys, and the poisoning became self-sustaining.

The checks, in order:

1. JWS signature against the pins, with `typ: "pkey-trust+jws"` required.
2. `schemaVersion` must be one this client understands — unknown fails closed.
3. `aud` equals the expected product; `iss` equals `key.plrs.im`.
4. `issuedAt` and `expiresAt` must be numbers.
5. **Anti-rollback**: a manifest whose `issuedAt` is not strictly greater than the last verified
   manifest's is rejected. The floor comes from the manifest currently held in memory, never from
   a disk counter — an attacker-writable JSON field is not a rollback defence.
6. **Freshness**, on the network path only: reject if `issuedAt` is more than the clock skew in
   the future, or if `expiresAt` has already passed by more than the skew. The reload path skips
   this, because a stale manifest is exactly what an offline client has, and refusing it would
   strand every offline client that has rotated keys.
7. Per key: a **pinned kid presented with different key bytes rejects the whole manifest** and
   keeps the previous trust set — that is a substitution attempt, not a partial error.
8. Entries with `status: "revoked"` are **dropped**. Entries that are not
   `alg: "EdDSA"` / `kty: "OKP"` / `crv: "Ed25519"` are **skipped, not fatal** — a future-algorithm
   key in the manifest must not brick current verifiers.

## Replace, never merge

The discovered set is **replaced wholesale** on every successful verification. It is not merged
into, not unioned with, and not diffed against the previous set.

That single rule is what makes revocation work: **absence is revocation**. A kid that simply
stops appearing in a newer manifest is gone from the discovered set on the next refresh. Pins are
unaffected — they are compiled in, terminal, and can only be withdrawn by shipping a new build.

The same rule governs cache reload. Trust is reset at the top of every load, so a reload can
never inherit keys the file no longer justifies, and a manifest that fails to re-verify is
treated as absent rather than as a reason to keep what it used to publish.

## Core owns refresh scheduling

Trust refresh is **not** a side effect of any single service's document fetch. In the client
sync loop it is step 3 — before the documents, independent of them, and gated only on a device
token existing:

```
1. no token            -> return, zero network calls
2. re-arm the single re-acquire budget
3. TRUST REFRESH       <- Core's own cadence
4. the ENABLED documents, in parallel
5. verify each against the effective set
6. ONE cache write
7. the floor rises from whatever verified
8. best-effort telemetry
```

Refresh errors are swallowed: a manifest that could not be fetched is a manifest the client
keeps, not a reason to fail the sync.

There are two reasons this scheduling is Core's, and both are structural.

**Any service mix must advance the clock.** The v2 design rode trust refresh on the `/config`
fetch, so a product that fetched no config advanced no signed clock. With five opt-in services
and products that legitimately run only one, coupling the independent clock to one service's
document makes the clock a function of which services a customer happened to buy.

**A document-only floor is provably inert.** The monotonic clock floor is:

```
highWaterMark = max(issuedAt of every currently-verified cached artifact)
effectiveNow  = max(systemClock, highWaterMark)
```

folded over the **whole** artifact set — license document, config document, and the trust
manifest. Fold it over documents alone and it can never bite, because `issuedAt < graceUntil`
always holds for a document: a clock wound back inside the document's own window still reads
`ok`, and the floor can never reach the end of grace. The trust manifest is the artifact that
makes the floor bite, precisely because it is short-lived and refreshed on a cadence nobody's
enablement set can switch off.

The conformance corpus pins the defective form as
`floor-config-doc-alone-does-not-stop-rollback` so it cannot silently return.

Only re-verified content may be folded in. A rejected artifact contributes nothing — otherwise
planting a file would become a way to force every client to `expired`. And the floor is a
minimum, never a substitute: with an honest clock ahead of every signed artifact,
`effectiveNow` is the system clock unchanged, so the floor costs nothing when the clock is
truthful.

Even a **stale** manifest raises the floor. Its signature, `aud`/`iss`/`typ` binding, and the
pinned-substitution guard all still apply, and a stale manifest is still a signed lower bound on
real time — independent of whether it may still publish keys.

## Signing

One function turns a document into a compact JWS under a product's active **document** key, and
every document-minting surface goes through it rather than reaching for the JWS library
directly. That is what keeps a single call site to audit when the envelope changes. The
encoding itself is frozen and pinned by the conformance corpus; the per-product `kid` and key
are what scope a signed document to one tenant.

The trust manifest is the exception, and it is the exception on purpose: `signTrustManifest`
signs with the product's **anchor** key and its anchor `kid`. Signing a manifest with the
rotating document key is precisely the defect the two-class split fixed — clients verify
manifests against pins only, so a manifest signed by a key that moved on rotation is a manifest
no installed client can accept.

## See also

- [Discovery](/docs/services/core/discovery/) — where `pinnedKeys` appears in an **unsigned**
  document, and why that is a hint rather than a trust root.
- [The device principal](/docs/services/core/device-principal/) — the credential the document
  routes authenticate with.
- [License](/docs/services/license/) and [Config](/docs/services/config/) — the two signed
  documents this key set verifies.
