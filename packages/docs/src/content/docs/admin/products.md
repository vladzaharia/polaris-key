---
title: "Products"
description: "The product registry: manual create vs. linking a GitHub repo, reserved slugs, resync, and what deleting a product actually does."
sidebar:
  order: 3
---

`#/products` is the platform product registry — every product a session with platform-admin
authority can see, which today is every product that exists. This page covers registering one,
what its lifecycle actions actually do server-side, and the setup-health checklist the
[Overview tab](/docs/admin/console-tour/#platform) is built from.

## Registering a product

**New product** opens a two-tab dialog. Both tabs end with a success panel naming the new
product's signing `kid` and public key — **record it now**; the private key never leaves the
platform, sealed under `PLATFORM_KEK` from the moment it's minted.

### Manual

For early experiments, before release syncing, OIDC or provisioning matter. You supply a slug,
an optional display name, an optional config catalog (JSON or YAML — publish one later from
Catalog if you skip it), and the per-license defaults (compat window, offline days, device
limit). The worker mints an Ed25519 signing key and an active catalog (empty if none was
supplied) in one batch — **a product can never exist without a usable signing key**. No release
row and no edge-mint row are created; this path has no GitHub coordinates to hang them on.

### From GitHub

The path onboarding actually uses. You give a repository URL; the linked GitHub App reads its
`.pkey/` directory, validates the manifest, and registers the product from it — services,
tiers, profiles, OIDC configuration, release coordinates, edge-mint recipes, all of it. The
success panel lists **remaining secrets**: names the manifest declared but that have no value
yet (an OIDC client secret, an edge-mint signing key). Set each one from
[Secrets & keys](/docs/admin/secrets-and-keys/) — they're write-only and never echoed back.
This is also the path DJDL uses in production; see [Operating: the KEK
keyring](/docs/admin/kek/) → _Product operations_ for its specific checklist.

### Reserved slugs

A product slug can't collide with a root path the router matches before `/<product>/…` — that
product would be permanently shadowed, every one of its routes unreachable. Both creation paths
refuse the same list:

`docs` · `manage` · `api` · `assets` · `login` · `logout` · `callback` · `magic` · `download` ·
`webhooks` · `well-known`

The link-repo path gets this for free from manifest validation (`reserved_slug` — see
[Manifest validation codes](/docs/reference/validation-codes/)); manual create checks the same
list explicitly.

### The `adminGroup` field is metadata, not a grant

Both dialogs, and Settings, carry an "Admin group" field labeled _metadata only_. It's recorded
on the product row and shown back to you, and it authorizes **nothing**: there is no
per-product admin tier. The console authorizes every request on the platform-wide
`PLATFORM_ADMIN_GROUP` alone (see [Operating: the KEK keyring](/docs/admin/kek/) → _Secrets_).
The field exists because a product's own OIDC configuration (`.pkey/product`'s `oidc.groupRoleMap`)
often names a group with a similar-looking purpose for a _different_ system — that product's own
customer-facing sign-in — and the two are easy to conflate. If you're setting this to grant
someone console access, it won't: add them to the platform OIDC provider's admin group instead.

## Per-product actions

From the registry row menu or the product's own Settings page:

| Action                               | What it does                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Edit**                             | Updates name and per-license defaults. The compatibility window isn't here — it moved to [Update settings](/docs/admin/console-tour/#update). |
| **Set secret**                       | Shortcut into [Secrets & keys](/docs/admin/secrets-and-keys/).                                                                                |
| **Resync from GitHub**               | GitHub-linked products only (greyed out otherwise). Re-fetches `.pkey/` from the repo's default branch and re-applies it — see below.         |
| **Prepare signing key**              | Stages a new Ed25519 keypair. See [Secrets & keys](/docs/admin/secrets-and-keys/#rotating-the-signing-key).                                   |
| **Delete** (Danger zone on Settings) | Tombstones the product. See below.                                                                                                            |

### What resync actually re-applies

Resync re-reads `schema`, `product` and `release` from the linked repo's **default branch** —
never a caller-supplied ref, so the manifest applied to production can't be a function of an
unreviewed branch — and re-applies each in place:

- Product metadata (name, compat window, defaults) is overwritten unconditionally.
- The catalog gets a new active `schemaVersion` **only when its content actually changed**.
- `release_config` is updated in place; the release truth store re-syncs in the same batch.
- `oidc_config`, `profiles`, `tiers`, `provisioning_config` and `edge_mint_config` are replaced
  from the manifest — these have no live-admin override, so the manifest is always the last
  word for them. Removing a tier or profile the manifest still lists as unused is refused (409)
  while a license still references it.
- **Services enablement and the fingerprint/auto-issue policies follow the ownership rule**:
  the manifest's values are written only while the row is still `manifest`-owned. Once an
  operator edits one of those live (claiming it as `admin`-owned), a resync no longer touches it
  — see [Services & enablement](/docs/admin/services-enablement/#manifest-vs-admin-ownership).

A resync is one D1 transaction: either everything above lands together, or a validation failure
(a bad catalog, an OIDC issuer change that fails the platform's own gate) leaves the product
exactly as it was.

### What deleting a product actually does

"Delete" is a **tombstone**, not a row deletion — nothing here is a `DELETE FROM`. It:

- flips the product's `status` to `deleted` and stamps `deleted_at`;
- disables every license **and scrubs its PII** — `email`, `name`, `sub`, `groups`, and the
  enroll-dedupe hardware hash are all set to null, though the license row and its history stay;
- deauthorizes every device and revokes their license keys;
- revokes every signing key (retiring the product's ability to sign anything new); and
- removes portal account-to-license links for the product.

Audit rows are never touched — the product's own history, including the deletion itself, is
preserved. You confirm by typing the product's slug back, the same pattern the license
enable/disable and tier/profile deletes use for anything that can't be undone.

## Setup health

The Overview tab's "needs attention" strip and guided checklist are both projections of one
server-computed setup state, recomputed on every product read rather than cached. It checks six
things:

| Module              | Healthy when                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signing key**     | An active signing key exists.                                                                                                                                                                      |
| **OIDC**            | Platform provider: `PLATFORM_OIDC_ISSUER`/`PLATFORM_OIDC_CLIENT_ID` are configured worker-wide. Custom provider: the product's own issuer, client id and client-secret product-secret are all set. |
| **Release**         | (Linked products only) A GitHub repo, an installation id, and a binary name are all present.                                                                                                       |
| **Customer portal** | Always "configured" — this module reports its enabled/disabled state, not a completeness check.                                                                                                    |
| **Manifest sync**   | The most recent resync attempt didn't error.                                                                                                                                                       |
| **Edge mint**       | Every edge-mint recipe's declared signing-key secret has a value.                                                                                                                                  |

Anything incomplete surfaces two ways: as a plain-language entry in the "needs attention" strip,
and as an actionable row in the checklist (a direct link to Secrets, Settings, or Releases,
whichever fixes it). The **required secrets** list on
[Secrets & keys](/docs/admin/secrets-and-keys/) is drawn from the same computation — a
product's OIDC and edge-mint configuration name which secrets it needs, and setup health checks
whether each one is actually set.

## Reference

- [D1 data model](/docs/reference/data-model/) — the `products`, `product_keys` and
  `product_secrets` columns this page describes.
- [Manifest validation codes](/docs/reference/validation-codes/) — every code the `.pkey/`
  validator can emit, including `reserved_slug`.
- [Authoring the manifest](/docs/build/manifest/) — the `.pkey/` format both creation paths
  validate against.
