---
title: "Edge mint"
description: "Mint short-lived third-party tokens from a sealed product secret, so the key material never reaches a device."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 7
---

Some secrets shouldn't be held by a client at all: a third-party signing key that should exist only as a short-lived, scoped token. A product declares a recipe, and the Worker mints a fresh token on request instead of shipping the key. Apple MusicKit's ES256 developer token is the motivating case. The mechanism also signs RS256 and EdDSA. In the console this is a **Minted token**, the third config entry type beside a Setting and a Secret: a catalog entry of `kind: "secret"` with `delivery: "edgeMint"`, read in code with `mintToken(key)`, never listed or synced.

A catalog entry opts in with `delivery: "edgeMint"` and carries its recipe in a `mint` block ([The catalog](/docs/features/managed-config/catalog/)). The entry's `key` is the recipe's id; with no block the validator warns that nothing can be minted. This page is the recipe and the routes.

## The recipe

| Field                 | Meaning                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                  | The recipe id and the path segment in `/config/mint/<id>/…`. Lowercase letters, digits and `-`, 1 to 64 characters |
| `alg`                 | `ES256`, `RS256` or `EdDSA`. Anything else is `500 misconfigured`                                                  |
| `signingKeySecret`    | The name of a sealed product secret, opened per request. Never the key itself                                      |
| `kid`                 | Optional. Carried into the token's header                                                                          |
| `claimsTemplate`      | A JSON object merged into the claims                                                                               |
| `ttlSeconds`          | The token's lifetime, 1 to 3600. A repo push may not decide how long a leaked token stays valid (`invalid_ttl`)    |
| `audience`            | Optional trusted `aud`, never settable from the template                                                           |
| `requires`            | `licensed` (the default), `registered` or `none`                                                                   |
| `requiredEntitlement` | Optional catalog key the caller's merged payload must carry, truthy                                                |
| `authPageTemplate`    | Optional HTML served verbatim at the `/auth` route                                                                 |

A recipe is the entry's `mint` block, without `id` (the key is the id). Author it in `.pkey/schema`, or edit it on the entry in **Config → Catalog**: a console publish saves it with the catalog and claims it with the catalog, so a later resync leaves it alone. A top-level `edgeMint[]` array is still read, and `pkey validate --fix` moves each recipe into its entry. The served catalog never carries a `mint` block. Declaring the recipe and supplying its key are separate: the operator still sets the named secret in the console.

```json title="An edgeMint[] item, or the entry's mint block without id"
{
  "id": "musickit",
  "alg": "ES256",
  "signingKeySecret": "MUSICKIT_PRIVATE_KEY",
  "kid": "<key id>",
  "claimsTemplate": { "iss": "<team id>" },
  "ttlSeconds": 3600
}
```

A device with a usable license calling the token route gets a token whose payload is the template's `iss` plus the server-stamped `iat` and `exp`. The key never appears in the response.

## Two operator conditions

A recipe is repo-authored, so it must not be enough to mint. The token route signs only when two more conditions hold, and neither can be set from a manifest.

1. **The signing secret has usage `edge-mint`.** An operator sets it in the console's **Keys & secrets** view or through the secrets API with `"usage": "edge-mint"`. A recipe naming a general secret reads as if the secret were missing: `500 misconfigured`, nothing signed.
2. **The recipe is approved in the exact form it runs.** The approval stores `alg`, `signingKeySecret`, `kid`, `claimsTemplate`, `ttlSeconds`, `audience`, `requires` and `requiredEntitlement`. A push that changes any of them makes the recipe inert until it is approved again. A resync that drops the id deletes the approval. `authPageTemplate` isn't part of it.

An unapproved or changed recipe answers exactly like an unknown one: `404 not_found`.

### Approving a recipe

Role required: a member who can edit the product, with a sign-in from the last 5 minutes (`step_up_required` otherwise). Approval is permanent until you revoke it, but widening the product revokes it for you.

1. **Console** Open **Config → Edge mint**, or select **Review and approve** on the entry in **Config → Catalog**. Each recipe shows **Approved**, **Needs approval** or **Changed since approval**, its signing secret and that secret's usage.
2. Select **Approve…**. The drawer shows the recipe's fields beside the last approval's values. Tick the public-mint acknowledgement when it appears.
3. Select **Approve**. If the recipe, its sign-in trust or License changed while the drawer was open, the server answers `409` and the drawer reloads, so you approve only what you saw.

**Revoke approval…** asks first, and the recipe answers `404` again. The admin routes are `/manage/api/products/<slug>/config/mint` (`GET`) and `…/mint/<id>/approve` and `…/mint/<id>/revoke` (`POST`). The approve body echoes the recipe's fields, `identity` and `licenseEnabled` as you saw them.

