---
title: "The license document"
description: "The pkey-license+jws document: its envelope, the entitlement map, the content-only ETag, and the build gate that lives on this route."
sidebar:
  order: 5
---

The license document is the signed statement of what a seat grants. It is the **only** carrier of
grant data in the system: the config document carries settings and secrets and no license fields
at all, which is the wire-level guarantee that a product can take either service without the
other.

## `GET /<product>/license/document`

```http
GET /djdl/license/document
Authorization: Bearer pkeyt_…
X-PKey-Version: 2.4.1
X-PKey-Channel: stable
If-None-Match: "8Kq…"
```

```http
HTTP/1.1 200 OK
Content-Type: application/jwt
ETag: "8Kq…"
Cache-Control: no-store
```

The body is a compact JWS with JOSE `typ` of `pkey-license+jws`, signed by the product's own
Ed25519 key. `typ` is domain separation, not decoration — a verifier that is handed a config
document, a trust manifest or a bundle under this expectation rejects it, and an unknown or
missing `typ` is rejected outright.

The route requires a live device token whose **license is usable**. That is stricter than the
config document, which needs only a live device: this route hands out a grant, so a dead license
must not be able to mint one.

:::note[This route speaks the nested error shape]
`GET /license/document` answers wire-v3 nested bodies — `{"error":{"code":"unauthorized"}}` —
while the activation routes still answer the flat v2 shape (`{"error":"device_limit"}`). The two
co-exist on purpose: handlers that moved into the suite without changing their body kept theirs
byte-identical, and the surfaces v3 introduced speak the nested shape from their first request.
:::

## What the handler does, in order

1. **Method.** Not `GET` is `405`.
2. **Authenticate.** Validate the `pkeyt_` token and require the license behind it to be usable.
   Failure is `401` — the same `401` for a bad token and for a dead license, so a stolen token
   cannot be used to probe license state.
3. **Touch the device.** `last_seen` is stamped and the request's client metadata headers are
   folded into the device row. Both document routes do this, so whichever services a product
   runs, a device that is talking to the server is recorded as seen.
4. **Resolve entitlements.** Merge every stored layer for this license and device, then stamp
   admin and tier policy on top as enforced entries.
5. **Run the build gate.** Refuse the request with `403` if this build may not hold a grant. See
   below.
6. **Build the document**, compute its ETag, answer `304` if the caller's `If-None-Match`
   matches, otherwise sign and return.

## The payload

```jsonc
{
  // the shared envelope (identical on the config document)
  "iss": "key.plrs.im",
  "aud": "djdl",
  "deviceId": "7Yb2Qh8sK1nR4tV9wX3zA6cD0eF5gH7j",
  "issuedAt": 1756252800,
  "expiresAt": 1756256400,
  "graceUntil": 1758844800,

  // the license half
  "licenseId": "lic_…",
  "profile": {
    "name": "Ada Lovelace",
    "firstName": "Ada",
    "email": "ada@example.com",
    "activatedAt": 1750000000,
  },
  "entitlements": {
    "…": { "state": "enforced", "value": "…", "updatedAt": 0 },
  },
}
```

### The envelope

| Claim        | Value                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `iss`        | A **fixed** string, never derived from the request's base URL.                                                        |
| `aud`        | The product slug. Product isolation is structural: every read is product-scoped and the signing key is the product's. |
| `deviceId`   | The device the token belongs to. A client rejects a document minted for another device.                               |
| `issuedAt`   | Issue time, in unix seconds.                                                                                          |
| `expiresAt`  | `issuedAt` plus the document TTL — one hour, on the online path.                                                      |
| `graceUntil` | `issuedAt` plus `maxOfflineDays × 86400`, where `maxOfflineDays` is the license's override or the product default.    |

