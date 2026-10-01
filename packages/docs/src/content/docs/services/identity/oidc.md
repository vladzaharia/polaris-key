---
title: "Product OIDC"
description: "Platform vs. custom providers, the PKCE browser flow, group-to-tier mapping, the auto-issue fallback, and claim provisioning."
sidebar:
  order: 2
---

Each product has exactly one server-selected OpenID Connect provider — the shared platform
default, or a provider the product links itself — plus its own group mapping and claim
provisioning. A browser sign-in mints or locates a **license** for the identity; a device-code
sign-in (see [The device-code flow](/docs/services/identity/device-flow/)) does the same thing
for a client that cannot receive a redirect. Every ID token is verified against the issuer's JWKS
with `jose`, asymmetric algorithms only.

## Platform vs. custom

`oidc_config.provider` is one of two values, read by `resolveOidcConfig` on every sign-in:

- **`platform`** (the default when the column is unset) — the operator-configured IdP shared by
  every product that has not linked its own, read from the `PLATFORM_OIDC_ISSUER` /
  `PLATFORM_OIDC_CLIENT_ID` / `PLATFORM_OIDC_CLIENT_SECRET` Worker secrets (falling back to the
  older `ADMIN_OIDC_*` names). This is the **same** IdP client the customer portal's root
  `/login` uses — see [Customer portal](/docs/services/identity/portal/) — so a
  platform-issuer product and the portal share one trust boundary.
- **`custom`** — a provider the product links itself: `issuer`, `client_id`, and a
  product-secret-sealed `client_secret`, fed by `.pkey/product`'s `oidc:` block through repo link
  and resync. `redirect_uris_json`, when set, is an allowlist the computed redirect URI must
  appear in — the IdP's own registered-redirect check is not the only one enforced here.

A **custom** issuer is repo-controlled, not operator-controlled: whoever can push to the linked
repo's `.pkey/product` can point `oidc.issuer` anywhere. Two independent checks stand between
that and a live sign-in — see "The issuer allowlist" below.

Neither path performs OIDC discovery. The issuer is expanded by fixed, hardcoded suffixes:
`<issuer>/authorize`, `<issuer>/api/oidc/token`, `<issuer>/.well-known/jwks.json`. A custom IdP
must expose exactly those three paths at those exact suffixes.

## The browser PKCE flow

Three routes, all under `/<product>/identity/auth`:

