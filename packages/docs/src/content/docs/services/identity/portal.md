---
title: "Customer portal"
description: "The root-level, cross-tenant self-service account surface: sign-in, licenses, devices, and gated release downloads."
sidebar:
  order: 5
---

The customer portal is a self-service account surface: sign in once, see every license you hold
across **every product** on the deployment, claim more by key, manage your own devices, and
download gated releases you're entitled to. It is implemented entirely inside Identity — its
code lives in `services/identity/portal/`, and its six tables are Identity's (see
[Identity](/docs/services/identity/)) — but its routes are not product-scoped like the rest of
this section.

## Why the routes are root-level

`/login`, `/callback`, `/logout`, `/magic/verify`, `/api/*`, and `/download/<token>` are reserved
ahead of every product slug and dispatched from the composition root, not from this service's
product-scoped sub-router. That is a consequence of what the portal _is_: one account can hold
licenses for several products at once, so there is no single `<product>` to hang these paths
under without inventing one and defeating the point of a cross-tenant view.

A platform route whose implementation lives inside one service is not a contradiction — it is the
same shape manifest ingest already takes elsewhere: a platform-owned pipeline dispatching into
service-owned rows. What moved into `services/identity/portal/` is the code; the routes stayed
exactly where they were.

## Signing in

| Route                   | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `GET /login`            | Begins platform OIDC and 302s to the IdP.                                   |
| `GET /callback`         | The OIDC redirect URI: exchanges the code, verifies the ID token, signs in. |
| `POST /api/magic/start` | Emails a one-time sign-in link.                                             |
| `GET /magic/verify`     | Redeems that link.                                                          |
| `POST /logout`          | Ends the portal session.                                                    |

**OIDC.** `/login` uses the same `platformOidcConfig` a `platform`-provider product uses (see
[Product OIDC](/docs/services/identity/oidc/)) — the portal and every platform-issuer product
share one IdP client and one trust boundary. Rate-limited to 20 requests per minute per IP; PKCE,
`state`, and `nonce` follow the same shape as the product flow, with the redirect URI fixed to
`<origin>/callback` rather than a product-scoped path.

**Magic links.** `POST /api/magic/start` takes `{ "email": "…" }`, rate-limited to 8 per minute
per IP, and — only if the platform has an `EMAIL` binding configured — sends a link to
`/magic/verify?token=…`. The token is single-use and expires in **10 minutes**: the KV record
behind it is deleted the moment `/magic/verify` reads it, before the token is even checked
against anything else, so a link can never be redeemed twice. The email is explicit about the
window: "This link expires in 10 minutes."

Both paths accept an optional `returnTo`, which must be same-origin and additionally may not
target `/manage` — a magic link or an OIDC return cannot be used to pivot a visitor into the
admin console.

**Logout** prefers `POST`, unconditionally accepted. A bare `GET` is tolerated only as a
compatibility bridge for a browser holding a stale bundle, and only when the request is a
genuine same-origin top-level navigation — not a cross-site `<img>` or link. The unconditional
`GET` this replaced was a logout-CSRF: the cookie is `SameSite=Lax`, which is a defense against a
class of cross-site request, not a substitute for a real token
(the R1 audit findings, `R1-03`).

## The session cookie

`__Host-pkey_portal`, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, 14-day `Max-Age`. Unlike
the product browser-session cookie in [Browser sessions](/docs/services/identity/sessions/), this
one carries the `__Host-` prefix — the only mechanism that stops a sibling subdomain from
planting a `Domain=`-scoped cookie of the same name that a browser would prefer over the real one
(`R1-08`).

The cookie's value is not opaque: it is a signed token — a base64url JSON body plus an
HMAC-SHA256 signature — verified on every request rather than merely looked up. The signing key
may, in practice, be the _same_ raw secret the admin console's session cookie uses
(`PORTAL_SESSION_SECRET`, falling back to `ADMIN_SESSION_SECRET` when unset); what keeps the two
realms from being interchangeable is a domain-separation tag mixed into the signed material
before the signature is computed, so a token signed for one realm never verifies in the other
even when the underlying key is shared (`R1-02`).

## The portal API surface

Everything under `/api/*` except `capabilities` and `magic/start` requires the session cookie
(`401 unauthorized` otherwise), and every mutating method additionally requires the
`X-PKey-Portal-CSRF` header to match the session's CSRF value (`403` otherwise).

- **`GET /api/capabilities?product=<slug>`** — pre-auth. With `product`, answers for that one
  product; without it, answers the platform-wide aggregate (used only by the root login page,
  which has no product context yet). Each is evaluated independently per row rather than folded
  across every tenant, so one product's settings can no longer flip another's (`R5-06`):

  ```json
  {
    "auth": { "oidc": true, "magic": true },
    "modules": { "licensing": true, "claim": true, "releases": true }
  }
  ```

- **`GET /api/me`** — account summary (`id`, `name`, `email`) plus the CSRF token, after folding
  in any newly-provable license links.
- **`DELETE /api/me`** — the account holder erases their own account. Deletes every email,
  identity, and license-link row plus the account row itself in one atomic batch, then writes a
  single tombstone audit entry naming only the opaque `acct_…` id — nothing that still identifies
  the person. Rate-limited to 5 attempts on the account's own budget; the notice email is sent
  **before** the delete, because afterward there is no address left to send it to
  (the R11 audit findings, `R11-09`). Licenses themselves are **not** deleted — they
  are the product's records, and the portal account is only a view onto them.
