# Polaris Key operator console: current state

**Status:** living reference for the console that is shipped from
`packages/admin/src/console` at `/manage`. This is a description of the running product, not an
implementation plan. The route and navigation declarations in
[`packages/admin/src/console/nav.ts`](../../packages/admin/src/console/nav.ts) and
[`packages/admin/src/console/routes.ts`](../../packages/admin/src/console/routes.ts) are the
authoritative page inventory and URL contract.

## 1. Scope and reading this document

The operator console is the authenticated React application served at `/manage`. It manages
platform and product resources through `/manage/api`; the Worker authorizes every request. The
customer-facing application is documented separately in [PORTAL.md](PORTAL.md).

This document records only behavior present in the source tree. [EXPERIENCE.md](EXPERIENCE.md),
[SETUP.md](SETUP.md), [FLOWS.md](FLOWS.md), and [SIGN-IN.md](SIGN-IN.md) contain accepted design
work and package plans as well as shipped behavior. A rule in one of those documents is not a
claim that the console has implemented it. The **Planned and parked work** section names the
relevant graph id where that distinction matters.

UI terminology follows [UI words and the identifiers they keep](../../packages/docs/src/content/docs/start/concepts.md#ui-words-and-the-identifiers-they-keep).
Identifiers, route segments, API fields, manifests, and some current labels retain their established
names. The console words follow the glossary: **Channel setup** and **Channel credentials** for
distribution channels, **Release tracks** for a release's lanes. Route segments and API fields
(`distribution/outlets`, `release/channels`, `outletId`) keep their older names.

## 2. Application shell and session

`App` loads the authenticated `/me` query before rendering the console. It shows the boot screen
while that query is pending and an error state with **Try again** if it fails. The shell then owns the
top bar, sidebar, page region, command palette, shortcut sheet, route focus management, and
toasts.

- The console uses a hash router under `/manage`. Route builders and parsing live together; a
  malformed or unknown hash is a not-found route rather than a guessed destination.
- A product URL has the form `#/p/<slug>/<page>`. Routes can include a record, record tab, nested
  child record, and typed hash-query parameters. `#/platform` opens Platform settings.
- A section root opens that section's first page. Old product tabs that are deliberately moved show
  a **Page moved** state with the new destination; the console does not silently redirect the
  bookmark.
- Page changes reset the content scroll, focus the page `h1`, and announce that the page loaded.
  The hash store, redirects, blockers and View Transitions live in `lib/router-core.ts`, shared with
  the portal; focus and the announcement are `ui/focusRoute.ts`. Each app keeps its own route table.
  Filtering through a query parameter does not remount the page or move focus.
- Product sections are shown only for enabled services. A deep link to an unavailable service
  names the problem and links to Services rather than rendering a failing page.
- At desktop widths the sidebar is an expandable list or persisted icon rail; below 1024 px it is a
  focus-trapped modal drawer. Platform navigation is hidden while a product is open.

### Authentication and authorization

The shipped `/manage/login` path starts the console's PKCE redirect to the configured operator
identity provider. The Worker verifies the callback, checks operator membership, sets the session
cookie, and validates a bounded `returnTo`; it is not the proposed shared `AuthCard`.

The client treats authorization as presentation, never as enforcement. It reads
`/me.permissions` to hide inaccessible destinations and render a useful no-access page, while the
Worker's route table remains the enforcement point for every API operation. A member can have
platform or product-scoped roles; a missing permissions payload preserves the legacy platform-admin
behavior. No-access states identify the missing area, the signed-in role, people who can help, and
destinations the member may still open.

### Theme, motion, and service context

The console consumes `@polaris-key/brand` tokens. It stores a shared per-browser preference for
**System**, **Dark**, or **Light**, applies explicit choices before the bundle renders, and follows
the operating-system scheme while System is selected. The active page's service is exposed as
`data-service` so the shell and portal content use the appropriate accent.

Motion can follow the operating system or use an explicit **Reduced** preference. Reduced motion
sets `data-motion="reduce"` and collapses the brand and console motion durations to instant swaps.
The preference is shared with the customer portal on the same origin.

### 2.4 The shell canvas

From 1024 px the main region is a `surface-raised` canvas (radius `xl`, `border-subtle`, inset
`space-4` from the top bar and window edge) carrying a 3 px section rule on its top edge; below
1024 px it is edge to edge with no radius. The page background is `surface-page`, content is at
most 1760 px wide (centred; the canvas itself fills the window), page gutters are `space-6`, card
radius `lg` and control radius `md`. No gradient, glow or wash on the canvas. BRAND §7.6 holds the
density and table rules.

### 2.8 Route ledger

`packages/admin/src/console/routeLedger.ts` (`ROUTE_LEDGER`) is the one map from every 0.9 page
address to its 1.0 home. The 0.9 line keeps removals, not aliases: a removed address does not
redirect. It opens a **Page moved** page that names the new home and links to it, keeping the record
id and the query; a page deleted with no successor says so instead. A page that leaves `nav.ts`
without a row fails `test/routeLedger.test.ts`. The table below is generated; edit the ledger, not
the table.

<!-- route-ledger:start (GENERATED by `pnpm gen route-ledger` from routeLedger.ts; do not edit) -->

| 0.9 page                      | 0.9 address                                  | 1.0 home                                                                   | Status           |
| ----------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- | ---------------- |
| `overview`                    | `#/p/<slug>`                                 | Core → Overview (`#/p/<slug>`)                                             | live             |
| `integration`                 | `#/p/<slug>/integration`                     | Core → Integration (`#/p/<slug>/integration`)                              | live             |
| `services`                    | `#/p/<slug>/settings/features`               | Core → Features and general (`#/p/<slug>/settings/features`)               | live             |
| `devices`                     | `#/p/<slug>/devices`                         | Core → Devices (`#/p/<slug>/devices`)                                      | live             |
| `users`                       | `#/p/<slug>/users`                           | Core → Users (`#/p/<slug>/users`)                                          | live             |
| `presentation`                | `#/p/<slug>/settings/presentation`           | Core → Presentation (`#/p/<slug>/settings/presentation`)                   | live             |
| `presentation-listing`        | `#/p/<slug>/settings/presentation/listing`   | Core → Listing (`#/p/<slug>/settings/presentation/listing`)                | live             |
| `keys`                        | `#/p/<slug>/settings/keys`                   | Core → Keys and secrets (`#/p/<slug>/settings/keys`)                       | live             |
| `activity`                    | `#/p/<slug>/activity`                        | Core → Activity (`#/p/<slug>/activity`)                                    | live             |
| `settings`                    | `#/p/<slug>/settings`                        | Core → Settings (`#/p/<slug>/settings`)                                    | live             |
| `settings-members`            | `#/p/<slug>/settings/members`                | Core → Members (`#/p/<slug>/settings/members`)                             | live             |
| `settings-all`                | `#/p/<slug>/settings/all`                    | Core → All settings (`#/p/<slug>/settings/all`)                            | live             |
| `licenses`                    | `#/p/<slug>/license/licenses`                | Licensing → Licenses (`#/p/<slug>/license/licenses`)                       | live             |
| `tiers`                       | `#/p/<slug>/license/tiers`                   | Licensing → Tiers (`#/p/<slug>/license/tiers`)                             | live             |
| `enrollment`                  | `#/p/<slug>/license/enrollment`              | Licensing → Enrollment (`#/p/<slug>/license/enrollment`)                   | live             |
| `license-batches`             | `#/p/<slug>/license/batches`                 | Licensing → Batches (`#/p/<slug>/license/batches`)                         | live             |
| `license-settings`            | `#/p/<slug>/license/settings`                | Licensing → Settings (`#/p/<slug>/license/settings`)                       | live             |
| `catalog`                     | `#/p/<slug>/config/catalog`                  | Managed config → Catalog (`#/p/<slug>/config/catalog`)                     | live             |
| `catalog-edit`                | `#/p/<slug>/config/catalog/edit`             | Managed config → Edit catalog (`#/p/<slug>/config/catalog/edit`)           | live             |
| `profiles`                    | `#/p/<slug>/config/profiles`                 | Managed config → Profiles (`#/p/<slug>/config/profiles`)                   | live             |
| `releases`                    | `#/p/<slug>/release/releases`                | Release → Releases (`#/p/<slug>/release/releases`)                         | live             |
| `channels`                    | `#/p/<slug>/release/channels`                | Release → Release tracks (`#/p/<slug>/release/channels`)                   | live             |
| `deliverables`                | `#/p/<slug>/release/deliverables`            | Release → Deliverables (`#/p/<slug>/release/deliverables`)                 | live             |
| `compatibility`               | `#/p/<slug>/release/compatibility`           | Release → Compatibility (`#/p/<slug>/release/compatibility`)               | live             |
| `simulator`                   | `#/p/<slug>/release/compatibility/simulator` | Release → Update simulator (`#/p/<slug>/release/compatibility/simulator`)  | live             |
| `content-keys`                | `#/p/<slug>/release/content-keys`            | Release → Content keys (`#/p/<slug>/release/content-keys`)                 | live             |
| `matrix`                      | `#/p/<slug>/distribution/matrix`             | Distribution → Matrix (`#/p/<slug>/distribution/matrix`)                   | live             |
| `rollouts`                    | `#/p/<slug>/distribution/rollouts`           | Distribution → Rollouts (`#/p/<slug>/distribution/rollouts`)               | live             |
| `outlets`                     | `#/p/<slug>/distribution/outlets`            | Distribution → Channel setup (`#/p/<slug>/distribution/outlets`)           | live             |
| `storefronts`                 | `#/p/<slug>/distribution/storefronts`        | Distribution → Storefronts (`#/p/<slug>/distribution/storefronts`)         | live             |
| `listing`                     | `#/p/<slug>/distribution/listing`            | Core → Listing (`#/p/<slug>/settings/presentation/listing`)                | moved (A-27)     |
| `app-store`                   | `#/p/<slug>/distribution/app-store`          | Distribution → App Store (`#/p/<slug>/distribution/app-store`)             | live             |
| `channel`                     | `#/p/<slug>/distribution/channels`           | Distribution → Channel (`#/p/<slug>/distribution/channels`)                | live             |
| `access`                      | `#/p/<slug>/distribution/access`             | Distribution → Access (`#/p/<slug>/distribution/access`)                   | live             |
| `package-feeds`               | `#/p/<slug>/distribution/feeds`              | Distribution → Packages (`#/p/<slug>/distribution/feeds`)                  | live             |
| `health`                      | `#/p/<slug>/distribution/health`             | Distribution → Health (`#/p/<slug>/distribution/health`)                   | live             |
| `credentials`                 | `#/p/<slug>/distribution/credentials`        | Distribution → Channel credentials (`#/p/<slug>/distribution/credentials`) | live             |
| `feed`                        | `#/p/<slug>/update/feed`                     | Update → Feed (`#/p/<slug>/update/feed`)                                   | live             |
| `portal`                      | `#/p/<slug>/identity/portal`                 | Sign-in → App sign-in (`#/p/<slug>/identity/app-sign-in`)                  | moved (I-29)     |
| `sign-in`                     | `#/p/<slug>/identity/sign-in`                | Sign-in → App sign-in (`#/p/<slug>/identity/app-sign-in`)                  | moved (I-29)     |
| `sync-data`                   | `#/p/<slug>/sync/data`                       | Cloud Sync → Data (`#/p/<slug>/sync/data`)                                 | live             |
| `connect-setup`               | `#/p/<slug>/connect/setup`                   | Cloud Connect → Cloud Connect (`#/p/<slug>/connect/setup`)                 | live             |
| `connect-devices`             | `#/p/<slug>/connect/devices`                 | Cloud Connect → Linked devices (`#/p/<slug>/connect/devices`)              | live             |
| `connect-usage`               | `#/p/<slug>/connect/usage`                   | Cloud Connect → Usage (`#/p/<slug>/connect/usage`)                         | live             |
| `commerce-overview`           | `#/p/<slug>/commerce`                        | Commerce → Overview (`#/p/<slug>/commerce`)                                | live             |
| `commerce`                    | `#/p/<slug>/commerce/in-app-purchases`       | Commerce → In-app purchases (`#/p/<slug>/commerce/in-app-purchases`)       | live             |
| `platform-settings`           | `#/platform/settings`                        | Settings (`#/platform/settings`)                                           | live             |
| `platform-deployment`         | `#/platform/deployment`                      | Status (`#/platform/status`)                                               | moved (CX-PSTAT) |
| `platform-operations`         | `#/platform/operations`                      | Status (`#/platform/status`)                                               | moved (CX-PSTAT) |
| `platform-stores`             | `#/platform/store-connections`               | Store connections (`#/platform/store-connections`)                         | live             |
| `platform-feeds`              | `#/platform/feeds`                           | Package feeds (`#/platform/feeds`)                                         | live             |
| `platform-activity`           | `#/platform/activity`                        | Activity (`#/platform/activity`)                                           | live             |
| `platform-members`            | `#/platform/members`                         | Members (`#/platform/members`)                                             | live             |
| `platform-override-migration` | `#/platform/override-migration`              | deleted (U-27)                                                             | deleted (U-27)   |
| `home`                        | `#`                                          | Home (`#`)                                                                 | live             |
| `products`                    | `#/products`                                 | Home (`#`)                                                                 | moved (ST-44)    |
| `product-new`                 | `#/products/new`                             | New product (`#/products/new`)                                             | live             |
| `api-tokens`                  | `#/tokens`                                   | API tokens (`#/tokens`)                                                    | live             |
| `personal-tokens`             | `#/personal-tokens`                          | Personal tokens (`#/personal-tokens`)                                      | live             |
| `sign-in-methods`             | `#/account/sign-in-methods`                  | Sign-in methods (`#/account/sign-in-methods`)                              | live             |
| `tab:overview`                | `#/p/<slug>/overview`                        | Core → Overview (`#/p/<slug>`)                                             | moved (P0-31)    |
| `tab:services`                | `#/p/<slug>/services`                        | Core → Features and general (`#/p/<slug>/settings/features`)               | moved (P0-31)    |
| `tab:presentation`            | `#/p/<slug>/presentation`                    | Core → Presentation (`#/p/<slug>/settings/presentation`)                   | moved (P0-31)    |
| `tab:keys`                    | `#/p/<slug>/keys`                            | Core → Keys and secrets (`#/p/<slug>/settings/keys`)                       | moved (P0-31)    |
| `tab:secrets`                 | `#/p/<slug>/secrets`                         | Core → Keys and secrets (`#/p/<slug>/settings/keys`)                       | moved (P0-31)    |
| `tab:licenses`                | `#/p/<slug>/licenses`                        | Licensing → Licenses (`#/p/<slug>/license/licenses`)                       | moved (P0-31)    |
| `tab:tiers`                   | `#/p/<slug>/tiers`                           | Licensing → Tiers (`#/p/<slug>/license/tiers`)                             | moved (P0-31)    |
| `tab:fingerprints`            | `#/p/<slug>/fingerprints`                    | Licensing → Enrollment (`#/p/<slug>/license/enrollment`)                   | moved (P0-31)    |
| `tab:profiles`                | `#/p/<slug>/profiles`                        | Managed config → Profiles (`#/p/<slug>/config/profiles`)                   | moved (P0-31)    |
| `tab:releases`                | `#/p/<slug>/releases`                        | Release → Releases (`#/p/<slug>/release/releases`)                         | moved (P0-31)    |
| `tab:deliverables`            | `#/p/<slug>/deliverables`                    | Release → Deliverables (`#/p/<slug>/release/deliverables`)                 | moved (P0-31)    |
| `tab:compatibility`           | `#/p/<slug>/compatibility`                   | Release → Compatibility (`#/p/<slug>/release/compatibility`)               | moved (P0-31)    |
| `tab:distribution-matrix`     | `#/p/<slug>/distribution-matrix`             | Distribution → Matrix (`#/p/<slug>/distribution/matrix`)                   | moved (P0-31)    |
| `tab:distribution-health`     | `#/p/<slug>/distribution-health`             | Distribution → Health (`#/p/<slug>/distribution/health`)                   | moved (P0-31)    |
| `tab:updates`                 | `#/p/<slug>/updates`                         | Update → Feed (`#/p/<slug>/update/feed`)                                   | moved (P0-31)    |

<!-- route-ledger:end -->

## 3. Shipped navigation and pages

The following labels and paths are the current `nav.ts` registry. A record is a route under its
collection; tabs listed here are route tabs, not promises of a future information architecture.

### Platform context

The sidebar has two contexts, never mixed (ST-45). A pinned context card at its top (72 px) names the
context and opens the switcher: Platform first, then the products, then New product. Below it the
list scrolls; Collapse (and, in a product, Settings) stays pinned at the foot. Platform pages never
appear in a product's sidebar, and a product's never in Platform's. A page the member cannot open is
absent, not disabled. A feature that is off has no group, and a feature with one page is one row.

Outside a product, the sidebar lists **Home** (`#/`), the Platform pages and the token pages. Home is the one
place for attention, Platform ready and the products, as cards or a table (ST-44); `#/products`
redirects to it with its filters. What needs attention is the server read
`GET /manage/api/attention`. `GET /manage/api/summary` and the A-8 fleet facts it carried (active
licences, newest release, storefronts, users per product) are dropped, not planned.

| Page              | Path                           |
| ----------------- | ------------------------------ |
| Settings          | `#/platform/settings`          |
| Deployment        | `#/platform/deployment`        |
| Operations        | `#/platform/operations`        |
| Store connections | `#/platform/store-connections` |
| Package feeds     | `#/platform/feeds`             |

**New product** is `#/products/new` and is reached from the switcher rather than the
sidebar. Override migration (`#/platform/override-migration`) was deleted (U-27) and no longer
addresses a page.

### Product context

Every product has **Core**, drawn as a flat list (no group header; Settings sits at the foot):

| Page        | Path and route detail                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| Overview    | `#/p/<slug>`: the hero, the feature board, the Integration-steps rail, recent activity |
| Integration | `#/p/<slug>/integration`                                                               |
| Devices     | `#/p/<slug>/devices`, with a routed device record                                      |
| Users       | `#/p/<slug>/users`, with overview, licenses, devices, activity, and data record tabs   |
| Activity    | `#/p/<slug>/activity`                                                                  |
| Settings    | `#/p/<slug>/settings`, the hub below                                                   |

**Settings** is a hub with five tabs, none of them a sidebar item: **Features and general**
(`settings/features`: the feature switches, then the product's name, origins, repository, storage,
alerts and the danger zone), **Presentation** (`settings/presentation`), **Polaris Locker**
(`settings/portal`), **Keys and secrets** (`settings/keys`) and **Members** (`settings/members`).
**All settings** (`settings/all`) lists every setting with its value where the registry has one, its
source and the page that edits it.

The Overview opens with a hero: the product's state and the one next step, with the Integration
pane beside it. The one filled primary on the page is that step. Under it, the feature board draws
one tile per feature the product runs, in the feature's accent with no accent top rule. **Ship
builds** is one tile for Release, Distribution and Update (the version on stable, the rollouts
live, the updater's state), as it is one group in the sidebar. The Integration-steps rail lists the
steps with a platform badge on each. Recent activity runs under the board.

Enabled services add their sections. Release, Distribution and Update share one sidebar group,
**Ship builds**; the rows below keep them apart because routes, docs and the feature switches do.

| Section      | Shipped pages                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License      | Licenses (record tabs: overview, keys, devices, config), Tiers (overview and used-by), Enrollment, Licensing settings, and non-sidebar Batches                                                      |
| Config       | Catalog, its non-sidebar editor (the minted-token approve drawer opens there), and Profiles                                                                                                         |
| Release      | Releases (builds, packs, release tracks, distribution), Release tracks, Deliverables (releases, release tracks, delivery, files), Compatibility, its non-sidebar Update simulator, and Content keys |
| Distribution | non-sidebar Matrix, Rollouts, Channel setup, Storefronts (including a record route), Listing, App Store, Access, Package feeds, Health, and Channel credentials                                     |
| Update       | Feed                                                                                                                                                                                                |
| Identity     | App sign-in (the Polaris Locker settings are a Settings tab)                                                                                                                                        |
| Cloud Sync   | Data                                                                                                                                                                                                |
| Commerce     | Overview and In-app purchases                                                                                                                                                                       |

Package feeds is shown only when the product reports that capability. The **Matrix** path remains
addressable and the `g m` shortcut resolves to it, but the sidebar and palette expose **Rollouts**
instead.

### Navigation aids

The top bar supplies product switching, environment information when provided, theme and account
menus, help, and keyboard shortcuts. `Cmd/Ctrl+K` opens the command palette. The palette
contains navigation, product results, registered safe actions, settings, and entity search
(ST-52): licenses and users across the products the member may read, and a pasted license key
resolved to its license, through `POST /manage/api/search` (the query is in the body so a key never
reaches a URL or a request log). Up to 5 rows per group, then "Show all N". It does not make an
unregistered server capability available.

The product switcher keeps the same product page when the destination product enables its service;
otherwise it opens that product's Overview. It never carries a record identifier or record tab into
another product.

## 4. Data, mutations, and screen states

The console uses TanStack Query. Successful reads are fresh for 30 seconds, refetch on window focus,
and do not retry silently. Failed reads surface an error and an explicit retry.

Every read is a `queryOptions` factory in a data module (`console/data/reads.ts` or a section's `data.ts`), with its key in `console/data/queries.ts`; `test/queryFactories.test.ts` rejects a `queryFn` or bare `api.*` read elsewhere. All requests go through the one HTTP client in `lib/http.ts` (the only `fetch`, and the only error class, `HttpError`). Every API write goes through `console/data/mutations.ts`, built on the shared write engine `lib/writes.ts`. That mutation table declares the query
keys made stale after the server confirms the write; tests reject direct write calls and missing
invalidation declarations. This includes product creation, repository linking and resync, service
changes, release and rollout operations, credentials and secrets, licensing, managed configuration,
assets, storefront/listing actions, and package feeds.

Current shared states are intentionally explicit:

- boot loading and boot failure;
- unknown product, unknown page, and moved-page recovery;
- service-off recovery;
- permission refusal with an accessible destination;
- query errors with retry; and
- page-local loading, empty, validation, mutation-error, and one-time-secret states supplied by the
  relevant page and shared UI primitives.

Draft-aware forms, save bars, route blockers, error-copy mapping, tables, overlays, and state
components are implemented in `packages/admin/src/ui` and the console section packages. Their
current code and tests are the reference for their exact behavior; this document does not duplicate
their obsolete API sketches.

## 5. Planned and parked work

The design specifications remain useful as coverage and design records, but their proposed screen
shapes are not automatically shipped. Use the program graph or the `uxRows` map in
[`backlog-changes.json`](../research/2026-10-07-dx-consolidation/backlog-changes.json) before
describing any of the following as present. The console sign-in card (P0-38, shipped by ST-30) and
the settings hub with its search (ST-10, ST-39) are shipped and no longer listed:

| Area                                                                | Status                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Launch path and the proposed guided first-run setup                 | **Planned — ST-41** (`UX-21`, `UX-50`, `UX-51`, `UX-63`–`UX-65`)                             |
| Channel/storefront automation and the proposed per-store setup flow | **Planned — A-19 through A-25** (`UX-52`–`UX-58`, `UX-68`, `UX-70`, `UX-71`)                 |
| The redesigned New Product flow beyond the shipped route            | **Planned — ST-43** (`UX-73`, `UX-74`, `UX-76`); `UX-72` is recorded built in the UX-row map |
| Role-request workflow and further access-policy changes             | **Planned — ST-33**; the shipped console has no request workflow                             |

This table is deliberately not a second backlog. It prevents a design proposal from being reported
as a shipped console capability.

## 6. Console screen-package acceptance (`admin-4-23`)

Every package that delivers a console screen **must cite and satisfy this checklist**:

- [ ] The accepted source is reconciled.
- [ ] Pending, empty, stale, refused, and partial states are fixtured.
- [ ] Below-the-fold and return paths are exercised.
- [ ] Both color schemes, large text, and localisation are covered.
- [ ] Keyboard and screen-reader behavior are checked in the real host.
- [ ] Reduced motion is covered.
- [ ] Secrets and consequences are explicit.
- [ ] The relevant gates pass.

This is the acceptance checklist for a screen package, not a claim that every historical screen has
already met every row.

## 7. Pages derived from supplemental studies (`admin-4-23`)

When a console page is informed by a supplemental study:

1. Map each legacy route into an accepted home.
2. Never recreate a retired navigation item.
3. Replace placeholder rows with model fields and permission checks.
4. Keep preview, step-up, stale-state detection, and per-item results where the accepted design
   requires them.

Studies 372–387 are a **coverage checklist only** (**B16**). They do not authorize a route, page,
navigation item, permission, API capability, or product behavior. The accepted source and the
shipped code decide those.

## 8. Verification

For documentation-link changes, run:

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

For console behavior, use the focused tests in `packages/admin/test/` and the package's normal
build and test scripts. The repository green gate is defined in [AGENTS.md](../../AGENTS.md).
