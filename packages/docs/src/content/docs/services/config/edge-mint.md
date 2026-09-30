---
title: "Edge-mint"
description: "Minting short-lived third-party tokens from a sealed product secret: recipes, operator approval, claims templates, and the confused-deputy guard."
sidebar:
  order: 6
---

Some catalog secrets aren't meant to be _held_ by a client at all — a third-party API key that
should only ever exist as a short-lived, purpose-scoped token. **Edge-mint** is Config's answer: a
product declares a **recipe**, and the Worker mints a fresh token on request instead of ever
shipping the underlying key material anywhere near a device. Apple MusicKit's ES256 developer
token is the motivating case; the mechanism is generic and also signs RS256 and EdDSA.

A catalog entry marks itself as edge-minted with `delivery: "edgeMint"` — see
[The catalog](/docs/services/config/catalog/) for that half. This page is the recipe and the
routes.

## The recipe

| Field              | Meaning                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`               | The recipe's identifier; also the path segment in `/config/mint/<id>/…`. Constrained to `^[a-z0-9-]+$` at the router, before any lookup happens. |
| `alg`              | `ES256`, `RS256`, or `EdDSA`. Anything else is `500 misconfigured` at mint time.                                                                 |
| `signingKeySecret` | Not the key material — the **name** of a sealed row in `product_secrets`, opened per request.                                                    |
| `kid`              | Optional; carried into the minted JWT's header when present.                                                                                     |
| `claimsTemplate`   | A free-form JSON object merged into the minted claims.                                                                                           |
| `ttlSeconds`       | The minted token's lifetime; the Worker stamps `exp = now + ttlSeconds`.                                                                         |
| `audience`         | Optional, trusted `aud` — server/recipe-controlled, never settable from the template.                                                            |
| `authPageTemplate` | Optional operator HTML served verbatim at the `/auth` route.                                                                                     |

Authored via the `.pkey/` manifest's `edgeMint[]` array at link and resync. `signingKeySecret`
names a row the operator still has to configure in admin's product secrets — declaring the
recipe and supplying its key material are two separate steps, and the product's setup view lists
which required secrets remain unconfigured.

A worked recipe, in the shape of `.pkey/release`'s `edgeMint[]` entry:

```jsonc
{
  "id": "musickit",
  "alg": "ES256",
  "signingKeySecret": "MUSICKIT_PRIVATE_KEY",
  "kid": "ABC123DEFG",
  "claimsTemplate": { "iss": "TEAMID1234" },
  "ttlSeconds": 3600,
}
```

A device with a usable license calling `POST /djdl/config/mint/musickit/token` gets back a token
whose decoded payload is the template's `iss` plus the server-stamped `iat`/`exp` — never a
`MUSICKIT_PRIVATE_KEY` value anywhere in the response.

## Two operator conditions

A recipe is **repo-authored**: anyone who can push to the linked repo can write one. On its own,
then, it must not be enough to mint — otherwise a repo writer, or a mistaken recipe, could turn
any PEM-shaped product secret into a token mint that every device of the product can reach
(under open registration, anyone). So the token route signs only when two further conditions hold,
and neither can be set from a manifest:

1. **The signing secret is marked `edge-mint`.** Every product secret has a _usage_: general (the
   default — an OIDC client secret, anything else) or `edge-mint`. The usage is set only by an
   operator, through the console's Secrets view or
   `PUT /manage/api/products/<slug>/secrets/<name>` with `"usage": "edge-mint"`. A recipe naming
   a general secret reads exactly as if the secret were missing: `500 misconfigured`, and nothing
   is signed. Conversely the OIDC client-secret path asks for a general secret, so an edge-mint key
   is never usable as one.
2. **The recipe is approved in the exact form it will run.** An operator's approval stores the
   recipe's security-relevant fields — `alg`, `signingKeySecret`, `kid`, `claimsTemplate`,
   `ttlSeconds` and `audience` — and the route mints only while the current recipe equals that
   approval column for column. A push that changes any of those fields makes the recipe inert
   until it is approved again; an unchanged resync keeps it approved; a resync that drops the
   recipe id deletes its approval, so re-adding the id later starts pending. `authPageTemplate` is
   not part of the approval: it does not change what is signed, and the `/auth` page ships its
   own script-free policy.

An unapproved (or changed) recipe answers **exactly** like an unknown one — `404 not_found` — so
the device-facing contract is unchanged: 404 means "not available here".

### Approving a recipe

The console's **Secrets** view has an _Edge-mint recipes_ card listing each recipe as
`approved`, `pending` or `changed` (with the approved value beside each changed field), its signing
secret's usage, and the product's effective registration policy. Behind it is Config's admin API:

| Endpoint                                                    | Does                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /manage/api/products/<slug>/config/mint`               | `{ registration, recipes[] }` — each recipe's fields, `status`, `secretUsage`, the stored `approval` (or `null`) and `changedFields`. |
| `POST /manage/api/products/<slug>/config/mint/<id>/approve` | Approves. The body **echoes** the recipe's fields as the operator saw them (see below).                                               |
| `POST /manage/api/products/<slug>/config/mint/<id>/revoke`  | Drops the approval; the recipe answers `404` again.                                                                                   |

The approve body carries `alg`, `signingKeySecret`, `kid`, `claimsTemplateJson` (the stored JSON
string), `ttlSeconds` and `audience`, exactly as `GET` returned them. If a push landed in between
and they no longer equal the stored recipe, the call is refused with `409` and the differing field
names, so an operator never approves something they did not see. A field missing from the body is
`422`.

