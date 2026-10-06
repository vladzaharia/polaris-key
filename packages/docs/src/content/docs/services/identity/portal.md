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

`/login`, `/callback`, `/logout`, `/magic/verify`, `/api/*`, `/download/<token>` and
`/media/<product>/<asset>` are reserved
ahead of every product slug and dispatched from the composition root, not from this service's
product-scoped sub-router. That is a consequence of what the portal _is_: one account can hold
licenses for several products at once, so there is no single `<product>` to hang these paths
under without inventing one and defeating the point of a cross-tenant view.

A platform route whose implementation lives inside one service is not a contradiction — it is the
same shape manifest ingest already takes elsewhere: a platform-owned pipeline dispatching into
service-owned rows. What moved into `services/identity/portal/` is the code; the routes stayed
exactly where they were.

## The Identity flag does not gate the portal

The portal is a platform concern: it runs for every product, whether or not that product has the
Identity service turned on. A product with Identity off has no `/identity/*` routes, but its
customers still see its licenses in the portal, can claim them by key and can manage their
devices. What decides that is the product's portal settings (below), never `services_json`'s
`identity` flag. The one service flag the portal does read is Release's: release downloads need
both `releasesEnabled` and the Release service on.

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
share one IdP client and one trust boundary. The console has its own client (`ADMIN_OIDC_*`),
so operators and customers do not share one. Rate-limited to 20 requests per minute per IP; PKCE,
`state`, and `nonce` follow the same shape as the product flow, with the redirect URI fixed to
`<origin>/callback` rather than a product-scoped path.

**Magic links.** `POST /api/magic/start` takes `{ "email": "…" }`, rate-limited to 8 per minute
per IP, and — only if the platform has an `EMAIL` binding configured — sends a link to
`/magic/verify?token=…`. The token is single-use and expires in **10 minutes**: the record
behind it lives in the Worker's atomic single-use store (a sharded Durable Object) and
`/magic/verify` consumes it in one operation — read and delete together, before anything else is
checked — so a link can never be redeemed twice, not even by two clicks that arrive at once. The
portal OIDC `state` is held the same way. The email is explicit about the
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
- **`GET /api/library`** — the account's library: one entry per product it holds a license for
  (portal-enabled products only), with the product's presentation from its `.pkey/distribution`
  root `listing` (name, developer, tint, website, support links; the product name and nulls
  without one), the status of its best license (`suspended`, `expired`, `device_limit`,
  `expires_soon` within 14 days, `active`, first match wins), that license's seats
  (`deviceLimit` as activation enforces it, `activeSeatCount`, `dormantCount`), how many licenses
  it holds and when it was added. Art is only ever a same-origin `/media/…` URL. `discoverCount`
  is how many offers `GET /api/discover` has, for the Discover count in the nav; a product the
  account already holds is never offered or counted, so it never names one `products` lists.
- **`GET /api/discover`** — the products the account could add for free right now: every product
  whose license policy would auto-issue to it on the product's first sign-in, evaluated by that
  same policy function without issuing anything. A product qualifies through its `oidcDefault`
  auto-issue rule (`reason: "free_with_account"`) or a `groupRoleMap` group the account holds at
  the platform IdP (`reason: "group:<group>"`, from the `groups` claim of the account's last portal
  sign-in). Each offer carries the presentation, the newest release's `platforms`, what the
  account would get (`offer`: `tier`, `tierLabel`, `deviceLimit`, `expiresAt`, `expiryDays`) and
  its `reason`, which is always present. Only products that run License, sign in through the
  platform issuer with auto-linking on, and have the portal and Discover on are considered;
  purchase-only and operator-issued products, and products the account already holds, never
  appear. An account that has only ever signed in by email link has no platform identity and is
  offered nothing.
- **`POST /api/discover/<product>/claim`** — "Add to library". Re-evaluates the offer and mints
  the license through the sign-in's own auto-issue path, so it has exactly the tier, limits and
  entitlements a first sign-in would give; links it to the account and audits it
  (`portal.discover.claim`, and `license.create` in the product's activity, both with
  `source: discover`). Idempotent per account and product: a repeat or a double submit answers the
  same license with `added: false`. `409 not_eligible` when the product is not, or no longer,
  offered (an unknown product included). Shares the activate preview's rate bucket.
