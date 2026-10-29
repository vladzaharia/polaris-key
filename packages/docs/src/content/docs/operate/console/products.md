---
title: "Products"
description: "The product registry: manual create vs. linking a GitHub repo, reserved slugs, resync, and what deleting a product actually does."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 3
---

Products live on **Home** (`#/`); `#/products` opens it, filters kept. This page covers registering
a product, turning its services on and off, and the needs-attention items the
[Overview page](/docs/operate/console/tour/#core) is built from. Resync, linking a repository and
deleting are on [Product actions](/docs/operate/console/product-actions/).

**Home** shows, in this order:

- **Needs attention**: what is broken across your products, one fact per line, each with the one
  link that fixes it. A failed resync, a required secret with no value, a missing signing key, an
  edge-mint recipe awaiting approval, a store credential expiring within 14 days and, for platform
  admins, paused Cloud Sync writes (one item for the whole platform, with **Resume**) appear. What a
  product has not set up yet does not: that is its Overview. You see only items whose fix you can
  open.
- **Platform ready**, for platform admins until every step is done: the open steps with their fix,
  and the done ones behind **Show done steps**.
- **Products**, as cards or a table (the choice is kept). Search, **Integration verified** and
  **Needs attention** filter both and live in the URL, so a filtered view can be bookmarked or
  shared.

A card shows the product's cover (its hosted `listing.header` art, else its icon on a plain tile),
its logo, name and slug, and one icon for each feature it runs. Each icon is named and links to the
feature's page; a dot marks the one with a problem. The name opens the product's **Overview**. A
product that needs something shows a pill: the one issue, or the number of issues. A healthy card
shows no status at all. On a phone the cover goes and the icons become one dot each. The table's
row menu holds Resync and Delete.

The logo is the product's hosted icon: the copy Polaris Key keeps of the `presentation.icon` in
`.pkey/product`, or of the store listing's icon. Until a copy exists, or when it cannot load, the
card shows the name's first letter on a plain tile. A failed re-fetch keeps showing the last good
copy.

## Registering a product

**New product** is a short wizard at `#/products/new`: a repository takes you through Repository and Check,
scratch through Name it and What it's for. **A GitHub repository** and **From scratch** sit above the first step (`?via=github|manual`
preselects one); the step is in the URL, so a refresh resumes it. The draft is kept for the tab, and
leaving with a draft asks first. **Cancel** is on the title line.

A refusal stays on the step it belongs to, in plain words, with its fix beside it. A refusal about
one field sits on that field and moves focus there, such as a taken slug. Anything else goes in a
callout below the step, such as a manifest the server would not accept. Nothing is created until
every check passes.

Creating lands on **Integration**, which shows "_Name_ is ready" once, with the key the product
signs with. The private key never leaves the platform: it is sealed under `PLATFORM_KEK` from the
moment it's minted. Give the public key to your SDK trust configuration and release tooling; it is
also in the product's JWKS.

### From scratch

**Name it.** Type the **Name** first. The **Slug** follows it (lowercase letters, digits and
hyphens) until you edit it, and the server checks it after a short pause. A taken slug says so and
offers a free one to take with one click (**Use tonebox-app**). A reserved or malformed slug is
refused before anything is sent. The slug is permanent: it is used in keys and URLs.

**What it's for.** The features of the Services page as cards, each with its service's accent
edge and one line of why: **Licensing** and **Ship builds** start on and are marked Recommended.
A card that needs another says **Needs** and what: **Cloud Sync** needs Managed config and
Sign-in, **Commerce** needs Licensing, and a locked card says what to select to unlock it.
Turning a feature off turns off whatever needs it, and says which. Licensing carries **Start with a
Free tier** (on); Ship builds asks for the platforms, which the storefronts follow. The
**Creates** rail (a collapsed bar on a narrow screen) lists exactly what Create writes. **I'll
choose later** creates the product with no features. **Create** writes everything in one batch.

