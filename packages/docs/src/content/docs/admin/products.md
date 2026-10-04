---
title: "Products"
description: "The product registry: manual create vs. linking a GitHub repo, reserved slugs, resync, and what deleting a product actually does."
sidebar:
  order: 3
---

`#/products` is the platform product registry — every product a session with platform-admin
authority can see, which today is every product that exists. This page covers registering one,
what its lifecycle actions actually do server-side, and the setup-health checklist the
[Overview page](/docs/admin/console-tour/#core) and Home are built from.

The registry is a table: each product's name (a link to its Overview; a click anywhere on the row
follows it), slug, the services it runs, whether its setup is complete, where it comes from
(GitHub or manual) and when it last changed. Search, the Setup and Source filters, and the sort
live in the URL, so a filtered view can be bookmarked or shared.

**Home** (`#/`) is the cross-product view of the same registry: a **Needs attention** list (every
product's open setup items, each with the one link that fixes it), live figures (products,
products needing attention, setup complete, repository-linked) and a card per product with the
services it runs. Its filter and sort are in the URL too.

## Registering a product

**New product** opens a full-page wizard at `#/products/new`. You choose the source first
(**Link a GitHub repository** or **Start manually**; `?via=github|manual` preselects it), then
fill one step at a time. The step is in the URL (`?step=…`) and the draft is kept for the tab, so
a refresh loses nothing; leaving with a draft asks first. A **Review** step comes before anything
is created. The result names the new product's signing `kid` and public key, with a copy button —
give the public key to your SDK trust configuration and release tooling (it is also in the
product's JWKS); the private key never leaves the platform, sealed under `PLATFORM_KEK` from the
moment it's minted. **Open product** takes you to its Overview.

### Manual

For early experiments, before release syncing, OIDC or provisioning matter. The steps are
**Basics** (a slug, an optional display name and the metadata-only admin group), **Catalog** (an
optional config catalog in JSON or YAML — publish one later from Catalog if you skip it) and
**Defaults** (the per-license offline days and device limit; blank uses the platform default). The
compatibility window is not asked for: it lives in
[Update → Feed](/docs/admin/console-tour/#update). The worker mints an Ed25519 signing key and an active catalog (empty if none was
supplied) in one batch — **a product can never exist without a usable signing key**. No release
row and no edge-mint row are created; this path has no GitHub coordinates to hang them on.

### From GitHub

The path onboarding actually uses. You give a repository URL; the linked GitHub App reads its
`.pkey/` directory, validates the manifest, and registers the product from it — services,
tiers, profiles, OIDC configuration, release coordinates, edge-mint recipes, all of it. A refused
manifest is listed problem by problem on the Review step, so you can fix them in one commit. The
result lists **remaining secrets**: names the manifest declared but that have no value yet (an
OIDC client secret, an edge-mint signing key), with a **Set missing secrets** button into
[Secrets & keys](/docs/admin/secrets-and-keys/) — they're write-only and never echoed back.
This is also the path DJDL uses in production; see [Operating: the KEK
keyring](/docs/admin/kek/) → _Product operations_ for its specific checklist.

### Reserved slugs

A product slug can't collide with a root path the router matches before `/<product>/…` — that
product would be permanently shadowed, every one of its routes unreachable. Both creation paths
refuse the same list:

`docs` · `manage` · `api` · `assets` · `login` · `logout` · `callback` · `magic` · `download` ·
`webhooks` · `well-known` · `media`

The link-repo path gets this for free from manifest validation (`reserved_slug` — see
[Manifest validation codes](/docs/reference/validation-codes/)); manual create checks the same
list explicitly.

### The system product

`polaris-key` is the platform's own product: it owns the platform packages (our SDKs and the
`pkey` image) on the package feeds. It is not a reserved slug — its `.pkey/` at the root of this
repository is an ordinary manifest — but neither creation path makes it: manual create and
link-repo both refuse the slug. Only the package-feeds bootstrap creates it, idempotently:

```http
POST /manage/api/platform/feeds/bootstrap
```

