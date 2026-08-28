---
title: "Trust"
description: "Two tiers of verification keys: compiled-in pins that are terminal, and a signed manifest verified only against them. Absence is revocation."
sidebar:
  order: 7
---

A verifier holds exactly **two tiers** of key material, in strictly decreasing authority, and
nothing else (spec §1):

1. **Pinned keys** — compiled into the host application. **Terminal.**
2. **Manifest keys** — learned only from a verified `pkey-trust+jws`, replaced wholesale on
   every refresh.

The on-disk cache is **never** a key source. It persists the manifest's compact JWS, never a
bare `kid → key` map, so a file write can neither add a `kid` nor swap the bytes behind one.

```ts
export type TrustSet = Record<string, string>; // kid → base64url(raw 32-byte Ed25519 pubkey)
```

Implementation: `packages/client-core/src/trust.ts`. Server side:
`packages/worker/src/core/trust.ts`.

## Tier 1: pins are terminal

The merge is one line, and the order of the spread is the whole rule:

```ts
export function mergeTrust(pinned: TrustSet, discovered: TrustSet): TrustSet {
  return { ...discovered, ...pinned }; // pins spread LAST
}
```

Pins spread last, so a manifest can never shadow one. Reversing those two spreads is the whole
of finding R2-01: one line, and a planted manifest entry replaced the key bytes behind a `kid`
the application had explicitly pinned in its own source.

Your application ships its pins. They are the root of everything below.

## Tier 2: the signed trust manifest

The manifest exists so a product can rotate signing keys without shipping a new build. It is
fetched from:

```
GET /<product>/.well-known/polaris-trust.jws     →  application/jose
```

Unauthenticated — it publishes public keys, and it is worthless to anyone who cannot verify it
against pins they already hold.

```jsonc
{
  "schemaVersion": 1,
  "aud": "<product-slug>",
  "iss": "key.plrs.im",
  "issuedAt": 1756252800,
  "expiresAt": 1756253100,
  "jwksUrl": "https://key.plrs.im/<product>/.well-known/jwks.json",
  "cacheSeconds": 300,
  "keys": [
    {
      "kid": "…",
      "alg": "EdDSA",
      "kty": "OKP",
      "crv": "Ed25519",
      "publicKey": "<base64url raw 32-byte key>",
      "status": "active",
    },
  ],
}
```

`jwksUrl` points at the same product's `GET /<product>/.well-known/jwks.json`, which serves the
same keys as unsigned JWKS. That endpoint is a convenience for tooling. **Clients do not learn
keys from it** — an unsigned key list cannot be a key source.

### Verified against pins only. Always.

A trust manifest is verified against the **pinned** set, never against the effective (merged)
set, on **both** the network path and the cache-reload path.

Two reasons, and both matter:

- Verifying against the effective set makes poisoning self-sustaining. A single planted key
  could sign a manifest minting further keys, which could sign the next one.
- Online and offline verification stay identical. Anything installed from the network still
  verifies after a restart, when only the pins are available.

Everything else in the envelope still applies: signature, `typ: "pkey-trust+jws"`, `aud`,
`iss`, and the size caps. On top of those, a manifest must satisfy:

| Check                                                                 | Behaviour on failure                       |
| --------------------------------------------------------------------- | ------------------------------------------ |
| `schemaVersion` in the supported set (currently `1` only)             | Reject the manifest — unknown fails closed |
| `aud` equals the configured product                                   | Reject                                     |
| `iss === "key.plrs.im"`                                               | Reject                                     |
| `issuedAt` / `expiresAt` are numbers                                  | Reject                                     |
| `issuedAt` strictly newer than the last verified manifest             | Reject — anti-rollback                     |
| Freshness, on the network path only                                   | Reject                                     |
| `keys` is an array of objects, each with string `kid` and `publicKey` | Reject                                     |

The anti-rollback floor is derived from the manifest this client last verified in memory, never
from a counter on disk. `lastTrustIssuedAt` used to be an attacker-writable JSON field.

## Revocation: absence is the mechanism

On every successful verification the **discovered set is replaced wholesale**. It is not merged
into, not unioned with, not diffed against the previous one:

```
discovered := { every non-revoked, Ed25519 key this manifest publishes }
```

That single sentence is what restores the server's ability to revoke. A `kid` that simply
disappears from a newer manifest is gone from the client on the next refresh. There is no
"remove" operation on the wire because there does not need to be one.

