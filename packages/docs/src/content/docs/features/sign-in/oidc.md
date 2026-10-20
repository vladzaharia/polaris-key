---
title: "Product sign-in provider"
description: "Platform or custom OpenID Connect provider, the PKCE browser flow, group-to-tier mapping, the keyless fallback and claim provisioning."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 3
---

Each product has one server-selected OpenID Connect provider and its own group mapping and claim provisioning. A browser sign-in mints or locates a license for the identity. The [device-code flow](/docs/features/sign-in/device-flow/) does the same for a client that can't receive a redirect. The Worker verifies every ID token against the issuer's JWKS and accepts asymmetric algorithms only.

## Platform or custom

`oidc_config.provider` is `platform` (the default) or `custom`.

- **Platform.** The operator-configured provider shared by every product that hasn't linked its own, from the `PLATFORM_OIDC_*` Worker secrets. Polaris Locker's `/login` uses the same provider, so a platform product and Locker share one trust boundary.
- **Custom.** A provider the product links: `issuer`, `client_id` and a sealed `client_secret`, fed by the `oidc:` block of `.pkey/product` through repo link and resync. When `redirect_uris_json` is set, the computed redirect URI must appear in it.

Both run on one relying-party client. It reads `<issuer>/.well-known/openid-configuration`, whose `issuer` must equal the configured one exactly, and dials only the issuer's host. A custom provider needs a discovery document that offers the code flow.

A custom issuer is repo-controlled: whoever can push `.pkey/product` can point it anywhere. Two checks stand between that and a live sign-in:

1. **Shape.** The issuer must be `https` and name no private, loopback, link-local or reserved address. This closes SSRF into internal infrastructure.
2. **Host allowlist.** The `OIDC_ISSUER_ALLOWLIST` Worker secret lists permitted hosts. Once set it is fail-closed: an issuer off the list is refused with `500 misconfigured` before the client secret is opened. Left unset, the gate doesn't apply, because enforcing an empty list would take every configured custom product offline. The platform issuer is exempt.

## The browser flow

`GET /<product>/identity/auth/start` begins PKCE and redirects to the provider. `GET /<product>/identity/auth/callback` is the registered redirect URI.

`start` generates `state`, `nonce` and a 32-byte PKCE verifier with its `S256` challenge, and stores them for 600 seconds keyed by the peppered hash of `state`. Flow records live in the Worker's atomic single-use store, so every once-only step is one atomic operation. A `return_to` must be same-origin and may not point into the console (`/manage`), else `400 bad_request`. It turns the callback into a cookie-issuing redirect.

`callback` claims the `state` first, so a replayed `state` gets the same generic `400` as an unknown one. It then exchanges the code with the verifier and verifies the ID token:

- algorithm `RS256`, `ES256` or `EdDSA` only;
- `issuer` and `audience` match;
- clock tolerance 300 seconds and a maximum token age of 5 minutes;
- the `nonce` equals the flow's, and a token with no `nonce` is rejected.

A verified token with an empty `sub` is invalid. The Worker trusts an `email` only when `email_verified` is true, because Locker may later use it to link accounts.

With a `return_to`, the callback sets a `pkey_<product>_session` cookie ([Browser sessions](/docs/features/sign-in/sessions/)). Without one, it hands the result to a poller that redeems a device token. There is no `state`-keyed poll: `state` isn't a secret, so a device completes the flow on the device-code poll with its secret device code.

## Groups to tier

`group_role_map_json` maps provider groups to a role and an optional tier: `{ "<group>": { "role": "…", "tier": "<tierId>" } }`. The first mapped group that names a tier decides the tier. A malformed map grants nothing. The authorize request asks for scope `openid email profile groups`.

An identity in no mapped group is refused with `403 forbidden` unless the product opts into the fallback: an `autoIssue` policy with mode `oidcDefault` or `both` and a tier lands that identity on the policy's tier. A policy with no tier, or a disabled one, counts as off. See [Enrollment and policy](/docs/features/licensing/access/).

## Find or mint the license

`activateFromIdentity` is idempotent on the subject: a second sign-in finds the same license. Sign-in updates `name`, `email` and `groups_json` and nothing else, so a trial ends when it ends however often the person signs in, and an operator's or a purchase's tier stays. The group mapping decides the tier only when a license is first minted or claimed. An existing license that is disabled, expired or revoked is refused with `license-unusable`.

It can also merge a claimable enrolled license into the identity, as a claim or a migrate ([Enrollment and policy](/docs/features/licensing/access/)). Only the device-code poll names one, after the person accepts the identity on the device.

## Claim provisioning

Provisioning rows turn any verified claim into an entitlement or a secret URL. A hook fires only when its claim is a literal `true` or a non-empty string other than `"false"`, `"0"` or `"null"`.

- **Entitlement.** Written as `enforced`. A malformed value skips the whole hook.
- **Secret.** Every `{claim}` in `secret_url_template` is replaced by the URL-encoded claim, then the host must be in `allowed_hosts_json` or the secret is dropped. This runs on every sign-in. At ingest the template must be an absolute `https` URL (`http` only for loopback), and `{claim}` may not appear in the host.

Sign-in owns exactly the override keys its hooks declare. It sets each from the current claims or removes it when the claim is no longer truthy, and leaves every other override alone.

## In the console

**Identity → Sign-in** shows the provider, issuer, client id, the group-to-tier table and the `oidcDefault` outcome, read-only. To change them, edit `.pkey/product`, commit, and select **Resync from repo**.

## Next steps

- [Device flow](/docs/features/sign-in/device-flow/): the same mint step without a redirect.
- [Browser sessions](/docs/features/sign-in/sessions/): what a `return_to` callback produces.
- [Locker](/docs/features/sign-in/customer-portal/): the platform-level login.