License defaults are not asked here: tiers own them. A config catalog, the compatibility window
([Ship builds → Feed](/docs/operate/console/tour/#update)) and everything else are set up later. Under
the hood the console sends the name and slug as `.pkey/` documents to the same ingest pipeline a
linked repository uses, with no repository: the snapshot origin is `link` with no commit.
**A product can never exist without a usable signing key.** No release row and no edge-mint row are
created, because this path has no GitHub coordinates to hang them on, and a `trustedPublisher`
needs a repository.

### From a GitHub repository

**Repository.** Paste `owner/repo` or its GitHub URL, or pick one the Polaris Key app can read:
each row says **Has .pkey/**, **No .pkey/ yet** or **Already a product** (which opens that product
instead of registering it twice). With the app not installed, the step offers **Install on GitHub**
and you can still paste a repository.

**Check.** Nothing is written. Polaris Key reads `.pkey/` on the default branch and shows the
product as it would be created: name, slug and whether it is available, the services, the catalog's size,
the platforms and the secrets to set after creating. The plan under the details names the rows
the create writes. Press **Create** to register the product from it: name, slug, services,
tiers, profiles, OIDC configuration, release coordinates, edge-mint recipes, all of it. The name and
slug come from `.pkey/product`, so the wizard does not ask for them.

When the check or the create is refused, the step shows what to do next:

- **The repository is a product already.** The step says so and **Open** that product is the
  action; nothing is created twice.
- **The repository has no `.pkey/`.** The step shows the `pkey init` command to run, a link to how
  `.pkey/` works, and **Start from scratch instead**.
- **The GitHub App can't read the repository.** **Install on GitHub** opens the app's page; install
  it on the owner, then press **Check again**. If the app is on the owner already, the step says
  the repository wasn't found: check the name, or add it to the app's repositories.
- **The manifest has problems.** **Fix these in one commit** lists each problem with its file and
  path, and **Create** stays off. Push the fix and press **Check again**.
- **The manifest's slug is taken, reserved or malformed.** Change `product.slug` in
  `.pkey/product`, push, then press **Check again**. Creating registers new products only: if the
  slug is taken because this repository is already registered, open that product and resync it
  instead (see [What resync actually re-applies](/docs/operate/console/product-actions/#what-resync-actually-re-applies)).
- **`.pkey/` changed after the check.** The create carries the check's digest and refuses. The step
  reads the repository again and holds **Create** until it has.

The Check step names any secrets the manifest declared that have no value yet, such as an OIDC
client secret or an edge-mint signing key. Set them after creating, from
[Keys and secrets](/docs/operate/console/keys-and-secrets/). Secrets are write-only and never echoed
back.

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
enables. The license defaults and the compatibility window are not create fields: tiers and
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

### The `adminGroup` field was removed

`product.adminGroup` granted nothing, so `.pkey/product` no longer takes it, at either spelling:
a manifest that has it is refused with `invalid_admin_group`. Map an identity-provider group to
a role in Platform → Members instead (`console.access`). Delete the field from your manifest.

A product's **Settings** page holds its registry fields and the **Danger zone**, where **Delete product…** lives. Everything else it edits has its own page.

## What needs attention

Home's Needs attention list, a product's Overview and the product switcher's badge all read one
server call, `GET /manage/api/attention`, recomputed on every read. It lists broken things only:

| Item                  | Raised when                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **No signing key**    | The product has no active signing key.                                                                           |
| **Missing secret**    | A secret the product's OIDC or edge-mint configuration names has no value in the Default profile.                |
| **Secret not marked** | A recipe's signing secret is set but not marked usage `edge-mint`.                                               |
| **Needs approval**    | An edge-mint recipe is not [approved](/docs/features/managed-config/edge-mint/#approving-a-recipe) as it stands. |
| **Resync failed**     | The most recent manifest resync errored.                                                                         |
| **Credential**        | A store credential has expired or expires within the window.                                                     |
| **Writes paused**     | Cloud Sync writes are paused for every product (platform admins; one item).                                      |

Each item links to the page that fixes it. The **required secrets** list on
[Keys and secrets](/docs/operate/console/keys-and-secrets/) is drawn from the same configuration.

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
product answers not-found within 30 seconds. **Ship builds → Packages** is in the sidebar whenever Ship builds is on, and shows
the off state with **Turn on**: see [Package feeds](/docs/features/ship-builds/packages/).

## Publish from CI

**Ship builds → Publish from CI** shows each check for a tag publish as a row: GitHub App installed,
`.pkey/release`, the release workflow, the release environment, the `v*` tag ruleset, the trusted
publisher and pull requests to Homebrew and Scoop. **Create** on the environment and ruleset rows
writes them in the linked repository (environment limited to `v*` tags); **Open pull request** adds
the workflow through one `pkey/setup` pull request that you merge. A row whose permission the GitHub
App installation has not accepted shows **Needs administration: write** and links to GitHub's
installation page. The CLI fallback is on
[Publishing from CI](/docs/features/ship-builds/ci/#set-it-up-from-the-console).

## Reference

- The D1 data model (platform admins) — `products`, `product_keys` and `product_secrets`,
  including `services_json` and `services_source`.
- [Manifest validation codes](/docs/reference/validation-codes/) — every code the `.pkey/`
  validator can emit, including `reserved_slug`.
- [Authoring the manifest](/docs/build/manifest/) — the `.pkey/` format both creation paths
  validate against.
- [The device principal](/docs/reference/protocol/device-principal/) — the registration policies in
  full.
- [Product actions](/docs/operate/console/product-actions/#what-resync-actually-re-applies) — how a resync interacts with
  an admin-claimed row.
