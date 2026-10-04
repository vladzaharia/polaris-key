---
title: "Secrets & keys"
description: "Core → Keys & secrets: signing keys and their lifecycle, write-only product secrets and their usage, CI publishing, edge-mint recipe approval and outlet credentials."
sidebar:
  order: 6
---

**Core → Keys & secrets** (`#/p/<slug>/keys`) holds what a product signs and authenticates with,
whether or not it runs any service at all: its **signing keys**, its write-only **secrets**, and
its **CI publishing** credentials. Signing keys and secrets are sealed under the same platform KEK.
While Config or Distribution is on, the page ends with **Edge mint and store credentials**: the
edge-mint recipe approvals and the outlet credentials described below.

## Product secrets

Secrets are **write-only**. **Set secret** opens a drawer with a name, a value and a usage, and
saves with `PUT /manage/api/products/<slug>/secrets/<name>`. The server seals the value under `PLATFORM_KEK` and
stores it; the response echoes the **name only** — never the value, on this write or any later
read. There is no endpoint that returns a secret's value, by design; if you need to confirm one
is right, rotate it rather than trying to recover it.

Typical secret names are an OIDC client secret (custom OIDC providers only — the platform
provider needs none) and an edge-mint signing key, one per recipe the product's manifest
declares (for example `EDGE_MINT__DJDL__<RECIPE>` — see [Operating: the KEK
keyring](/docs/admin/kek/) → _Product operations_).

### Secret usage

Each secret also has a **usage**, chosen in the drawer's _Usage_ selector (or sent as `"usage"` on
the `PUT`):

| Usage                     | Meaning                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| _General_ (the default)   | An ordinary secret — an OIDC client secret, anything else. An edge-mint recipe can **never** sign with it. |
| _Edge-mint signing key_   | Key material an edge-mint recipe may sign with. Not usable as an OIDC client secret.                       |
| _Keep current_ (selector) | Sends no `usage`: an existing secret keeps what it had, a new one is general.                              |

The usage is the operator's decision and only the operator's — a `.pkey/` manifest can name a
secret in a recipe but can never make it signable. So re-uploading a rotated key with _Keep
current_ never changes what it may sign, and a change of usage is audited on its own as
`secret.usage`. The response echoes the name and the resulting usage, never the value.

### Edge-mint recipes

