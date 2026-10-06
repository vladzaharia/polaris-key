---
title: "Identity"
description: "Product OIDC, browser sessions, the device-code flow, and the customer portal."
sidebar:
  order: 1
---

Identity is one of the six opt-in services over Core. It answers who a **human** is, to one
product: a browser or a CLI proves an identity against an OpenID Connect provider, and Identity
turns that into a **license** the rest of the suite already understands, a **browser session** a
page can hold as a cookie, or — for a headless client — a per-device token handed back through a
poll.

It also implements the **customer portal**, a self-service account surface that spans every
product on the deployment. The portal's routes are platform-level rather than product-scoped
(see [Customer portal](/docs/services/identity/portal/) for why), but its tables and its code
live inside this service.

D-14 makes this a deliberately narrow carve: what lands here is the OIDC, browser-session and
portal code that already existed, moved into `services/identity/` with a namespace and a
descriptor around it — not a new, centralized identity capability. Building that is explicitly
out of scope for now. A product that does not enable Identity has no `/identity/*` routes at
all. The customer portal is the exception: it is a platform concern and runs for every product
regardless of the Identity flag, governed by the product's portal settings instead (see
[Customer portal](/docs/services/identity/portal/#the-identity-flag-does-not-gate-the-portal)).

## In this section

| Page                                                         | What it covers                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Product OIDC](/docs/services/identity/oidc/)                | The platform-vs-custom provider choice, the PKCE browser flow, `groupRoleMap`, `activateFromIdentity`, the `oidcDefault` auto-issue fallback, provisioning hooks, and the issuer allowlist. |
| [The device-code flow](/docs/services/identity/device-flow/) | The device-code start, user-code, and poll routes — sign-in for a client that cannot receive a browser redirect.                                                                            |
| [Browser sessions](/docs/services/identity/sessions/)        | The session cookie, the fused session document and its build gate, key-to-session exchange, logout, and how `requires-identity` device registration is authorized without a license.        |
| [Customer portal](/docs/services/identity/portal/)           | The root-level, cross-tenant account surface: sign-in, account erasure, license claiming, device management, and gated release downloads.                                                   |

## The public surface

Ten product-scoped routes, all under `/<product>/identity`:

