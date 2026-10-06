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

The registry is a table: each product's logo and name (a link to its Overview; a click anywhere on
the row follows it), slug, the services it runs, whether its setup is complete, where it comes from
(GitHub or manual) and when it last changed. Search, the Setup and Source filters, and the sort
live in the URL, so a filtered view can be bookmarked or shared.

**Home** (`#/`) is the cross-product view of the same registry: a **Needs attention** list (every
product's open setup items, each with the one link that fixes it), live figures (products,
products needing attention, repository-linked) and a card for each of the six most recently changed
products, with **All products** opening this table. A card shows the product's logo, its name and
slug, and one row per service it runs. Each row links to that service's page and shows one fact:
the active licenses, the latest release and its channel, the storefronts, the catalog's schema
version or the users. When a service needs something, its row shows what instead, and links to
the fix. A product with more than four services lists three rows (those that need something
first) and links to the rest by their icons. An issue that belongs to the product itself, such as
a missing signing key, is a pill beside its name. A healthy card shows no status at all.

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
([Update → Feed](/docs/admin/console-tour/#update)) and everything else are set up later from
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
  instead (see [What resync actually re-applies](#what-resync-actually-re-applies)).

Overview's welcome lists any **remaining secrets**. These are names the manifest declared that
have no value yet, such as an OIDC client secret or an edge-mint signing key. A **Set _n_ missing
secrets** link goes to [Secrets & keys](/docs/admin/secrets-and-keys/). Secrets are write-only
and never echoed back. This is also the path DJDL uses in production; see [Operating: the KEK
keyring](/docs/admin/kek/) → _Product operations_ for its specific checklist.

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
out of the product switcher and the Products list. It is always
[manifest-authoritative](#manifest-authoritative-mode): its only manifest writer is the deploy hook,
which every production deploy runs with the root `.pkey/` at the deployed commit.

### The `adminGroup` field is metadata, not a grant

Settings carries an "Admin group" field labeled _metadata only_ (New product does not ask for it). It's recorded
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

- Product metadata (name, licence defaults, web origins) is written unless the console has
  claimed that field; the admin group is manifest-only and always follows the manifest. The
  compatibility window follows the ownership rule below.
- The catalog gets a new active `schemaVersion` **only when its content actually changed**, and
  never once a console publish has claimed it.
- `release_config` is updated in place; the release truth store re-syncs in the same batch.
- `oidc_config`, `provisioning_config` and `edge_mint_config` are replaced from the manifest —
  these have no live-admin override, so the manifest is always the last word for them.
- `tiers` and `profiles` are applied per row: a row created or edited in the console is left
  alone, and a manifest row the manifest drops is removed when nothing references it.
- Manifest-owned `profiles` follow the manifest, **except for their secret values**. A manifest
  can't carry a secret value, so the secrets an operator set on a profile in the console are
  carried forward, still sealed, onto every profile the manifest still lists. The pushed catalog
  decides what counts: a value is carried only while its key is still a `secret` entry, or a
  `config` entry flagged `secret: true`, in the catalog this push brings, and only if it is
  stored sealed. A key the new catalog drops or stops calling secret loses its value, and a
  plaintext value is never carried. A key the manifest's own profile payload declares wins, and
  a profile the manifest drops is removed, secrets and all. Setting a plain config value or a
  flag on a profile in the console claims that profile for the console, so later resyncs leave
  it alone.
- Dropping a tier or profile from the manifest is refused (409) while a license still
  references it.
- **Services enablement and the fingerprint/auto-issue policies follow the ownership rule**:
  the manifest's values are written only while the row is still `manifest`-owned. Once an
  operator edits one of those live (claiming it as `admin`-owned), a resync no longer touches it
  — see [Services & enablement](/docs/admin/services-enablement/#manifest-vs-admin-ownership).

A resync is one D1 transaction, and every check runs before it: either everything above lands
together, or a refusal (a bad catalog, an OIDC issuer change that fails the platform's own gate,
a dropped tier a license still uses) leaves the product exactly as it was. Each setting, tier or
profile it changes gets its own audit row.

### Claimed settings

On a repository-linked product, saving the display name or a licence default in Settings
claims it for the console: you confirm first, the row's source badge then reads **Set in
console**, and resyncs leave it alone. **Revert…** in that badge restores the value from the
last applied manifest at once, or at the next resync for a product not applied since claims
arrived. Publishing the catalog claims it the same way, with Revert in the catalog's source
badge. The admin group is read-only there: change it in `.pkey/product`.

### Manifest-authoritative mode

A repository-linked product can make its `.pkey/` the only writer of its **display name, licence
defaults, web origins and catalog**: turn on **Manifest-authoritative** in Settings → Repository
(you confirm first). Off is the default. While it is on, saving one of those in the console is
refused unless it is a **break-glass claim**, for an incident that cannot wait for a commit:

- You give a reason (up to 500 characters, kept in the audit log) and confirm a level-2 dialog.
  The API takes the same write with `breakGlass: { reason }`; without it the answer is 409
  `manifest_authoritative`.
- The claim ends after **7 days**, or at the **first resync that changes that field** in
  `.pkey/`, whichever comes first. The manifest's value then applies. A resync that leaves the
  field alone keeps the claim, so an unrelated push cannot undo the fix.
- Saving the setting again makes a new break-glass claim: it needs a new reason, audited like the
  first, and restarts the 7 days.
- The setting's row says when its claim ends, and every resync's result lists the live
  break-glass claims and the ones it ended. Revert to manifest ends one early.

To keep a break-glass value, commit it to `.pkey/`. Settings claimed before you turned the mode on
stay claimed until you revert them. The other settings `.pkey/` declares — services and
registration, the fingerprint and auto-issue policies, the compatibility window, the release
access modes, tiers and profiles, and the trusted publisher — are not yet refused by the mode: a
console edit still claims them as before. They move to it with the settings work packages ST-04
and ST-05.

**The system product** is manifest-authoritative always; the switch shows it locked, and the
settings registry, not a stored value, fixes it (`core.manifest.authoritative`). Its manifest is the
monorepo's root `.pkey/`, and its only manifest writer is the deploy hook (`POST /webhooks/deploy`,
called by `deploy.yml` with every production deploy at the deployed commit; see
[Releasing](/docs/contribute/releasing/)): a push webhook for the platform repository and a console
Resync of it are refused with "the system product is applied by the deploy hook", and Settings
offers no Resync for it. Today the deploy hook applies the release configuration, the package
deliverables, the trusted publisher and each enabled service's manifest rows, plus the value of
any field whose break-glass claim it ends. It does not yet apply the display name, the licence
defaults, the web origins, the catalog or the admin group from `.pkey/`; applying every declared
field is a later settings work package (ST-17). Its break-glass claims (today on the licence defaults: its display name and
admin group cannot be changed in the console) end after 7 days or at the first deploy that
changes the field, and each deploy's log names the live ones as warnings.

Every save is checked against the [settings reference](/docs/reference/settings/): the display
name and the admin group are at most 200 characters, the device limit at most 1,000,000 and the
offline grace 1 to 365 days, and a value outside answers 422 `invalid_value`.

### Linking a repository to an existing product

A product created from nothing (or before its repository had a `.pkey/`) can be handed over to
its manifest later: **Settings → Repository → Link repository…**, or **Link a repository** on the
Releases page before the first release. Both open the same drawer, and it works in two steps.

1. **Check.** Type `owner/repo` or the repository's GitHub URL. The console runs the link's checks
   and marks each one: the repository parses, the Polaris Key GitHub App can read it, the
   `.pkey/` manifest validates, and its `product.slug` is this product's slug. It also runs the
   checks a resync would otherwise hit halfway: an OIDC issuer change outside the platform's
   allowlist, an unsafe binary name, a catalog the validator refuses. Nothing is written. A
   passing check lists what the link will do:
   - **Applies**: the values and rows the manifest writes (name and defaults, a new catalog
     version, tiers, profiles, release settings, the trusted publisher, and so on);
   - **Stays (set in the console)**: values the manifest declares but an operator already set
     here (services, the compatibility window, the fingerprint and auto-issue policies, release
     access, a trusted publisher saved in Keys & secrets). The ownership rule above applies from
     the first apply;
   - **Removes**: tiers, profiles, catalog keys, token recipes and so on that the product has and
     the manifest does not declare;
   - **Blocks the link**: a tier or profile the manifest drops while licenses still use it. Add it
     to the manifest or move the licenses, then check again.
2. **Link repository.** The console sends back a digest of the manifest it checked. If someone
   pushed to `.pkey/` in between, the link is refused (`409`) and asks for a fresh check, so the
   manifest applied is always the one you read. Otherwise the product's source becomes the
   repository and the manifest is applied by the same code as **Resync from repo**. The signing
   key is not touched. Secrets the manifest names but cannot carry are listed for you to set in
   [Secrets & keys](/docs/admin/secrets-and-keys/).

The link is recorded in Activity as _linked the product to a repository_. After it, every push to
the default branch re-applies `.pkey/`, exactly as for a product created from its repository. The
platform's own product cannot be linked here: the deploy hook links it.

The API is `POST /manage/api/products/<slug>/release/link?dryRun=1` with `{ "repoUrl" }` for the
check, then `POST …/release/link` with `{ "repoUrl", "manifestDigest" }`. A refusal's `reason`
names the check that failed: `product`, `repository`, `app`, `manifest`, `slug` or `policy`.

### The settings backfill

Products registered before claims existed carry console edits that no claim records, and their
tiers and profiles all read as manifest-owned. The **settings backfill** moves such a product onto
the claim model once, by one rule: **every field and tier or profile the product's `.pkey/`
declares takes the manifest's value and loses its console claim**, and every tier or profile the
manifest does not declare stays, as a console row, so no later resync deletes it. There is no
per-value review: to keep a console value, commit it to `.pkey/` first. A break-glass claim ends
as at any resync (once expired, or when the manifest changes its field); a live one stays, as do
the services, compatibility, access, fingerprint and auto-issue ownership markers and the system
product's name.

It runs from the admin API (the operator procedure is in the runbook). The dry run
(`POST /manage/api/products/<slug>/settings/backfill?dryRun=1`) classifies every field and row as
**equal**, **differs** or **not declared**, with the console activity that explains a difference
and the values the apply would revert (secrets redacted), and stores that report. The apply
(`?dryRun=0&expectReport=<the dry run's reportId>`) applies exactly that dry run: it refuses (409
`backfill_stale`) if the manifest or any of the product's settings changed since, and (409
`backfill_conflict`) if a console edit lands while it runs. It stores its own report and writes
one `setting.backfill` activity row listing every value it changed. Both reports stay readable
(`GET …/settings/backfill`). A second dry run and apply change nothing. Manual products have no
manifest and are only reported as unlinked; the system product is classified against the root
`.pkey/` as the last deploy applied it.

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