Edge-mint recipes are approved on their own page, **Config → Edge mint**. A recipe arrives from
the linked repo, so it mints only once its signing secret, set here with usage _Edge-mint signing
key_, is marked edge-mint and you have **approved the recipe exactly as it stands** there. The
setup checklist lists each recipe awaiting approval and each recipe secret not yet marked
edge-mint. The full rule (public mints, sign-in trust, License checks and why a widening is
permanent), the admin endpoints and the console page are on
[Edge mint](/docs/services/config/edge-mint/#approving-a-recipe); the upgrade backfill is in
[Two operator conditions](/docs/services/config/edge-mint/#two-operator-conditions).

:::note[A different, related mechanism]
Catalog-declared **managed secrets** — a config entry with `kind: "secret"`, or `secret: true` —
are a different thing sealed a different way: they live nested inside a profile's or license's
managed-payload JSON, under a per-key AAD that binds each value to the product _and_ to the
catalog key it was written under. They're set through the license/profile override editor, not
here. Both mechanisms end up under `PLATFORM_KEK`, but a plain product secret and a
catalog-declared managed secret are stored in different tables and read through different code
paths. See [Config entry reference](/docs/reference/config-entry/) for the catalog side.
:::

### The secrets list

The list is the union of every secret stored for the product and every secret its configuration
requires but nobody has set: each row has its **usage**, a **Configured** or **Missing** status,
when it was last set, and what requires it (for example "OIDC client secret", or "Edge mint" and
the recipe id). A row's **Set…** (or **Replace…**) opens the drawer with its name filled in.
Saving over a configured secret needs **Replace the existing value** ticked first, so a stored
value is never overwritten by accident. The required names come from the same setup computation
as the Overview checklist — see [Products](/docs/admin/products/#setup-health) for exactly which
manifest fields feed it.

`GET /manage/api/products/<slug>/secrets` returns the list as
`{ secrets: [{ name, configured, usage, createdAt, updatedAt, requiredBy }] }`. It never reads a
value: the sealed column is not even selected.

## Outlet credentials

**Distribution → Outlet credentials** holds the keys the Distribution service uses to reach a store
on the product's behalf, and the Sentry integration secret. They are **not** product
secrets, and the difference is the point. Edge-mint can sign with any product secret an operator
marks _edge-mint_, for any device of the product — and under open registration anyone can be a
device — so a store key stored as a product secret would be one approval away from a public
token mint for your App Store Connect account. Outlet credentials live in their own table under
their own encryption binding: a value copied into the product-secret table does not even decrypt
there, and no edge-mint recipe can name one.

A product with no outlet credential of a kind can instead use the platform's team-level
credential for that store, for the one app assigned to it — see [Store
connections](/docs/admin/store-connections/).

Seven kinds exist today:

| Kind                             | Value                                                     | Least privilege                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Store Connect API key        | key ID, issuer ID and the `.p8` file (a P-256 PKCS#8 key) | A **team** key with the **App Manager** role — not Admin.                                                                                                                                    |
| App Store webhook secret         | the shared secret App Store Connect signs webhooks with   | Used only to verify Apple's webhook calls; let the Worker generate it.                                                                                                                       |
| Google service account           | the service account's JSON key file                       | Invite the account to **one app** in Play Console with release permissions only ([Google Play connector](/docs/services/distribution/google-play/#least-privilege-for-the-service-account)). |
| Microsoft Partner Center app     | tenant ID, client ID, client secret and seller ID         | An Entra app added to Partner Center with the **Manager** role, not Account admin ([Microsoft Store connector](/docs/services/distribution/microsoft-store/#the-partner-center-app)).        |
| Sentry internal integration      | the integration's client secret                           | Used only to verify Sentry's alert webhooks; the Worker never calls Sentry ([Update health](/docs/services/distribution/update-health/#sentry-alerts)).                                      |
| App Store In-App Purchase key    | key ID, issuer ID and the `.p8` file (a P-256 PKCS#8 key) | Created under **Integrations → In-App Purchase** — not an App Store Connect API key. Pinned to the bundle id ([Commerce bridge](/docs/services/distribution/commerce/#app-store)).           |
| Steamworks Web API publisher key | the 32-hex-digit publisher key                            | A publisher key from a Steamworks group that can see only this game, pinned to its app id ([Commerce bridge](/docs/services/distribution/commerce/#steam)).                                  |

Each is validated when you save it — a `.p8` that is not a P-256 PKCS#8 key, or a Google key that
is not RSA or names a token endpoint other than `https://oauth2.googleapis.com/token`, is refused
and nothing is stored. Of a Google key file only `client_email`, `private_key` and `token_uri` are
kept.

The rules, all enforced by the Worker rather than by the console:

- **Platform admins only, write-only.** `PUT /manage/api/products/<slug>/outlet-credentials/<id>`
  with `{kind, value, pin?, outletId?, expiresAt?}` seals and stores the value and echoes the **id
  only**. Saving to an existing id of the same kind rotates it in place (and clears its health);
  saving a different kind to an existing id is refused (409) — delete it first. No `.pkey/`
  manifest, resync or service can write one. For an App Store webhook secret, send
  `{kind: "asc-webhook-secret", generate: true}` instead of a value: the Worker generates 32 random
  bytes and stores them without ever returning them, and the
  [App Store Connect connector](/docs/services/distribution/app-store-connect/)'s "register
  webhook" control hands them to Apple.
- **Metadata only on read.** `GET …/outlet-credentials` lists each credential's kind, outlet,
  non-secret identifiers (key ID, issuer ID, client email, tenant, client and seller IDs), when it
  was created and by whom, when it was last used, and the last result a connector reported. There
  is no endpoint that returns a value.
- **Every use is audited.** Only the Distribution service can open one, and each open writes an
  `outlet_credential.use` row to the product's activity log with actor `system:distribution` and
  what it was for (for example `asc:poll`) — including opens that failed. Connectors check their
  cache of short-lived tokens first and open the credential only when they need a fresh token, so
  this is tens of rows a day per credential, not one per request; a request served from the cache
  is not logged and does not move **Last used**.
  Your own writes are audited as `outlet_credential.set`, `outlet_credential.pin` and
  `outlet_credential.delete`.
- **You pick the app, not the repo.** An App Store Connect key is a team key: it can see every app
  in the team. So it carries a **pin**, the App Store Connect app id (the app's numeric Apple ID)
  of the one app it may be used for in this product, and its connector runs only while the
  product's `.pkey/distribution` names that same app. Send it as `pin` with the key (the form asks
  for it), or alone — `{"kind": "asc-api-key", "pin": "1234567890"}`, no `value` — to re-pin a
  stored key without pasting the `.p8` again (**Pin…** in a row's menu). A rotation that leaves `pin`
  out keeps the old pin. Each change of a pin is audited as `outlet_credential.pin` with the old
  and the new app id. A key with no pin, or a pin naming another app than the manifest does, is
  stored but unused: see
  [the connector's setup](/docs/services/distribution/app-store-connect/#pinning-the-app). The
  list shows the pin with the key's metadata (`meta.appleId`), and `pins` maps each kind that
  takes one to its field. A **Google service account** is pinned the same way, by the Play app's
  package name (`{"kind": "google-service-account", "pin": "gg.acme.dice"}`, `meta.packageName`),
  because one account can be invited to several apps: see
  [the Play connector's setup](/docs/services/distribution/google-play/#pinning-the-app). A
  **Microsoft Partner Center app** is pinned by the Store ID (`{"kind": "ms-partner-center",
"pin": "9NBLGGH4R315"}`, `meta.productId`), because its Manager role reaches every app of the
  seller account: see
  [the Microsoft Store connector's setup](/docs/services/distribution/microsoft-store/#pinning-the-app).
- **Deleted with the product,** and re-sealed by the KEK rotation sweep like everything else on
  this page (its own `outletCredentials` bucket in `GET /manage/api/products/kek`).

**Delete…** (in a row's menu, `DELETE …/outlet-credentials/<id>`) removes the value for good;
connectors that used it stop working until a new one is set. In the console, **Set credential…**
asks for the kind first, then its fields and its pin; **Rotate…** in a row's menu replaces a stored
value, and typing an existing id in Set credential warns that saving rotates it. Each row shows
the last result a connector reported, as text. Below the table, **Store connectors** shows each
connector's state and its configuration actions.

## Signing keys

Every product signs everything it hands a client — license documents, config documents, trust
manifests, offline bundles — with one Ed25519 keypair, sealed the same way a product secret is.
The **Signing keys** section lists every key with its state: **Active**, **Staged**, **Retired** or
**Revoked**, its algorithm, when it entered that state, and its public key with a copy button.
The product's JWKS URL sits under the list.

The lifecycle, all from this section:

| Action                         | Where                                       | Endpoint                                         | Effect                                                                                                                          |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Prepare signing key**        | the section header (asks first)             | `POST .../keys/prepare` (or `.../keys/rotate`)   | Mints a new key as **staged**: published for trust discovery, not yet signing anything.                                         |
| **Activate**                   | a staged row, once its trust window ends    | `POST .../keys/activate`                         | Retires the active key and promotes the staged one, in one batch.                                                               |
| **Activate now (break-glass)** | a staged row's menu, before the window ends | `POST .../keys/activate` with `breakGlass: true` | The same, early. You type the key id to confirm; clients that have not refreshed reject documents until they do.                |
| **Retire**                     | a staged row's menu                         | `POST .../keys/retire`                           | Marks a non-active key retired.                                                                                                 |
| **Revoke**                     | a retired row's menu (type the key id)      | `POST .../keys/revoke`                           | Marks a non-active key revoked: the trust manifest lists it as revoked and clients reject what it signed (compromise response). |

### Rotating the signing key

Rotation is Prepare, wait out the trust window, then Activate: the old key retires in the same
step and keeps verifying the documents it signed while it ages out of the trust set.

A staged key shows a live countdown to the end of its **trust-refresh window** (5 minutes):
clients need that long to pick the new key up from the trust manifest before anything is signed
with it, or a client that hasn't refreshed would reject a document signed by a `kid` it doesn't
recognize. Activate is disabled, with that reason, until the window ends.

Retire and revoke both refuse (`409`) on the **currently active** key — stage and activate a
replacement first. A product must always have exactly one active key; this guard is what stops
an operator from accidentally leaving it with zero. The private key never leaves the platform's
KEK-sealed storage at any point.

`GET /manage/api/products/<slug>/keys` returns
`{ keys: [{ kid, status, alg, publicKey, createdAt, activateAfter, activatedAt, retiredAt, revokedAt }], now }`
— public material only, active key first. `now` is the server's clock, which the countdown is
measured against.

:::caution[If you suspect a key was compromised]
Prepare a new key, wait out (or break-glass through) the trust window, activate it, then revoke
the old one — the same shape as a `PLATFORM_KEK` compromise response in [Operating: the KEK
keyring](/docs/admin/kek/) → _KEK compromise (containment)_, one level down: that runbook
rotates the KEK that seals every product's keys; this rotates one product's own signing key.
:::

## CI publishing

The **CI publishing** section holds how your CI proves who it is:

- **Trusted publisher** — the GitHub repository, workflow, environment and scopes a GitHub Actions
  run must match to exchange its OIDC token for a short-lived publishing token. A linked repo's
  manifest can declare it (_From manifest_); **Edit…** claims it (_Set in console_), after which
  resyncs leave it alone. Claiming is the only way to grant `release:yank`.
  `GET`/`PUT /manage/api/products/<slug>/ci-publisher`.
- **CI tokens** — static tokens for a CI that is not GitHub Actions, and the short-lived tokens
  trusted runs were issued, with their scopes, status and expiry. **Issue token…** shows a new
  token once (only its hash is stored); it lasts 1 to 90 days. **Revoke…** refuses it from then on,
  together with any upload tickets it bought and has not used.
  `GET`/`POST /manage/api/products/<slug>/ci-tokens`, `DELETE .../ci-tokens/<tokenId>`.

See [CI publishing](/docs/build/ci/) for the workflow side.

## Reference

- [Operating: the KEK keyring](/docs/admin/kek/) — the runbook for `PLATFORM_KEK` itself, which
  seals both the secrets and the keys on this page. If it's misconfigured, every product route
  serving something signed 404s silently — read that page's opening note before you touch it.
- [D1 data model](/docs/reference/data-model/) — `product_secrets`, `product_keys`,
  `outlet_credentials` and `edge_mint_approvals`.
- [Edge-mint](/docs/services/config/edge-mint/) — recipes, the two operator conditions, and the
  mint route.
- [Products](/docs/admin/products/#setup-health) — the full setup-health computation.
