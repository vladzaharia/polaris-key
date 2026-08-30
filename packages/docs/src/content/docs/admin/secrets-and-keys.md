---
title: "Secrets & keys"
description: "Write-only product secrets, the setup-health required-secrets list, and signing-key rotation."
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

## Rotating the signing key

A product has **two** Ed25519 keypairs, each sealed the same way a product secret is, and which
one you are rotating decides what the operation costs:

| Class        | Signs                                                   | Clients pin it? | Rotating it costs           |
| ------------ | ------------------------------------------------------- | --------------- | --------------------------- |
| **document** | license documents, config documents, offline bundles    | No              | Nothing. Routine.           |
| **anchor**   | the trust manifest (`pkey-trust+jws`), and nothing else | **Yes**         | **An application release.** |

A client verifies a trust manifest against its **pinned** keys and nothing else — that is what
stops a manifest from introducing the key that verifies it. So whichever key signs the manifest
is the key every install has compiled in, and moving it moves the ground under all of them at
once: they would reject every later manifest, stop advancing their signed clock, and stop
receiving revocations. Splitting the anchor out is what makes a document-key rotation a routine
operation instead of a release, because the manifest signer does not move.

**The anchor is what an adopter pins.** It is what `signing.trustKeys` returns at product
creation and what `trust.pinnedKeys` advertises in discovery. `signingKid` — the `kid` you will
see in the header of every license and config document — is the _document_ key, and pinning it is
the mistake this split exists to prevent.

**Prepare signing key**, available from both the product registry row menu and the Settings page,
is `POST /manage/api/products/<slug>/keys/rotate` and stages a **document** key by default:

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

| Action                                       | Endpoint                                     | Effect                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prepare** (console: _Prepare signing key_) | `POST .../keys/rotate` or `.../keys/prepare` | Mints and stages a new key. Body `{"role":"document"}` (default) or `{"role":"anchor"}`.                                                                                                 |
| **Activate**                                 | `POST .../keys/activate`                     | Retires the current active key **of the staged key's class** and promotes the staged one, in one batch. Refused (`409`) before the trust-cache window elapses unless `breakGlass: true`. |
| **Retire**                                   | `POST .../keys/retire`                       | Marks a non-active key retired.                                                                                                                                                          |
| **Revoke**                                   | `POST .../keys/revoke`                       | Marks a non-active key revoked (compromise response).                                                                                                                                    |

Retire and revoke both refuse (`409`) on the **currently active** key of either class — stage and
activate a replacement first. A product must always have one active anchor and one active
document key; this guard is what stops an operator from accidentally leaving it with zero.

Activating a document key leaves the anchor exactly where it was: that is the point, and it is
why an installed client follows a document-key rotation without noticing.

:::caution[Rotating the anchor is an application release]
Preparing an anchor returns `requiresApplicationRelease: true`, and it means it. Clients pin the
anchor, so you must ship a build that pins **both** the outgoing and the incoming anchor, wait for
adoption, and only then activate. Activating before adoption takes every un-updated install dark:
it will refuse every trust manifest and stop receiving revocations, while running on its cached
documents until `graceUntil`. The full procedure is in `docs/RUNBOOK.md` → _Rotating a product
signing key_.
:::

:::caution[If you suspect a key was compromised]
For a **document** key: prepare, wait out (or break-glass through) the trust window, activate,
then revoke the old one. No client action at all.

For the **anchor**: same shape, but the wait is for application adoption rather than a 300-second
cache window — see the note above. If the attacker can mint manifests, activate immediately and
accept that un-updated installs go dark until they update; that is the trade the pinning rule
buys.

Either is the same shape as a `PLATFORM_KEK` compromise response in [Operating: the KEK
keyring](/docs/admin/kek/) → _KEK compromise (containment)_, one level down: that runbook
rotates the KEK that seals every product's keys; this rotates one product's own signing key.
:::

## Reference

- [Operating: the KEK keyring](/docs/admin/kek/) — the runbook for `PLATFORM_KEK` itself, which
  seals both the secrets and the keys on this page. If it's misconfigured, every product route
  serving something signed 404s silently — read that page's opening note before you touch it.
- [D1 data model](/docs/reference/data-model/) — `product_secrets` and `product_keys`.
- [Products](/docs/admin/products/#setup-health) — the full setup-health computation.
