# Admin UI inventory

Companion to [ADMIN.md](../ADMIN.md) §1. This is the exhaustive per-view audit of both SPAs in
`packages/admin` as of `574bd242`. Paths are relative to `packages/admin/src/` unless prefixed:
`W/` is `packages/worker/src/`, `D/` is `packages/docs/src/content/docs/`. Every API path below
sits under `/manage/api/products/:slug`, written `…`.

Each finding has a stable ID (`AREA-n`). The redesigns in ADMIN.md §6 and the implementation
chunks in §7 cite these IDs, so a reviewer can check that every finding is either fixed or
explicitly deferred.

Severity tags: **[bug]** is wrong behavior today. **[a11y]** is an accessibility defect.
**[dead]** is a dead end (a promise the UI does not keep). Untagged findings are UX debt.

---

## 0. Inventory at a glance

### 0.1 Operator console (`/manage`, `manage.html` → `main.tsx` → `App.tsx`)

| Route (hash)                    | View (file)                                                                                        | Section      | Reads                                                                              | Writes                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `#/`                            | `Dashboard` (`views/Dashboard.tsx`, 170)                                                           | —            | `me` (boot)                                                                        | —                                                                                              |
| `#/products`                    | `Products` (`views/Products.tsx`, 335 + `products/*`, 1302)                                        | —            | `GET /products`                                                                    | create, link-repo, PATCH, DELETE, resync, keys/prepare, PUT secret                             |
| `#/p/:slug[/overview]`          | `ProductOverview` (`views/ProductOverview.tsx`, 659)                                               | Platform     | `GET …`                                                                            | —                                                                                              |
| `#/p/:slug/services`            | `Services` + `services/ServicesCard.tsx` (28 + 515)                                                | Platform     | `GET …/services`                                                                   | `PATCH …/services`, `POST …/services/revert`                                                   |
| `#/p/:slug/devices`             | `Devices` (`views/Devices.tsx`, 693)                                                               | Platform     | `GET …/devices`, `…/devices/summary`, `…/devices/:id`                              | deauthorize, fingerprint reset                                                                 |
| `#/p/:slug/secrets`             | `Secrets` + `EdgeMintRecipes` + `OutletCredentials` (242 + 531 + 599)                              | Platform     | `GET …`, `…/config/mint`, `…/outlet-credentials`                                   | PUT secret, mint approve/revoke, outlet credential PUT/DELETE                                  |
| `#/p/:slug/activity`            | `Activity` (`views/Activity.tsx`, 185)                                                             | Platform     | `GET …/activity` (keyset)                                                          | —                                                                                              |
| `#/p/:slug/settings`            | `Settings` (`views/Settings.tsx`, 407)                                                             | Platform     | `GET …`                                                                            | PATCH product, keys/prepare, DELETE product                                                    |
| `#/p/:slug/licenses`            | `Licenses` (`views/Licenses.tsx`, 719)                                                             | License      | `…/license/licenses`, `…/license/tiers`, `…/config/profiles`, `…/release/releases` | POST license                                                                                   |
| `#/p/:slug/licenses/:id`        | `LicenseDetail` + `licenses/*` (369 + 1843)                                                        | License      | license, tiers, catalog, profiles, services, releases                              | enable/disable, PATCH, PUT overrides, keys mint/revoke, device deauthorize/reset, POST bundles |
| `#/p/:slug/tiers`               | `Tiers` + `tiers/dialogs.tsx` (345 + 550)                                                          | License      | tiers, profiles, releases                                                          | POST/PATCH/DELETE tier                                                                         |
| `#/p/:slug/fingerprints`        | `FingerprintPolicy` (488)                                                                          | License      | `…/services`, `…/license/policy`                                                   | PATCH policy, revert                                                                           |
| `#/p/:slug/config`              | `Catalog` + `catalog/*` (265 + 315)                                                                | Config       | `GET …/config/catalog`                                                             | `PUT …/config/catalog`                                                                         |
| `#/p/:slug/profiles`            | `Profiles` + `profiles/CreateProfileDialog.tsx` (269 + 166)                                        | Config       | `…/config/profiles`                                                                | POST, DELETE profile                                                                           |
| `#/p/:slug/profiles/:id`        | `ProfileDetail` + `PayloadEditor` (117 + 122)                                                      | Config       | profile, catalog                                                                   | PUT profile payload                                                                            |
| `#/p/:slug/releases`            | `Releases` + `releases/{ChannelsPanel,PolicyActionDialog,ReleaseBuilds,ResyncButton}` (787 + 1306) | Release      | product, `…/release/health`, `…/release/releases`, `…/release/channels`            | channel PUT/revert/floor, yank/unyank, resync                                                  |
| `#/p/:slug/deliverables`        | `Deliverables` + `ContentKeys` (301 + 161)                                                         | Release      | `…/release/deliverables`, `…/release/delegations`                                  | —                                                                                              |
| `#/p/:slug/deliverables/:id`    | `DeliverableDetail` (571)                                                                          | Release      | deliverables, `…/deliverables/:id/releases`, `…/releases/:rid/files`               | —                                                                                              |
| `#/p/:slug/compatibility`       | `Compatibility` (833)                                                                              | Release      | `…/release/compat`, `…/distribution/matrix?limit=50`, `…/update/simulate`          | —                                                                                              |
| `#/p/:slug/distribution`        | `Distribution` (326)                                                                               | Distribution | `…/services`, `…/distribution/rollouts`                                            | —                                                                                              |
| `#/p/:slug/distribution-matrix` | `DistributionMatrixView` (`distribution/Matrix.tsx`, 470)                                          | Distribution | `…/distribution/matrix`, `…/release/releases`                                      | rollout pause/resume/halt/complete                                                             |
| `#/p/:slug/distribution-health` | `UpdateHealthView` (`distribution/UpdateHealth.tsx`, 476)                                          | Distribution | `…/distribution/update-health`                                                     | auto-halt settings, Sentry candidate confirm/dismiss                                           |
| `#/p/:slug/updates`             | `UpdateSettings` (727)                                                                             | Update       | `…/update/settings`, `…/distribution/access`                                       | PATCH update settings, PUT delivery access, both reverts                                       |
| `#/p/:slug/identity`            | `Identity` (501)                                                                                   | Identity     | `…/identity/portal`, product                                                       | PATCH portal settings, resync                                                                  |
| (not a route) `/manage/login`   | Worker-rendered HTML (`W/admin/auth.ts:203`)                                                       | —            | —                                                                                  | —                                                                                              |

### 0.2 Customer portal (`/`, `index.html` → `portal/main.tsx` → `portal/App.tsx`, 1105 lines)

| Route (hash)              | Screen                       | Reads                      | Writes                                            |
| ------------------------- | ---------------------------- | -------------------------- | ------------------------------------------------- |
| (no session)              | `SignIn` (`App.tsx:185-292`) | `GET /api/capabilities`    | `POST /api/magic/start`; `/login` redirect (OIDC) |
| `#/`                      | Dashboard (`:387-421`)       | `/api/me`, `/api/licenses` | `POST /api/claim/license-key`                     |
| `#/licenses`              | Licenses (`:550-612`)        | `/api/licenses`            | —                                                 |
| `#/licenses/:product/:id` | License detail (`:682-771`)  | `/api/licenses/:p/:id`     | `DELETE /api/licenses/:p/:id/devices/:d`          |
| `#/downloads`             | Downloads (`:961-1082`)      | `/api/releases`            | `POST /api/releases/:p/:rid/artifacts/:aid/token` |
| `#/profile`               | Profile (`:1084-1105`)       | `/api/me`                  | —                                                 |

### 0.3 Admin API capability with no UI

From the API sweep (`W/admin/*`, `W/services/*/admin.ts`); `api.ts` makes 77 distinct calls.

| Capability                                        | Route(s)                                                                                       | Today                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Signing key activate / retire / revoke            | `POST …/keys/{activate,retire,revoke}`                                                         | API-only; only Prepare is wired; no key list exists |
| Platform KEK keyring status and re-seal           | `GET/POST /products/kek`                                                                       | none                                                |
| CI trusted publisher and CI tokens                | `GET/PUT …/ci-publisher`, `GET/POST/DELETE …/ci-tokens`                                        | none                                                |
| Blob GC dry run                                   | `GET …/blob-gc`, `…/blob-gc/bundles`                                                           | none                                                |
| Outlets and capability narrowing                  | `GET …/distribution/outlets`, `PUT/POST …/capabilities[/revert]`                               | none                                                |
| Rollout start / set percentage                    | `POST …/distribution/rollouts/:outlet/:channel` `{releaseId,bp}`                               | none (verbs only)                                   |
| Availability, submissions                         | `GET …/distribution/{availability,submissions}`                                                | only inside matrix cells, partially                 |
| Distribution keys                                 | `GET/PUT/DELETE …/distribution/keys`                                                           | none                                                |
| Readiness list, refresh, override, clear          | `…/distribution/readiness`, `…/readiness/refresh`, `…/readiness/:app/:outlet/{override,clear}` | read-only inside Compatibility's overlay            |
| Store connectors (App Store Connect, Google Play) | `…/distribution/connectors/*`                                                                  | none                                                |
| Asset packs and retire candidates (P5-08)         | `GET …/distribution/asset-packs`                                                               | none                                                |
| Per-pack delivery access                          | `PUT …/distribution/access {deliverable}`                                                      | app only                                            |
| Pack channel policy, pack floors (`contentApi`)   | `PUT …/release/channels/:c {deliverable, contentApi}`                                          | app only, no `contentApi`                           |
| Update-health window                              | `GET …/update-health?windowHours=`                                                             | fixed default                                       |
| Simulator `channel`, `methods`                    | `GET …/update/simulate`                                                                        | not exposed                                         |
| Self-service account erasure (portal)             | `DELETE /api/me`                                                                               | none                                                |
| Per-product capabilities (portal)                 | `GET /api/capabilities?product=`                                                               | always unscoped                                     |

