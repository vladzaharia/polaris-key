---
title: "Secrets & keys"
description: "Write-only product secrets and their usage, edge-mint recipe approval, the setup-health required-secrets list, outlet credentials, and signing-key rotation."
sidebar:
  order: 6
---

Two Platform-section surfaces, covered together because both are sealed under the same platform
KEK and both exist whether or not a product runs any service at all: the Secrets tab, and the
signing-key card on Settings.

## Product secrets

The Secrets tab is a **write-only** form: a name and a value, `PUT
/manage/api/products/<slug>/secrets/<name>`. The server seals the value under `PLATFORM_KEK` and
stores it; the response echoes the **name only** — never the value, on this write or any later
read. There is no endpoint that returns a secret's value, by design; if you need to confirm one
is right, rotate it rather than trying to recover it.

Typical secret names are an OIDC client secret (custom OIDC providers only — the platform
provider needs none) and an edge-mint signing key, one per recipe the product's manifest
declares (`EDGE_MINT__DJDL__APPLEMUSIC` is the production example — see [Operating: the KEK
keyring](/docs/admin/kek/) → _Product operations_).

### Secret usage

Each secret also has a **usage**, chosen in the form's _Usage_ selector (or sent as `"usage"` on
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

Below the form, products that declare edge-mint recipes get an **Edge-mint recipes** card. A
recipe arrives from the linked repo, so it mints only once you have **approved it exactly as it
stands**: each recipe shows as _Pending approval_, _Approved_, or _Changed since approval_ (with
the approved value beside each changed field), next to its signing secret's usage. **Approve**
shows the full recipe once more and records exactly those values; if a push changed it in the
meantime the approval is refused and the card reloads. **Revoke** drops the approval. When the
mint is public — the product's registration is open, auto-issue allows anonymous enrolment, or
Identity is on with an OIDC default tier — the card warns that an approved recipe is a public token mint, and approval needs an explicit
acknowledgement. The acknowledgement belongs to the approval: if the mint becomes public after you
approved without it, the recipe shows _Changed since approval_ and stops minting until you
re-approve it. When Identity is on, the card also shows the identity provider and group map an
approval covers, because signing in is how people get device tokens without a key; a push that
changes them makes the recipe _Changed since approval_ too, with the approved values beside the new
ones, and so does turning License off after an approval given with it on. When the change arrives
by a manifest push, the ingest also drops the approval (audited as `config.mint.invalidate`), so
the recipe returns to _Pending approval_ and a later push that reverts the change does not restore
it: review the licences and devices issued in between before you re-approve. While License is
off the card and the approve dialog warn that the mint does not check device licences, so an
approval given then (recorded as such) lets a disabled or expired licence mint. The setup checklist lists each recipe awaiting approval
and each recipe secret not yet marked edge-mint. The full rule, the admin endpoints and the
upgrade backfill are in [Edge-mint](/docs/services/config/edge-mint/#two-operator-conditions).

:::note[A different, related mechanism]
Catalog-declared **managed secrets** — a config entry with `kind: "secret"`, or `secret: true` —
are a different thing sealed a different way: they live nested inside a profile's or license's
managed-payload JSON, under a per-key AAD that binds each value to the product _and_ to the
catalog key it was written under. They're set through the license/profile override editor, not
here. Both mechanisms end up under `PLATFORM_KEK`, but a plain product secret and a
catalog-declared managed secret are stored in different tables and read through different code
paths. See [Config entry reference](/docs/reference/config-entry/) for the catalog side.
:::

### The required-secrets checklist

The same form shows a **Required secrets** list above the input — the product's setup-health
projection filtered to just the secret names it names, each with a **Configured**/**Missing**
badge and, where relevant, which part of the manifest asked for it (for example "Edge mint
applemusic"). Clicking a name fills it into the form. This is the same computation the Overview
tab's "needs attention" strip draws from — see [Products](/docs/admin/products/#setup-health)
for exactly which manifest fields feed it.

## Outlet credentials

Below the edge-mint card, the Secrets tab has an **Outlet credentials** card: the keys the
Distribution service uses to reach a store on the product's behalf. They are **not** product
secrets, and the difference is the point. Edge-mint can sign with any product secret an operator
marks _edge-mint_, for any device of the product — and under open registration anyone can be a
device — so a store key stored as a product secret would be one approval away from a public
token mint for your App Store Connect account. Outlet credentials live in their own table under
their own encryption binding: a value copied into the product-secret table does not even decrypt
there, and no edge-mint recipe can name one.

Four kinds exist today:

| Kind                         | Value                                                     | Least privilege                                                                    |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| App Store Connect API key    | key ID, issuer ID and the `.p8` file (a P-256 PKCS#8 key) | A **team** key with the **App Manager** role — not Admin.                          |
| App Store webhook secret     | the shared secret App Store Connect signs webhooks with   | Used only to verify Apple's webhook calls; let the Worker generate it.             |
| Google service account       | the service account's JSON key file                       | Invite the account to **one app** in Play Console with release permissions only.   |
| Microsoft Partner Center app | tenant ID, client ID, client secret and seller ID         | An Entra app added to Partner Center with the **Manager** role, not Account admin. |

Each is validated when you save it — a `.p8` that is not a P-256 PKCS#8 key, or a Google key that
is not RSA or names a token endpoint other than `https://oauth2.googleapis.com/token`, is refused
and nothing is stored. Of a Google key file only `client_email`, `private_key` and `token_uri` are
kept.

The rules, all enforced by the Worker rather than by the console:

- **Platform admins only, write-only.** `PUT /manage/api/products/<slug>/outlet-credentials/<id>`
  with `{kind, value, outletId?, expiresAt?}` seals and stores the value and echoes the **id
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
  Your own writes are audited as `outlet_credential.set` and `outlet_credential.delete`.
- **Deleted with the product,** and re-sealed by the KEK rotation sweep like everything else on
  this page (its own `outletCredentials` bucket in `GET /manage/api/products/kek`).

**Delete** (the bin icon on a row, `DELETE …/outlet-credentials/<id>`) removes the value for good;
connectors that used it stop working until a new one is set.

## Rotating the signing key

Every product signs everything it hands a client — license documents, config documents, trust
manifests, offline bundles — with one Ed25519 keypair, sealed the same way a product secret is.
**Prepare signing key**, available from both the product registry row menu and the Settings page,
is `POST /manage/api/products/<slug>/keys/rotate`:

1. A new Ed25519 keypair is generated and sealed under the active KEK.
2. It's inserted as **`staged`** — published for trust discovery, but not yet the key anything
   is signed with.
3. The response returns the new `kid` and **public key once**, in a dialog that stays open until
   you dismiss it. Record both now — this is the only response that ever carries the public key
   directly; after this it's only recoverable via the product's JWKS or trust-manifest endpoint.

The private key never leaves the platform's KEK-sealed storage at any point in this flow.

### The rest of the lifecycle

A staged key isn't live yet on purpose: clients need a **trust-refresh window** to have picked up
the new key from the trust manifest before anything is actually signed with it, or a client that
hasn't refreshed would reject a document signed by a `kid` it doesn't recognize. The full
lifecycle has four actions; today only the first has a console button — the rest are admin-API
calls, the same authenticated pattern [Offline bundles](/docs/admin/bundles/) describes for the
`pkey` CLI (a session cookie plus the echoed CSRF token):

| Action                                       | Endpoint                                     | Effect                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prepare** (console: _Prepare signing key_) | `POST .../keys/rotate` or `.../keys/prepare` | Mints and stages a new key.                                                                                                                                          |
| **Activate**                                 | `POST .../keys/activate`                     | Retires the current active key and promotes the staged one, in one batch. Refused (`409`) before the trust-cache window elapses unless `breakGlass: true` is passed. |
| **Retire**                                   | `POST .../keys/retire`                       | Marks a non-active key retired.                                                                                                                                      |
| **Revoke**                                   | `POST .../keys/revoke`                       | Marks a non-active key revoked (compromise response).                                                                                                                |

Retire and revoke both refuse (`409`) on the **currently active** key — stage and activate a
replacement first. A product must always have exactly one active key; this guard is what stops
an operator from accidentally leaving it with zero.

:::caution[If you suspect a key was compromised]
Prepare a new key, wait out (or break-glass through) the trust window, activate it, then revoke
the old one — the same shape as a `PLATFORM_KEK` compromise response in [Operating: the KEK
keyring](/docs/admin/kek/) → _KEK compromise (containment)_, one level down: that runbook
rotates the KEK that seals every product's keys; this rotates one product's own signing key.
:::

## Reference

- [Operating: the KEK keyring](/docs/admin/kek/) — the runbook for `PLATFORM_KEK` itself, which
  seals both the secrets and the keys on this page. If it's misconfigured, every product route
  serving something signed 404s silently — read that page's opening note before you touch it.
- [D1 data model](/docs/reference/data-model/) — `product_secrets`, `product_keys`,
  `outlet_credentials` and `edge_mint_approvals`.
- [Edge-mint](/docs/services/config/edge-mint/) — recipes, the two operator conditions, and the
  mint route.
- [Products](/docs/admin/products/#setup-health) — the full setup-health computation.
