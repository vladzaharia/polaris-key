---
title: "Console tour"
description: "The console shell: the top bar, the sidebar sections and their pages, the URL scheme, the old URLs that still work, and the pages a bad link lands on."
sidebar:
  order: 2
---

The console at `/manage` is a single-page app. Navigation has two tiers: a **top bar** for things
that do not depend on a product, and a **sidebar** with one section per service the current
product runs. Every page, its URL, its icon and its docs link come from one table (`SECTIONS` in
`packages/admin/src/console/nav.ts`), and this page walks that table. It describes the shell; the
mechanics behind each page have their own pages, linked as they come up.

## Signed in as a platform admin

There is exactly one admin identity: signed in, or not. `/manage/api/me` returns every product
you may administer or none. There is no per-product grant, and a product's manifest
`adminGroup` field is display metadata that authorizes nothing (see
[Products](/docs/admin/products/)).

The session is a hard 8 hours. The account menu shows when it ends ("Session ends 18:40"), so
you know before you start a long edit.

## The top bar

From left to right:

| Element                | What it does                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Polaris Key**        | The mark and name. It links to **Home**. In a service section, the K's terminal bit takes that section's colour.                                                                                                                                       |
| **Product switcher**   | Shown when a product is in scope. Type to filter by name or slug; your last five products are listed first. Choosing a product keeps the page you are on when that product runs the page's service, and otherwise opens its Overview. Shortcut: `g p`. |
| **Environment badge**  | "Staging" or "Dev" on those deployments; nothing in production. The Worker's `PKEY_ENVIRONMENT` setting decides it, never the hostname.                                                                                                                |
| **Search or jump to…** | The command palette (`⌘K` or `Ctrl+K`, or `/` outside a text field): every page of the current product's sections, plus every product. Recent choices come first.                                                                                      |
| **Docs**               | Opens the docs page for the page you are on, in a new tab.                                                                                                                                                                                             |
| **Theme**              | System (the default, which follows your OS live), Dark or Light. The choice is remembered in this browser.                                                                                                                                             |
| **Account menu**       | Your name and email, when the session ends, the running version (a link to Platform → Deployment), the keyboard shortcut sheet (`?`), the docs home, and **Sign out**.                                                                                 |

## The sidebar

**Home** and **Products** always come first, then the **Platform** section: pages about this
instance as a whole rather than any product, such as **Deployment** (the build it runs, its deploy
history, database migrations, bindings and the platform activity log). On Home, Products and the
Platform pages no product is in scope, so nothing else is shown. Inside a product, one section
follows per service:

- **Core** first. It has no owning service and is never hidden: you must always be able to reach
  **Services** to turn something back on.
- Then one section for each service the product runs, in the service table's order.

A service the product does not run has no section at all. The console does not grey it out: a
dimmed row invites a click that can only fail.

**Collapsing sections.** Only the section holding the page you are on is open; every other
section shows just its header. To look inside a collapsed section, click its header or press Enter
or Space on it. That peek is temporary: when you open a page in another section, that section
opens and the rest collapse again. The section holding the current page cannot be collapsed, and
nothing about this is remembered between visits.

**The rail.** `⌘\` (or `Ctrl+\`), or **Collapse** at the bottom, shrinks the sidebar to icons.
Narrower than 1280 px it starts that way. Narrower than 1024 px the sidebar is hidden and the menu
button in the top bar opens it as a drawer; Escape closes it.

While a product's enablement is still loading, every section is shown rather than hidden: hiding
first and revealing a beat later would make the nav jump under your cursor.

## Sections and pages

URLs follow `#/p/<slug>/<section>/<page>`, with a record id and tab after the page where there is
one (`#/p/djdl/license/licenses/lic_123/keys`). Filters and other page state go in the query
string, so a URL you share opens the same view.

Some pages of the redesign are still being built. Until they are, their URLs open the page that
holds that capability today, so every link keeps working. Those pages are noted below.

### Core