Storefront feeds (AltStore, AltStore PAL, Obtainium, F-Droid, Scoop, Flathub) are public routes
(`W/services/distribution/routes.ts:22-26`) with no admin surface. Their URLs are derivable from the
outlets list plus channel names (`D/services/distribution/feeds.md`).

---

## 1. Shell, routing and data layer

**Files:** `route.ts` (385), `App.tsx` (325), `components/Shell.tsx` (452), `context.tsx` (181),
`components/theme.tsx` (62), `components/brand/Logo.tsx` (76), `styles.css` (215),
`tailwind.config.ts`.

**Layout today.** A `lg:grid-cols-[16rem_1fr]` frame (`Shell.tsx:126`):

- **Sidebar, top to bottom:**
  - Logo button ("admin" subtitle).
  - Dashboard and Products items.
  - A "Product" Radix `Select` switcher.
  - Per enabled section: an uppercase accent label and its items.
- **Topbar** (sticky, h-14): `<h1>` "Section · Tab", a help icon, a theme toggle and a user menu.
- **Content:** `max-w-6xl` with `data-service` on the wrapper (`Shell.tsx:156-157`).

Below `lg` the sidebar becomes an off-canvas drawer.

**Findings**

- **SH-1 [bug]** The session (`me`, including `me.products`) is fetched once at boot and never
  refreshed (`App.tsx:75-85`). After a product is created or deleted, the switcher, Dashboard and
  the Settings redirect are stale until a reload.
- **SH-2 [a11y]** The off-canvas sidebar is only translated with CSS (`Shell.tsx:185-191`). It is
  not `inert` and has no Escape-to-close, focus trap or scroll lock, so keyboard users tab through
  an invisible menu.
- **SH-3 [bug]** The frame is `min-h-screen` and the aside is `lg:static` (`Shell.tsx:126,156,188`),
  so the desktop sidebar scrolls away on long pages.
- **SH-4** Four nav items have no icon: `deliverables`, `compatibility`, `distribution-matrix` and
  `distribution-health` (`Shell.tsx:62-85`). They render a blank spacer (`:304-308`).
- **SH-5 [a11y]** Sidebar items are `<button onClick>` (`Shell.tsx:289`): no middle-click and no
  open-in-new-tab. Views use `<a href>`, and `Settings.tsx:350` writes `location.hash` directly.
  There are three navigation primitives.
- **SH-6** Every view is remounted on route change (`<div key={routeKey}>`, `App.tsx:139,173-179`),
  and there is no unsaved-changes guard anywhere, so any route change drops a draft.
- **SH-7** Routes carry no query state (`route.ts:334` stops at `?`). Filters, sort, tabs and the
  open drawer are never in the URL, so nothing is shareable or survives a refresh.
- **SH-8** An unknown tab silently becomes `overview` and an unknown hash becomes the dashboard
  (`route.ts:353-362`). There is no 404. `#/productsfoo` matches Products (`:339`, `startsWith`).
- **SH-9** `normalizeView` is an identity function (`route.ts:307-309`), and the "X not found" leaf
  branches in `App.tsx:246-283` are unreachable.
- **SH-10** On Dashboard and Products the sidebar still draws the first product's sections
  (`activeSlug` falls back to `me.products[0]`, `App.tsx:87-88`). This implies a product is
  selected when none is.
- **SH-11** Switching product always lands on `overview` (`App.tsx:123-124`, `Shell.tsx:228-230`),
  so the current page is lost.
- **SH-12** The topbar `<h1>` ("License · Licenses") plus each view's own `<h2>` doubles every page
  title. Only the `license` leaf is special-cased in `titleFor` (`Shell.tsx:321-329`), so profile
  and deliverable pages read "Config · Profiles" and "Release · Deliverables".
- **SH-13 [a11y]** The help link is labelled only by `title` (`Shell.tsx:375-394`).
- **SH-14** The user menu shows name, email and Sign out only: no session expiry (the session is a
  hard 8 h, `W/admin/session.ts:44-50`), no theme choice, no shortcuts.
- **SH-15 [bug]** Theme is dark/light only, defaults to dark and ignores `prefers-color-scheme`
  (`theme.tsx:14-19`). The class is applied in an effect after first paint with no pre-paint script
  in `manage.html`, so light users get a dark flash.
- **SH-16** The resource cache (`context.tsx:41-147`) has no TTL, no focus refetch and no optimistic
  updates. `invalidate(prefix)` must be called by hand, and the product resource `product:<slug>`
  has five identical inline fetchers (`ProductOverview.tsx:40`, `Settings.tsx:40`, `Secrets.tsx:51`,
  `Identity.tsx:386`, `context.tsx:170`). `"products"` and `product:<slug>` go stale independently.
  §1.3 below lists the stale-cache bugs this causes.
- **SH-17** There is one breakpoint (`lg`). Tables only scroll horizontally, and dialogs have no
  bottom-sheet form on phones.
- **SH-18** The placeholder accent palette (`styles.css:113-172`) uses indigo for core, amber for
  License (confusable with the gold signing bit), violet for Release and rose for Identity. The kit
  forbids all four in these roles.
- **SH-19** Fonts: the system stack, with "Inter" listed after system faces so it is never used
  (`tailwind.config.ts:74-95`). There is no type scale, and 181 `font-medium`/`font-semibold` uses
  have no counterpart in Rubik's 400/700 pair.
