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
(under open registration, anonymous enrolment or an OIDC default tier, anyone). So the token route signs only when two
further conditions hold, and neither can be set from a manifest:

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
   own script-free policy. The approval is also bound to the three product settings that decide
   who can hold a device token the mint accepts — whether the mint is [public](#public-mints),
   whether [License is checked](#license-checks) and which [identity provider](#sign-in-trust)
   sign-in trusts — because a push can change each of them without touching the recipe. A push
   that widens one of them drops the approval for good (see
   [Widening is permanent](#widening-is-permanent)).

An unapproved (or changed) recipe answers **exactly** like an unknown one — `404 not_found` — so
the device-facing contract is unchanged: 404 means "not available here".

### Approving a recipe

The console's **Secrets** view has an _Edge-mint recipes_ card listing each recipe as
`approved`, `pending` or `changed` (with the approved value beside each changed field), its signing
secret's usage, the product's effective registration policy, whether anonymous enrolment or an
OIDC default tier is on, and — when Identity is on — the identity provider and group map an
approval would cover. Behind it is Config's admin API:

| Endpoint                                                    | Does                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /manage/api/products/<slug>/config/mint`               | `{ registration, anonymousEnroll, oidcDefault, publicMint, licenseEnabled, identity, recipes[] }` — `identity` is the sign-in trust (or `null` with Identity off); each recipe's fields, `status`, `secretUsage`, the stored `approval` (or `null`) and `changedFields`. |
| `POST /manage/api/products/<slug>/config/mint/<id>/approve` | Approves. The body **echoes** the recipe's fields, `identity` and `licenseEnabled` as the operator saw them (see below).                                                                                                                                                 |
| `POST /manage/api/products/<slug>/config/mint/<id>/revoke`  | Drops the approval; the recipe answers `404` again.                                                                                                                                                                                                                      |

The approve body carries `alg`, `signingKeySecret`, `kid`, `claimsTemplateJson` (the stored JSON
string), `ttlSeconds` and `audience`, exactly as `GET` returned them, plus the `identity` object
(`null` when Identity was off) and the `licenseEnabled` boolean. If a push landed in between and
they no longer equal the stored recipe, the product's current sign-in trust or whether License is
on, the call is refused with `409` and the differing field names (`identity` or `licenseEnabled`
for the latter two), so an operator never approves something they did not see. A recipe field or
`licenseEnabled` missing from the body is `422`.

### Public mints

The mint is **public** (`publicMint: true`) when anyone can hold a device token, which happens
in three ways:

- the product's effective registration is `open` — any installation registers;
- [auto-issue](/docs/services/license/policy/#auto-issue) allows anonymous enrolment (`mode` `anonymous` or
  `both`) — `POST /<slug>/license/enroll` hands any caller a licence and a device token with no
  key and no sign-in, even though registration still reads `requires-license`; or
- Identity is on and auto-issue gives signed-in users a default tier (`mode` `oidcDefault` or
  `both`) — every account the identity provider will sign in gets a licence, mapped group or not.
  On a public identity provider that is anyone.

A public mint can be the right call, but it has to be a visible one: the approve body must also
carry `"acknowledgeOpenRegistration": true` (else `422`), and the audit entry records that it was
given.

The acknowledgement is stored **on the approval** and checked on every mint, not only when you
approve. All three settings are product state, and a `.pkey/product` push can change them without
touching the recipe: declaring `devices.registration: open`, turning License off (with Identity
off) so the derived policy becomes open, or enabling `autoIssue` (manifest-owned until an operator
edits the policy in the console). While the mint is public, an approval given without the
acknowledgement does not count: the recipe answers `404`, and the list shows it `changed` with
`registration` in `changedFields` (the approval's `openRegistrationAcknowledged` is `false`).
Re-approve it with the acknowledgement to make it mint again. A push that makes the mint public
also deletes such an approval (see [Widening is permanent](#widening-is-permanent)), so closing
the mint again does not bring it back. An approval that already carries the acknowledgement keeps
minting whatever the policy becomes.

### License checks

The mint requires a usable licence only while the License service is on. With Identity on, a push
that turns License off keeps the mint closed (registration derives `requires-identity`) but stops
checking licences, so a device whose licence an operator disabled, or that expired, could mint
again. The approval therefore records whether License was on (`licenseEnabled`); an approval
given with License on does not apply while it is off — the recipe answers `404` and the list shows
it `changed` with `license` in `changedFields`. Turning License **on** only narrows, so it never
invalidates an approval.

Re-approving while License is off is a decision to mint without licence checks, so it has to be a
seen one: the console warns on the card and in the approve dialog whenever License is off
("this mint does not check device licences; a disabled or expired licence can mint"), the approve
body echoes `licenseEnabled` (`409` if a push flipped it since the card loaded), and the audit
entry says "License off". The warning matters most after a push: the ingest deletes the widened
approval, so the recipe reads plain `pending` and the card-level warning is what says why.

### Sign-in trust

On a closed product, signing in is the other way people get device tokens without a key an
operator issued: Identity licenses any account whose IdP groups hit the product's `groupRoleMap`,
and with `registration: requires-identity` any signed-in account may register. The provider,
issuer, client id and group map are all written from the `.pkey/product` manifest. So a push that
points `oidc.issuer` at another host, swaps in a client the pusher registered, maps a group the
pusher belongs to onto a tier, or turns Identity on, would otherwise hand the pusher a licensed
device token that an approval given under the old settings still accepted.

The approval therefore records the sign-in trust it was given under — whether Identity was on,
and the `oidc_config` provider, issuer, client id and group map — and while Identity is on it
applies only if all of them are unchanged (the group map compared by content, so reordering its
keys is not a change). Otherwise the recipe answers `404` and the list shows it `changed` with
`identity` in `changedFields`, the approved values beside the current ones; re-approving it, with
the new trust in view, is the operator's decision. Turning Identity **off** only removes a way to
get a token, so it never invalidates an approval.

### Widening is permanent

Each of the three conditions above is checked on every mint, so a widening refuses at once. But a
check against the product _as it stands_ is not enough on its own: a push that widens issuance
(opens enrolment, turns License off, aims sign-in at an issuer the pusher controls) and a second
push that reverts it would leave the approval applying again, while the licences and device
tokens handed out in between keep working. So every writer of those settings first **deletes**
every approval the product has already widened, and audits each dropped approval as
`config.mint.invalidate`: resync sweeps before its first write, and the console sweeps before
every edit or revert of the product's services or License device policy. Resync also sweeps after
its last write (also when the push is refused or throws part-way, since the earlier writes are not
rolled back); a push whose Worker is cut off before that is caught by the next push or console
edit, before it writes. Linking a product deletes every approval row under its slug. After the
revert the recipe is `pending`, and it mints again only when an operator re-approves it.

Before re-approving, review the audit log from the `config.mint.invalidate` entry on, and disable
the licences and devices you did not intend: a re-approval drops nothing that was issued while the
approval was widened. A change to a recipe field is not swept — a changed recipe signs nothing
meanwhile — so reverting it restores the approval. An operator's own console edit that widens the
product is swept at the next push or console edit, so turning it back off leaves the recipe
`pending` too; until then the per-mint check refuses.

What this does not cover: the approval trusts the identity provider itself. Anyone that provider
signs in with a mapped group — including an account its administrator adds later — is covered, as
is anyone at all under an OIDC default tier (which is why that counts as public). Choosing the
provider remains an operator decision: a change to a custom issuer's host is also refused at
ingest unless the host is in `OIDC_ISSUER_ALLOWLIST`.

Every change is audited: `config.mint.approve`, `config.mint.revoke`, `config.mint.invalidate`
when an ingest drops a widened approval, and `secret.usage` when a secret's usage changes. A re-upload of a secret that omits `usage` keeps the stored usage, so
rotating a key never silently changes what it may sign.

**Upgrading.** Migration `0025_b_edge_mint_approvals.sql` backfills both conditions from what was
deployed: every secret a recipe already named is marked `edge-mint`, and every existing recipe is
approved as it stands (`approved_by = 'migration'`), so deployed products keep minting. That is
the status quo, not a weakening: each of those secrets was already mintable under the product's
current policy. The acknowledgement is recorded **only** where the mint was already public at
deploy (open registration, anonymous enrolment, or an OIDC default tier with Identity on);
everywhere else — djdl, which runs `requires-license`, included — the migrated approval carries
none, so a later push that makes the mint public turns the recipe inert until an operator
re-approves it with the acknowledgement. Whether License was on and the sign-in trust are
recorded as deployed too (for djdl: License on, Identity on, the platform provider and its group
map), so a later push that turns License off or changes the sign-in trust turns the recipe inert
the same way. Review the list once after deploying:

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

## From an SDK

`client.config.mintToken(recipeId)` (`mint_token` in Python) in the Node, Python and Swift SDKs
calls the token route with the device bearer, caches the result in memory only until
`expiresAt` minus 30 seconds, applies the usual single re-acquire on a 401, and validates the
recipe id against the router's alphabet before sending anything.
`conformance/transcripts/edge-mint.json` pins the conversation.

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