Platform admins only. The bootstrap runs the same creation path as a manual create (a signing
key generated and sealed under `PLATFORM_KEK`, the empty catalog), marks the row as the system
product, turns Release and Distribution on, turns its package feeds on and seeds one feed per
ecosystem with the platform's namespaces (`@polaris-key`, `polaris-key`, `im.plrs.key`, the
PyPI name `polaris-key`, the Godot publisher `polaris-key`; Swift releases must be signed). A
second run creates nothing and leaves an operator's later feed settings alone. It is audited as
`feed.bootstrap` in the [platform trail](/docs/admin/activity/#the-platform-trail) and answers
`{ ok, slug, created }`; a product of that slug that is not the system product is refused (409,
`slug_taken`).

The system product cannot be deleted or renamed (409, `system_product`), and the console keeps it
out of the product switcher and the Products list.

### The `adminGroup` field is metadata, not a grant

The wizard's Basics step, and Settings, carry an "Admin group" field labeled _metadata only_. It's recorded
on the product row and shown back to you, and it authorizes **nothing**: there is no
per-product admin tier. The console authorizes every request on the platform-wide
`PLATFORM_ADMIN_GROUP` alone (see [Operating: the KEK keyring](/docs/admin/kek/) → _Secrets_).
The field exists because a product's own OIDC configuration (`.pkey/product`'s `oidc.groupRoleMap`)
often names a group with a similar-looking purpose for a _different_ system — that product's own
customer-facing sign-in — and the two are easy to conflate. If you're setting this to grant
someone console access, it won't: add them to the platform OIDC provider's admin group instead.

## Per-product actions

The registry row menu opens the product's own pages rather than repeating their forms, so each
setting has one form with one set of rules:

| Action                                                        | What it does                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Open overview**, **Open settings**, **Open keys & secrets** | Go to that page of the product. Name and per-license defaults are edited in Settings; secrets and signing keys in [Secrets & keys](/docs/admin/secrets-and-keys/). |
| **Resync from repo…**                                         | Repository-linked products only. Re-fetches `.pkey/` from the repo's default branch and re-applies it — see below. You confirm the consequences first.             |
| **Delete product…** (also the Danger zone on Settings)        | Tombstones the product. See below.                                                                                                                                 |

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

**Delete product** is a **tombstone**, not a row deletion — nothing here is a `DELETE FROM`. It:

- flips the product's `status` to `deleted` and stamps `deleted_at`;
- disables every license **and scrubs its PII** — `email`, `name`, `sub`, `groups`, and the
  enroll-dedupe hardware hash are all set to null, though the license row and its history stay;
- deauthorizes every device and revokes their license keys;
- revokes every signing key (retiring the product's ability to sign anything new); and
- removes portal account-to-license links for the product.

Audit rows are never touched — the product's own history, including the deletion itself, is
preserved. You confirm by typing the product's slug back; what you type is what the console sends
the worker as `confirmSlug`, which the worker checks against the slug before it changes anything.

## Setup health

The Overview tab's "needs attention" strip and guided checklist, the registry's Setup column and
Home's Needs attention list are all projections of one server-computed setup state, recomputed on
every product read rather than cached. It checks six
things:

| Module              | Healthy when                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Signing key**     | An active signing key exists.                                                                                                                                                                                      |
| **OIDC**            | Platform provider: `PLATFORM_OIDC_ISSUER`/`PLATFORM_OIDC_CLIENT_ID` are configured worker-wide. Custom provider: the product's own issuer, client id and client-secret product-secret are all set.                 |
| **Release**         | (Linked products only) A GitHub repo, an installation id, and a binary name are all present.                                                                                                                       |
| **Customer portal** | Always "configured" — this module reports its enabled/disabled state, not a completeness check.                                                                                                                    |
| **Manifest sync**   | The most recent resync attempt didn't error.                                                                                                                                                                       |
| **Edge mint**       | Every recipe's signing secret is set and marked usage `edge-mint`, and every recipe is [approved](/docs/services/config/edge-mint/#approving-a-recipe) as it stands (`needs-secret` / `needs-approval` otherwise). |

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