- **SH-20** Two sr-only utilities exist (`pk-sr-only`, `styles.css:204`, and Tailwind's `sr-only`).
  The `container` config is unused.

### 1.1 The component kit (`components/ui/`)

- **UI-1 [bug]** `Button` sets `disabled={disabled ?? loading}` (`Button.tsx:71`). A caller passing
  `disabled={false}` stays clickable while loading, which allows a double submit. Affected callers:
  - `EdgeMintRecipes.tsx:509`
  - `CreateProductDialog.tsx:327,483`
  - `ServicesCard.tsx:421`
  - `Settings.tsx:215`
  - `Identity.tsx:362`
  - `FingerprintPolicy.tsx:332`
- **UI-2 [a11y]** The base button class has `disabled:pointer-events-none` (`Button.tsx:8`), so
  every `title=` explanation on a disabled button never shows. Examples: `ServicesCard.tsx:427-432`,
  `FingerprintPolicy.tsx:338-343`, `Identity.tsx:490-493`, `ResyncButton.tsx:58-60`,
  `UpdateSettings.tsx:628-639`.
- **UI-3** `Button` has no default `type="button"`, so inside a `<form>` it submits. `asChild`
  ignores `loading` and `disabled` (`:56-65`).
- **UI-4** `Badge` has no info or neutral variant, no size and no icon or dot slot. Status is
  often color-only.
- **UI-5** `CardHeader` has no actions slot; callers hand-roll the flex row (`ServicesCard.tsx:260`,
  `FingerprintPolicy.tsx:257`). There is no compact density.
- **UI-6 [a11y]** `Field` clones its child to inject `id`/`aria-*` (`Field.tsx:48-53`), which a
  Radix `Select` root silently drops. So every select is hand-wired with a bare Label + Select
  (`Secrets.tsx:201-228`, `SecretDialog.tsx:139-156`, `ServicesCard.tsx:322-395`,
  `OutletCredentials.tsx:458-478`, `FingerprintPolicy.tsx:303-327`, `Identity.tsx:315-358`), and
  `SchemaForm.tsx:316-336` misses it (see SCF-1). The required marker is a color-only red `*`
  (`:60`).
- **UI-7** `Select` has no search, no multi-select and no clear. Hence sentinel values such as
  `__none__` and `__derived__` (`ServicesCard.tsx:102`).
- **UI-8** `Tabs` has one pill style, no underline variant and no URL sync, and `TabsContent` has a
  hard-coded `mt-4`. Without `forceMount`, switching tabs unmounts drafts (LDT-4).
- **UI-9** `Dialog` has no size prop (callers override `max-w-*` 5 ways). `DialogFooter` and
  `DialogActionBar` both exist. There is no Sheet or Drawer: `Devices.tsx:542` restyles a Dialog
  into a right-side sheet with inline classes.
- **UI-10** `ConfirmDialog` defaults `confirmVariant` to destructive, so every non-destructive use
  must override it. Escape is blocked while loading, but outside-click is not.
  - **There is no typed confirmation.** Product delete sends `confirmSlug: slug` automatically from
    the client (`api.ts:1703`), which defeats the server's typed-confirm guard
    (`W/admin/handlers/products.ts:272`).
- **UI-11** `Toaster` uses 5 s for every variant, errors included (`Toaster.tsx:31,98`). There is no
  warning or info variant, no action or undo, no dedupe and no stack limit.
- **UI-12** `DataTable` (`DataTable.tsx`, 319):
  - **Has:** client sort (tri-state, `aria-sort`), one global substring filter, 4 fixed skeleton
    rows, an empty slot, expandable rows, and row click via `role="button"` on `<tr>`.
  - **Lacks:** facets, pagination (only a separate `useKeysetPagination` "load more" hook that races
    on reset, `:270-319`), selection, bulk actions, column visibility, sticky header, density, a
    mobile layout, an error prop and URL state.
  - **[a11y]** A clickable row containing buttons nests interactive elements (Products).
- **UI-13 [a11y]** `Skeleton` is `aria-hidden` with no live announcement, so screen readers hear
  nothing while views load.
- **UI-14** `EmptyState` is also the error state everywhere: no error tone, and retry copy that
  varies ("Retry", "Try again", "Retry" with an icon).
- **UI-15** Components that are missing, and are hand-rolled instead:
  - PageHeader (in every view).
  - Callout/Alert: `ProductOverview.tsx:166-179`, `EdgeMintRecipes.tsx:332-357`,
    `Identity.tsx:466-486`, `Settings.tsx:285-302`.
  - CopyButton: only `licenses/shared.tsx` and `ReleaseBuilds.tsx` have one.
  - DescriptionList: 4 copies.
  - StatCard: `Dashboard.tsx:146-170` and `ProductOverview.tsx:586-622` (MetricCard).
  - SourceBadge (manifest/admin): 3 copies, in `ServicesCard.tsx:471-485`,
    `FingerprintPolicy.tsx:269-278` and UpdateSettings.
  - DocsLink: 26 inline copies.
  - BackLink: 2 copies.
  - `describeError`: 3 copies.
  - Not present at all: Breadcrumbs, Avatar, RadioGroup, Popover, Combobox, Sheet, Kbd.

### 1.2 Cross-cutting patterns (counts)

| Pattern                                          | Count / evidence                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page header heading size                         | `text-2xl` in 12 views; `text-xl` in 11 (Settings, Services, Activity, Secrets, Identity, FingerprintPolicy, Devices, Distribution, Matrix, UpdateHealth, UpdateSettings). Compatibility has no header (`Compatibility.tsx:104-122`). |
| Page subtitle                                    | Usually "… for **{slug}**": the slug, not the product name.                                                                                                                                                                           |
| Toast calls                                      | ~90 in `views/`.                                                                                                                                                                                                                      |
| `invalidate(` calls                              | 44, with no shared map of which mutation stales which key.                                                                                                                                                                            |
| `err instanceof Error ? err.message : undefined` | 26 sites, which surface "api 422" when the body has no message. Only 5 files use `products/util.ts` `errorMessage()`, which also joins `fields`.                                                                                      |
| `ConfirmDialog`                                  | Used in 17 files, none with typed confirmation.                                                                                                                                                                                       |
| Hand-rolled `<table>` instead of `DataTable`     | 7 files: OutletCredentials, Distribution, Compatibility, DeliverableDetail, ReleaseBuilds, Matrix, UpdateHealth. Most lack `scope`.                                                                                                   |
| Key facts only in a `title` attribute            | Matrix, Compatibility, ChannelsPanel, ContentKeys, UpdateHealth, OutletCredentials, DevicesSection, portal Downloads. The `Tooltip` primitive is used in 2 views.                                                                     |
| Timestamp formatters                             | `views/format.ts` relative/absolute, `licenses/shared.tsx:16-29` absolute, `Releases.tsx:751-758`, `SchemaForm.tsx:619-626`, `portal/format.ts`. 5 implementations.                                                                   |
| Hard-coded colors                                | Only `bg-black/50` (`Shell.tsx:131`) and `bg-black/60` (`Dialog.tsx:18`). Views otherwise stay on tokens.                                                                                                                             |

### 1.3 Stale-cache bugs (from SH-16)

- **CC-1 [bug]** Product create invalidates only `"products"` (`CreateProductDialog.tsx:161,358`).
  Delete calls `reload()` only (`Products.tsx:84`). Edit misses `product:<slug>`
  (`EditProductDialog.tsx:78`). Settings misses `"products"` (`Settings.tsx:144`). No path refreshes
  `me`.
- **CC-2 [bug]** `ResyncButton` invalidates only `product:`, `release-health:` and `schema:`
  (`ResyncButton.tsx:39-41`). Yet a resync re-applies channels, catalog, services, tiers, profiles,
  update settings and delivery access.
- **CC-3 [bug]** `PolicyActionDialog` misses `deliverables:`, `release-compat:*`,
  `distribution-matrix:*` and `pack-releases:*` (`PolicyActionDialog.tsx:48-52`). A yank leaves
  Compatibility and the Matrix stale.
- **CC-4 [bug]** Matrix rollout verbs invalidate `distribution-matrix:${slug}` but not
  `distribution-matrix:${slug}:compat` (Compatibility's overlay) or update-health
  (`Matrix.tsx:141`). Sentry confirm, which halts a rollout, invalidates neither the matrix nor the
  rollouts.

---

## 2. Platform views

### 2.1 Dashboard (`views/Dashboard.tsx`)

**Purpose.** The landing page. **Data.** `me` from context only.

**Layout.**

- "Welcome, {first}".
- 3 StatCards: Products, Access "All products", Session "Active".
- "Your products" grid of cards (name, `schema vN`, slug, "Open"), or an EmptyState.

**Findings**

- **DSH-1** Two of three stat cards are constants (`:62-71`). There is no operational information:
  attention items, license counts, rollouts, recent activity, setup health.
- **DSH-2 [bug]** The product list is the boot-time snapshot (SH-1).
- **DSH-3** The card has a hover border (`hover:border-primary/40`) but only the "Open" button is
  clickable (`:119,134-141`).
- **DSH-4** The "schema vN" badge is jargon, explained only by `title` (`:123-128`). Email is
  repeated in the header and in the user menu (`:52`).
- **DSH-5** Three names for one place: "Manage registry" (`:83`), "Open registry" (`:94`), nav
  "Products".
- **DSH-6** The empty state says "Link a repository or create a product" but navigates away instead
  of opening the create flow (`:91-96`).
- **DSH-7** No search or sort. Cards show no enabled services and no health.

### 2.2 Products registry (`views/Products.tsx`, `products/*`)

**Purpose.** The platform registry.

**Data.**

- Reads: `GET /products`.
- Writes: `POST /products`, `POST /products/link-repo`, `PATCH`/`DELETE /products/:slug`,
  `POST …/release/resync`, `POST …/keys/prepare`, `PUT …/secrets/:name`.

**Layout.**

- Header with "New product".
- A filterable DataTable: Slug, Name, Release source, Created, Modified, and a ⋯ menu with Edit,
  Set secret, Resync from GitHub, Prepare signing key, Delete.
- Dialogs:
  - `CreateProductDialog` (`max-w-3xl`): tabs Manual / From GitHub, with Manual nesting Basics /
    Catalog / Defaults. Ends in a success panel with kid and public key.
  - `EditProductDialog`: Basics / Defaults.
  - `SecretDialog`.
  - `RotateKeyResultDialog`.

**Findings**

- **PRD-1 [bug]** Row click opens `licenses` (`:209-211`), a service that may be off, which lands on
  the ServiceDisabled screen. Dashboard opens `overview`.
- **PRD-2 [a11y]** The `role=button` row contains the ⋯ menu button (`:169-171`). Nesting is papered
  over with `stopPropagation` (`:304,309`).
- **PRD-3** One action, three names: menu "Delete" (`:330`), confirm "Disable product" (`:249`),
  toast "Product disabled… tombstoned" (`:83`).
- **PRD-4 [bug]** Tombstoning has no typed confirmation, and the client auto-fills `confirmSlug`
  (UI-10). It disables every license and evicts device tokens.
- **PRD-5** The registry duplicates per-product surfaces, with diverging validation:
  - Edit vs Settings → General. Settings requires a name (`Settings.tsx:126`); Edit sends blank as
    `undefined`.
  - Set secret vs Secrets.
  - Prepare signing key vs Settings.
  - Delete vs Danger zone.
- **PRD-6 [bug]** Edit cannot clear the admin group, and a blank name is silently ignored rather
  than rejected: `trimmedOrUndefined` drops blanks (`EditProductDialog.tsx:73-76`).
- **PRD-7** Create has tabs inside tabs (`CreateProductDialog.tsx:199-210` inside `:522-542`). Its
  Defaults tab still collects compat min/max (`:273-286`), which now live under Update.
- **PRD-8 [dead]** The GitHub success copy says "Set each secret from the product's Settings"
  (`:426-427`), but secrets are on Secrets. The success panel offers only "Done", with no
  "Open product" or "Set secrets" (`:432-434`).
- **PRD-9** Key material has no copy button: success `ResultRow` (`:41-56`), `KeyReminder`
  (`:71-106`), `RotateKeyResultDialog.tsx:64-66`. Copy leaks implementation: "once the backend
  exposes it" (`:99-103`).
- **PRD-10 [bug]** Create can be submitted twice while loading (UI-1). Confirm dialogs close on
  outside-click mid-request (`:246,255,265`).
- **PRD-11** No services, status or health column. A reload after a mutation shows no indicator,
  and 6 columns overflow on mobile.
- **PRD-12** Errors are toast-only. With no JSON message, the toast reads "api 500"
  (`api.ts:1665-1666`).

### 2.3 Product overview (`views/ProductOverview.tsx`)

**Purpose.** Setup health at a glance. **Data.** `GET …` (`ProductDetail`: signing, modules,
services, setup, onboarding).

**Layout.**

- Header with "Settings" and "Create license".
- HealthStrip: 4 MetricCards (Setup, Modules, Trust key, Release source) plus a warning banner.
- Row 1: SetupCard (key/value list plus a "Guided checklist" of up to 7 items) and SigningCard
  (kid, public key, JWKS, JSON).
- Row 2: ModulesCard and SdkCard (JS snippet).

**Findings**

- **OVR-1** Actions ignore enablement:
  - "Create license" is unconditional, is shown even in the error state (`:116-120`), and only opens
    the list.
  - "Review identity" and "Review config" are unconditional (`:531-552`).
  - The ModulesCard fallback invents a "baseline" module list that contradicts Services
    (`:434-468`).
- **OVR-2** The checklist is inaccurate:
  - "Issue a license" is always "action" (`:333-345`).
  - "Review setup warning" links to the page itself (`:349-358`).
  - Warnings show twice (banner and checklist).
  - `slice(0,7)` silently truncates (`:379`).
- **OVR-3 [dead]** The trust-key item links to Settings (`:299`), which shows only the kid: no
  public key, staged keys or activation.
- **OVR-4** The SetupCard still shows the compat window (owned by Update now, `:199`) and license
  defaults when License is off (`:200-201`).
- **OVR-5** Meaningless values: "Modules: Baseline", "Setup: Baseline" (`:151,625`); raw `manual`
  and `github` (`:139,162`).
- **OVR-6** The SDK snippet hard-codes `version: "1.0.0"`, is JS-only and has no copy
  (`:514,527-529`). The public key and JSON have no copy (`:410-422`). The fallback
  "// public key not available yet" is rendered as code (`:420`).
- **OVR-7 [a11y]** Checklist status is icon color only (`:236-246`).
- **OVR-8** On mobile the dense SetupCard comes first. MetricCard duplicates Dashboard's StatCard
  (`:586-622`).

### 2.4 Services (`views/Services.tsx`, `services/ServicesCard.tsx`)

**Purpose.** Per-product service enablement and the device-registration policy.

**Data.** `GET`/`PATCH …/services`, `POST …/services/revert`. Coherence errors are 422 with
`errors[]` (`W/core/services.ts:278-315`).

**Layout.**

- h2 "Services" over a card also titled "Services".
- 6 rows: icon, label, summary, Switch.
- A registration Select with "Declared / Enforced now" badges.
- Footer: Save services / Revert to manifest.

**Findings**

- **SVC-1** Dependencies (`SERVICE_REQUIRES`, `services.generated.ts:40-49`) are invisible until a
  422 (`ServicesCard.tsx:216-217`). Turning one off neither cascades nor warns.
- **SVC-2** Disabling a service has no confirmation, though its effects are large: sections vanish,
  endpoints answer not-configured, edge-mint approvals can lapse (`:308-316,421`).
- **SVC-3** No per-row "changed" marker and no sticky save bar. Save sits at the card bottom
  (`:420-438`).
- **SVC-4** Every service icon uses the core accent (`:97`), although per-service accents exist.
- **SVC-5** Raw slugs in badges: `requires-license`, `open` (`:383,392`). An unknown coherence code
  is shown raw (`:409`).
- **SVC-6** Registration policy is edited here and shown read-only again in FingerprintPolicy
  (`FingerprintPolicy.tsx:102-153`).
- **SVC-7** Duplicate heading (`Services.tsx:17`, `ServicesCard.tsx:262`). UI-1 and UI-2 apply
  (`:421,427-432`).

### 2.5 Devices (`views/Devices.tsx`)

**Purpose.** Every device of the product, licensed or license-free.

**Data.** `GET …/devices` (cursor; `status`, `platform`, `licensed`, `q` prefix, `limit`),
`…/devices/summary`, `…/devices/:id`. Writes: deauthorize, fingerprint reset.

**Layout.**

- Header with Refresh.
- SummaryChips.
- Filter row: search, Status, License, Platform, Clear.
- DataTable: Device, Status, License, Platform · arch, App · SDK, Last seen.
- "Load more".
- A fake right sheet (`DeviceDrawer`).

**Findings**

- **DEV-1 [dead]** The license id is raw mono text in the table (`:165-178`) and drawer
  (`:639-647`): no link and no holder name. "Whose device is this?" is unanswerable.
- **DEV-2** The drawer is a restyled Dialog (`:542`). The footer sits outside the body with no Close
  (`:566-582`), and the error has no Retry (`:556-559`).
- **DEV-3** The drawer omits probes, hardware (`cpuModel`, `cpuCores`, `ramMb`, `machineModel`) and
  `os.build`/`kernel` (`:676-690`).
- **DEV-4** The summary is half-interactive:
  - Platform chips toggle a filter and silently reset status (`:261`).
  - The status chips look identical but do nothing (`:441-445`).
  - `byArch`, `bySdkName` and `byAppVersion` are fetched and unused.
- **DEV-5** Pagination is hand-rolled again (`:81-127`) beside the DataTable hook. There is no total
  for the current filter.
- **DEV-6** Search is prefix-only, on id or label (server limit, `W/admin/repo.ts:262`). No bulk
  actions, export or sort.
- **DEV-7** The heading is `text-xl` (`:237`). `aria-label="Refresh devices"` duplicates the visible
  text (`:252`). The fixed `w-40`/`w-44` filters stack badly on phones (`:275,292,307`).
- **DEV-8** Two device UIs: this one and License detail → Devices. They use different endpoints,
  columns and confirm copy (`DevicesSection.tsx:163-181` vs `:586-607`).

### 2.6 Secrets page (`views/Secrets.tsx`), hosting `EdgeMintRecipes` and `OutletCredentials`

**Data.**

- `PUT …/secrets/:name {value, usage}`. Write-only, with no list endpoint; required-secret status
  comes from `product.setup`.
- `GET …/config/mint`, `POST …/config/mint/:id/{approve,revoke}`.
- `GET`/`PUT`/`DELETE …/outlet-credentials[/:id]`.

**Layout.**

- Card "Product secrets": required list, Name, Value, Usage, Set secret.
- Then the EdgeMintRecipes card.
- Then the OutletCredentials card.

**Findings (Secrets)**

- **SEC-1** One page mixes three unrelated concerns:
  - platform secrets;
  - edge-mint approval, a Config security decision;
  - outlet credentials, Distribution-only. These render even when Distribution is off (`:239`).
- **SEC-2** Only manifest-required secrets are visible. There is no inventory of set secrets, no
  `updatedAt` and no delete (`:98-180`). This is API-limited: there is no list route.
- **SEC-3** Overwriting a configured secret has no warning (`:63-96`).
- **SEC-4** A required-secret name is a link-styled `<button>` that silently fills the input
  (`:155-161`). "Missing" has no icon while "Configured" has one (`:168-175`).
- **SEC-5** Submit is `variant="secondary"` (`:231`). No required markers. The "never read back"
  copy is repeated (`:107-108,140-141`).
- **SEC-6** `USAGE_CHOICES` is exported from a view and imported by `products/SecretDialog.tsx:24`
  (a view-to-view dependency).

**Findings (OutletCredentials)**

- **OUT-1** A hand-built `<table>` (`:335-425`). The empty case is a bare `<p>` (`:330-333`).
- **OUT-2** Create and rotate share one form. Reusing an id silently rotates, which only help text
  mentions (`:440`).
- **OUT-3** Kind comes after id and outlet although it determines the form (`:437-478`). Changing
  kind clears entered values (`:462-465`).
- **OUT-4 [bug]** The pin input is `inputMode="numeric"` for all kinds, including the alphanumeric
  Google package name (`:509`).
- **OUT-5** No required markers. Errors arrive one at a time on one line (`:515-519`).
- **OUT-6 [a11y]** `lastError` is visible only through the `title` of the "Error" badge (`:157-162`).
  Timestamps are in `title` too (`:174`).
- **OUT-7** The copy lists the three stores (`:310-313`) but the kinds include Sentry (`:132`). The
  pin-field mapping duplicates the server's (`:205-211`). Delete has no typed confirmation, and its
  invalidate runs in `finally` (`:271-272`).

**Findings (EdgeMintRecipes)**

- **EMR-1 [dead]** The card returns `null` when there are no recipes (`:316-317`). The feature is
  undiscoverable.
- **EMR-2 [a11y]** Pending and Changed are both `warning` badges (`:101-104`). Static banners use
  `role="alert"` and re-announce on every load (`:333,346,467`).
- **EMR-3** An approve error closes the dialog, and a long 409 explanation becomes the toast title
  (`:258-264`). Approve can be submitted twice (`:507-513`). Cancel is not a `DialogClose`
  (`:500-506`).
- **EMR-4** Identity trust is rendered up to three times (`:358-367,405-417,475-482`). Positional
  copy: "Set X **above**…" (`:435-437`).
- **EMR-5** Four explanatory paragraphs before any action. The card is not linked from Config or
  Identity, where its preconditions live.

### 2.7 Activity (`views/Activity.tsx`)

**Data.** `GET …/activity` (keyset `beforeAt`/`beforeId`; **no filters**, `W/admin/handlers/activity.ts:10`).

**Layout.**

- Header with Refresh.
- DataTable: When, Actor, Action, Target, Summary.
- "Load more".

**Findings**

- **ACT-1** No filtering (actor, action, target, date) and no sorting (`:32-97,141-154`). API-limited
  for server-side filters.
- **ACT-2 [dead]** Targets are plain text, not links to the license, profile or other object
  (`:76-90`).
- **ACT-3** Per product only: no platform-wide feed, no export.
- **ACT-4 [a11y]** `<time tabIndex=0>` makes a non-interactive element focusable (`:41`). A redundant
  nested `TooltipProvider` (`:102`). `text-[11px]` (`:70`).
- **ACT-5** Refresh shows no spinner (`:117-125`). Reset can race on a slug change
  (`DataTable.tsx:301-307`). The error line and "Load more" share one `aria-live` region
  (`:156-179`).
- **ACT-6** Summary has no clamp. 5 columns overflow on mobile.

### 2.8 Settings (`views/Settings.tsx`)

**Data.** `GET`/`PATCH …`, `POST …/keys/prepare`, `DELETE …`.

**Layout.**

- General card: Name, Default max offline days, Default device limit, compat-moved note.
- Signing key card.
- Danger zone.

**Findings**

- **SET-1 [dead]** The signing-key flow dead-ends:
  - The card says activation follows a trust window (`:272-274`), but there is no key list and no
    Activate action.
  - The prepared-key panel is local state and vanishes on navigation (`:236-240,284-303`).
  - No copy buttons (`:298`).
- **SET-2 [bug]** The danger zone has no typed confirmation (UI-10). Its copy differs from
  Products' (`:381` vs `Products.tsx:248`). After delete, `me` is stale (SH-1), and the redirect
  writes `location.hash` (`:349-352`).
- **SET-3** The compat note is text, "Update → Update settings", with no link (`:208-212`).
- **SET-4** A server field error becomes "Invalid value." (`:147-150`). Success is toast-only.
- **SET-5** The skeleton draws 2 cards for a 3-card page (`:393`). UI-1 (`:215`). Confirms close on
  outside-click (`:313,379`).
- **SET-6** Fields duplicate EditProductDialog with different validation (PRD-5).

### 2.9 Identity (`views/Identity.tsx`)

**Data.** `GET`/`PATCH …/identity/portal`, product, resync.

**Layout.**

- PortalCard: 5 switches, an auto-link tri-state Select, Save.
- OidcCard: a read-only explainer and "Re-sync from linked repo".

**Findings**

- **IDN-1** Resync has no confirmation here, while Products confirms it (`:487-497`). Copy drift:
  "Re-sync" / "Resync", and "Re-sync complete" (`:401`) vs "Resync triggered"
  (`Products.tsx:88`).
- **IDN-2** The OIDC card shows no current provider, issuer or client. That data already arrives
  via `edgeMintRecipes().identity` and is shown there (`EdgeMintRecipes.tsx:444-463`).
- **IDN-3** Toggles ignore dependencies:
  - Module toggles stay editable while the portal is off (`:276-306`).
  - "Release downloads" ignores the Release service (`:162-167`).
- **IDN-4** Branding exists in the model but cannot be edited (`:192`). The defaults fallback can
  masquerade as real values (`:79-88,177`).
- **IDN-5** The page title "Sign-in & portal" does not match the section "Identity". The `w-56`
  select is cramped (`:347`). UI-1 (`:362`), UI-2 (`:490-493`).

### 2.10 Enrollment & fingerprints (`views/FingerprintPolicy.tsx`)

**Data.** `GET …/services`, `GET`/`PATCH …/license/policy`, `POST …/license/policy/revert`.

**Layout.**

- Registration card (read-only).
- Policy card: source badge, Enforce switch, Default mode, Save, Revert.
- Probes DataTable.

**Findings**

- **FPP-1** The "Enforce fingerprints" switch and the "Off" mode overlap. Mode stays editable while
  enforcement is off (`:162-167,283-323`).
- **FPP-2** The registration card repeats ServicesCard (`:102-153`) and points at
  "Platform → Services" without a link (`:113-114`).
- **FPP-3** Revert also reverts auto-issue, which only the confirm body says (`:358-360`).
- **FPP-4** Probes are "applied by a resync" but no resync is offered here. Columns are not sortable
  (`:393-436`).
- **FPP-5** A third SourceBadge copy (`:269-278`). UI-1 and UI-2 apply (`:332,338-343`). Raw slugs
  appear in badges (`:131,140`).

---

## 3. License and Config views

### 3.1 Licenses list (`views/Licenses.tsx`)

**Data.**

- Reads: `GET …/license/licenses` (unpaged), plus tiers, profiles and releases for the create
  dialog.
- Writes: `POST …/license/licenses` → `{key (once), licenseId}`.

**Layout.**

- Header with "Create license".
- DataTable: Name/id, Email, Status, Keys, Devices, Tier, Channels, Identity.
- The create dialog (`max-w-3xl`, tabs Holder / Policy / Profiles), ending in `OneTimeKeyPanel`.

**Findings**

- **LIC-1 [bug]** No Expires column and no expired state. Status is `active|disabled` only
  (`shared.tsx:52-62`), so an expired license shows green "active".
- **LIC-2 [bug]** The one-time key can be lost: X, Esc and overlay-click close the minted panel with
  no "copied?" guard (`:323,350`). The same applies in MintKeyDialog (`KeysSection.tsx:204,230`).
- **LIC-3 [dead]** "Profiles apply in the order selected here" (`:515`), but the list is an
  unordered checkbox list with no reordering (`:523-551`).
- **LIC-4** The policy summary claims "Device limit … Product default" (`:682-689`), but no
  per-license device limit exists. Only a tier sets one.
- **LIC-5 [bug]** `dateInputToEpoch` parses as UTC midnight (`shared.tsx:38`) while `formatDate`
  renders local (`:29`). West of UTC the expiry shows a day early.
- **LIC-6** Lookup failures for tiers, profiles and releases are ignored (`:233-237`): "No profiles
  are defined" even on error.
- **LIC-7** Unpaged and filtered client-side (`:57-59,194-205`). No status or tier facets, no bulk
  actions, no export. The Channels column has no accessor (`:124-128`).
- **LIC-8** The Identity column shows raw `manual`/`oidc` (`:135-139`). A long mono id under every
  name (`:71-76`).
- **LIC-9** Duplicated helpers: `compareDottedVersion` (`:626-640` and `PolicySection.tsx:179-193`)
  returns 0 for any non-numeric version, so `1.2.0-beta` vs `1.0` passes (`:628-633`).
  `clearFieldError` ×3. The metadata and create validators overlap.
- **LIC-10** Submit is disabled until name and email are non-empty (`:571`), so the "Enter the
  holder name" error can never show. The success toast duplicates the panel (`:310`). One 719-line
  file.

### 3.2 License detail (`views/LicenseDetail.tsx`, `licenses/*`)

**Data.**

- Reads: `GET …/license/licenses/:id` (keys, devices and redacted overrides embedded), tiers, the
  catalog, each profile in the stack, services, releases.
- Writes:
  - enable/disable;
  - `PATCH` (from both the Edit dialog and the Policy tab);
  - `PUT …/overrides {updates}`;
  - keys mint/revoke;
  - device deauthorize and fingerprint reset (license-scoped);
  - `POST …/bundles`.

**Layout.**

- BackLink.
- Header: name, status, identity, email, id; on the right, an Enabled Switch, Edit, Offline bundle.
- Metadata `dl`.
- Tabs:
  - Policy (channels, versions, Save policy).
  - Keys (Mint key, table, Revoke).
  - Devices (7-column table, Reset binding, Deauthorize).
  - Overrides (`ManagedPayloadEditor`).
- Dialogs: EditMetadataDialog (Holder / Policy) and OfflineBundleDialog.

**Findings**

- **LDT-1** Policy is split: tier, expiry and max offline sit in Edit → "Policy"
  (`EditMetadataDialog.tsx:209-269`), while channels and versions sit in the page's "Policy" tab.
  Same name, different save paths.
- **LDT-2 [bug]** Max offline days cannot be cleared: blank sends nothing
  (`EditMetadataDialog.tsx:127-130`), and the worker ignores non-numbers
  (`W/services/license/admin/licenses.ts:310-313`).
- **LDT-3 [dead]** Profiles cannot be changed after creation (`PatchLicenseBody.profiles` exists,
  `api.ts:1477`). They are displayed as `" -> "` text (`:250-252`).
- **LDT-4 [bug]** Tabs unmount on switch (no `forceMount`), losing Policy and Overrides drafts. The
  tab is not in the URL (`defaultValue="policy"`, `:273`). No navigation guard.
- **LDT-5 [bug]** Overrides shows an endless skeleton when the catalog fails or Config is off
  (`:306-318`).
- **LDT-6 [bug]** A failed profile-stack fetch (`:95-108`) shows catalog defaults as if inherited.
- **LDT-7** Status is shown twice (badge `:209` and label `:226`). A Switch fronts a confirmed,
  destructive action and lags the server.
- **LDT-8** The header's right cluster does not wrap below ~400 px (`:223-243`). "Offline bundle", a
  rare action, gets top-level weight.
- **LDT-9** The metadata card repeats the tab counts (`:260-267`) and shows the raw tier id (`:248`).
  `groups`, `oidcSubject`, `modifiedBy` and `modifiedAt` are not shown (no "last changed by").
- **LDT-10 [bug]** Deauthorize is offered on already-deauthorized devices
  (`DevicesSection.tsx:140-142`).
- **LDT-11** The keys table shows a 16-character hash fragment only (`KeysSection.tsx:74`). "By" is
  a raw `sub`. Revoked keys never collapse. Revoke is outline, not destructive (`:109`).
- **LDT-12** The downgrade warning is muted `text-xs` (`EditMetadataDialog.tsx:234-238`) and counts
  authorized devices, while the header uses the server's `deviceCount` (`:326-328`).
- **LDT-13 [bug]** The bundle download silently does nothing without `URL.createObjectURL`
  (`OfflineBundleDialog.tsx:343-347`). No bundle history exists.
- **LDT-14** `if (!license) return <BackLink/>` (`:195`) renders a bare link.
- **LDT-15 [a11y]** hwid components, drift and probe presence are tooltip-only
  (`DevicesSection.tsx:205-218,246-254`). Seven columns, with actions off-screen on mobile.
- **LDT-16** Timestamps are absolute here, relative on Devices, and mixed on Profiles.
- **LDT-17** No link to this license's Activity. The channel picker uses a native checkbox with
  `accent-[hsl(var(--primary))]` (`shared.tsx:153-161`).

### 3.3 Tiers (`views/Tiers.tsx`, `tiers/dialogs.tsx`)

**Data.** `GET`/`POST`/`PATCH`/`DELETE …/license/tiers` (409 with `references` while referenced),
profiles, releases.

**Layout.**

- DataTable: Id, Label, Profile, Expiry (days), Device limit, Channels, Version window, and icon
  actions.
- Create and Edit dialogs (Basics / Policy / Channels).

**Findings**

- **TIR-1 [bug]** Expiry and device limit cannot be cleared: `toNumber("")` → `undefined`
  (`dialogs.tsx:425-426`), and the worker keeps the old value (`W/services/license/admin/tiers.ts:169-176`).
  The help text "Blank = product default" (`:70,83`) is false after the first save.
- **TIR-2 [dead]** No "used by" count. Delete is always offered and fails late with a 409
  (`Tiers.tsx:191-198,293`). Usage is computable client-side from the unpaged license list.
- **TIR-3** No client checks for policy fields or min > max. A 422 collapses to
  "Check: policyDeviceLimit." (`:337`).
- **TIR-4** Edit always sends the full body, with Save always enabled (`:420-431,542`). "No profile"
  is sent as `""` (`:424`).
- **TIR-5** Rows are not clickable; only small icon buttons (`:183-198`).
- **TIR-6** "Expiry (days)" (a duration) is never related to license "Expires" (a date).
  `default` vs `any` wording (`:138,150,168,317`).
- **TIR-7** One profile per tier, many per license, is unexplained. The Profile select is a bare
  Label + Select with no help (`dialogs.tsx:303-324,490-505`).
- **TIR-8** Three tabs for eight fields. Create and Edit duplicate ~150 lines (`:159-369` vs
  `:373-550`). `describeError` is copied.
- **TIR-9** Eight columns with no collapse. The Profile badge does not link to the profile
  (`:124-129`).

### 3.4 Profiles (`views/Profiles.tsx`, `profiles/*`)

**Data.** `GET`/`POST …/config/profiles`, `GET`/`PUT`/`DELETE …/config/profiles/:id`, catalog.

**Layout.**

- List: DataTable with Id, Name (link), Description, Last modified, Pencil, Trash.
- Detail: BackLink, name, id badge, meta `dl`, `ManagedPayloadEditor`.

**Findings**

- **PRF-1 [dead]** Name and description cannot be edited after create. No PATCH route exists.
- **PRF-2 [dead]** The detail page has no delete and no "used by" list (tiers and licenses). Delete
  from the list fails late with a 409 (`:66-82,241`).
- **PRF-3** The id is shown twice on detail (`ProfileDetail.tsx:76-78,87-89`).
- **PRF-4** Mixed navigation: the name is a link and the pencil also navigates, but the row is not
  clickable. A pencil suggests inline edit, not a page.
- **PRF-5 [bug]** Every 409 on create reads "That id is already in use." (`:257-260`), yet 409 also
  means "no active catalog" (`:250-254`).
- **PRF-6 [bug]** Unsaved payload edits are lost on back (`ProfileDetail.tsx:69,107-117`).
- **PRF-7** Description is clamped with no tooltip (`:112`). Config-off shows "Could not load the
  catalog" (`PayloadEditor.tsx:86-98`).
- **PRF-8** References from licenses and tiers do not link here. Profiles sits under Config while
  its consumers sit under License (cross-links are needed, not a move).

### 3.5 Catalog (`views/Catalog.tsx`, `catalog/*`)

**Data.** `GET`/`PUT …/config/catalog` (version = max + 1; no expected-version check, no history
route).

**Layout.**

- Header: h2, `schema vN`, count, "Publish new version".
- Per category: a Card per entry with badges and a details `dl`.
- `PublishDialog`: one JSON Textarea.

**Findings**

- **CAT-1 [bug]** With no catalog, "Publish new version" renders (`:61`) but `PublishDialog` is
  mounted only in the data branch (`:100-105`), so clicking does nothing. The empty state tells the
  user to publish, and the dialog requires an existing catalog, so a first publish is impossible.
- **CAT-2** Raw JSON is the only editing path. No per-entry editor, no diff against the active
  version, no warning on removed or renamed keys. This is the riskiest write in the section.
- **CAT-3** No ownership badge. A resync re-applies `.pkey/schema` over a console publish
  (`ResyncButton.tsx:10,72`), unannounced.
- **CAT-4** The textarea is not monospace, with no formatting or line numbers, and errors are
  "first problem only" without a position (`PublishDialog.tsx:112-121`).
- **CAT-5** The client validator (`helpers.ts:111-170`) is shallow, while SchemaForm uses the real
  `@polaris-key/catalog`.
- **CAT-6** Errors are shown inline **and** as a toast (`PublishDialog.tsx:76-78`). Closing drops
  the draft (`:53-58`). The bumped version is buried in the JSON.
- **CAT-7** One card per entry: low density, no search, kind filter or table.
- **CAT-8** No version history and no "used by" (profiles and licenses overriding a key).
  `ConfigEntry` in `api.ts:34` is a hand-copied subset missing `dependsOn`/`appliesTo`.
- **CAT-9** `KIND_VARIANT`, `STATE_VARIANT` and `formatValue` are duplicated (`helpers.ts:9-64`,
  `SchemaForm.tsx:155-195`).
- **CAT-10 [a11y]** The lock icon has `aria-label` without `role="img"` (`:176`).

### 3.6 `SchemaForm.tsx` and `ManagedPayloadEditor.tsx`

- **SCF-1 [a11y][bug]** The enum `Select` is passed into `Field` (`SchemaForm.tsx:316-336`). The
  label points at nothing, and help and error text are never announced. UpdateSettings works around
  the same trap (`UpdateSettings.tsx:644-649`).
- **SCF-2 [a11y]** Every control sets `aria-label={entry.label}` (`:305,326,342,366,378,473`). This
  overrides the visible label and drops the unit.
- **SCF-3 [bug]** The Switch emits `valid: true` without validating (`:308-310`).
- **SCF-4** The JSON control is a plain textarea (`:472-502`). Secret inputs have no reveal toggle
  (`:376-386`).
- **SCF-5 [a11y]** `ManagementStateControl` is a hand-rolled radiogroup (`:541-617`): no Home/End
  keys, and a disabled selected item keeps `tabIndex 0`. Help appears twice (`:868-872`).
- **SCF-6 [a11y]** N identical "Set value" buttons (`:774-782`). The dirty dot's `aria-label` sits on
  a role-less span (`:701-705`). The kind badge appears twice on unset rows (`:771-773`).
- **SCF-7** One 895-line file with four responsibilities. `formatStamp` is duplicated.
- **MPE-1 [bug]** A background refetch wipes the draft: the re-seed effect fires on any new `payload`
  object (`ManagedPayloadEditor.tsx:262-265`).
- **MPE-2** `blocked` counts every row, untouched ones included (`:289-302`). One stale invalid value
  blocks every save, possibly hidden inside a collapsed group that shows no error count
  (`:433-467`). No jump-to-error.
- **MPE-3** No review step and no effective-value preview.
- **MPE-4** The filter ignores values (`:331-336`). A real "Advanced" category collides with the
  synthetic one (`:347-349`). `bodyId` can collide (`:432`).
- **MPE-5** The sticky bar has no safe-area padding (`:541`). It imports from a view module
  (`views/catalog/helpers`, `:24`).

---

## 4. Release views

### 4.1 Releases (`views/Releases.tsx`)

**Data.** product, `…/release/health`, `…/release/releases` (unpaged), `…/release/channels`.
Writes go through PolicyActionDialog and ResyncButton.

**Layout.** Seven stacked blocks:

1. Header with Resync.
2. ReleaseStoreCard (DataTable, 9 columns, expand → ReleaseBuilds, "Channel map").
3. ChannelsPanel.
4. ManifestNote.
5. ReleaseHealthCard.
6. SyncStateCard.
7. DistributionCard.

**Findings**

- **REL-1** Overloaded: 7 blocks, 4 fetches and 4 concerns (store, policy, repo sync, product
  metadata) on one scroll (`:110-147`).
- **REL-2** ManifestNote says the values "are not editable directly from the admin panel"
  (`:445-447`), directly under a panel that edits channel policy.
- **REL-3** The subtitle "Release distribution & minters" is stale (`:410`). DistributionCard shows
  license defaults (`:706-717`) under the title "Distribution & compatibility".
- **REL-4** Channel data is shown three times: row badges (`:282-299`), the "Channel map"
  (`:371-390`) and ChannelsPanel.
- **REL-5** Yank is a ghost button and Unyank is outline (`:304-322`): the destructive action is the
  weaker one, inline on every row.
- **REL-6** A local `formatStamp` (`:751-758`) and a local `StatusBadge` (`:760-774`).
- **REL-7** The skeleton gates on the product only (`:78`), so the store and channels pop in
  separately.
- **REL-8** `SyncList` truncates to 12 with no "+N" (`:663`). The floor hint points at "the Channels
  panel above" in text (`:569-574`).
- **REL-9** `sourceUrl` is never rendered (no link to the GitHub release). Health copy is
  GitHub-only (`:505-511`).
- **REL-10** 9 columns plus an 8-column expansion. No pagination.

### 4.2 ChannelsPanel (`releases/ChannelsPanel.tsx`)

- **CHN-1 [dead]** Only `kind==="app"` is rendered (`:62`). Pack channels are returned and dropped,
  although `PUT …/release/channels/:c {deliverable}` supports them.
- **CHN-2** 10 columns, with a nested per-platform badge list per cell.
- **CHN-3** Every write hides behind an icon kebab (`:331-339`). Critical, minimum supported and
  floor have display columns but no inline affordance.
- **CHN-4** The pointer/serves/newest mental model is never explained (`:93-103`). The "nothing"
  badge has no reason (`:306`).
- **CHN-5 [a11y]** Floor `loweredBy`/`loweredAt` are not shown. `raisedAt` appears only in `title`
  (`:145,168`).
- **CHN-6** No link to Compatibility or the Matrix from a channel.

### 4.3 PolicyActionDialog (`releases/PolicyActionDialog.tsx`)

**Scope.** One ConfirmDialog for 10 actions: promote, pin, unpin, minSupported, critical, revert,
lowerFloor, clearFloor, yank, unyank.

- **PAD-1 [bug]** Incomplete invalidation (CC-3).
- **PAD-2** The release picker shows versions only: no date or channel, and no search (`:192-196`).
- **PAD-3** Promote and Pin take the same input and differ only in prose (`:248-268`).
- **PAD-4** Clearing minimum supported is hinted only by a placeholder (`:164-166`). There is no
  semver validation, and "lower floor" accepts any text.
- **PAD-5** "Mark critical" uses the destructive variant (`:314`).
- **PAD-6 [a11y]** The yank Textarea is `aria-invalid` from first render (`:144`).

### 4.4 ReleaseBuilds and ResyncButton

- **RBD-1** A hand-rolled table nested inside a DataTable expansion (`ReleaseBuilds.tsx:78-124`).
- **RBD-2 [bug]** `Sha256` swallows clipboard failure (`:322-324`). `ArtifactDto.access` is never
  shown. Location badges are unexplained (`:272`). Pinned packs are not links (`:198-222`).
- **RSY-1 [bug]** Incomplete invalidation (CC-2).
- **RSY-2 [a11y]** The disabled reason is a `title` (UI-2).
- **RSY-3** The `ResyncResult` (`updated[]`, `refused`, `packSets`) is discarded. The toast is
  generic (`:34-37`).

### 4.5 Deliverables and ContentKeys

- **DLV-1** The app row is not clickable, and there is no route to the app's releases (`:55-57`).
- **DLV-2** 11 columns with many "—" cells. Wide on mobile.
- **DLV-3 [dead]** The GateCell says "the gate is set in Distribution" (`:255`), but no screen sets
  per-pack gates (UPS-5).
- **DLV-4** "Not pinned by any app release" (`:273`) gives no next step. The "declaration
  unreadable" badge sits inside the link (`:66-68`).
- **DLV-5** ContentKeys is an unrelated card on the same page.
- **CKY-1** The fingerprint is truncated to 16 characters with `title` only and no copy
  (`ContentKeys.tsx:104-106`).
- **CKY-2** The signing window is two absolute timestamps with no "expires in" (`:63-65`).
- **CKY-3** `origin`, `types` vs `effectiveTypes` and the revocation `kid`/`issuedAt` are not shown.
  There is no status filter, and "Releases" is not a link.

### 4.6 DeliverableDetail (pack page)

- **PKD-1 [dead]** No actions. The copy explains yanking pack releases (`:276-278`), but there is no
  control here, and Releases lists app releases only.
- **PKD-2 [bug]** An unknown id or a failed list renders nothing (`:95-100`).
- **PKD-3** No "current per channel" summary (that exists only on Compatibility).
- **PKD-4** `signer` (release key vs delegated content key, the provenance fact) is never rendered.
- **PKD-5** Version and Seq are redundant (`:220,237-240`).
- **PKD-6** Three nesting levels (release → variants → files) inside a DataTable. Opaque
  `variantKey` strings, with the parsed axes unused.
- **PKD-7** Files are capped at 2000 in a flat list, with no search or tree (`:524-527`). They are
  fetched without cache, and the error has no retry (`:513-519`).
- **PKD-8** "Pinned by" badges are not links. Yank is shown by color plus a suffix (`:314-322`).
  Only a back button, no breadcrumb. Five components in one file.

### 4.7 Compatibility and the simulator (`releases/Compatibility.tsx`, 833)

**How it works.**

- `GET …/release/compat?limit=10&offset=n`.
  - Rows: app releases.
  - Columns: pack releases grouped by pack.
  - Cells: `pinned | held | compatible | incompatible | revoked`, plus `current` (ring), `yanked`
    (strike) and `reason`.
  - An "Outlets" column joins `GET …/distribution/matrix?limit=50` for liveness and readiness.
- The simulator calls `GET …/update/simulate` (`appRelease`, `platform`, `outlet`, `variant`,
  `device`, `packSetId`). It runs client-core's update check on the server and returns selector,
  feed, decision, set, per-pack gates, floors and revocations.

**Findings**

- **CMP-1** No page header (`:104-122`).
- **CMP-2 [a11y]** Cells are tinted spans (`:64-70`). `current` and `yanked` are visual only in the
  pack column headers (`:326`). The per-cell reason is only in `title` (`:487`), cells are not
  focusable, and the `unsatisfied` details and overlay blockers are `title`-only
  (`:425-427,460-462`).
- **CMP-3** The error state drops the message and the retry (`:166-169`). The docs link lacks
  `target="_blank"` (`:155-158`).
- **CMP-4 [bug]** The overlay cache key `distribution-matrix:${slug}:compat` is never invalidated by
  Matrix actions (CC-4).
- **CMP-5** One `offset` pages app releases and every pack together (`:84,188-193`). The paging copy
  is hard to parse, and there is no jump-to-version.
- **CMP-6** The overlay knows only 50 releases ("unknown (outside Distribution's newest 50)",
  `:443-447`).
- **CMP-7** No sticky first column or header. The table width is packs × releases.
- **CMP-8** The simulator lists only the current page's app releases (`:520,587-592`). It falls back
  to a hard-coded `PLATFORMS` list (`:72-81`) and uses a native `<select>` (`:508-509`).
- **CMP-9** A stale result stays beside changed inputs (`:527`). Inputs are jargon with no help
  ("Reported packSetId", variant syntax only in a placeholder, `:630`).
- **CMP-10** Output dropped: `set[]` (the actual pack set), `activePackSetId`, selector
  axes/build/methods, `feed.target`, per-pack expected/active, `gate.bucket`. The decision is
  flattened to one string (`:674-682`). `channel` is not exposed.
- **CMP-11** Cells do not link to the pack release or the app release. Five renderers in one file.

---

## 5. Distribution and Update views

### 5.1 Distribution overview (`views/Distribution.tsx`)

- **DOV-1 [bug]** A hard-coded halt caveat (`:262-267`, "does not stop devices yet") contradicts the
  Matrix's server-provided `effect.note` (`Matrix.tsx:102`). The overview ignores
  `RolloutsResponse.effect` (`api.ts:577`).
- **DOV-2 [bug]** `HOOKS[2].today` says "No outlets are declared yet" (`:57`) even when outlets
  exist.
- **DOV-3** The rollouts table is read-only and unlinked. It shows raw `releaseId` (`:305`) with no
  `updatedAt`/`updatedBy`.
- **DOV-4** The rollouts error has no retry (`:269-272`). HooksCard shows developer internals
  ("null" as a status, `:211`). Chain steps do not link to Services (`:149-151`). Raw tables lack
  `scope`.

### 5.2 Distribution matrix (`distribution/Matrix.tsx`)

**How it works.**

- `GET …/distribution/matrix` returns the newest ≤20 app releases (rows) × outlets (columns).
- Each cell carries: `availability` (best record state), `records[]` per build, `submission`,
  `rollouts[]` with server-allowed `controls`, `readiness` (holds, warning, blockers), and
  `effect`.
- Verbs go to `POST …/distribution/rollouts/:outlet/:channel/:verb`.

**Findings**

- **MTX-1** Extreme density: every rollout in every cell renders four buttons, most of them disabled
  (`:452-465`).
- **MTX-2 [dead]** `readiness` is fetched but not shown here (only on Compatibility). Overrides and
  refresh exist in the API with no UI.
- **MTX-3 [a11y]** Per-build availability and sources are `title`-only (`:415-420`). Submission
  times and `since` are never shown.
- **MTX-4** Three different rollout-state color maps (`:61-69`, `Distribution.tsx:228-236`,
  `UpdateHealth.tsx:166-170`). `in-review` and `processing` are both warning; `approved` is primary
  (`:48-59`).
- **MTX-5** No start-rollout or set-percentage control, although
  `POST …/rollouts/:outlet/:channel {releaseId,bp}` exists.
- **MTX-6** App only, with no deliverable picker (the API accepts `deliverable`). No limit or paging
  control.
- **MTX-7** No sticky first column; `min-w` cells × outlets (`:362,411`). The files list expands
  inside the row header (`:384-396`).
- **MTX-8** O(R·O·C) `find` per cell (`:289-293`).
- **MTX-9** One empty state covers both "no releases" and "no outlets" (`:194-207`).
- **MTX-10** Pause is styled destructive like halt (`:333`). The effect note is duplicated in the
  dialog (`:340-342`).

### 5.3 Update health (`distribution/UpdateHealth.tsx`)

- **UHL-1** No visual funnel and no step conversion: ten numeric columns (`:139-195`).
- **UHL-2** No window selector (the API takes `windowHours`).
- **UHL-3** `autoHalt.lastReading`, `defaults`, `verdict.trips` and `truncated` are unused (`:37`).
- **UHL-4 [bug]** The auto-halt draft is seeded once and never re-synced (`:224-230`). Save is
  always enabled. An empty input becomes 0 (`:237`), with no 0–1 range checks.
- **UHL-5** Rates are entered as 0–1 fractions but displayed as percentages (`:53-54,297-301`).
- **UHL-6** Raw `releaseId` everywhere, with no links (`:160,352,422,463`).
- **UHL-7** Only open Sentry candidates show, with no history (`:377`). The unconfigured hint does
  not link to credentials (`:408`). `ObjectList` can print an empty reason (`:354`).
- **UHL-8 [a11y]** The Switch is double-labelled (`:276-285`). Headers lack `scope`, and event
  counts are `title`-only.

### 5.4 Update settings (`views/UpdateSettings.tsx`)

**Data.**

- Update service: `GET`/`PATCH …/update/settings`, `POST …/update/settings/revert`.
- Distribution service: `GET`/`PUT …/distribution/access`, `POST …/distribution/access/revert`.

**Findings**

- **UPS-1 [bug]** The save is not atomic: delivery access saves first, then the settings PATCH
  (`:232-251`). A failure of the second request reports "save failed" after the first has applied
  and claimed the row.
- **UPS-2 [bug]** The re-seed effect depends on `delivery` (`:214-217`), so a late load or a refetch
  wipes every edit.
- **UPS-3 [bug]** Artifact access shows "Public" while loading or on error (`:422`), labelled "not
  configured" (`:673-675`).
- **UPS-4** Delivery revert is gated on `settings.configured` (`:410`), which belongs to a different
  service.
- **UPS-5 [dead]** Per-pack delivery access (`deliverables[]`, `{deliverable}`) is unused
  (`api.ts:544-556,1994-2002`).
- **UPS-6** Two services and four blocks share one Save inside the Update section.
- **UPS-7** Revert buttons are always rendered, mostly disabled, with reasons in `title`
  (`:628-639`). Toast grammar (`:329`). No semver validation. The legend is a separate `dl`
  (`:431-440`).

---

## 6. Customer portal (`portal/*`)

**Auth model.**

- Sign-in is by OIDC via the platform IdP (`/login`, PKCE) or by email magic link
  (`POST /api/magic/start`; 10-minute token, 8/min/IP).
- A license key is **not** a sign-in method. It is a post-login claim.
- Sessions are a signed cookie (14 days, SameSite=Lax). CSRF uses `X-PKey-Portal-CSRF`.
- Licenses auto-link by verified email or OIDC subject, per product's `auto_link_enabled`, or by an
  explicit key claim (`W/services/identity/portal/repo.ts:325-380`).

**Layout.**

- Sticky top bar: logo, Home / Licenses / Downloads, Profile, Sign out.
- `max-w-7xl` content.

**Findings**

- **POR-1 [bug]** "This tab will update after you use it" (`:281-282`) is false: there is no polling
  and no focus or visibility listener. "Refresh session" shows even before sending.
- **POR-2** Email has no `required` attribute or validation. There is no "sent to X / resend / use
  another email" state. "Continue with OIDC" is protocol jargon for customers (`:247,252-270`).
- **POR-3 [bug]** A non-401 `/api/me` failure shows SignIn (`:100-106`). A capabilities failure
  reads "Portal sign-in is unavailable" (`:117-122,272-278`).
- **POR-4 [bug]** The dashboard ignores the licenses error (`:392`): zeros and "No licenses linked"
  on failure. "Recent" is `slice(0,5)` of server order (`:418`).
- **POR-5** The empty-state copy tells a signed-in user to "Sign in with OIDC" (`:538`) and suggests
  a key claim even when claim is off. The Licenses empty and error states have no description or
  Retry (`:566,572`).
- **POR-6 [dead]** Claim exists only on the dashboard. The returned license is discarded (no
  navigation). The input is not monospace. A bare 404 surfaces as "portal api 404"
  (`portal/api.ts:110,147-148`).
- **POR-7** "Needs attention" hides why (expired, disabled, offline grace) and wins over "Disabled"
  (`:661`).
- **POR-8 [a11y]** The whole card is an `<a>`, giving a long accessible name (`:622-650`). The
  product name repeats. The tier id is raw. Entitlements are cut at 4 with no "+N".
- **POR-9** License detail: the error has no back link or retry (`:709-717`). The back link has no
  focus ring (`:721-726`). Max offline days, channels and version window are hidden. Big stat cards
  repeat the table counts.
- **POR-10** Keys are unidentifiable ("—" labels, no prefix), with no empty state (`:803-853`).
- **POR-11** Devices show a 32-character id with no platform, no seat usage and no empty state.
  Deauthorized devices persist. The disconnect confirm shows only the id (`:951`). The actions
  header has no sr-only text (`:898-899`).
- **POR-12 [a11y]** Downloads is a flat list across products: no grouping, no "latest", no platform
  detection, notes or checksums. Disabled reasons live in `title` on a disabled button
  (`:1052-1061`). The error has no Retry (`:1007`).
- **POR-13 [bug]** `formatDate(null)` returns "No expiry" and is reused for `publishedAt`
  (`format.ts:2`, `App.tsx:1024`).
- **POR-14** Profile is read-only. No account deletion, although `DELETE /api/me` exists. The name
  collides with console "Profiles".
- **POR-15 [a11y]** No mobile menu, so the bar crowds at 360 px. The profile link's only text is
  `hidden sm:inline` (no accessible name, `:334-337`). No skip link, and `document.title` is
  static.
- **POR-16** No theme toggle. `productBranding` is unused. One 1105-line file with its own fetch
  hooks and no race guards.
- **POR-17** Tests cover sign-in gating, boot and Downloads gating only
  (`test/portal.test.tsx`, `test/portalServices.test.tsx`).

---

## 7. Docs drift found during the audit

- **DOC-1** `D/admin/console-tour.md:60-93` says Release has one tab and Distribution has one
  read-only tab. The code has Deliverables, Compatibility, Matrix and Update health.
- **DOC-2** The resync button has three names: "Resync from repo", "Resync from GitHub"
  (`D/admin/products.md:71`) and "Re-sync from linked repo" (`console-tour.md:115`).
- **DOC-3** "disable product" (`console-tour.md:38`) vs **Delete** (a tombstone, `products.md`).
- **DOC-4** Two tabs labelled "Overview" (Platform and Distribution).
- **DOC-5** `D/services/release/index.md:34-37` says Update requires Release; the chain now runs
  through Distribution.
- **DOC-6** "machine" appears in admin pages (`console-tour.md:43`, `bundles.md`), against the
  glossary.
