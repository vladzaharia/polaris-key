---
title: "Edge-mint"
description: "Minting short-lived third-party tokens from a sealed product secret: recipes, claims templates, and the confused-deputy guard."
sidebar:
  order: 6
---

Some catalog secrets aren't meant to be *held* by a client at all — a third-party API key that
should only ever exist as a short-lived, purpose-scoped token. **Edge-mint** is Config's answer: a
product declares a **recipe**, and the Worker mints a fresh token on request instead of ever
shipping the underlying key material anywhere near a device. Apple MusicKit's ES256 developer
token is the motivating case; the mechanism is generic and also signs RS256 and EdDSA.

A catalog entry marks itself as edge-minted with `delivery: "edgeMint"` — see
[The catalog](/docs/services/config/catalog/) for that half. This page is the recipe and the
routes.

## The recipe

| Field | Meaning |
| --- | --- |
| `id` | The recipe's identifier; also the path segment in `/config/mint/<id>/…`. Constrained to `^[a-z0-9-]+$` at the router, before any lookup happens. |
| `alg` | `ES256`, `RS256`, or `EdDSA`. Anything else is `500 misconfigured` at mint time. |
| `signingKeySecret` | Not the key material — the **name** of a sealed row in `product_secrets`, opened per request. |
| `kid` | Optional; carried into the minted JWT's header when present. |
| `claimsTemplate` | A free-form JSON object merged into the minted claims. |
| `ttlSeconds` | The minted token's lifetime; the Worker stamps `exp = now + ttlSeconds`. |
| `audience` | Optional, trusted `aud` — server/recipe-controlled, never settable from the template. |
| `authPageTemplate` | Optional operator HTML served verbatim at the `/auth` route. |

Authored via `.pkey/release`'s `edgeMint[]` array at manifest ingest, or directly in admin.
`signingKeySecret` names a row the operator still has to configure in admin's product secrets —
declaring the recipe and supplying its key material are two separate steps, and the product's
setup view lists which required secrets remain unconfigured.

A worked recipe, in the shape of `.pkey/release`'s `edgeMint[]` entry:

```jsonc
{
  "id": "musickit",
  "alg": "ES256",
  "signingKeySecret": "MUSICKIT_PRIVATE_KEY",
  "kid": "ABC123DEFG",
  "claimsTemplate": { "iss": "TEAMID1234" },
  "ttlSeconds": 3600
}
```

A device with a usable license calling `POST /djdl/config/mint/musickit/token` gets back a token
whose decoded payload is the template's `iss` plus the server-stamped `iat`/`exp` — never a
`MUSICKIT_PRIVATE_KEY` value anywhere in the response.

## Signing

`ES256` imports the PEM as a P-256 PKCS#8 key and signs with WebCrypto, taking the raw `r‖s`
signature JWS ES256 expects. `RS256` accepts either PKCS#1 (`BEGIN RSA PRIVATE KEY`) or PKCS#8
(`BEGIN PRIVATE KEY`) PEM — a PKCS#1 key is re-wrapped in the fixed `rsaEncryption`
`AlgorithmIdentifier` envelope before WebCrypto will import it. `EdDSA` delegates to
`@polaris-key/jws`'s own compact-JWS signer.

`signingKeySecret` is opened through the same KEK-envelope machinery as the product's Ed25519
signing key and its OIDC client secret. Missing, or present but unopenable, is `500 misconfigured`
— the route never mints on a guess.

## Claims: what the template can and can't set

The stored template is parsed defensively: a corrupt `claims_template_json` is `500
misconfigured`, never an uncaught parse error and never a silent empty template — an empty
template would drop operator-set claims (`iss`, scopes, a tenant id) the recipient may depend on,
which is worse than refusing outright.