| Page               | URL        | What it's for                                                                                                                                                                        |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**       | (root)     | Setup health at a glance: a "needs attention" strip, a guided checklist, the SDK trust key and trust set, and a starter snippet. See [Products](/docs/admin/products/#setup-health). |
| **Services**       | `services` | Which services the product runs, and its device-registration policy. See [Services & enablement](/docs/admin/services-enablement/).                                                  |
| **Devices**        | `devices`  | Every device of the product, including those that hold no license. See [Licenses & devices](/docs/admin/licenses-and-devices/#devices-product-wide).                                 |
| **Keys & secrets** | `keys`     | Write-only product secrets and the required-secrets checklist. Outlet credentials are here too until they move to Distribution. See [Secrets & keys](/docs/admin/secrets-and-keys/). |
| **Activity**       | `activity` | The product's audit log. See [Activity](/docs/admin/activity/).                                                                                                                      |
| **Settings**       | `settings` | Registry fields, per-license defaults, signing-key preparation, and deleting the product. See [Products](/docs/admin/products/).                                                     |

### License

Shown when the product runs **License**.

| Page           | URL                                   | What it's for                                                                                                                                                                                                                            |
| -------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Licenses**   | `license/licenses`, `…/licenses/<id>` | License holders, each with a record page for policy, keys, devices and overrides. See [Licenses & devices](/docs/admin/licenses-and-devices/).                                                                                           |
| **Tiers**      | `license/tiers`, `…/tiers/<id>`       | Reusable templates a license can be assigned, each with a record page for its policy and the licenses using it. A tier cannot be deleted while a license uses it.                                                                        |
| **Enrollment** | `license/enrollment`                  | The device-registration policy (read-only here; it is set in Services) and the fingerprint policy. See [Licenses & devices](/docs/admin/licenses-and-devices/#fingerprint-policy) and [Fingerprints](/docs/services/core/fingerprints/). |

### Config

Shown when the product runs **Config**.

| Page          | URL                                     | What it's for                                                                                                                                            |
| ------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog**   | `config/catalog`, `config/catalog/edit` | The product's config keys, their history, and the editor that publishes a new version. See [The catalog](/docs/services/config/catalog/#in-the-console). |
| **Profiles**  | `config/profiles`, `…/profiles/<id>`    | Named managed payloads a tier or license inherits, each edited on its own page. See [Profiles](/docs/services/config/profiles/#in-the-console).          |
| **Edge mint** | `config/edge-mint`                      | Edge-mint recipe approval. See [Edge mint](/docs/services/config/edge-mint/#approving-a-recipe).                                                         |

### Release

Shown when the product runs **Release**.

| Page              | URL                                           | What it's for                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Releases**      | `release/releases`                            | The release truth store, release health, and the channels panel: promote, pin, unpin, minimum supported, critical, rollback floor, revert to manifest, yank and unyank. See [Channels](/docs/services/release/channels/). |
| **Channels**      | `release/channels`                            | Until it becomes its own page, this URL opens Releases, where the channels panel is.                                                                                                                                      |
| **Deliverables**  | `release/deliverables`, `…/deliverables/<id>` | Packs and their releases, pins and files, plus content keys for now.                                                                                                                                                      |
| **Compatibility** | `release/compatibility`                       | Which releases each version window admits, and the update simulator.                                                                                                                                                      |
| **Content keys**  | `release/content-keys`                        | Until it moves here, this URL opens Deliverables.                                                                                                                                                                         |

### Distribution

Shown when the product runs **Distribution**, which requires Release (see
[Services & enablement](/docs/admin/services-enablement/#coherence-errors)).

| Page                   | URL                        | What it's for                                                                                                                       |
| ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Matrix**             | `distribution/matrix`      | Releases against outlets: availability, submissions, rollouts and their controls. See [Distribution](/docs/services/distribution/). |
| **Rollouts**           | `distribution/rollouts`    | The recorded outlet rollouts, with the release-to-update chain this product runs.                                                   |
| **Outlets & feeds**    | `distribution/outlets`     | Until it is built, this URL opens the Matrix.                                                                                       |
| **Access**             | `distribution/access`      | Who may download each deliverable. Until it moves here, this URL opens Update → Feed, where delivery access is set.                 |
| **Health**             | `distribution/health`      | Update health: funnels, auto-halt and Sentry candidates.                                                                            |
| **Outlet credentials** | `distribution/credentials` | Until it moves here, this URL opens Keys & secrets.                                                                                 |

### Update

Shown when the product runs **Update**, which requires Distribution.

| Page     | URL           | What it's for                                                                                                                                                                   |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feed** | `update/feed` | Who may read the update feed and download the binaries it points at, the compatibility window, and the artifact policy. Delivery access is here until it moves to Distribution. |

### Identity

Shown when the product runs **Identity**.

| Page        | URL                | What it's for                                                                                          |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| **Portal**  | `identity/portal`  | The customer portal's module toggles and automatic license linking, plus the read-only OIDC explainer. |
| **Sign-in** | `identity/sign-in` | Until it becomes its own page, this URL opens Portal.                                                  |

## Old URLs

Every URL from before the redesign still works. The console replaces it with the new one (Back
does not loop through the old address):

| Old                                                | New                                      |
| -------------------------------------------------- | ---------------------------------------- |
| `#/p/<slug>/overview`                              | `#/p/<slug>`                             |
| `#/p/<slug>/secrets`                               | `#/p/<slug>/keys`                        |
| `#/p/<slug>/licenses`, `…/licenses/<id>`           | `#/p/<slug>/license/licenses[/<id>]`     |
| `#/p/<slug>/tiers`                                 | `#/p/<slug>/license/tiers`               |
| `#/p/<slug>/fingerprints`                          | `#/p/<slug>/license/enrollment`          |
| `#/p/<slug>/config`                                | `#/p/<slug>/config/catalog`              |
| `#/p/<slug>/profiles`, `…/profiles/<id>`           | `#/p/<slug>/config/profiles[/<id>]`      |
| `#/p/<slug>/releases`                              | `#/p/<slug>/release/releases`            |
| `#/p/<slug>/deliverables`, `…/deliverables/<id>`   | `#/p/<slug>/release/deliverables[/<id>]` |
| `#/p/<slug>/compatibility`                         | `#/p/<slug>/release/compatibility`       |
| `#/p/<slug>/distribution`, `…/distribution-matrix` | `#/p/<slug>/distribution/matrix`         |
| `#/p/<slug>/distribution-health`                   | `#/p/<slug>/distribution/health`         |
| `#/p/<slug>/updates`                               | `#/p/<slug>/update/feed`                 |
| `#/p/<slug>/identity`                              | `#/p/<slug>/identity/portal`             |

## When a link goes nowhere

The console never quietly shows a different page than the one you asked for.

- **A service the product does not run.** A bookmark, a shared URL, or a service someone turned
  off in another tab can point at a section the product no longer has. The page says so ("The
  License service isn't enabled for DJDL.") and offers **Enable License**, which opens Services.
  This explains a 404 you would otherwise have to guess at; it is not a security boundary, since
  every endpoint gates itself the same way regardless of what the nav shows.
- **A page that does not exist.** "Page not found" names the path it could not match, with links
  to the product's Overview and to the command palette.
- **A product that does not exist.** "Unknown product" lists the slugs that are one or two edits
  away, and links to Products.

## Keyboard

Shortcuts never fire while you type in a field. Press `?` for the full sheet.

| Keys                                      | Action                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `⌘K` / `Ctrl+K`, `/`                      | Command palette                                                                                |
| `?`                                       | Keyboard shortcut sheet                                                                        |
| `g h`, `g p`                              | Home; change product                                                                           |
| `g o` `g l` `g c` `g r` `g m` `g a` `g s` | Overview, Licenses, Catalog, Releases, Matrix, Activity, Settings, when the section is enabled |
| `⌘\` / `Ctrl+\`                           | Collapse or expand the sidebar                                                                 |
| `Esc`                                     | Close the topmost overlay                                                                      |

## Where the model lives

The nav table itself (which page belongs to which section, which service gates it, its URL, its
icon and its docs link) is `SECTIONS` in `packages/admin/src/console/nav.ts`. For the enablement
mechanics behind "shown when", see [The service model](/docs/start/service-model/) and
[Services & enablement](/docs/admin/services-enablement/).
