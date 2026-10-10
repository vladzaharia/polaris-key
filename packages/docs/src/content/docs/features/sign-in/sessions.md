---
title: "Browser sessions"
description: "The session cookie, the fused session document and its build gate, key-to-session exchange, logout, and keyless requires-identity registration."
sidebar:
  order: 4
---

The browser session is Identity's cookie-bearing principal. A page signs in — through the OIDC
flow in [Product OIDC](/docs/services/identity/oidc/), or by presenting a license key directly —
and gets a cookie bound to a synthetic `browser:<licenseId>` device row, so a browser tab is
authorized the same way a native install is: through Core's device principal, not a parallel
mechanism.

## The cookie

Name `pkey_<product>_session` (the product slug's hyphens become underscores), scoped
`Path=/<product>`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age` 30 days. It carries an opaque
token; the record behind it lives in KV, peppered-hash-keyed, holding the device's `pkeyt_` token,
a CSRF value, the `licenseId`, the synthetic `deviceId`, and a creation timestamp — also on a
30-day TTL, so the cookie and its record always expire together.

A cookie whose KV record is missing or unparseable is treated exactly like no cookie at all, the
same fail-closed rule the OIDC flow records use: every caller already has a well-defined answer
for "there is no session here," and a truncated or corrupted value must take that branch rather
than escape as an unhandled error.

## `GET /identity/session` — the fused document

Unlike `/license/document` and `/config/document`, this route mints **one fused document** —
license claims, config, and entitlements together — rather than the split pair wire v3 uses
elsewhere. That is deliberate: it is minted for a _page_, not an SDK, and it is the one caller
still using the pre-split shape until the React SDK migrates to the split documents. `secrets` is
always stripped to an empty object before the response is built — a browser session is never
handed secret material.

The response shape depends on how far the request gets:

| Situation                                                                                | Response                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| No session cookie, or its record is missing/corrupt                                      | `200 { "authenticated": false, "doc": null }`                                                                       |
| Session valid, but the device token or license fails Core's usability check              | `200 { "authenticated": false, "doc": null }` — identical to no session at all                                      |
| Session valid, but the active catalog can't validate the payload                         | `500 catalog_unavailable` — fails closed, matching `/config/document`                                               |
| Session valid, device/license usable, but the **build gate** blocks this version/channel | `200 { "authenticated": true, "doc": null, "blocked": { "reason": "…", "allowedRange": {...} }, "csrfToken": "…" }` |
| Session valid and nothing blocks it                                                      | `200 { "authenticated": true, "doc": {...}, "csrfToken": "…" }`                                                     |

A session that exists but no longer authorizes anything is indistinguishable from having no
session — a client cannot tell "never signed in" from "signed in, but the license expired"
without inspecting further, which is the same hide-the-reason posture the rest of this service
takes.

The `doc` itself, when present, mirrors the claim envelope the signed documents carry, plus the
fused license/config payload. It is delivered as **plain JSON inside this response**, not as a
compact JWS — the page is already talking to the origin over an authenticated session, so there
is no cache or disk boundary here for a signature to survive:

```json
{
  "schemaVersion": 1,
  "aud": "<product>",
  "iss": "key.plrs.im",
  "licenseId": "lic_…",
  "deviceId": "browser:lic_…",
  "issuedAt": 1756252800,
  "expiresAt": 1756256400,
  "graceUntil": 1758844800,
  "profile": {},
  "payload": { "config": {}, "secrets": {}, "entitlements": {} }
}
```

`expiresAt` is `issuedAt + 3600` and `graceUntil` is `issuedAt + maxOfflineDays × 86 400`, the
same arithmetic the signed documents use, ending no later than the licence's expiry (and never
earlier than `expiresAt`) while `licensing.clampGraceToExpiry` is on
([WIRE-CONTRACT-V4 §3.6](/docs/services/license/document/#the-envelope)).

`secrets` is always the empty object shown above — never omitted, never populated. A browser
session's whole point is to drive a page's UI off config and entitlements; secret material stays
behind the SDK/keyring path native clients use.

### The build gate lives here too

Wire contract v3 §5 names **two** enforcement points for version and channel blocking: this
route, and `/license/document`. Both read `X-PKey-Version` / `X-PKey-Channel` and must refuse
exactly the same builds — a browser tab and a native client are held to one gate, computed once
in `core/licensing/gate.ts` and imported by both, not reimplemented per surface. See
[License](/docs/services/license/) for the document-route half of the same enforcement.

`csrfToken` is returned specifically so a page has it on hand for the one mutating call it is
likely to make next: logout, below.

## `POST /identity/session/license` — key to session

Exchanges a license key for a session cookie, for a page that has a key rather than an existing
sign-in: body `{ "key": "pkey_…" }`, or a bearer `Authorization` header. The key is hashed,
looked up, and must be `active`; its license is loaded and run through the _same_
seat-authorization step activation uses, binding the synthetic `browser:<licenseId>` device the
same way a native install's device id would be bound. A seat conflict answers `403 device_limit`
with the same `{ "limit": …, "deviceCount": … }` detail activation's device-limit refusal
carries.

This is a credential-exchange endpoint — it takes an attacker-suppliable secret and reports
whether it is valid, making it an online oracle for guessing license keys — so it is
rate-limited at 30 requests per minute per IP, the same budget `/license/activate` uses for
exactly the same key-redemption shape. Success is `201` with `Set-Cookie`, and touches the key's
`last_used_at`.

## Logout — `POST /identity/auth/logout`

Requires the `X-CSRF-Token` header to equal the session's stored CSRF value, or `403 forbidden`.
This is the one mutating browser-session surface that _does_ check CSRF: unlike registering a
device below, logout's effect is visible without reading the response, so a cross-site POST with
no token attached must not be able to trigger it.

On a valid match, it deauthorizes the `browser:<licenseId>` device row, deletes its KV token
record, and deletes the session record. The cookie is cleared in the response either way — with
or without a valid session to act on — so a client that calls logout redundantly always ends up
signed out rather than erroring.

Despite living beside the session surfaces conceptually, this route is dispatched from the same
`auth` group as the OIDC flow (`/identity/auth/logout`, not `/identity/session/logout`) — it sits
in `routes.ts`'s `auth` switch alongside `start`/`callback`/`poll`.

## Authorizing `requires-identity` registration — without a license

The browser session is also the credential behind Core's keyless
`POST /<product>/devices/register`, for a product whose registration policy is
`requires-identity`. Core cannot itself answer "is a human signed in to this product" — that
question is Identity's — so it asks through one narrow hook, `authorizeRegistration`, rather than
importing this service.

What that hook checks is deliberately **one step short** of what `/identity/session` checks:

1. Load the session from the cookie — a pure read, resolving to the stored KV record and nothing
   more.
2. Validate the device token _by itself_ — Core's `validateDeviceToken`, not
   `requireLicensedDevice`. It asks only "is this a live device," never "does it hold a usable
   license."

That second point is load-bearing. `requires-identity` is precisely the policy a product picks
when it does **not** run License at all (a Config-only or Release-only product with sign-in but
no seats) — demanding a usable license here would make the policy unsatisfiable for the very
products it exists to serve. Contrast this with `/identity/session` above, which upgrades to the
full license-usability check because a browser asking for its config document _is_ asking a
licensing question.

One more gate sits in front of both: the registry-level `authorizeRegistration` first confirms
`identity.enabled` for the product before it ever calls this hook, and refuses outright if either
the flag is off or no hook is registered. A product cannot declare `requires-identity` with
Identity disabled and have registration fall open — see [Identity](/docs/services/identity/) for
the enablement rule that closes that combination off at the admin API.

No CSRF check applies to this exchange, unlike logout: it authorizes minting a _new_ credential
that is returned only in the response body, so a cross-site caller that forced the request could
never read what it produced.

## See also

- [Product OIDC](/docs/services/identity/oidc/) — how a sign-in ends up with a `return_to` and
  therefore a cookie, versus ending up with a raw device token instead.
- [The device-code flow](/docs/services/identity/device-flow/) — the token-issuing counterpart
  for a client that cannot hold a cookie.
- [License](/docs/services/license/) — the document route this service's build gate mirrors, and
  the seat-authorization step both key-to-session and activation share.
- [The device principal](/docs/services/core/device-principal/) — `validateDeviceToken`,
  registration policies, and why a device is a Core concept rather than a licensing one.
- [Public route table](/docs/reference/routes/) — every route with its owning service.
