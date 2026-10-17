---
title: "Products"
description: "The product registry: manual create vs. linking a GitHub repo, reserved slugs, resync, and what deleting a product actually does."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 3
---

`#/products` is the platform product registry — every product a session with platform-admin
authority can see: every product. This page covers registering one,
turning its services on and off, and the setup-health checklist the
[Overview page](/docs/operate/console/tour/#core) and Home are built from. Resync, linking a
repository and deleting are on [Product actions](/docs/operate/console/product-actions/).

The registry is a table: each product's logo and name (a link to its Overview; a click anywhere on
the row follows it), slug, the services it runs, whether its setup is complete, where it comes from
(GitHub or manual) and when it last changed. Search, the Setup and Source filters, and the sort
live in the URL, so a filtered view can be bookmarked or shared.

**Home** (`#/`) is the cross-product view of the same registry: a **Needs attention** list (every
product's open setup items, each with the one link that fixes it), live figures (products,
products needing attention, repository-linked) and a card for each of the six products changed last,
with **All products** opening this table. A card shows the product's logo, its name and slug, and one
icon for each service it runs. Each icon is named and links to that service's page; the name opens
the product's **Overview**. A product that needs something shows a pill beside its name: the one
issue, or the number of issues. A healthy card shows no status at all.

The logo is the product's hosted icon: the copy Polaris Key keeps of the `presentation.icon` in
`.pkey/product`, or of the store listing's icon. Until a copy exists, or when it cannot load, the
card shows the name's first letter on a plain tile. A failed re-fetch keeps showing the last good
copy.

## Registering a product

**New product** opens one screen at `#/products/new`. **Start from** picks the source:
**Nothing** or **A GitHub repository** (`?via=manual|github` preselects it). There are no steps
and no review page: fill the fields and press **Enter** or the button to create. The draft is
kept for the tab, so a refresh loses nothing; leaving with a draft asks first.

A refusal stays on the screen, in plain words, with its fix beside it. A refusal about one field
sits on that field and moves focus there, such as a taken slug or a repository the GitHub App
can't read. Anything else goes in a callout above the button, such as a manifest the server
would not accept. Nothing is created until every check passes.

There is no result page. A new product opens on its **Overview**, which shows "_Name_ is ready"
once, with the new signing `kid` and a button that copies its public key. Give the public key to
your SDK trust configuration and release tooling; it is also in the product's JWKS. The private
key never leaves the platform: it is sealed under `PLATFORM_KEK` from the moment it's minted.
Dismiss the welcome, refresh, or come back later and Overview shows its ordinary setup.

### Starting from nothing

For early experiments, before release syncing, OIDC or provisioning matter. Type the **Name**
first. The **Slug** follows it (lowercase letters, digits and hyphens) until you edit it, and it is
checked against the registry as you type. A taken slug says so and offers a free one to take
with one click (**Use tonebox-app**). A reserved or malformed slug is refused before anything is
sent. The slug is permanent: it is used in keys and URLs.