Before signing, four claims are stripped from whatever the template set and then stamped by the
recipe itself: `iat`, `exp`, `nbf`, and `aud`. A template cannot forge its own expiry, backdate
its issuance, or override the trusted audience. `iss` is the one deliberate exception — there is
no separate `iss` recipe column, and Apple MusicKit's own recipe legitimately sets `iss` (the
Apple developer team id) through the template. So the rule is: a template may set `iss` and any
non-reserved claim; it may never set `iat`, `exp`, `nbf`, or `aud`.

## The routes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `/<product>/config/mint/<id>/token` | Device token + the confused-deputy guard below. | Mints and returns `{ token, expiresAt }`. Both `GET` and `POST` work. |
| `GET /<product>/config/mint/<id>/auth` | None. | Serves `authPageTemplate` verbatim as HTML, or `404` if the recipe has none. |

## Minting: the confused-deputy guard

Requesting `/<product>/config/mint/<id>/token`:

1. **Rate limit** — bucket `mint`, keyed by client IP, 60 requests per 60 seconds. Over budget is
   `429 rate_limited`.
2. **Device token required** — the same `validateDeviceToken` the config document route uses.
   Missing or invalid is `401 unauthorized`.
3. **License-usable, but only if License is enabled.** When the product runs License, the
   device's license must also be usable (`licenseUsable`) or the request is `401`. When License
   is disabled for the product, this extra check is skipped entirely.

That third step is the confused-deputy guard, and its condition is deliberately narrower than
"always require a license". Minting a third-party credential is a stronger capability than reading
your own settings, so it borrows the same scope rule Core's own `/devices` and `/devices/report`
surfaces use: the license check applies **iff** the product enables License. On a config-only
product (D-08) a valid device token is sufficient — there is no license to be usable, and refusing
every mint on that product would leave Config's edge-mint capability permanently unreachable for
it. On a licensed product, this is byte-identical to what device-token validation used to enforce
on this route's behalf before the license/config split moved the check here explicitly.

### Responses at a glance

| Status | When |
| --- | --- |
| `200` | Minted. `{ token, expiresAt }`. |
| `401 unauthorized` | Missing/invalid device token, or (License enabled) an unusable license. |
| `404 not_found` | No recipe with that `id` for this product. |
| `429 rate_limited` | Over 60 requests/60s for this client IP. |
| `500 misconfigured` | Unsupported `alg`, missing/unopenable signing key, or a corrupt claims template. |

A success is `200`:

```json
{ "token": "…", "expiresAt": 1756256400 }
```

`content-type: application/json`, `cache-control: no-store`.

## The `/auth` page

`authPageTemplate` is operator-authored HTML, rendered **verbatim** on the platform origin — the
same origin that carries the admin session cookie. That makes it a script-execution primitive by
construction, so it ships with a strict CSP (`default-src 'none'`, via
`staticHtmlSecurityHeaders`): an injected `<script>` cannot run, and an injected
`fetch("/manage/api/me")` cannot connect. If a product genuinely needs to run something like
MusicKit JS from this page, that needs its own explicit allowlist — and ideally a separate sandbox
origin — rather than a relaxation of the default policy. A missing template is `404`; served
responses carry `cache-control: no-store`.

## What discovery publishes

`/<product>/.well-known/polaris.json`'s `services.config.mint` carries one boolean —
`available` — never the recipe id list and never per-recipe URLs. A client that needs a specific
recipe already learned its id from the catalog entry whose `delivery` is `edgeMint`; publishing
the inventory to an anonymous caller would enumerate a product's third-party integrations for
nothing.

## See also

- [The catalog](/docs/services/config/catalog/) — the `delivery: "edgeMint"` annotation this
  mechanism pairs with.
- [The config document](/docs/services/config/document/) — the plain device-token auth this
  route's guard is stricter than.
- [Public route table](/docs/reference/routes/) — every route with its owning service.
- `packages/worker/test/edgeMint.test.ts` — pins the confused-deputy guard, the reserved-claims
  strip, and the fail-closed `misconfigured` responses for a bad alg, a missing key, and a corrupt
  claims template.