When the product's effective registration is `open`, anyone who installs it can hold a device
token, so an approved recipe is a **public** token mint. That can be the right call, but it has to
be a visible one: the approve body must also carry `"acknowledgeOpenRegistration": true` (else
`422`), and the audit entry records that it was given.

Every change is audited: `config.mint.approve`, `config.mint.revoke`, and `secret.usage` when a
secret's usage changes. A re-upload of a secret that omits `usage` keeps the stored usage, so
rotating a key never silently changes what it may sign.

**Upgrading.** Migration `0025a_edge_mint_approvals.sql` backfills both conditions from what was
deployed: every secret a recipe already named is marked `edge-mint`, and every existing recipe is
approved as it stands (`approved_by = 'migration'`), so deployed products keep minting. That is the
status quo, not a weakening — each of those secrets was already mintable. Review the list once
after deploying:

```sql
SELECT product, name FROM product_secrets WHERE usage = 'edge-mint';
```

## Signing

`ES256` imports the PEM as a P-256 PKCS#8 key and signs with WebCrypto, taking the raw `r‖s`
signature JWS ES256 expects. `RS256` accepts either PKCS#1 (`BEGIN RSA PRIVATE KEY`) or PKCS#8
(`BEGIN PRIVATE KEY`) PEM — a PKCS#1 key is re-wrapped in the fixed `rsaEncryption`
`AlgorithmIdentifier` envelope before WebCrypto will import it. `EdDSA` delegates to
`@polaris-key/jws`'s own compact-JWS signer.

`signingKeySecret` is opened through the same KEK-envelope machinery as the product's Ed25519
signing key and its OIDC client secret, and only when its usage is `edge-mint`. Missing, marked
general, or present but unopenable, is `500 misconfigured` — the route never mints on a guess.

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

| Route                                  | Auth                                            | Behaviour                                                                    |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `/<product>/config/mint/<id>/token`    | Device token + the confused-deputy guard below. | Mints and returns `{ token, expiresAt }`. Both `GET` and `POST` work.        |
| `GET /<product>/config/mint/<id>/auth` | None.                                           | Serves `authPageTemplate` verbatim as HTML, or `404` if the recipe has none. |

## Minting: the confused-deputy guard

Requesting `/<product>/config/mint/<id>/token`:

1. **Rate limit** — bucket `mint`, keyed by client IP, 60 requests per 60 seconds. Over budget is
   `429 rate_limited`.
2. **Device token required** — the same `validateDeviceToken` the config document route uses.
   Missing or invalid is `401 unauthorized`.
3. **License-usable, but only if License is enabled.** When the product runs License, the
   device's license must also be usable (`licenseUsable`) or the request is `401`. When License
   is disabled for the product, this extra check is skipped entirely.
4. **Per-device rate limit** — bucket `mintDevice`, keyed by the device id, 30 requests per 60
   seconds, on top of the per-IP budget: one device behind many addresses cannot multiply its
   allowance. Counted before the recipe lookup, so probing recipe ids spends the same budget.
   Over budget is `429 rate_limited`.
5. **An approved recipe** — see [Two operator conditions](#two-operator-conditions). Unknown,
   pending, or changed since approval is `404 not_found`.
6. **An `edge-mint` signing secret** — else `500 misconfigured`.

That third step is the confused-deputy guard, and its condition is deliberately narrower than
"always require a license". Minting a third-party credential is a stronger capability than reading
your own settings, so it borrows the same scope rule Core's own `/devices` and `/devices/report`
surfaces use: the license check applies **iff** the product enables License. On a config-only
product (D-08) a valid device token is sufficient — there is no license to be usable, and refusing
every mint on that product would leave Config's edge-mint capability permanently unreachable for
it. On a licensed product, this is byte-identical to what device-token validation used to enforce
on this route's behalf before the license/config split moved the check here explicitly.

### Responses at a glance

| Status              | When                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `200`               | Minted. `{ token, expiresAt }`.                                                                                       |
| `401 unauthorized`  | Missing/invalid device token, or (License enabled) an unusable license.                                               |
| `404 not_found`     | No recipe with that `id` for this product, or one not approved as it now stands.                                      |
| `429 rate_limited`  | Over 60 requests/60s for this client IP, or over 30/60s for this device.                                              |
| `500 misconfigured` | Unsupported `alg`, a signing key that is missing, unopenable or not marked `edge-mint`, or a corrupt claims template. |

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
`available` — never the recipe id list and never per-recipe URLs. It is `true` only when at least
one recipe is **approved** as it stands: a product whose every recipe is pending or changed says
`false`, because there is nothing a client could mint. A client that needs a specific
recipe already learned its id from the catalog entry whose `delivery` is `edgeMint`; publishing
the inventory to an anonymous caller would enumerate a product's third-party integrations for
nothing.

## See also

- [The catalog](/docs/services/config/catalog/) — the `delivery: "edgeMint"` annotation this
  mechanism pairs with.
- [The config document](/docs/services/config/document/) — the plain device-token auth this
  route's guard is stricter than.
- [Public route table](/docs/reference/routes/) — every route with its owning service.
- [Secrets and keys](/docs/admin/secrets-and-keys/) — setting a secret's usage in the console.
- `packages/worker/test/edgeMint.test.ts` — pins the confused-deputy guard, the reserved-claims
  strip, the fail-closed `misconfigured` responses for a bad alg, a missing key, a general-usage
  key and a corrupt claims template, recipe approval, the per-device budget and the migration
  backfill; `test/linkRepo.test.ts` pins approvals across link and resync.
