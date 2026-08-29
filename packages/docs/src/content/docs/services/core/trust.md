---
title: "Trust and signing"
description: "Per-product Ed25519 keys, JWKS, the signed trust manifest, pinned-key verification, replace-not-merge revocation, and why Core owns refresh scheduling."
sidebar:
  order: 4
---

Every product has its own Ed25519 keypair. The private half is envelope-encrypted at rest in D1
under the platform **KEK** (a single worker secret) and never leaves the worker. The public half
is published two ways, and only one of them is a trust root.

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
    },
  ],
}
```

`TRUST_CACHE_SECONDS` is **300**, and it sets three things at once: the manifest's own lifetime,
the advertised `cacheSeconds`, and the HTTP `max-age`. `jwksUrl` is built from the origin the
request actually arrived on, so the manifest advertises the host it was fetched from, while
`iss` is the fixed `key.plrs.im` string and is never derived from the host.

`typ` is mandatory in v3. One product key signs the license document, the config document, and
the trust manifest, so `typ` is the only thing standing between them — without it a config
document could be replayed into a call site expecting a license document and verify perfectly.
An untyped manifest is rejected outright, which means the signing side had to start emitting it
too.

The same signing function produces the manifest embedded inside an offline bundle, so the served
artifact and the bundled one cannot drift in shape.

### Which keys are published

The manifest is built from the product's verification keys — `active`, `staged`, and `retired`,
in that priority order. `retired` and `staged` keys are trusted for **verification**; only the
active key signs.

:::caution
Revoked keys are filtered out of the query entirely, so this worker's manifest never carries a
`status: "revoked"` entry. Revocation reaches clients as **absence** (see below), not as an
explicit prune signal. The wire contract (§2.3) describes servers emitting revoked keys
explicitly for at least `2 × cacheSeconds`; the client honours such entries if it sees them, but
this server does not produce them.
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

One function turns a document into a compact JWS under a product's active key, and every
minting surface goes through it rather than reaching for the JWS library directly. That is what
keeps a single call site to audit when the envelope changes. The encoding itself is frozen and
pinned by the conformance corpus; the per-product `kid` and key are what scope a signed document
to one tenant.

## See also

- [Discovery](/docs/services/core/discovery/) — where `pinnedKeys` appears in an **unsigned**
  document, and why that is a hint rather than a trust root.
- [The device principal](/docs/services/core/device-principal/) — the credential the document
  routes authenticate with.
- [License](/docs/services/license/) and [Config](/docs/services/config/) — the two signed
  documents this key set verifies.