| Route                                         | What it is                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /<p>/identity/session`                   | The browser session's fused document                                        |
| `POST /<p>/identity/session/license`          | Mint a browser session from a license key                                   |
| `GET /<p>/identity/auth/start`                | Begin browser OIDC (PKCE) — 302 to the IdP                                  |
| `GET /<p>/identity/auth/callback`             | The OIDC redirect URI                                                       |
| `GET`/`POST /<p>/identity/auth/choose`        | The legacy sign-in's license chooser — a step of the choice, or the choice  |
| `POST /<p>/identity/auth/logout`              | End the browser session                                                     |
| `POST /<p>/identity/auth/device/start`        | Begin the device-code flow                                                  |
| `GET`/`POST /<p>/identity/auth/device`        | The RFC 8628 user-code page — type or scan the code, then confirm           |
| `GET`/`POST /<p>/identity/auth/device/verify` | The device-authorization page — side-effect-free `GET`, CSRF-checked `POST` |
| `POST /<p>/identity/auth/device/poll`         | Poll the device-code flow                                                   |

The full generated table — every service, every method — is at
[Public route table](/docs/reference/routes/).

The customer portal adds a second surface — `/login`, `/callback`, `/logout`, `/magic/verify`,
`/api/*`, and `/download/<token>` — reserved ahead of every product slug rather than nested under
one. See [Customer portal](/docs/services/identity/portal/).

:::note[No aliases]
Before the service carve, these routes answered at `/<p>/auth/…` and `/<p>/session`. Those
spellings are **deleted, not aliased** — unlike the four permanent aliases Release and Update
keep for tooling that has a URL compiled into a shipped artifact (`/<p>/appcast.xml`,
`/<p>/install.sh`, …), nothing external ships an identity URL that way: an SDK reads its URLs out
of `/<product>/.well-known/polaris.json`, and a browser flow is entered from a page the
deployment itself serves. `/auth/login`, a second spelling of `/auth/start`, is gone the same
way rather than kept as a compatibility alias.

The one path an operator does pin by hand is an IdP's registered redirect URI — that moves with
the product to `…/<p>/identity/auth/callback`, because it is per-product configuration an
operator re-registers, not a shipped binary.
:::

## Turning it on

Identity follows the same single-authority enablement every service does: `products.services_json`
carries an `identity` key with a boolean `enabled`, and Core checks that flag _before_ consulting
this service's descriptor — a disabled product's `/identity/*` routes 404 exactly like an
unregistered slug or a bad path, and no handler ever runs to tell the two apart.

Two things follow from that:

- **`registration_requires_identity`.** A product may only declare
  `devices.registration: requires-identity` while Identity is enabled. The enablement API
  (`PATCH /manage/api/products/<slug>/services`) refuses the combination otherwise: there is no
  login to stand behind, so turning Identity off would silently take registration away rather
  than restrict it. See [Browser sessions](/docs/services/identity/sessions/) for what that
  policy actually authorizes.
- **`enabled` vs. `configured`.** The discovery document's `identity` fragment carries both.
  `enabled` is the flag, full stop. `configured` is separate — whether an `oidc_config` row
  exists yet — because a product can consent to the service before anyone has pointed it at an
  IdP, and a client that cannot tell "on but not set up" from "on and serving" retries a 500
  forever.

## Key entries

While Identity is on, the product counts **key entries** per licence (WIRE-CONTRACT-V4 §12.2): a
new device activating by key, a browser key session (`POST /<p>/identity/session/license`, whose
`201` then answers `{"ok": true, "keyEntries": {"used": 1, "limit": 10}}`), and a portal claim
that adds the key to an account. An enrolled device entering the key again, sign-in, enrollment
and token refresh never count. The table is Core's (`license_key_entries`), because License, the
browser key session and the portal all write it.

- **`identity.keyEntry.limit`** (product setting): 1 to 100, default 10, never unlimited. Until
  the settings resolver (ST-04) lands it is read from the product's settings row and is not
  editable in the console.
- **`identity.keyEntryRefusals`** (platform setting, Platform → Settings, stored as
  `KEYENTRY_REFUSALS`): off by default. While it is on, a new device whose key belongs to a usable
  licence in no account, at or past the limit, gets `403 key_entry_limit` with `keyEntries` and a
  `manageUrl` to the portal's activate page. Counting runs either way. Turn it on only once the
  SDKs that show the refusal are released.

The details, and the refusal's body, are in
[Activation](/docs/services/license/activation/#key-entries-identity-products). The portal's
previews report the same `keyEntries` — see
[Customer portal](/docs/services/identity/portal/).

## Two shapes of credential

Every sign-in — browser or device-code — runs the same PKCE exchange and lands on the same
mint-or-locate-a-license step (`activateFromIdentity`, covered in
[Product OIDC](/docs/services/identity/oidc/)). What differs is what comes out the other end:

- A browser flow started with a `return_to` gets a `pkey_<product>_session` **cookie**, set
  directly on the callback's redirect. See [Browser sessions](/docs/services/identity/sessions/).
- A flow with no `return_to` hands its result to a poller, which redeems it into a raw device
  **token** instead. A device-code flow (which never has a `return_to`) goes one step further:
  its callback only stores the verified identity, and `/device/poll` activates it, so the
  device-code holder can be shown the identity first and opt in to
  [attaching the device's anonymous license](/docs/services/identity/device-flow/#attaching-the-devices-anonymous-license). See
  [The device-code flow](/docs/services/identity/device-flow/).

Both paths authorize the _same_ device principal Core defines; they just hand the result back in
the shape their caller can actually use — a page can hold a cookie, a headless client cannot.
Neither path is available to a product that skips Identity entirely: a `requires-license`
product still mints tokens exclusively through activation and enrollment, and an `open` product
mints them from `POST /<product>/devices/register` with no identity involved at all.

## What Identity owns

Eight D1 tables, logically owned the way every service's are — one database, crossed only
through a Core-mediated seam, enforced by a boundary test that refuses cross-service imports:

- `oidc_config`, `provisioning_config` — one product's IdP choice, group mapping, and claim
  provisioning hooks. See [Product OIDC](/docs/services/identity/oidc/).
- `portal_accounts`, `portal_account_emails`, `portal_account_identities`,
  `portal_license_links`, `portal_product_settings`, `portal_audit` — the customer portal. See
  [Customer portal](/docs/services/identity/portal/).

## The admin surface

`GET`/`PATCH /manage/api/products/<slug>/identity/portal` — the customer-portal module settings
described in [Customer portal](/docs/services/identity/portal/).

Product OIDC is manifest-fed: `oidc_config` and `provisioning_config` are written by
`.pkey/product`'s `oidc:` and `provisioning:` blocks through repo link and resync, never by an
admin route.

In the console, the **Identity** section has two pages: **Portal** (`#/p/<slug>/identity/portal`)
edits the customer-portal settings above, and **Sign-in** (`#/p/<slug>/identity/sign-in`) shows
the product's provider, issuer, client and group → tier map read-only, with **Resync from repo**
to apply a manifest change. See [The console](/docs/admin/console-tour/).

:::note[Terminology]
This section follows [Concepts & terminology](/docs/start/concepts/), which wins over code when the two disagree. In
particular: **license** (never "account" on its own), **claim** and **migrate** for the two ways
a signed-in identity meets an auto-issued license, and **customer portal** (never "dashboard" or
"account portal") for the cross-tenant surface in
[Customer portal](/docs/services/identity/portal/).
:::

## Where the guarantees are pinned

Prose is not the contract. These are:

- `docs/security/WIRE-CONTRACT-V3.md` §3.2 and §5 — the fused session document and its build
  gate, alongside the license document's.
- The design spec, `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` — §2.1
  (taxonomy), §4.1/§4.3 (routes and discovery), §5.1/§5.2 (layout and table ownership), and
  decision **D-14** (the carve boundary this whole section describes).
- The red-team findings that shaped the current code (a point-in-time audit; the write-ups are
  not published, the IDs are stable labels): the R8 audit findings (the
  three OIDC flows), the R9 audit findings (the issuer allowlist), the R5 audit findings (the portal's
  cross-tenant linking), the R6 audit findings (the download redirect), the R1 audit findings (the
  portal session cookie), and the R11 and R12 audit findings (retention and erasure). Each detail
  page in this section cites the specific finding that holds its claims up.