| Route                             | What it does                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<p>/identity/auth/start`    | Begins PKCE and 302s to the IdP's `/authorize`.                                                                                                                        |
| `GET /<p>/identity/auth/callback` | The registered redirect URI: exchanges the code, verifies the ID token, mints or locates the license (a device-code flow: stores the identity; the poll activates it). |
| `GET /<p>/identity/auth/poll`     | Polls a device-bound flow by `state`; a device-code flow is refused here (see below).                                                                                  |

**`/auth/start`** generates `state` and `nonce` (16 random bytes each, base64url) and a PKCE pair
— a 32-byte random `verifier` and its SHA-256 `challenge`, method `S256` — and stores them in a
KV flow record for 600 seconds, keyed by `state`. `return_to`, when present, must be same-origin
with the request or the call is refused outright (`400 bad_request`); it is what turns the
callback into a cookie-issuing redirect rather than a bare confirmation page — see
[Identity](/docs/services/identity/) for the two shapes a completed sign-in can take. The
redirect URI is always computed as `…/<product>/identity/auth/callback`; when
`redirect_uris_json` is set, it must appear in that list or the call is refused.

**`/auth/callback`** claims the flow's `state` before doing anything else — a stored
`consumedAt` makes it single-use, and a replayed `state` gets the same generic
`400 unknown state` a state that never existed would (this closes what the findings below call
"flow injection": a second callback on the same state could otherwise overwrite the license a
poller is already waiting on). It then exchanges the code at `<issuer>/api/oidc/token` with the
PKCE verifier, fetches the IdP's JWKS, and verifies the ID token:

- algorithms `RS256`, `ES256`, or `EdDSA` only — never a symmetric algorithm an attacker could
  forge with a public value;
- `issuer` and `audience` (the client id) must match;
- `clockTolerance` 300 seconds and `maxTokenAge` 5 minutes, so a token minted long before this
  exchange cannot be replayed into a sign-in later — freshness is enforced here because a token's
  `exp` alone is entirely the IdP's choice;
- the token's `nonce` claim must equal the flow's stored `nonce`; a token with no `nonce` is
  rejected unconditionally.

A verified token with an empty `sub` is treated as invalid (the same generic `401 unauthorized`
as any other bad token) rather than allowed through — an empty subject would otherwise collapse
every such identity onto one license row. Only an `email` carried on a token with
`email_verified: true` is trusted; an unverified email is attacker-chosen and is stored as
nothing rather than as an unverified fact, because the customer portal may later use this exact
value to auto-link accounts.

What happens next depends on whether the flow carries a `return_to` — see
[Identity](/docs/services/identity/) for the full split between the cookie path and the
device-token path.

**`/auth/poll`** only ever completes for a flow that was started bound to a device id, and never
for one the [device-code flow](/docs/services/identity/device-flow/) started: such a flow answers
the generic `error` here and completes only on `/auth/device/poll`, with the secret device code.
The reason is that `state` is not a secret — it rides on the authorize URL, which the device-code
confirmation page hands to anyone holding the public user code — so `state` plus a device id must
not redeem a device-code flow. Since the device-code flow is today the only thing that binds a
flow to a device id, `/auth/poll` currently completes no flow; it keeps its generic
`pending`/`error`/`timeout` answers and stays advertised in discovery.

:::note[No aliases]
These three routes, plus `/auth/logout` and the three `/auth/device/*` routes, are the _only_
spellings. The pre-namespace paths (`/<p>/auth/…`, `/<p>/session`) are deleted outright, and
`/auth/login` — a second spelling of `/auth/start` — is gone the same way. See
[Identity](/docs/services/identity/) for why no compatibility alias was kept.
:::

## The issuer allowlist: `OIDC_ISSUER_ALLOWLIST`

A **custom** issuer is checked twice before it is ever fetched or redirected to, because the same
value is both the base of the `/authorize` redirect and the destination of a POST carrying the
product's OIDC `client_secret`:

1. **Shape**, at manifest-ingest time and again here as a sink-side repeat: `isSafeIssuerUrl`
   refuses anything that is not `https`, or that names a private, loopback, link-local, or
   reserved address. This closes SSRF into internal infrastructure, but it cannot distinguish a
   real IdP from `https://exfil.attacker.example` — a public https host is indistinguishable from
   a legitimate one at the character level.
2. **Host allowlist**, `issuerHostAllowed`: the `OIDC_ISSUER_ALLOWLIST` Worker secret, a
   comma/whitespace-separated host list. Once set, it is enforced fail-closed — an issuer whose
   host is not on the list is refused with `500 misconfigured`, before the product's client
   secret is even opened. **Left unset, the gate does not apply.** That is a deliberate,
   documented trade-off: enforcing an empty allowlist would take every already-configured custom
   OIDC product offline on the deploy that ships the check, with no operator action and no
   warning.

The platform issuer is exempt from this check — it is a Worker secret an operator set, not a
value a repo can steer.

## `groupRoleMap`: groups to tier and entitlement grants

`oidc_config.group_role_map_json` maps IdP group names to a role and an optional tier:
`{ "<group>": { "role": "…", "tier": "<tierId>" } }`. On sign-in, `activateFromIdentity` walks
the verified token's `groups` claim: any group present as a key grants entitlement, and the
**first** mapped group that names a tier decides `tierId` (a later group naming a different tier
does not override it). A malformed or unparseable map grants nothing — fail closed — rather than
throwing out of the sign-in path.

An identity matching no mapped group is refused with `error: "not-entitled"` (surfaced as
`403 forbidden`) unless the product opts into the fallback below.

For a group claim to exist at all, the IdP must be asked for it: every authorize request
requests scope `openid email profile groups`.

## `oidcDefault`: the auto-issue fallback for group-less users

A product's **auto-issue policy** — `.pkey/product`'s top-level `autoIssue:` block, default off
— names a tier and a mode: `anonymous`, `oidcDefault`, or `both`.

- `anonymous` opens the keyless `POST /<product>/license/enroll` path — no OIDC involved.
- `oidcDefault` (or `both`) changes what happens to an OIDC identity that matched **no**
  `groupRoleMap` entry: instead of the `not-entitled` refusal above, `allowsOidcDefault(policy)`
  lets them land on `product.autoIssue.tierId` — any authenticated user gets the free/default
  tier rather than a hard 403.

A policy naming no tier, or left disabled, counts as off — `oidcDefault` never silently grants
access; a product opts in explicitly.

## `activateFromIdentity`: minting or locating a license

Idempotent on the OIDC subject: a second sign-in by the same identity finds the same license
(`getLicenseBySub`) rather than minting a duplicate. Before branching on that, it applies every
matching provisioning hook (below) into a payload of overrides.

`activateFromIdentity` can also merge a **claimable** enrolled license into the identity. A
claimable license is an anonymous, keyless one with no identity attached yet (`origin: "enroll"`,
`sub: null`). The caller must name it as the license its device is already on. **Only
`/device/poll` names one**, and only when the device-code holder opts in. The callback used to
take it from the device that started a device-code flow. But a device-code flow is confirmed with
a public user code, so whoever confirmed it and signed in could take that device's license over.
A device-code callback therefore stores the verified identity and activates nothing; the poll
activates it. The device first asks to see the identity (`confirmIdentity`, answered `confirm`
with the name and e-mail), and only after the player accepts it on the device does a poll send
`attachLicense: true` with that device's own bearer. See
[attaching the device's anonymous license](/docs/services/identity/device-flow/#attaching-the-devices-anonymous-license). When a caller does name one, two merge outcomes
are possible, using the vocabulary from
[the concepts page](/docs/start/concepts/):

- **Claim.** No license exists yet for this identity: the identity is attached to the _same_ row.
  Its devices, keys, and overrides all survive; the person simply becomes known.
- **Migrate.** The identity already has its own license: the enrolled license's devices move onto
  it, and the enrolled row is retired (`disabled`). Its `enroll_hwid` is deliberately **not**
  cleared — that column is the only guard against one machine enrolling again and repeating the
  merge with a second identity, so clearing it would remove the guard it exists to be.

Otherwise: an existing identity license is updated in place (refused with `error:
"license-unusable"` if it is disabled, expired, or revoked), or a brand-new license is inserted
with `origin: "oidc"`.

## Provisioning hooks: claim → entitlement / secret

`provisioning_config` rows are generic: any verified claim key on the ID token, not only group
membership, can grant an **entitlement** or deliver a **secret** URL. Each row names a `claim`,
and optionally an `entitlement_key` (+ value) and a `secret_key` + `secret_url_template` +
`allowed_hosts_json`.

A hook only fires when its claim is genuinely truthy: a literal boolean `true`, or a non-empty
string that is not `"false"`, `"0"`, or `"null"` — an IdP that emits any of those falsy-looking
strings must not grant anything, so truthiness alone is not enough.

- **Entitlement.** Written into the payload as `state: "enforced"`. A malformed
  `entitlement_value_json` skips the _whole_ hook rather than guessing a value.
- **Secret.** `secret_url_template` has every `{claim}` occurrence — there may be more than one —
  replaced with the URL-encoded claim value, then checked against `allowed_hosts_json`: the
  resulting URL's host must be a member, or the secret is dropped entirely. A missing or
  non-array allowlist drops it too. This host check runs on **every** sign-in, independent of the
  ingest-time check below — two layers, so a future writer of `provisioning_config` cannot
  silently reopen the gap by skipping one of them.

`secretUrlTemplate` is validated again at manifest-ingest time, before it ever reaches a D1 row:
it must be an absolute `https://` URL (plain `http://` is accepted only for a loopback host,
for local development), and the `{claim}` placeholder may not appear in the **host** — only in
the path or query — so a claim value can retarget where in a service a secret points, but never
which service receives the request.

## See also

- [The device-code flow](/docs/services/identity/device-flow/) — the same mint step, reached by
  a client that cannot receive a redirect.
- [Browser sessions](/docs/services/identity/sessions/) — what a `return_to` callback turns the
  minted license into.
- [Customer portal](/docs/services/identity/portal/) — the platform-level OIDC login that shares
  the platform provider with a `platform`-issuer product.
- `docs/security/findings/R8-oidc.md` — `R8-04` (single-use state), `R8-05` (claim trust: empty
  `sub`, unverified email, truthiness-only provisioning, token freshness), `R8-06` (fail-closed
  JSON parsing), `R8-10` (rate limiting on every handler here).
- `docs/security/findings/R9-injection.md` — `R9-01`/`R9-02`, the issuer allowlist and its
  companion open-redirect fix.
- [Public route table](/docs/reference/routes/) — every route with its owning service.