The `status` field layers a positive signal on top of it:

| `status`  | Effect on the client                                                                |
| --------- | ----------------------------------------------------------------------------------- |
| `active`  | Trusted for verification                                                            |
| `staged`  | Trusted for verification — a key being rotated _in_ must be trusted before it signs |
| `retired` | Trusted for verification — documents signed by it are still in caches               |
| `revoked` | **Dropped.** Never enters the discovered set                                        |

The contract asks the server to keep emitting explicitly `revoked` entries for at least
`2 × cacheSeconds` after a revocation, so a client that refreshes on its cache cadence receives
a positive prune signal rather than only an absence (spec §2.3). A client must nonetheless
**not depend on ever seeing one** — wholesale replacement already prunes an absent key, and
that is the guarantee the contract rests on.

Two more rules on the key list:

- **Substitution is fatal to the whole manifest.** A manifest presenting a **pinned** `kid`
  with **different** key bytes is a substitution attempt: the entire manifest is rejected and
  the previous trust set is kept. Not "that entry is ignored" — the whole document is refused,
  because a signer trying that is not a signer you take the rest of the list from. A pinned
  `kid` with _identical_ bytes is fine and common.
- **An unknown algorithm is skipped, not fatal.** An entry that is not
  `alg: "EdDSA"` / `kty: "OKP"` / `crv: "Ed25519"` is skipped and the rest of the manifest is
  honoured. A future-alg key appearing in the list must not brick current verifiers.

## Freshness, and the stale cached manifest

The manifest's `expiresAt` is minutes away by design (`cacheSeconds` is 300 today, and
`expiresAt = issuedAt + cacheSeconds`). On the network path that window is enforced. On the
**reload** path it is not:

- A cached manifest is loaded with `checkFreshness: false`. Refusing a stale one would strand
  every offline client that has rotated keys — restart the app after a week offline and every
  document signed by a rotated key would suddenly fail.
- It still **raises the monotonic clock floor**. Its `issuedAt` is a signed lower bound on
  real time regardless of whether it may still publish keys; those are unrelated questions.
  See [Cache and clock](/docs/build/wire/cache-and-clock/).

Do not re-introduce freshness checking on the reload path to justify the floor. The corpus pins
both halves: `trust-expired-manifest` (network, reject), `trust-expired-manifest-reload-path`
(reload, accept), and `floor-stale-cached-manifest-still-yields-its-keys`.

## Trust refresh belongs to Core

Refreshing the manifest is **not** a side effect of any one service's document fetch. Core
refreshes it on its own cadence, before and independently of whichever documents a given
product happens to fetch (spec §4.2).

This is not tidiness. In v2 the floor rode the `/config` fetch, which meant a product that did
not run the Config service had no independently-advancing signed clock at all. In v3 a product
with **any** service enabled still advances one, because trust is a Core capability that is
always on.

## What a client actually does

```
on load:      pins  →  verify cached trustJws against pins (freshness off)  →  effective set
on refresh:   pins  →  fetch + verify manifest against pins (freshness on)  →  effective set
on document:  verify the document against the EFFECTIVE set
on bundle:    verify the bundle and its inner manifest against PINS only
```

The effective set is `mergeTrust(pinned, discovered)`, recomputed rather than stored. A failed
manifest is treated as absent and the client falls back to **pins alone** — never to whatever
the file claimed.

## Corpus coverage

Eleven `trustCases` vectors pin this page, each of them a rule above:

| Case                                        | Rule                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| `trust-learn-rotated-key`                   | A verified manifest extends the set                      |
| `key-status-revoked`                        | Revoked keys never enter the set                         |
| `key-status-retired-and-staged-are-trusted` | Rotation in and out both keep verifying                  |
| `trust-prune-on-absence`                    | Absence is revocation                                    |
| `trust-prune-to-pins-only`                  | Replacement is wholesale, down to the pins               |
| `trust-pinned-substitution`                 | A pinned `kid` with different bytes rejects the manifest |
| `trust-pinned-kid-same-bytes`               | Identical bytes are fine                                 |
| `trust-signed-by-non-pinned-key`            | Manifests verify against pins only                       |
| `trust-aud-mismatch`                        | Product scoping                                          |
| `trust-expired-manifest` / `…-reload-path`  | The two freshness profiles                               |

Counts and families for the whole corpus are at
[Conformance corpus v2](/docs/reference/corpus/).
