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
names. In particular, the current route registry still calls the Distribution page **Outlets &
feeds**; that is a current label, not a statement that the glossary migration is complete.

## 2. Application shell and session

`App` loads the authenticated `/me` query before rendering the console. It shows the boot screen
while that query is pending and an error state with **Retry** if it fails. The shell then owns the
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
sidebar. Override migration (`#/platform/override-migration`) remains addressable but is not in
navigation or the palette.

### Product context

Every product has **Core**, drawn as a flat list (no group header; Settings sits at the foot):

| Page           | Path and route detail                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| Overview       | `#/p/<slug>`                                                                         |
| Services       | `#/p/<slug>/services`                                                                |
| Devices        | `#/p/<slug>/devices`, with a routed device record                                    |
| Users          | `#/p/<slug>/users`, with overview, licenses, devices, activity, and data record tabs |
| Presentation   | `#/p/<slug>/presentation`                                                            |
| Keys & secrets | `#/p/<slug>/keys`                                                                    |
| Activity       | `#/p/<slug>/activity`                                                                |
| Settings       | `#/p/<slug>/settings`                                                                |

Enabled services add their sections:

| Section      | Shipped pages                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License      | Licenses (record tabs: overview, keys, devices, config), Tiers (overview and used-by), Enrollment, Licensing settings, and non-sidebar Batches                                    |
| Config       | Catalog, its non-sidebar editor (the minted-token approve drawer opens there), and Profiles                                                                                       |
| Release      | Releases (builds, packs, channels, distribution), Channels, Deliverables (releases, channels, delivery, files), Compatibility, its non-sidebar Update simulator, and Content keys |
| Distribution | non-sidebar Matrix, Rollouts, Outlets & feeds, Storefronts (including a record route), Listing, App Store, Commerce, Access, Package feeds, Health, and Outlet credentials        |
| Update       | Feed                                                                                                                                                                              |
| Identity     | Portal and Sign-in                                                                                                                                                                |
| Cloud Sync   | Data                                                                                                                                                                              |

Package feeds is shown only when the product reports that capability. The **Matrix** path remains
addressable and the `g m` shortcut resolves to it, but the sidebar and palette expose **Rollouts**
instead.

### Navigation aids

The top bar supplies product switching, environment information when provided, theme and account
menus, help, and keyboard shortcuts. `Cmd/Ctrl+K` opens the command palette. The palette currently
contains navigation, product results, and registered safe actions; it does not make an unregistered
server capability available.

The product switcher keeps the same product page when the destination product enables its service;
otherwise it opens that product's Overview. It never carries a record identifier or record tab into
another product.

## 4. Data, mutations, and screen states

The console uses TanStack Query. Successful reads are fresh for 30 seconds, refetch on window focus,
and do not retry silently. Failed reads surface an error and an explicit retry.

Every API write goes through `console/data/mutations.ts`. That mutation table declares the query
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
describing any of the following as present:

| Area                                                                              | Status                                                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Shared console sign-in card, session-ended card, and related console sign-in work | **Planned — P0-38** (`UX-40`, `UX-43`)                                                                                             |
| Entity search in the palette                                                      | **Parked — UX-06b**; revive when settings search and the product switcher are no longer enough (a third product or a support desk) |
| Settings search, unified settings hub, and its row model                          | **Planned — ST-10, ST-41, and ST-39**                                                                                              |
| Launch path and the proposed guided first-run setup                               | **Planned — ST-41** (`UX-21`, `UX-50`, `UX-51`, `UX-63`–`UX-65`)                                                                   |
| Channel/storefront automation and the proposed per-store setup flow               | **Planned — A-19 through A-25** (`UX-52`–`UX-58`, `UX-68`, `UX-70`, `UX-71`)                                                       |
| The redesigned New Product flow beyond the shipped route                          | **Planned — ST-43** (`UX-73`, `UX-74`, `UX-76`); `UX-72` is recorded built in the UX-row map                                       |
| Role-request workflow and further access-policy changes                           | **Planned — ST-33**; the shipped console has no request workflow                                                                   |

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