### Conditions the approval is bound to

The approval also records three product settings that decide who can hold a device token the mint accepts. A push can change each without touching the recipe.

| Condition      | When it applies                                                                                                 | What happens                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public mint    | Registration is `open`, or auto-issue allows anonymous enrollment, or Identity is on with an `oidcDefault` tier | The approve body must carry `"acknowledgeOpenRegistration": true` (else `422`). An approval without it doesn't count while the mint is public      |
| License checks | The recipe is approved with License on                                                                          | Turning License off keeps the mint closed to anonymous devices but stops license checks. The approval then doesn't apply: `404`, listed as changed |
| Sign-in trust  | Identity is on and License is off                                                                               | The provider, issuer, client id and group map must be unchanged. Otherwise `404`, listed as changed                                                |

Widening is permanent. Every writer of those settings first deletes each approval the product has already widened and audits it as `config.mint.invalidate`. Otherwise a second push that reverted the first would restore the approval while the devices issued in between kept working. After a revert the recipe is pending and mints only when re-approved. Review the audit log from the `config.mint.invalidate` entry on, and disable the licenses and devices you didn't intend: re-approval drops nothing issued meanwhile. Turning License or Identity on, or off in the cases above, only narrows and never invalidates.

Every change is audited: `config.mint.approve`, `config.mint.revoke`, `config.mint.invalidate` and `secret.usage`.

## Signing and claims

ES256 imports a P-256 PKCS#8 PEM and signs with WebCrypto. RS256 accepts PKCS#1 or PKCS#8. EdDSA uses `@polaris-key/jws`. A missing, general-usage or unopenable secret is `500 misconfigured`.

A corrupt claims template is `500 misconfigured`, never a silent empty template, which would drop claims the recipient depends on. Before signing, the Worker strips `iat`, `exp`, `nbf` and `aud` from the template and stamps them itself. A template may set `iss` and any other claim.

## Minting

`/<product>/config/mint/<id>/token` accepts `GET` and `POST`. It checks, in order:

1. A device token (`401 unauthorized`).
2. A usable license, when the product runs License and the recipe is `licensed`. A caller without one gets the same `401` for an unknown id.
3. A rate limit charged to refused requests: 60 per 60 seconds per client network. Authenticated devices never spend it.
4. A per-device limit of 30 per 60 seconds, counted before the recipe lookup.
5. An approved recipe (`404`) and an `edge-mint` secret (`500`).

| `requires`   | Who may mint                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `licensed`   | A device with a usable license. The product must run License, else `500 misconfigured`. The default        |
| `registered` | Any device of the product. What a config-only product declares when the device token is the whole gate     |
| `none`       | No demand of its own. Every mint still needs a device token, because the route spends your third-party key |

On a config-only product registration is open, so an anonymous caller can get a device token in one request. That's why `licensed` is the default. `requiredEntitlement` must be present and truthy in the caller's merged payload. A stored `false`, `0` or `""` is a denial. A caller without it gets `403 forbidden`.

| Status | When                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------ |
| `200`  | `{ "token": "…", "expiresAt": 1756256400 }` with `cache-control: no-store`                             |
| `401`  | No device token, or a license is required and unusable                                                 |
| `403`  | `requiredEntitlement` absent or falsy                                                                  |
| `404`  | No such recipe, or not approved as it stands                                                           |
| `429`  | Over a rate limit                                                                                      |
| `500`  | Unsupported `alg`, a bad or non-`edge-mint` secret, a corrupt template, or `requires` that doesn't fit |

## The auth page

`GET /<product>/config/mint/<id>/auth` serves `authPageTemplate` verbatim, or `404` if there is none or the recipe isn't approved. It renders on the platform origin, which carries the console session cookie, so it ships with `default-src 'none'`. An injected script can't run and an injected fetch can't connect. A page that needs MusicKit JS needs its own allowlist, ideally on a separate sandbox origin.

## Discovery

`services.config.mint` in the discovery document is one boolean, `available`. It is `true` only when at least one recipe is approved as it stands. It never lists recipe ids or URLs. A client learns the id from the catalog entry whose `delivery` is `edgeMint`.

## From an SDK

`client.config.mintToken(recipeId)` in Node, `mint_token` in Python and the Swift equivalent call the token route, cache the token in memory until 30 seconds before `expiresAt`, and drop it when the device token changes. They re-acquire once on a `401` and validate the id before sending.

## Next steps

- [The catalog](/docs/features/managed-config/catalog/): the `edgeMint` delivery.
- [Troubleshoot managed config](/docs/features/managed-config/troubleshooting/).
- [Public routes](/docs/reference/routes/).
