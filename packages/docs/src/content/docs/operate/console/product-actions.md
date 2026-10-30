---
title: "Product actions"
description: "Resync, link a repository, rename, back-fill settings and delete a product: what each action does on the server."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 3.5
---

The registry row menu opens the product's own pages rather than repeating their forms, so each
setting has one form with one set of rules:

| Action                                                          | What it does                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Open overview**, **Open settings**, **Open keys and secrets** | Go to that page of the product. Name and per-license defaults are edited in Settings; secrets and signing keys in [Keys and secrets](/docs/operate/console/keys-and-secrets/). |
| **Resync from repo…**                                           | Repository-linked products only. Re-fetches `.pkey/` from the repo's default branch and re-applies it — see below. You confirm the consequences first.                         |
| **Delete product…** (also the Danger zone on Settings)          | Tombstones the product. See below.                                                                                                                                             |

## What resync actually re-applies

Resync re-reads `schema`, `product` and `release` from the linked repo's **default branch** —
never a caller-supplied ref, so the manifest applied to production can't be a function of an
unreviewed branch — and re-applies each in place:

- Product metadata (name, license defaults, web origins) is written unless the console has
  claimed that field. The
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
  — see [Services & enablement](/docs/operate/console/products/#services--enablement).

A resync is one D1 transaction, and every check runs before it: either everything above lands
together, or a refusal (a bad catalog, an OIDC issuer change that fails the platform's own gate,
a dropped tier a license still uses) leaves the product exactly as it was. Each setting, tier or
profile it changes gets its own audit row.

## Claimed settings

On a repository-linked product, saving the display name or a license default in Settings
claims it for the console: you confirm first, the row's source badge then reads **Set in
console**, and resyncs leave it alone. **Revert…** in that badge restores the value from the
last applied manifest at once, or at the next resync for a product not applied since claims
arrived. Publishing the catalog claims it the same way, with Revert in the catalog's source
badge.

## Manifest-authoritative mode

A repository-linked product can make its `.pkey/` the only writer of its **display name, license
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
stay claimed until you revert them. The other settings `.pkey/` declares — services (which derive
device registration), the fingerprint and auto-issue policies, the compatibility window, the release
access modes, tiers and profiles, and the trusted publisher — are not yet refused by the mode: a
console edit still claims them as before. They are not yet covered by the mode.

**The system product** is manifest-authoritative always; the switch shows it locked, and the
settings registry, not a stored value, fixes it (`core.manifest.authoritative`). Its manifest is the
monorepo's root `.pkey/`, and its only manifest writer is the deploy hook (`/webhooks/deploy` (POST),
called by `deploy.yml` with every production deploy at the deployed commit): a push webhook for the platform repository and a console
Resync of it are refused with "the system product is applied by the deploy hook", and Settings
offers no Resync for it. The deploy hook applies the release configuration, the package
deliverables, the trusted publisher and each enabled service's manifest rows, plus the value of
any field whose break-glass claim it ends. It does not yet apply the display name, the license
defaults, the web origins or the catalog from `.pkey/`; applying every declared
field is not built. Its break-glass claims (today on the license defaults: its display name
cannot be changed in the console) end after 7 days or at the first deploy that
changes the field, and each deploy's log names the live ones as warnings.

Every save is checked against the [settings reference](/docs/reference/settings/): the display
name is at most 200 characters, the device limit at most 1,000,000 and the
offline grace 1 to 365 days, and a value outside answers 422 `invalid_value`.

## Linking a repository to an existing product

A product created from nothing (or before its repository had a `.pkey/`) can be handed over to
its manifest later: **Settings → Repository → Link repository…**, or **Link a repository** on the
Releases page before the first release. Both open the same drawer, and it works in a check step and an apply step.

1. **Check.** Type `owner/repo` or the repository's GitHub URL. The console runs the link's checks
   and marks each one: the repository parses, the Polaris Key GitHub App can read it, the
   `.pkey/` manifest validates, and its `product.slug` is this product's slug. It also runs the
   checks a resync would otherwise hit halfway: an OIDC issuer change outside the platform's
   allowlist, an unsafe binary name, a catalog the validator refuses. Nothing is written. A
   passing check lists what the link does:
   - **Applies**: the values and rows the manifest writes (name and defaults, the presentation's
     icon and accents, a new catalog version, tiers, profiles, release settings, the trusted
     publisher, and so on);
   - **Stays (set in the console)**: values the manifest declares but an operator already set
     here (services, the compatibility window, the fingerprint and auto-issue policies, release
     access, a trusted publisher saved in Keys and secrets). The ownership rule above applies from
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
   [Keys and secrets](/docs/operate/console/keys-and-secrets/).

The link is recorded in Activity as _linked the product to a repository_. After it, every push to
the default branch re-applies `.pkey/`, exactly as for a product created from its repository. The
platform's own product cannot be linked here: the deploy hook links it.

The API is `/manage/api/products/<slug>/release/link?dryRun=1` (POST) with `{ "repoUrl" }` for the
check, then `POST …/release/link` with `{ "repoUrl", "manifestDigest" }`. A refusal's `reason`
names the check that failed: `product`, `repository`, `app`, `manifest`, `slug` or `policy`.

## The settings backfill

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
(`/manage/api/products/<slug>/settings/backfill?dryRun=1` (POST)) classifies every field and row as
**equal**, **differs** or **not declared**, with the console activity that explains a difference
and the values the apply would revert (secrets redacted), and stores that report. The apply
(`?dryRun=0&expectReport=<the dry run's reportId>`) applies exactly that dry run: it refuses (409
`backfill_stale`) if the manifest or any of the product's settings changed since, and (409
`backfill_conflict`) if a console edit lands while it runs. It stores its own report and writes
one `setting.backfill` activity row listing every value it changed. Both reports stay readable
(`GET …/settings/backfill`). A second dry run and apply change nothing. Manual products have no
manifest and are only reported as unlinked; the system product is classified against the root
`.pkey/` as the last deploy applied it.

## What deleting a product actually does

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
