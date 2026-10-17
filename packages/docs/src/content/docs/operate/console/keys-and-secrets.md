---
title: "Keys & secrets"
description: "Keys & secrets: signing keys and their lifecycle, write-only product secrets and their usage, CI publishing, edge-mint approval and outlet credentials."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 6
---

**Keys & secrets** (`#/p/<slug>/settings/keys`, a tab of **Settings**) holds what a product signs and
authenticates with, whether or not it runs any service: its **Signing keys**, its write-only
**Secrets** and its **CI publishing** credentials. Signing keys and secrets are sealed under the
same platform KEK. Edge-mint recipes are approved on **Config → Edge mint**, and store credentials
are on **Distribution → Outlet credentials**.

## Product secrets

Secrets are **write-only**. **Set secret** opens a drawer with a name, a value and a usage, and
saves with `/manage/api/products/<slug>/secrets/<name>` (PUT). The server seals the value under `PLATFORM_KEK` and
stores it; the response echoes the **name only** — never the value, on this write or any later
read. There is no endpoint that returns a secret's value, by design; if you need to confirm one
is right, rotate it rather than trying to recover it.

Typical secret names are an OIDC client secret (custom OIDC providers only — the platform
provider needs none) and an edge-mint signing key, one per recipe the product's manifest
declares (for example `EDGE_MINT__<PRODUCT>__<RECIPE>`).

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
[Edge mint](/docs/features/managed-config/edge-mint/#approving-a-recipe); the upgrade backfill is in
[Two operator conditions](/docs/features/managed-config/edge-mint/#two-operator-conditions).

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
as the Overview checklist — see [Products](/docs/operate/console/products/#setup-health) for exactly which
manifest fields feed it.

`/manage/api/products/<slug>/secrets` (GET) returns the list as
`{ secrets: [{ name, configured, usage, createdAt, updatedAt, requiredBy }] }`. It never reads a
value: the sealed column is not even selected.

## Outlet credentials

Store keys and the Sentry integration secret are not product secrets. They live on
**Distribution → Outlet credentials**, in their own table, and no edge-mint recipe can name one. A
platform admin sets them: see Outlet credentials (platform admins).

## Signing keys

Every product signs everything it hands a client — license documents, config documents, trust
manifests, offline bundles — with one Ed25519 keypair, sealed the same way a product secret is.
The **Signing keys** section lists every key with its state: **Active**, **Staged**, **Retired** or
**Revoked**, its algorithm, when it entered that state, and its public key with a copy button.
The product's JWKS URL sits under the list.

The lifecycle, all from this section:

| Action                         | Where                                                                     | Endpoint                                         | Effect                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Prepare signing key**        | the section header (asks first); disabled while a rotation is in progress | `POST .../keys/prepare` (or `.../keys/rotate`)   | Mints a new key as **staged**: published for trust discovery, not yet signing anything.                                         |
| **Activate**                   | the rotation strip, once its trust window ends                            | `POST .../keys/activate`                         | Retires the active key and promotes the staged one, in one batch.                                                               |
| **Activate now (break-glass)** | the rotation strip's menu, before the window ends                         | `POST .../keys/activate` with `breakGlass: true` | The same, early. You type the key id to confirm; clients that have not refreshed reject documents until they do.                |
| **Cancel rotation**            | the rotation strip's menu                                                 | `POST .../keys/retire`                           | Retires the staged key; the active key keeps signing.                                                                           |
| **Revoke**                     | a retired row's menu (type the key id)                                    | `POST .../keys/revoke`                           | Marks a non-active key revoked: the trust manifest lists it as revoked and clients reject what it signed (compromise response). |

### Rotating the signing key

Rotation is Prepare, wait out the trust window, then Activate: the old key retires in the same
step and keeps verifying the documents it signed while it ages out of the trust set.

While a key is staged, a strip above the list walks the rotation: **Prepared → Trust window →
Activate → Old key retires**. The trust window step counts down the **trust-refresh window**
(5 minutes): clients need that long to pick the new key up from the trust manifest before
anything is signed with it, or a client that hasn't refreshed would reject a document signed by a
`kid` it doesn't recognize. Activate is disabled, with that reason, until the window ends.

For 30 days after an activation, one line says what share of the devices active in the last 30
days have **refreshed** since the new key went live: devices whose last contact with the platform
came after the activation. The platform keeps no per-device record of a trust fetch, so this is a
reassurance, not proof that a given device holds the new key.

Retire and revoke both refuse (`409`) on the **active** key — stage and activate a
replacement first. A product must always have exactly one active key; this guard is what stops
an operator from accidentally leaving it with zero. The private key never leaves the platform's
KEK-sealed storage at any point.

`/manage/api/products/<slug>/keys` (GET) returns
`{ keys: [{ kid, status, alg, publicKey, createdAt, activateAfter, activatedAt, retiredAt, revokedAt }], now, refresh }`
— public material only, active key first. `now` is the server's clock, which the countdown is
measured against. `refresh` is `{ kid, activatedAt, activeDevices, refreshedDevices, windowDays }`
for 30 days after the active key replaced another, and `null` otherwise.

:::caution[If you suspect a key was compromised]
Prepare a new key, wait out (or break-glass through) the trust window, activate it, then revoke
the old one — the same shape as a `PLATFORM_KEK` compromise response, one level down: that rotates the KEK
that seals every product's keys (platform admins), this rotates one product's own signing key.

A revoked key stays listed as revoked in the trust manifest for 400 days. A client that pins
both keys tombstones the revoked one when it reads that manifest: it never trusts it again,
even for a key its app compiled in. A client that pinned **only** the revoked key cannot be
told, and needs an app update.
:::

**Pin at least two keys.** Prepare a second key before you build, so the app ships with both
pinned and one can revoke the other. `pkey sdk` warns when discovery lists only one key. An app
whose pins predate a rotation still updates its keys: it asks for the trust manifest signed by
a key it pins (`?signer=<kid>`), which any active, staged or retired key can sign.

## CI publishing

The **CI publishing** section holds how your CI proves who it is:

- **Trusted publisher** — the GitHub repository, workflow, environment and scopes a GitHub Actions
  run must match to exchange its OIDC token for a short-lived publishing token. A linked repo's
  manifest can declare it (_From manifest_); **Edit…** claims it (_Set in console_), after which
  resyncs leave it alone. Claiming is the only way to grant `release:yank`.
  `GET`/`/manage/api/products/<slug>/ci-publisher` (PUT).
- **CI tokens** — static tokens for a CI that is not GitHub Actions, and the short-lived tokens
  trusted runs were issued, with their scopes, status and expiry. **Issue token…** shows a new
  token once (only its hash is stored); it lasts 1 to 90 days. **Revoke…** refuses it from then on,
  together with any upload tickets it bought and has not used.
  `GET`/`/manage/api/products/<slug>/ci-tokens` (POST), `DELETE .../ci-tokens/<tokenId>`.

See [CI publishing](/docs/build/ci/) for the workflow side.

## Reference

- [D1 data model](/docs/reference/data-model/) — `product_secrets`, `product_keys`,
  `outlet_credentials` and `edge_mint_approvals`.
- [Edge-mint](/docs/features/managed-config/edge-mint/) — recipes, the two operator conditions, and the
  mint route.
- [Products](/docs/operate/console/products/#setup-health) — the full setup-health computation.