The short `expiresAt` and the long `graceUntil` are two different clocks. `expiresAt` governs
whether a freshly-fetched document is acceptable; `graceUntil` governs how long an _offline_
install keeps running. A verifier enforces a 365-day ceiling on grace at verify time, not merely
in the gate, so a hostile signer cannot grant a century of it.

### `profile`

The signed greeting block — name, first name, email, activation time — so a client can render a
personalised, tamper-proof welcome with no network. It tolerates an anonymous license (a keyless
[enrollment](/docs/services/license/enrollment/)) by rendering empty strings rather than
special-casing the document shape.

This is `DocProfile`, and it is **not** the reusable managed-payload profile a tier attaches.

### `entitlements`

Catalog-declared `flag` entries, plus the policy the server injects as **enforced** entries:

| Key                 | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `license.tier`      | The license's tier id. Absent when the license has no tier.          |
| `license.tierLabel` | The tier's human label, when it has one.                             |
| `channels`          | The union of the tier's and the license's entitled release channels. |
| `app.minVersion`    | The tighter (higher) of the tier's and the license's minimum.        |
| `app.maxVersion`    | The tighter (lower) of the tier's and the license's maximum.         |
| `deviceLimit`       | The tier's seat count. The same number the seat check enforces.      |

Every injected entry is `state: "enforced"` and carries `updatedAt` from the license row's
`modified_at`, which is what makes [re-licensing](/docs/services/license/relicensing/) detectable
without changing the document's shape.

The document carries **no secret material**. Entitlements are never sealed, which is the
wire-level reason this document can be handed to a build gate without decrypting anything.
Managed secrets ride the config document instead.

### What is deliberately absent

**License state is never in the document.** There is no `status`, no `ok`, no `grace`, no
`expired` field. The client's gate derives the state from the verified document, its clock, and
two unsigned local hints that can only _tighten_ the outcome:

`ok` · `grace` · `expired` · `revoked` · `needs-activation` · `version-too-old` ·
`version-too-new` · `channel-not-entitled` · `not-applicable`

`not-applicable` is what a product that does not enable License returns, and it counts as usable
— so a config-only or release-only product boots working rather than claiming it needs an
activation it will never have.

## The ETag

The ETag is **strong** and computed over document **content only**:

```text
tag := sha256( { iss, aud, deviceId, licenseId, profile, entitlements } )
```

The three per-request timestamps — `issuedAt`, `expiresAt`, `graceUntil` — are excluded, so an
unchanged license collapses to the same tag on every request and the client's `If-None-Match`
gets a `304`. A differing tag therefore means the **content** genuinely differs, which is exactly
the signal an SDK's change callback fires on.

`test/relicense.test.ts` pins both directions: the tag changes when a tier changes, and it stays
stable across two fetches when nothing changed.

Tags are **per document** by construction. The license and config documents carry independent
tags, so a config edit no longer forces a license re-download and vice versa.

A `304` carries the `etag` header and no body. Per wire contract §5, a client that receives one
and finds itself within the refresh margin — half an hour before `expiresAt` — refetches
unconditionally rather than trusting the `304`, because the document it holds is about to age
out.

## The build gate

Channel and version enforcement lives on **this route** and on identity's
`GET /<product>/identity/session`, and nowhere else.

### Why here

It has to be somewhere a grant is being handed out, because the version window and the entitled
channel set _are_ grants — they arrive as enforced entitlements on this very document.

Putting it on the config document instead would mean a build outside its window could not read
its settings, which is a **support incident** rather than a security control. The point of
blocking an out-of-window build is to stop it _claiming a license_, not to blind it.

### The refusal

```jsonc
// 403, Content-Type: application/json, Cache-Control: no-store
{
  "error": { "code": "version_blocked", "reason": "version-too-old" },
  "allowedRange": { "min": "2.0.0", "max": "3.4.9" },
}
```

`allowedRange` sits at the **top level**, beside `error` rather than inside it — that is where
the contract puts it. `code` collapses the two version outcomes into `version_blocked`, and
`reason` rides alongside so a client can still tell too-old from too-new and render the right
sentence. A channel refusal uses code `channel_not_allowed`.