- **`GET /api/licenses`** / **`GET /api/licenses/<product>/<licenseId>`** — every license linked
  to the account, across every product, with visible entitlements folded in; detail adds keys and
  devices.
- **`DELETE /api/licenses/<product>/<licenseId>/devices/<deviceId>`** — disconnect one of the
  account's own devices. Ownership is checked _before_ the rate-limit charge is spent, so a
  caller who owns nothing on that product cannot spend a budget at all, and the budget it does
  spend is scoped to that one product rather than shared platform-wide (`R5-05`).
- **`POST /api/claim/license-key`** — link a license by presenting a typed `pkey_…` key,
  rate-limited to 10 per minute on the account's budget.
- **`GET /api/releases`** and **`POST /api/releases/<product>/<releaseId>/artifacts/<artifactId>/token`**
  — the downloads surface, gated by _three_ independent things at once: the portal's own
  `releasesEnabled` toggle, whether the product runs the Release service at all
  (`services_json`), and — for a `licensed`-access artifact — whether the account holds a usable
  license for that product. Minting a token is refused up front if the artifact's stored source
  URL is not a redirectable `https` GitHub-storage host, so nothing is ever minted that could
  only fail later. The listing itself omits `signature` and `checksum` artifacts (`.sig` and
  `.sha256` sidecars): they are verification material, not downloads. As shipped, a download
  therefore needs a signed-in account **and** a license for the product linked to it (a usable
  one for `licensed` access); there is no anonymous path, and the redirect target is always a
  GitHub-storage host.
- **`GET /download/<token>`** — redeems a minted token. Every one of those checks is run again
  here, at redemption, not assumed to still hold from mint time — portal enabled, releases
  enabled, account active, license still linked, licensed access still held — and the token is
  spent with a single conditional `UPDATE … WHERE used_at IS NULL`, so two concurrent redemptions
  of the same token cannot both win; exactly one sees the row change. See
  the R6 audit findings' `R6-12` for the redirect allowlist, and
  the R9 audit findings' `R9-05b` (the redemption used to be read-then-write, not
  compare-and-swap) for the atomic single-use fix.

## Per-product portal settings

`portal_product_settings`, edited at `GET`/`PATCH /manage/api/products/<slug>/identity/portal`.
Five plain booleans, all defaulting **on** for a product that has never written a settings row:
`portalEnabled`, `oidcEnabled`, `magicEnabled`, `licenseKeyClaimEnabled`, `releasesEnabled`.

`autoLinkEnabled` is **tri-state**, not boolean — `true`/`false` is an explicit operator
override; `null` ("auto") derives from the product's _own_ OIDC provider: on for a
`platform`-issuer product, **off** for a `custom`-issuer one. A tenant-controlled IdP's `email`
and `sub` claims are outside the platform's trust boundary, so a tenant that stands up its own
IdP is opted out of auto-linking automatically, by the same default rule, rather than by an
operator remembering to flip a switch.

This is what decides whether a _verified_ email or OIDC subject may silently fold a product's
license into the account requesting it — verified in two senses at once: only email addresses
the portal itself proved (a magic link it sent, or an `email_verified: true` claim from the
**platform** issuer specifically) can drive a link at all, and only a platform-issuer subject may
match a license's `sub`, so subjects minted by mutually untrusted custom IdPs can never collide
across products (the R5 audit findings, `R5-01` and `R5-02`).

**In the console**, these settings are **Identity → Portal**. The sign-in methods and modules
are read-only while the portal switch is off, and **Release downloads** is read-only while the
product's Release service is off. The page saves the five switches and the linking choice in one
`PATCH`; it never sends `branding`, which it shows as a read-out.

## Supported browsers

The portal's UI is built on Tailwind CSS v4, whose generated styles rely on modern CSS
(cascade layers, `@property`, `color-mix()`). The floor is **Safari 16.4+, Chrome 111+ (and
Chromium-based Edge 111+), and Firefox 128+**. An older browser still reaches every route, but
the page renders largely unstyled. Point a customer on an older browser at an update before
debugging anything else.

## See also

- [Product OIDC](/docs/services/identity/oidc/) — the platform provider `/login` shares, and how
  a `custom` per-product provider sits outside auto-linking entirely.
- [Browser sessions](/docs/services/identity/sessions/) — the product-scoped session cookie this
  page's cookie is deliberately not the same as.
- the R5 audit findings — the full cross-tenant linking analysis this page's
  auto-link section summarizes, plus `R5-05`/`R5-06` (rate-limit and capability scoping).
- the R1 audit findings — `R1-02`/`R1-03`/`R1-08`, the session-cookie and
  logout hardening.
- the R9 audit findings and the R6 audit findings — `R9-05b` and `R6-12`, the
  download-token redemption and redirect allowlist.
- the R11 audit findings — `R11-09` (account erasure) and `R11-05` (download-token
  retention).
- [Public route table](/docs/reference/routes/) — every _product-scoped_ wire route. The
  portal's root-level paths on this page are not part of that table; they are platform routes,
  not per-product API surface.