**Advanced: license defaults** holds the per-license offline grace (1 to 365 days) and device
limit. Leave either blank to use the platform default. A config catalog, the compatibility window
([Update → Feed](/docs/operate/console/tour/#update)) and everything else are set up later from
Overview. The worker mints an Ed25519 signing key and an empty active catalog in one batch:
**a product can never exist without a usable signing key**. No release row and no edge-mint row
are created, because this path has no GitHub coordinates to hang them on.

### From a GitHub repository

This is the path onboarding uses. Give the repository as `owner/repo` or its GitHub URL and press
**Link repository**. The linked GitHub App reads the `.pkey/` directory on the default branch,
validates the manifest, and registers the product from it: name, slug, services, tiers, profiles,
OIDC configuration, release coordinates, edge-mint recipes, all of it. The name and slug come from
`.pkey/product`, so the screen does not ask for them.

When the link is refused, the screen shows what to do next:

- **The GitHub App isn't installed on the repository, or the repository is private.** The message
  sits on the Repository field, with **Install the GitHub App** beside it. Install the Polaris Key
  GitHub App on the repository, then link again.
- **The manifest has problems.** The callout lists each problem with its file and path, so you can
  fix them all in one commit. Push the fix and press **Check again** to link again.
- **The manifest's slug is taken, reserved or malformed.** Change `product.slug` in
  `.pkey/product`, push, then press **Check again**. Linking registers new products only: if the
  slug is taken because this repository is already registered, open that product and resync it
  instead (see [What resync actually re-applies](/docs/operate/console/product-actions/#what-resync-actually-re-applies)).

Overview's welcome lists any **remaining secrets**. These are names the manifest declared that
have no value yet, such as an OIDC client secret or an edge-mint signing key. A **Set _n_ missing
secrets** link goes to [Keys & secrets](/docs/operate/console/keys-and-secrets/). Secrets are write-only
and never echoed back.

### What a create writes

Both paths write the same defaults in the one batch as the product, so a new product is ready
for an SDK without another call. If any row fails, none is written.

| Row               | Written                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Signing key       | Ed25519, sealed, active                                                                   |
| Catalog           | Version 1: the supplied or `.pkey/schema` catalog, else an empty one                      |
| Default profile   | `default`, empty. The id is reserved; a `.pkey/` that declares its own `default` keeps it |
| Free tier         | `free`, rank 0, on the Default profile. Skipped when License is off or `.pkey/` has tiers |
| Services          | The ones you ask for; License and Config otherwise                                        |
| Planned platforms | The platforms you plan to ship (`distribution.intendedPlatforms`)                         |
| Release trust     | From a repository: `.github/workflows/release.yml` as the product's CI publisher          |

The API takes these as `services`, `intendedPlatforms`, `starterTier` (`free` or `none`) and, on
`link-repo`, `trustReleaseWorkflow`. A service whose requirement is off is refused with its
`<service>_requires_<requirement>` code. From a repository, `services` adds to what `.pkey/`
enables. The licence defaults and the compatibility window are not create fields: tiers and
platform defaults own the first, `release.compatWindow` the second.

### Reserved slugs

A product slug can't collide with a root path the router matches before `/<product>/…` — that
product would be permanently shadowed, every one of its routes unreachable. Both creation paths
refuse the same list:

`docs` · `manage` · `api` · `assets` · `login` · `logout` · `callback` · `magic` · `download` ·
`webhooks` · `well-known` · `media` · `activate` · `avatar`

The admin API's own one-segment actions under `/manage/api/products/` are reserved the same way,
because a product slugged like one would have its console record shadowed: `kek` · `link-repo` ·
`slug-check`.

The shape is one rule too: lowercase letters, digits and hyphens, 1–64 characters, starting with a
letter or digit (`^[a-z0-9][a-z0-9-]{0,63}$`). The manifest validator (so `pkey validate`,
link-repo and resync), the slug check and manual create all apply the same shape and lists from
`@polaris-key/manifest`, and refuse with the same codes (`invalid_slug`, `reserved_slug` — see
[Manifest validation codes](/docs/reference/validation-codes/)).

### The system product

`polaris-key` is the platform's own product: it owns the platform packages (the SDKs and the
`pkey` image) on the package feeds. It is not a reserved slug — its `.pkey/` at the root of this
repository is an ordinary manifest — but neither creation path makes it: manual create and
link-repo both refuse the slug. Only the package-feeds bootstrap creates it, idempotently:

```http
/manage/api/platform/feeds/bootstrap (POST)
```

Platform admins only. The bootstrap runs the same creation path as a manual create (a signing
key generated and sealed under `PLATFORM_KEK`, the empty catalog), marks the row as the system
product, turns Release and Distribution on, turns its package feeds on and seeds one feed per
ecosystem with the platform's namespaces (`@polaris-key`, `polaris-key`, `im.plrs.key`, the
PyPI name `polaris-key`, the Godot publisher `polaris-key`; Swift releases must be signed). A
second run creates nothing and leaves an operator's later feed settings alone. It is audited as
`feed.bootstrap` in the [platform trail](/docs/operate/console/activity/#the-platform-trail) and answers
`{ ok, slug, created }`; a product of that slug that is not the system product is refused (409,
`slug_taken`).

The system product cannot be deleted or renamed (409, `system_product`), and the console keeps it
out of the product switcher and the Products list. It is always
[manifest-authoritative](/docs/operate/console/product-actions/#manifest-authoritative-mode): its only manifest writer is the deploy hook,
which every production deploy runs with the root `.pkey/` at the deployed commit.

### The `adminGroup` field is metadata, not a grant

Settings has no input for it: a product that has one shows it read-only, marked
**Not enforced** (New product does not ask for it either). It's recorded on the
product row and shown back to you, and it authorizes **nothing**: there is no
per-product admin tier. The console authorizes every request on the platform-wide
`PLATFORM_ADMIN_GROUP` alone (a platform admin sets it).
The field exists because a product's own OIDC configuration (`.pkey/product`'s `oidc.groupRoleMap`)
often names a group with a similar-looking purpose for a _different_ system — that product's own
customer-facing sign-in — and the two are hard to tell apart. If you're setting this to grant
someone console access, it does not: add them to the platform OIDC provider's admin group instead.

A product's **Settings** page holds its registry fields and the **Danger zone**, where **Delete product…** lives. Everything else it edits has its own page.

## Setup health

The Overview tab's "needs attention" strip and guided checklist, the registry's Setup column and
Home's Needs attention list are all projections of one server-computed setup state, recomputed on
every product read rather than cached. It checks six
things:

| Module              | Healthy when                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signing key**     | An active signing key exists.                                                                                                                                                                                              |
| **OIDC**            | Platform provider: `PLATFORM_OIDC_ISSUER`/`PLATFORM_OIDC_CLIENT_ID` are configured worker-wide. Custom provider: the product's own issuer, client id and client-secret product-secret are all set.                         |
| **Release**         | (Linked products only) A GitHub repo, an installation id, and a binary name are all present.                                                                                                                               |
| **Customer portal** | Always "configured" — this module reports its enabled/disabled state, not a completeness check.                                                                                                                            |
| **Manifest sync**   | The most recent resync attempt didn't error.                                                                                                                                                                               |
| **Edge mint**       | Every recipe's signing secret is set and marked usage `edge-mint`, and every recipe is [approved](/docs/features/managed-config/edge-mint/#approving-a-recipe) as it stands (`needs-secret` / `needs-approval` otherwise). |

Anything incomplete surfaces two ways: as a plain-language entry in the "needs attention" strip,
and as an actionable row in the checklist (a direct link to Secrets, Settings, or Releases,
whichever fixes it). The **required secrets** list on
[Keys & secrets](/docs/operate/console/keys-and-secrets/) is drawn from the same computation — a
product's OIDC and edge-mint configuration name which secrets it needs, and setup health checks
whether each one is actually set.

## Services & enablement

Services are product features, generated from `tools/services.json`: Licensing, Managed config,
Ship builds, Sign-in and Cloud Sync. The feature groups control the services that back them; a
feature is not a separate service model.

`/manage/api/products/<slug>/services` (GET) returns service state and feature facts. `PATCH` writes
a partial service state, while `POST .../services/revert` hands ownership to the manifest. GET
facts remain visible in the console after a mutation response updates its service state.

Ship builds is one feature switch. Enabling it sends Release, Distribution and In-app updates in
one PATCH, hence one audited write. Its nested In-app updates switch controls only Update.

Device registration is derived, never declared: License means `requires-license`; otherwise
Identity means `requires-identity`; otherwise it is open. `devices.registration` is removed and
the manifest validator rejects it with a replacement message.

## Coherence rule

The Worker owns the generated `SERVICE_REQUIRES` rule. It refuses an enable request whose
prerequisite is off. Disabling a prerequisite cascades all dependents in the same audited write;
the console first sends a dry run and names those cascades in its confirmation. Turning a
prerequisite back on never restores a dependent.

| Service        | Requires       | Refusal code                    |
| -------------- | -------------- | ------------------------------- |
| Distribution   | Release        | `distribution_requires_release` |
| In-app updates | Distribution   | `update_requires_distribution`  |
| Cloud Sync     | Managed config | `sync_requires_config`          |
| Cloud Sync     | Sign-in        | `sync_requires_identity`        |

`services_json` is owned by either `manifest` or `admin`. PATCH claims it for `admin`; reverting
only returns ownership to `manifest`, leaving live state unchanged until the next resync.

## Where enablement actually takes effect

Turning a service off doesn't hide a page — it makes the service **not exist** from the outside.
A disabled service's routes 404 exactly like an unregistered slug or a typo'd path (deliberately
indistinguishable, so probing which services a product runs isn't free), its discovery document
entry becomes `{"enabled": false}` with no endpoint list, its console nav section drops instead
of greying out (a deep link to it opens a page that offers **Enable** and the section's name),
and the customer portal stops offering whatever that service backed. Identity has one more
answer: a person who follows a sign-in link of the product in a browser is sent to the portal's
sign-in page (`/signin?product=<slug>&error=identity_disabled`) instead of a JSON 404; apps and
scripts still get the 404. Read
[The service model](/docs/start/service-model/) for the four projections and the full coherence
rule set this page's table is drawn from.

## Package feeds

Under **Ship builds**, the **Packages** switch is Distribution's one sub-capability: whether the
product's packages are served on the registry host. It is operator-owned (a manifest never writes
it), blocked until Ship builds is on, and saves on its own, through
`/manage/api/products/<slug>/distribution/package-feeds` (PUT) with `{enabled, expectedVersion}`; a
stale version is a 409 and nothing changes. Turning it off asks first, because every feed of the
product answers not-found within 30 seconds. While it is on, **Distribution → Package feeds** is in
the sidebar: see [Package feeds](/docs/features/ship-builds/packages/).

## Reference

- [D1 data model](/docs/reference/data-model/) — `products`, `product_keys` and `product_secrets`,
  including `services_json` and `services_source`.
- [Manifest validation codes](/docs/reference/validation-codes/) — every code the `.pkey/`
  validator can emit, including `reserved_slug`.
- [Authoring the manifest](/docs/build/manifest/) — the `.pkey/` format both creation paths
  validate against.
- [The device principal](/docs/reference/protocol/device-principal/) — the registration policies in
  full.
- [Product actions](/docs/operate/console/product-actions/#what-resync-actually-re-applies) — how a resync interacts with
  an admin-claimed row.