- **`GET /api/products/<product>`** — one of those products: the presentation, `services` (each
  service's own toggle), the status, and every linked license best first with its seats,
  entitlements and authorized devices, each marked `dormant` once it is past the 90-day dormancy
  window (a dormant device holds no seat), and its `purchase`: where it came from (`source` is
  `store` while a verified store purchase is active on it, else `developer`, `sign_in` or
  `free`), the stores, and each store grant with its state and dates. A grant names its flag only
  when the developer shows that flag in the portal; no purchase key is ever returned. The facts
  are License's, read through its `licenseProvenance` descriptor hook, so `purchase` is `null`
  while License is off. The product also carries `returnTo` (`{ origins, schemes }`): where the
  focused flows (`#/p/<product>/free-device` and `#/p/<product>/download`) may send the person
  back to with `?return=` — the product's exact `web.origins`; app schemes are always empty until
  the manifest can declare them, so a scheme return ends on the product page. `404` for a product
  the account holds nothing for.
- **`GET /media/<product>/<asset>`** — public, no session: the product's `icon` or `header` art
  from its listing, fetched by the Worker and served from this origin, because the portal's CSP is
  `img-src 'self' data:`. Only `https` sources on GitHub-hosted names (`github.com`,
  `*.githubusercontent.com`), at most three redirects each re-checked, at most 1 MB (icon) or
  5 MB (header), and only PNG, JPEG, WebP or GIF by their bytes; the answer carries the sniffed
  type, `nosniff` and a `default-src 'none'; sandbox` policy. Every refusal is the same `404`.
  With the URL's current `?v=` the answer is immutable for a year, otherwise cached for five
  minutes.
- **`DELETE /api/licenses/<product>/<licenseId>/devices/<deviceId>`** — disconnect one of the
  account's own devices. Ownership is checked _before_ the rate-limit charge is spent, so a
  caller who owns nothing on that product cannot spend a budget at all, and the budget it does
  spend is scoped to that one product rather than shared platform-wide (`R5-05`).
- **`PATCH /api/licenses/<product>/<licenseId>/devices/<deviceId>`** — rename one of the
  account's own devices: `{ "label": "Studio PC" }`, or `null` / `""` to clear the name. Plain text
  only: at most 64 characters after trimming, no control or format characters (so no
  bidirectional overrides). Ownership first, then 30 per minute in that product's shard; audited
  as `portal.device.rename`.
- **`POST /api/licenses/<product>/<licenseId>/keys`** — "Get a new key". Only for products whose
  operator turned on `keyReissueEnabled` (otherwise `404`, the same answer as a license that is not
  yours; the license detail says which with `canGetNewKey`). The sign-in must be at most 5 minutes
  old, otherwise `401 { "error": "step_up_required", "maxAgeSeconds": 300 }` and the customer signs
  in again. Every active key of the license is revoked and the new one inserted in one batch;
  the response (`201`, `no-store`) carries the raw key once, `{ key, revokedKeys, createdAt }`,
  and it is never readable again. Devices already activated keep working; the old key only stops
  activating new ones. 5 per hour in the product's shard; the account and the license's own email
  get a notice.
- **`POST /api/activate/preview`** — what adding a key would do, before it is added. Takes
  `{ "key": "pkey_…" }`; a string that is not exactly `pkey_<slug>_` plus 22 base64url characters
  is a `422`. Otherwise `200` with a `verdict`:

  | `verdict`        | Also carries                                                       | Meaning                                                                                    |
  | ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
  | `addable`        | `license` (tier, label, status, expiry, device limit), `platforms` | The key can be added.                                                                      |
  | `already_yours`  | the same, plus `license.id`                                        | Already in this account.                                                                   |
  | `license_owned`  | nothing else                                                       | In another account; a license never moves by its key (named `owned_elsewhere` until I-05). |
  | `email_mismatch` | `maskedEmail` (`m•••@proton.me`)                                   | Carries an email this account has not verified, and the product needs it.                  |
  | `portal_off`     | nothing else                                                       | The product manages this license elsewhere (portal or key claim switched off).             |
  | `unknown`        | nothing else                                                       | No such key (or it was replaced), or no such product.                                      |

  Every answer carries `product` (`null` for `unknown`, so a guessed key never reveals whether a
  product exists; otherwise `slug`, `name`, `branding`; `developerName`, `iconUrl` and
  `headerUrl` are reserved for the library presentation) and `entries`, which is `null` until key
  entries are counted. Nothing is written. A refusal never names the other account or the license.

- **`POST /api/claim/license-key`** — link a license by presenting a typed `pkey_…` key. It acts
  on the same evaluation as the preview, so the two never disagree: `401` for an unknown key,
  `404` when the product's portal or key claim is off, `403 license_owned` (a `409 owned_elsewhere` until I-05), and
  `403 email_mismatch` with `maskedEmail`; a license already yours answers `200` without writing or
  emailing again. A new link emails the account and, when it is a different address, the
  license's own email. The preview and the claim share one budget: 10 per minute per account.
- **`GET /api/releases`** and **`POST /api/releases/<product>/<releaseId>/artifacts/<artifactId>/token`**
  — the downloads surface, gated by _three_ independent things at once: the portal's own
  `releasesEnabled` toggle, whether the product runs the Release service at all
  (`services_json`), and — for a `licensed`-access artifact — whether the account holds a usable
  license for that product. Minting a token is refused up front when nothing can hand a browser
  the bytes, so nothing is ever minted that could only fail later: a `public` file redirects to
  Distribution's bytes host, which serves every location (R2, and GitHub through the Release
  installation token, so a private repository's files too); any other file only to its stored
  GitHub-storage URL, and only when the repository is public (a private one answers an
  anonymous browser with 404). An account with no linked license for the product gets the same
  `404` for every refusal; an owner is told why: `404 file_not_found` (the release or file is
  gone), `403 license_inactive` or `403 not_entitled`, and `409 not_hosted` (nothing here serves
  it yet), the same reasons the downloads view gives per file. Path segments are percent-decoded
  once, so an id such as `file:App-1.0.dmg` matches whether or not the client encoded it. The
  listing itself omits `signature` and `checksum` artifacts (`.sig` and `.sha256` sidecars): they
  are verification material, not downloads. As shipped, a download therefore needs a signed-in
  account **and** a license for the product linked to it (a usable one for `licensed` access);
  there is no anonymous path, and the redirect target is always the bytes host or a
  GitHub-storage host.
- **`GET /api/products/<product>/downloads[?channel=<channel>]`** — one product's downloads and
  store links, shaped for the product page's "Get it" section. Answered only for an account with
  a license for the product linked to it, behind the same three gates as `GET /api/releases`
  (every refusal is `404`), and rate-limited per account in the product's own shard. It returns
  the visitor's `detected` platform (from the User-Agent and the low-entropy client hints only),
  the `recommended` files for that platform, every platform's files in its newest release, the
  platform-free `extras`, and every store outlet (`kind`, `platforms`, `label`, `url`,
  `deepLink`, `command`, `activateUrl`, `live`, `version`; `activateUrl` is Steam's key-activation
  page, for a held Steam key). A universal build is recommended alone and flagged `universal`; otherwise
  every arch is, Apple silicon first on a Mac and the detected arch first when the browser said.
  Each file carries `canDownload` and, when false, a `reason`: `license_inactive` (no usable
  license), `not_entitled` (the license's channels or update window do not reach the release) or
  `not_hosted` (covered, but not yet served to a browser). When the newest release is not
  covered, the recommendation falls back to the newest one that is (`latest: false`). The
  product facts come from Distribution's `customerDownloads` hook, read through Core; whether the
  account may download is the same decision the token mint makes, so every file marked
  `canDownload` is one the mint answers. A product with Distribution off answers
  `available: false` with empty lists; `?channel=` names another channel (default `stable`).
- **`GET /download/<token>`** — redeems a minted token. Every one of those checks is run again
  here, at redemption, not assumed to still hold from mint time — portal enabled, releases
  enabled, account active, license still linked, licensed access still held — and the token is
  spent with a single conditional `UPDATE … WHERE used_at IS NULL`, so two concurrent redemptions
  of the same token cannot both win; exactly one sees the row change. See
  the R6 audit findings' `R6-12` for the redirect allowlist, and
  the R9 audit findings' `R9-05b` (the redemption used to be read-then-write, not
  compare-and-swap) for the atomic single-use fix.
- **`POST /api/products/<product>/email-download`** — `{ "platform": "macos" }` (one of
  `macos`, `ios`, `android`, `windows`, `linux`, `web`). Emails the account's own address a link
  to that product's download for that platform, so someone browsing on a phone can pick it up on
  their computer. The link is the signed-in app's `#/p/<product>/download?platform=…` route, never
  a download token, so a forwarded email opens a sign-in and nothing more. It needs a license for
  the product linked to the account, portal release downloads on and the Release service on
  (otherwise `404`, the same answer as an unknown product). It answers `422` for an unknown
  platform, `503 email_not_configured` without an `EMAIL` binding, and `202` when sent. Limited
  to 5 an hour per account and product; the bucket fails closed.

## Emails

Every email is from **Polaris Key** (`PORTAL_EMAIL_FROM`, default `Polaris Key <noreply@plrs.im>`)
and calls the service "Polaris Key", never "the portal". It names the product and the device by
their names, not their slugs or ids, and links to the exact section of the signed-in app:

| Email                | Subject (example)                           | Links to                           | Goes to                |
| -------------------- | ------------------------------------------- | ---------------------------------- | ---------------------- |
| Sign-in link         | Sign in to Polaris Key                      | `/magic/verify?token=…`            | the address typed      |
| License added by key | Mossgarden is in your library               | `#/p/<product>`                    | the session's address  |
| Download link        | Download Mossgarden for macOS               | `#/p/<product>/download?platform=` | the account's address  |
| Device removed       | Studio PC was removed from Tidewater Studio | `#/p/<product>/devices`            | every verified address |
| Account deleted      | Your Polaris Key account has been deleted   | nothing                            | every verified address |

The security notices (a device removed, and the sign-in method and new-device templates the
identity-linking work sends) carry "Wasn't you? Secure your account" and go to **every verified
email on the account**, one message per address. No link but the sign-in link carries a token.
Each message has a plain-text part and a branded HTML part (table layout, inline colours, a dark
palette for clients that honour `prefers-color-scheme`).

## Per-product portal settings

`portal_product_settings`, edited at `GET`/`PATCH /manage/api/products/<slug>/identity/portal`.
Five plain booleans, all defaulting **on** for a product that has never written a settings row:
`portalEnabled`, `oidcEnabled`, `magicEnabled`, `licenseKeyClaimEnabled`, `releasesEnabled`.

Two more default **off** (PX-W5, migration `0064`):

- `keyReissueEnabled` — customers may replace a license's key from the portal ("Get a new key").
- `claimByKey` — a license that carries an email may be added by anyone holding its key. Off is
  the S-16 safety default: such a license joins only an account that verified that email. A
  license already in an account never moves by its key either way.

`discoverEnabled` defaults **on** (PX-W10, migration `0071`): the product may be offered on
Discover to accounts its auto-issue policy covers. Turning it off hides the offer without
changing the policy, which keeps issuing on the product's own sign-in.

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

A portal account's OIDC identities are keyed by the issuer that minted the subject (the
configured platform issuer URL, without a trailing slash), not by a provider kind, so a second issuer's subjects can never
land in the platform issuer's namespace. Rows written before migration `0059` carried the literal
`oidc`; the Worker re-keys them to the platform issuer at the next portal OIDC sign-in. The
migration still accepts that literal on insert, so a Worker version from before it (still serving
mid-deploy, or rolled back to) keeps signing new users in; those rows are re-keyed the same way.

**In the console**, these settings are **Identity → Portal**. The sign-in methods and modules
are read-only while the portal switch is off, and **Release downloads** is read-only while the
product's Release service is off. The page saves the five switches and the linking choice in one
`PATCH`; it never sends `branding`, which it shows as a read-out. **Offer on Discover** (the Discover section) saves
with them.

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