The three reasons are `version-too-old`, `version-too-new`, and `channel-not-entitled`. A client
turns them into a gate state **without needing a document at all**.

### How the decision is taken

Inputs are the `X-PKey-Version` header (defaulting to `0.0.0` when absent), the optional
`X-PKey-Channel` header, the resolved entitlements, and the product's own compatibility window.

1. **Dev-build bypass — opt-in only.** A `0.0.0-dev…` version short-circuits the whole gate
   _only_ if the license is positively entitled to the `dev` channel. It defaults to **off**.
   The gate accepts a per-product override too, but there is no `products` column feeding it
   today, so the channel entitlement is the live lever. The bypass used to fire on a version
   string the caller types into a header, which is a self-signed exemption.
2. **Version window.** The product's compatibility range intersected with the grant's own
   `app.minVersion` / `app.maxVersion`; **tighter wins in both directions**. Outside it, the
   refusal names `version-too-old` or `version-too-new` and returns the range. An unparseable
   version compares equal to everything, so a malformed version is never blocked on shape alone.
3. **Channel.** The channel the **build implies** always applies: `0.0.0-dev…` is `dev`,
   `0.0.0-beta…` and the legacy `0.0.0-staging…` are `beta`, `0.0.0-pr-42` (hyphen optional) is
   `pr-42`, everything else (including `2.0.0-beta.1`) is `stable`. A declared `X-PKey-Channel`
   header can only **add** a second channel to check, never replace the first — otherwise a
   pre-release build would simply declare `stable` and skip the entitlement check. The header is
   normalised: `latest` is `stable`, `staging` is `beta`, the literal `pr` is the build's own
   `pr-<n>`, and `pr42` is `pr-42`.
4. **Malformed declarations are refusals; unknown names must be granted.** A header outside the
   channel alphabet (`STAGING`, `Beta.2`) is `channel-not-entitled`. A well-formed name the gate
   does not know (`nightly`, `staging-2`) is checked as a grant of exactly that name, so it is
   never a free pass. Mapping the unknown onto `stable` — the one channel that is never
   entitlement-checked — once meant such headers skipped the check outright.
5. **`stable` is the floor** every license holds. A product that has never authored a `channels`
   entitlement still serves its shipping release to everybody. Otherwise the `channels` grant
   must name the channel, with two widenings: a `staging` grant also covers `beta`, and a `pr`
   grant covers every `pr-<n>`. The full vocabulary is WIRE-CONTRACT-V3 §5.1; see
   [channel](/docs/start/concepts/#core-nouns) in the glossary.

## Offline

A verified document is written to the client's cache alongside the trust manifest it was verified
against, and the cache is **never** a key source. Reloading it uses a different validation
profile: the document is _expected_ to be past `expiresAt` — that is what offline operation is —
and only `graceUntil` bounds it.

Air-gapped installs get the same document by a different route. An operator-minted offline bundle
carries a license document, a config document, or both, plus the trust manifest, and is imported
all-or-nothing. The bundle's documents are assembled by the **same** builder the network path
uses, so a bundle-activated install cannot receive a differently-merged grant. Fingerprint
enforcement is skipped for bundle activation — there is no server to dedupe against — and the
grace bound is the only revocation lever such an install has.

## Reference

- `docs/security/WIRE-CONTRACT-V3.md` §2 (envelope), §2.1 (this document), §3 (claim validation
  and grace), §5 (transport and gate placement), §7 (offline bundles).
- [Wire error codes](/docs/reference/error-codes/) — `version_blocked`, `channel_not_allowed`,
  `unauthorized`.
- [Re-licensing](/docs/services/license/relicensing/) — how a tier change reaches a running
  client through this document.
- [The license model](/docs/services/license/model/) — the merge order that produces
  `entitlements`.
