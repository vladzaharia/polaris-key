# Polaris Key admin UI: audit and redesign specification

> **Superseded in part (2026-10-05).** [EXPERIENCE.md](EXPERIENCE.md) is now the single
> experience spec for the console and the portal: journeys, information architecture, the shared
> component inventory, page anatomy, copy rules and the shared sign-in. Where the two disagree,
> EXPERIENCE.md wins. The sections it replaces are listed in
> [EXPERIENCE.md §14](EXPERIENCE.md#14-superseded-sections-in-adminmd-and-portalmd): §2.2, §2.3
> (page list), T1, T4, T6 (product creation), T8, §4, §5.2 (patterns), §5.8, §6.1, §6.2, §6.4
> (Matrix as its own page), §6.5.2 (tab order), §6.7 (scope), §6.8 (search), §6.9 (Services) and
> §6.10. Settings follow the S-18 hub and licensing follows S-19 (both owner-approved); EXPERIENCE.md
> §0.8 reconciles its work packages with the `ST`, `LX` and `PX` packages.

> **Setup and storefronts are specified in [SETUP.md](SETUP.md) (2026-10-05).** It supersedes
> this document's T6 wizard rules where they differ (one wizard pattern with page and drawer
> hosts, resumable from server-side state, ending in a live verification), §2.3's Distribution rows
> (Storefronts, Listing, App Store, Commerce, Outlets & feeds and Outlet credentials become one
> Storefronts catalogue with one page per storefront) and the empty states of every page it lists
> in its §4.7.

> **Licence holders and the New License wizard are specified in [notes/S-24](../research/2026-09-29-godot-omniplatform/notes/S-24-licence-holders.md) (2026-10-06).** It
> supersedes §6.5.1's Create license dialog (now the five-step **New license** drawer, single or
> batch, assigned or floating), adds the **Holder** column and filters to the licences list, and
> replaces Edit holder with **Assign…**, **Send a new key…**, **Reassign…** and **Make floating…** on
> the record (§6.5.2). Packages LX-26 to LX-30; mockups [licenses/](licenses/).

> **Sign-in is specified in [SIGN-IN.md](SIGN-IN.md) (2026-10-05).** It supersedes this document's
> sign-in parts where they differ: §2.7's Sign in row, T8's Session expired row (the console now
> renders "Your session ended" in place on the shared card, not a dialog) and §6.10.1.

> **Vocabulary follows the concepts page (2026-10-07).** UI words come from
> [UI words and the identifiers they keep](../../packages/docs/src/content/docs/start/concepts.md#ui-words-and-the-identifiers-they-keep)
> (AGENTS.md rule 4, ST-37), which wins where this document uses an older word: outlet, and
> storefront for a place builds are delivered, become **Channel**; storefront feed becomes
> **Install source**; update channel and the Channels page become **Release track**; grant becomes
> **Add-on**; flag becomes **Entitlement**; policy and terms become **Limits** and **Duration**;
> default, enforced and hidden become **Editable**, **Read-only** and **Hidden**; auto-issue
> becomes **Access policy**; services become **Features**. The console copy rules there ("outlet",
> "storefront feed", "grant" and "capability" leave the UI) are checked by
> `packages/admin/test/copyLint.test.ts`. Identifiers keep their names. P0-41 folds this into the
> current-state rewrite of this document.

**Status:** draft for lead approval · **Scope:** `packages/admin` (operator console at `/manage`,
customer portal at `/`) · **Builds on:** `@polaris-key/brand` and
[BRAND.md](BRAND.md) (in progress on
`brand/system`) · **Baseline:** `574bd242`

This document has eight parts, plus a preamble (§0) on goals, principles and the brand contract:

1. **Inventory:** what both SPAs do today, and what is wrong with them.
2. **Information architecture:** navigation, URLs and redirects.
3. **Page templates.**
4. **Component system.**
5. **Interaction and content conventions.**
6. **Area redesigns, with wireframes.**
7. **Implementation plan:** ordered, reviewable chunks.
8. **Open questions for the lead.**

Two companion files hold the detail that would otherwise bury the argument:

- [admin/inventory.md](admin/inventory.md): the exhaustive per-view audit. Every finding has an ID
  (`LIC-2`, `MTX-5`…) that this document cites.
- [admin/components.md](admin/components.md): API sketches, states and accessibility contracts
  for every component.

Terminology follows the glossary (`packages/docs/src/content/docs/start/concepts.md`, AGENTS.md
rule 4): **license** (US spelling), **device**, **product**, **tier**, **profile** (payload
baseline only), **yank** for releases, **revoke** for keys and licenses, **channel** (a
distribution channel; `outlet` in code), **kind**, **customer portal**.

---

## 0. Goals, principles and the brand contract

### 0.1 What "done" looks like

1. **One console, one grammar.** Every page is one of eight templates. Page headers, actions,
   tables, forms, confirmations, empty, loading and error states each have exactly one
   implementation.
2. **Operational first.** Home and the product overview answer "what needs me?" before
   "what exists?". Today the dashboard shows two constant stat cards (DSH-1).
3. **Nothing is lost.**
   - No draft disappears on a refetch, tab switch or navigation (SH-6, MPE-1, UPS-2, LDT-4).
   - No one-time secret can be closed without being copied (LIC-2).
   - No fact lives only in a `title` attribute (§1.2 counts eight views that do this).
4. **Every capability has a home.** The admin API offers about 40 routes the console never calls
   (inventory §0.3). The redesign gives each one a page, or deliberately defers it.
5. **Brand-true.** Per-service accents follow the kit, dark-first with system follow. Gold means
   signed, and nothing else. The Star Cut identifies the delivery services. The section bit sits in
   the header, in service sections only; core pages show the K without a bit.
6. **Accessible by construction.**
   - WCAG 2.2 AA.
   - Keyboard-complete, including the two matrices.
   - Screen-reader announcements for loading and results.
   - Works at 360 px.

### 0.2 Design principles

| Principle                                    | In practice                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The server is the truth.**                 | No optimistic writes to security state. Every mutation confirms, then invalidates a declared set of queries (§5.4).                              |
| **Explain the why, at the point of action.** | Copy takes the docs' voice: declarative, names the consequence ("Every device loses access at its next check-in"), and is candid about limits.   |
| **Say it once.**                             | One status vocabulary, one source badge, one error mapper, one date formatter. They replace 5, 3, 26 and 5 copies today.                         |
| **Density with hierarchy.**                  | Comfortable by default with a compact table toggle. Primary information in the first column; detail in drawers rather than in ever-wider tables. |
| **Links, not dead ends.**                    | Every id is an `EntityLink`. Every "set this elsewhere" sentence is a button to that elsewhere.                                                  |
| **Manifest-aware.**                          | Anything a resync can overwrite carries a `SourceBadge`, and the page says what a resync will do.                                                |

### 0.3 Consuming `@polaris-key/brand` (the contract)

ADMIN.md defines **no** color, type, spacing, radius, elevation or motion values. It consumes these
from `@polaris-key/brand`.

**What the brand package (in progress on `brand/system`, `packages/brand/src/tokens/*`) already
fixes:**

- **Surfaces:** `surface.page | raised | overlay | sunken`.
- **Text:** `text.strong | default | muted | subtle | onAccent`.
- **Borders:** `border.subtle | strong`, plus `focus`.
- **Accent families** (`solid`, `fg`, `on`, `subtle`), per section:

  | Section      | Family                  |
  | ------------ | ----------------------- |
  | core         | violet (the kit violet) |
  | license      | chartreuse              |
  | config       | yellow                  |
  | release      | cyan                    |
  | distribution | green                   |
  | update       | tangerine               |
  | identity     | orchid                  |
  | sync         | teal                    |

  None is blue, indigo or rose, and none is confusable with gold.

- **Status:** `success | warning | danger | info`, each with `fg`, `on`, `border`, `subtle`. Info is
  violet; warning is a red-leaning orange that stays clear of gold.
- **Signed:** `signed.mark` (the kit gold, artwork only), `signed.solid` (the UI indicator),
  `signed.on`, `signed.border`.
- **Scales:** a 4 px space grid; radius `xs…xl` (controls `md`, cards `lg`); elevation `0–3`; motion
  `micro` 80 / `fast` 120 / `base` 200 / `moderate` 260 / `slow` 320 / `deliberate` 480 ms with
  standard, enter, exit, emphasized and spring easings, distances, a stagger and two delays (every
  duration collapses under reduced motion; [notes/S-23](../research/2026-09-29-godot-omniplatform/notes/S-23-motion-system.md) §5, MO-01). The motion
  patterns are §5.12.
- **Type:** Rubik **400 and 700 only** (`font-synthesis: none`) and a type scale `xs…5xl` where `sm`
  is the console table and form size. The platform mono stack is used for code.
- **Marks:** `PolarisMark` (Pinned K and Star Cut, optical cuts by displayed size),
  `PolarisLockup`, `PoweredByBadge`. `SERVICE_MARK` maps distribution and update to the Star Cut.

**What ADMIN needs from the brand package.** If BRAND.md lands these under other names, a one-file
alias layer in admin absorbs the difference:

| Need                       | Form                                                                                                                                                                                                                  | Used by                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| A Tailwind v4 theme export | `@import "@polaris-key/brand/tailwind.css"`, an `@theme` block mapping the semantic tokens to utilities (`bg-surface-raised`, `text-muted`, `border-subtle`, `bg-accent-solid`, `text-accent-fg`, `bg-signed-solid`…) | every component                 |
| Section scoping            | A `[data-service="<ServiceId>"]` selector that re-points the `accent.*` custom properties to that section's family, with `core` as the default                                                                        | shell, buttons, nav, focus ring |
| Theme selector             | `:root[data-theme="dark" \| "light"]`, plus a pre-paint snippet that resolves `system`                                                                                                                                | both SPAs                       |
| `SectionMark`              | `<SectionMark section={ServiceId} size={28} />`: the Pinned K whose terminal bit is `signed.mark` for `core` and the section's `accent.solid` otherwise, star unchanged                                               | `BrandBlock` (top bar)          |
| `ServiceGlyph`             | `<ServiceGlyph id size={16 \| 24} />`: the Star Cut service and favicon cuts for distribution; lucide icons for the rest (Update: `CircleArrowUp`)                                                                    | sidebar, badges, empty states   |
| `SignedGlyph`              | the terminal-bit rhombus as a 10–12 px UI glyph in `signed.solid`                                                                                                                                                     | `SignedBadge`                   |
| Fonts                      | `@polaris-key/brand/fonts.css` (variable Rubik and JetBrains Mono, latin and latin-ext WOFF2), self-hosted through Vite                                                                                               | both SPAs                       |
| Favicons and PWA           | the kit's `04-web/key` set for `/manage` and `/`                                                                                                                                                                      | `index.html`, `manage.html`     |

**Mapping from today's tokens.** `styles.css` `--pk-*` HSL channels and the
`[data-service=key|id|…]` placeholder palette (SH-18) are deleted in chunk 1.

`tools/services.json`'s `console.accent` values (`key`, `id`, …) become the brand `ServiceId`s
(`license`, `identity`, …). This is a service-table change, so it must be regenerated with
`pnpm gen:services` and pass `pnpm gen:services -- --check`. Alternatively, `console.accent` is
dropped in favor of the brand's `SERVICE_FAMILY`; that is the brand lead's call, and either works.

### 0.4 Stack decisions

| Area            | Today                                     | Target                                                                                              | Why                                                                                                                               |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| React           | 18.3                                      | **19**                                                                                              | Owner decision. `ref` as a prop removes every `forwardRef`; `useActionState` and `useOptimistic` are available but unused (§5.3). |
| Tailwind        | 3.4 with JS config and PostCSS            | **v4** via `@tailwindcss/vite`, CSS-first `@theme` from the brand package                           | Owner decision. Tokens come from one CSS import; `dark:` becomes `@custom-variant dark ([data-theme=dark] &)`.                    |
| Primitives      | individual `@radix-ui/react-*`            | the unified `radix-ui` package                                                                      | One version line; React 19 ready.                                                                                                 |
| Data            | hand-rolled `context.tsx` cache           | **TanStack Query v5**                                                                               | Staleness, focus refetch, dedupe, and declared invalidation. Fixes SH-1, SH-16, CC-1 to CC-4.                                     |
| Tables          | `DataTable.tsx`                           | **TanStack Table v8** + **TanStack Virtual**                                                        | Headless. Sorting, facets, visibility, selection; virtualization over 200 rows.                                                   |
| Forms           | per-view `useState` + `useEffect` seeding | **react-hook-form** behind `useAdminForm`                                                           | Dirty tracking that survives refetch; server-error mapping.                                                                       |
| Routing         | hand-rolled hash router                   | **the same router, extended**: typed route table, hash query params, `<Link>`, a navigation blocker | Keeps "one declaration" (`route.ts`), adds query state and guards, and needs no Worker change (§2.6).                             |
| Toasts          | Radix Toast + custom Toaster              | **sonner**                                                                                          | Stacking, actions, persistent errors, dedupe.                                                                                     |
| Command palette | none                                      | **cmdk**                                                                                            | Accessible combobox palette.                                                                                                      |
| Code editing    | Textarea                                  | **CodeMirror 6**, lazy-loaded                                                                       | Only on the catalog and payload JSON editors.                                                                                     |
| Diff            | none                                      | **jsdiff** (`diff`)                                                                                 | Text diff for JSON and YAML; the structured catalog diff is in-house.                                                             |
| Charts          | none                                      | hand-rolled SVG (`StatTile`, `Sparkline`, `Meter`, `Funnel`, `BarList`)                             | Tiny, accessible, brand-token colors only.                                                                                        |
| Icons           | lucide-react 0.469                        | lucide-react (latest) + brand `ServiceGlyph`                                                        | Star Cut for delivery.                                                                                                            |

The new runtime dependencies are listed in open question **Q3**.

---

## 1. Inventory

The full audit is [admin/inventory.md](admin/inventory.md). It covers:

- the route table for both SPAs (§0.1, §0.2);
- the API capability with no UI (§0.3);
- 290+ findings across the shell, the kit and every view, each with file:line;
- the stale-cache bugs (§1.3);
- docs drift (§7).

### 1.1 Shape of the console today

- **Routes.** 24 routes: 21 tabs and 3 detail leaves, in 7 sections (Platform, License, Config,
  Release, Distribution, Update, Identity), behind a hash router (`route.ts:110-385`).
- **Size.** About 25k lines of source in 91 files. The five largest views are Compatibility (833),
  Releases (787), UpdateSettings (727), Licenses (719) and Devices (693). The portal is one 1105-line
  file.
- **Tests.** 458 admin tests (403 `it` blocks plus `.each` expansions) in 34 files.

### 1.2 The twelve problems that shape the redesign

| #   | Problem                                                                                                                                                                                                                 | Evidence                                 | Where it is solved                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| P1  | **No page grammar.** Every view builds its own header; heading sizes split 12/11; doubled titles; actions sometimes in headers, mostly in card footers.                                                                 | inventory §1.2, SH-12                    | §3 templates, `PageHeader`                          |
| P2  | **Drafts are fragile.** Remount on every route; re-seed effects wipe edits on refetch; tabs unmount; no unsaved-changes guard.                                                                                          | SH-6, MPE-1, UPS-2, UHL-4, LDT-4, PRF-6  | `useAdminForm`, `SaveBar`, `useUnsavedChangesGuard` |
| P3  | **Stale data after writes.** 44 hand-placed `invalidate` calls with no map; `me` never refreshes.                                                                                                                       | SH-1, CC-1 to CC-4                       | TanStack Query + the invalidation table (§5.4)      |
| P4  | **Overloaded pages.** Releases stacks 7 blocks over 4 concerns; Secrets hosts 3 unrelated features; UpdateSettings saves two services' rows with one non-atomic Save.                                                   | REL-1, SEC-1, UPS-1                      | §2 IA moves and §6 redesigns                        |
| P5  | **Dead ends.** Gates "set in Distribution" with no UI; pack yank described but absent; signing activation promised but not wired; profile metadata and license profiles not editable; first catalog publish impossible. | DLV-3, PKD-1, SET-1, PRF-1, LDT-3, CAT-1 | §6 per area, plus API additions A-3 to A-7          |
| P6  | **Facts in `title`.** Blockers, reasons, errors, hashes and timestamps are hover-only in 8 views; disabled-button reasons never show at all.                                                                            | UI-2, CMP-2, MTX-3, OUT-6                | `Popover`, `Drawer`, `Button.disabledReason`        |
| P7  | **Unreadable matrices.** Four buttons per rollout per cell; tinted spans with no keyboard path; no sticky axes; readiness fetched but hidden.                                                                           | MTX-1/2/7, CMP-2/7                       | `Grid` primitive and cell drawers (§6.4, §6.3)      |
| P8  | **Weak destructive-action safety.** No typed confirmation anywhere (the client auto-fills the server's `confirmSlug`); the one-time key closes on Escape; Yank weaker than Unyank; Pause styled like Halt.              | UI-10, LIC-2, REL-5, MTX-10              | §5.2 policy, `ConfirmDialog`, `OneTimeSecretPanel`  |
| P9  | **Errors read "api 422".** 26 sites show `err.message`; server `reason` codes partly mapped; toasts vanish after 5 s, errors included.                                                                                  | inventory §1.2, UI-11                    | `errorCopy` (§5.9), persistent error toasts         |
| P10 | **Off-brand.** Indigo primary; amber, violet and rose accents in forbidden roles; no Rubik; dark-only default; dark flash for light users.                                                                              | SH-15, SH-18, SH-19                      | §0.3, chunk 1                                       |
| P11 | **Accessibility gaps.** Invisible mobile nav still tabbable; `role=button` rows nesting buttons; unlabelled selects; color-only states; no load announcements.                                                          | SH-2, UI-6, UI-12, UI-13, SCF-1          | the component a11y contracts                        |
| P12 | **The portal under-serves customers.** False "this tab will update" promise; errors look like sign-out; unidentifiable devices and keys; no account deletion despite the API.                                           | POR-1 to POR-17                          | §2.7, §6.10                                         |

---

## 2. Information architecture

### 2.1 Model

Navigation has two tiers.

**Global (top bar).** Things that do not depend on a product:

- the brand block: Home, carrying the section bit;
- the product switcher;
- the environment badge;
- the command palette;
- docs help;
- the theme menu;
- the user menu.

**Product-scoped (sidebar).** One group per **section**:

- **Core**, always shown;
- one per **enabled service**, in the service table's canonical order.

A section's label is its service label. The glossary rule that "the slug is the console section
name" holds.

The sidebar shows **platform links** (Home, Products) and the **Platform section** when no product
is in scope. It fixes SH-10: Home and Products no longer draw a product's sections.

**The Platform section** (owner decision, notes/S-13 §11 item 3, 2026-10-04) is a sidebar group of
instance-wide pages that belong to no product: Settings, Deployment, Operations, Store connections
and Package feeds. It follows the product sections' rules: its header has no icon, every item has
one, only the active group is open (a collapsed group can be peeked into), it takes the `core`
accent and no section bit. It is shown **only off a product** (Home, Products and the Platform pages
themselves), after the platform links. Inside a product it is hidden (owner, 2026-10-04: beside a
product's own sections it read as part of the product), and stays one step away: the product
switcher's **Platform** entry (beside "All products"), the account menu's version chip (→
Deployment) and `⌘K`. `#/platform` is not a page: it redirects to Settings.

### 2.2 Global elements

| Element               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Brand block**       | `SectionMark` at 28 px + "Polaris Key" (≥ 640 px). Links to Home. The terminal bit shows the current section's accent: chartreuse in License; yellow in Config; cyan in Release; green in Distribution; tangerine in Update; orchid in Identity; no bit at all on Home, Products, Platform and Core pages (BRAND.md §6, 2026-10-03, superseding gold there). The star never changes. Gold was used on core pages because a violet bit would disappear into the violet K. |
| **Product switcher**  | A combobox (search, recent, service dots, attention count). It keeps the current page when the target product runs that service (SH-11). Its footer links All products, Platform and New product. The trigger shows the name (never squeezed below a few characters) and, from 1024 px, the slug and service dots. Shortcut `g p`.                                                                                                                                       |
| **Environment badge** | Shown in staging and dev ("Staging" in `status.warning`, "Dev" in `status.info`); hidden in production. The source is `/me.environment` (API addition **A-1**), with no hostname heuristics.                                                                                                                                                                                                                                                                             |
| **Command palette**   | `⌘K` / `Ctrl+K`. Navigation, products, entities of the current product, and safe actions (`components.md` §1.5).                                                                                                                                                                                                                                                                                                                                                         |
| **Docs**              | "Docs" link to `docsFor(page)`, a labelled link, not a `title`-only icon (SH-13).                                                                                                                                                                                                                                                                                                                                                                                        |
| **Theme menu**        | System (default) / Dark / Light. Persisted per viewer. System follows `prefers-color-scheme` live, and dark is the fallback when the OS gives no answer. Under 640 px the top bar has no room for it, and the account menu carries Theme and Motion instead.                                                                                                                                                                                                             |
| **User menu**         | Name and email; "Session ends 18:40" (from **A-1** `sessionExpiresAt`, else omitted); a **version chip** ("v0.8.6 · prod", from **A-11** `GET /platform/version`; hidden when it cannot be read) linking to Platform → Deployment; Keyboard shortcuts (`?`); Docs home; Sign out.                                                                                                                                                                                        |

### 2.3 Sections and pages

Each section's pages are listed in nav order. **Bold** marks pages that are new or substantially
re-scoped. A page is shown only when its section is shown, plus the conditions listed.

| Section (accent)                   | Page                   | URL (`#/p/:slug/…`)                                                                      | Template                 | Replaces / notes                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core** (violet, gold bit)        | Overview               | `` (root)                                                                                | T1 overview              | ProductOverview, rebuilt as the operational overview (§6.2)                                                                                                                                                                                                                                                |
|                                    | Services               | `services`                                                                               | T4 settings              | Services, plus the **dependency graph** (Release → Distribution → Update) that replaces Distribution's ChainCard                                                                                                                                                                                           |
|                                    | Devices                | `devices`, `devices/:deviceId` (drawer)                                                  | T2 collection            | Devices; drawer routed                                                                                                                                                                                                                                                                                     |
|                                    | Users                  | `users`, `users/:subject/[overview\|licenses\|devices\|activity\|data]`                  | T2, T3                   | New (I-12): every product, keyed by pairwise subject; sign-in history with Identity on; `data` only with Cloud Sync on                                                                                                                                                                                     |
|                                    | Presentation           | `presentation`                                                                           | T4 settings (sections)   | New (HA-06): every image Polaris Key hosts for the product (icon, listing art, store slots), with source, status, size and an image-host preview; Upload or Replace claims a slot, Revert to manifest, Delete copy                                                                                         |
|                                    | **Keys & secrets**     | `keys`                                                                                   | T4 settings (sections)   | Secrets, Settings → Signing key, Products → Prepare signing key. Holds signing keys (gold), product secrets and **CI publishing** (trusted publisher and CI tokens, an API with no UI today). Edge mint moves to Config; outlet credentials move to Distribution.                                          |
|                                    | Activity               | `activity`                                                                               | T2 collection (timeline) | Activity, with filters and target links                                                                                                                                                                                                                                                                    |
|                                    | Settings               | `settings`                                                                               | T4 settings              | Settings: General, License defaults (when License is on), **Repository** (link state, last sync, Resync from repo), **Storage** (blob GC dry run, API with no UI today), Danger zone                                                                                                                       |
| **License** (chartreuse)           | Licenses               | `license/licenses`, `license/licenses/:id/[overview\|keys\|devices\|config\|history]`    | T2, T3                   | Licenses, LicenseDetail; tabs in the URL                                                                                                                                                                                                                                                                   |
|                                    | Tiers                  | `license/tiers`, `license/tiers/:id`                                                     | T2, T3                   | Tiers, with a **detail page** (used-by, policy) instead of dialogs                                                                                                                                                                                                                                         |
|                                    | Enrollment             | `license/enrollment`                                                                     | T4                       | "Enrollment & fingerprints" → **Enrollment** (registration policy read-out with a link to Services, fingerprint policy, probes)                                                                                                                                                                            |
| **Config** (yellow)                | Catalog                | `config/catalog`, `config/catalog/edit`                                                  | T2 (read), T7 editor     | Catalog + PublishDialog; structured editor, diff, review (§6.6)                                                                                                                                                                                                                                            |
|                                    | Profiles               | `config/profiles`, `config/profiles/:id/[payload\|used-by\|history]`                     | T2, T3 + T7              | Profiles, ProfileDetail                                                                                                                                                                                                                                                                                    |
|                                    | **Edge mint**          | `config/edge-mint`                                                                       | T2 collection            | EdgeMintRecipes, moved from Secrets; always visible, with a first-run state (EMR-1)                                                                                                                                                                                                                        |
| **Release** (cyan)                 | Releases               | `release/releases`, `release/releases/:releaseId/[builds\|packs\|channels\|history]`     | T2, T3                   | Releases store table; **release detail page** (new)                                                                                                                                                                                                                                                        |
|                                    | **Channels**           | `release/channels?deliverable=app`                                                       | T5 visualization         | ChannelsPanel, promoted to a page; all deliverables (CHN-1)                                                                                                                                                                                                                                                |
|                                    | Deliverables           | `release/deliverables`, `release/deliverables/:id/[releases\|channels\|delivery\|files]` | T2, T3                   | Deliverables, DeliverableDetail                                                                                                                                                                                                                                                                            |
|                                    | Compatibility          | `release/compatibility`, `release/compatibility/simulator`                               | T5 + T6                  | Compatibility split into Matrix and Simulator sub-pages                                                                                                                                                                                                                                                    |
|                                    | **Content keys**       | `release/content-keys`                                                                   | T2                       | ContentKeys, moved off Deliverables (DLV-5)                                                                                                                                                                                                                                                                |
| **Distribution** (green, Star Cut) | **Matrix**             | `distribution/matrix?deliverable=app`                                                    | T5                       | Matrix; default page of the section                                                                                                                                                                                                                                                                        |
|                                    | **Rollouts**           | `distribution/rollouts`                                                                  | T2                       | Distribution overview's rollouts table, now live with controls                                                                                                                                                                                                                                             |
|                                    | **Outlets & feeds**    | `distribution/outlets`                                                                   | T2 + T3 drawer           | New. Outlets and capabilities (API with no UI today), storefront feed URLs, distribution keys                                                                                                                                                                                                              |
|                                    | **Storefronts**        | `distribution/storefronts?flow=add&step=&stores=`                                        | T2 tiles + T6            | A-18j. One tile per storefront adapter, capabilities rendered from its declaration; **Add to storefronts** (T6) provisions the product onto any of them, resumable from the ledger (notes/S-15 §8.1)                                                                                                       |
|                                    | **Polaris Key**        | `distribution/storefronts/polaris-key`                                                   | T4                       | PS-06. The built-in storefront's own page: readiness, Listing (Automatic / Listed / Not listed), Audience (typed widening), Ways to add (absent when not configured), Group labels, "Who can see this?" with a persona preview, the 28-day analytics card (notes/S-21 §6.6; SETUP.md §2.10's Discover tab) |
|                                    | **Listing**            | `distribution/listing?tab=&locale=&release=`                                             | T3 (tabs)                | A-18j. The shared listing model: text per locale, fit report with overrides, slot board, release notes, "Push listing" per store (notes/S-15 §8.2)                                                                                                                                                         |
|                                    | **App Store**          | `distribution/app-store?step=&build=&version=`                                           | T6 + aside               | A-17g. The App Store Distribute flow (notes/S-14 §8.2) beside App Store Connect's versions and review submissions                                                                                                                                                                                          |
|                                    | **Commerce**           | `distribution/commerce`                                                                  | T2                       | A-17g. App Store products: the `app-store` commerce mappings beside Apple's In-App Purchases (S-14 §8.3)                                                                                                                                                                                                   |
|                                    | **Access**             | `distribution/access`                                                                    | T4                       | Delivery access moved from UpdateSettings, incl. **per-pack** gates (UPS-5, DLV-3)                                                                                                                                                                                                                         |
|                                    | Health                 | `distribution/health`                                                                    | T1-style dashboard       | Update health, with funnel charts and a window selector                                                                                                                                                                                                                                                    |
|                                    | **Outlet credentials** | `distribution/credentials`                                                               | T2 + drawer              | OutletCredentials, moved from Secrets; store connectors status                                                                                                                                                                                                                                             |
| **Update** (tangerine, Star Cut)   | **Feed**               | `update/feed`                                                                            | T4                       | UpdateSettings minus delivery access: metadata access, compat window, artifact policy, feed **endpoints**                                                                                                                                                                                                  |
| **Identity** (orchid)              | **Portal**             | `identity/portal`                                                                        | T4                       | Portal module toggles with dependencies, branding read-out                                                                                                                                                                                                                                                 |
|                                    | **Sign-in**            | `identity/sign-in`                                                                       | T3 read-only             | The OIDC card, now showing the provider, issuer and client (data already returned by `config/mint` → `identity`) and the manifest pointer                                                                                                                                                                  |
| **Cloud Sync** (teal)              | **Data**               | `sync/data`                                                                              | T3 read-only             | U-04. What the catalog declares: user settings, collections, saves, migrations, and the platform ceilings; the sign-in-only callout                                                                                                                                                                        |

**Global pages**:

| Page        | URL                           | Template | Notes                                                    |
| ----------- | ----------------------------- | -------- | -------------------------------------------------------- |
| Home        | `#/`                          | T1       | §6.1                                                     |
| Products    | `#/products`                  | T2       | the registry                                             |
| New product | `#/products/new[?via=github]` | T6       | full-page wizard instead of nested tabs (PRD-7)          |
| Platform    | `#/platform`                  | —        | Not a page: redirects to Platform → Settings (S-13 §9.1) |

**Platform section** (global, instance-wide; notes/S-13 §9.1, owner decision 2026-10-04). A page
that is not built yet carries `ready: false` in `nav.ts` and redirects to Deployment, with no
"coming soon" copy:

| Page                  | URL                            | Template       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settings**          | `#/platform/settings`          | T4             | Background jobs (the four runtime-editable job settings: `LAZY_DELTAS`, `LAZY_DELTA_MAX_BYTES` lower-only, `BLOB_GC_MODE`, `BLOB_GC_GRACE_DAYS`, each with its source; ceiling precedence for kill switches), Licensing (`LICENSING_RESERVED_NAMES` warn/error and the reserved-names list of registered products, LX-05), the read-only inventory, the KEK keyring (re-seal sweep, L3 "type reseal") and secrets presence. Needs A-13 |
| **Deployment**        | `#/platform/deployment`        | T1 plus tables | The running build (tag, commit, Cloudflare version, protocol and discovery versions), deploy history (`platform_deploys`, keyset Load more), D1 migrations against the build's newest, required indexes, bindings (presence only), and **Platform activity** (`platform_audit`, A-12). Built in chunk 4                                                                                                                                |
| **Operations**        | `#/platform/operations`        | T1             | Self-reported operations data (A-14), built in chunk 4P-3: a health state (Healthy, Degraded, Failed) per section, cron runs by step with recent history, heartbeats and staleness, queue and dead-letter backlog, D1 and R2 size, required indexes, connector aggregates; refreshes on an interval with a pause switch. Cloudflare analytics panels wait for A-15 and are absent until then                                           |
| **Store connections** | `#/platform/store-connections` | T2             | Instance-wide store connector state; **Set up** on an assigned app opens that product's Add to storefronts, scoped to the store (A-18j)                                                                                                                                                                                                                                                                                                |
| **Package feeds**     | `#/platform/feeds`             | T2 (S-12)      | S-12 owns the page and its API                                                                                                                                                                                                                                                                                                                                                                                                         |

**Rejected moves, so they stay rejected:**

- **Profiles stay in Config.** They are a Config service object; licenses and tiers link to them
  (PRF-8 is fixed by cross-links, not a move).
- **Devices stay in Core.** The device is Core's principal and exists without License. License
  detail embeds the same `DeviceTable` scoped to that license.
- **Update keeps its own section** although it has one page. The service table and glossary make
  sections equal to services. Its pages sit directly under Distribution's in the sidebar. Since
  2026-10-03 their accents differ (Distribution green, Update tangerine), and since 2026-10-04 the
  Update glyph is lucide `CircleArrowUp` (owner feedback: a recognisable "update" icon; the Star
  Cut alone made the two sections indistinguishable). `RefreshCw` stays the refresh/resync verb.

### 2.4 Accent and mark mapping

| Context                                               | `data-service` | Bit color          | Section glyph                          | Primary buttons and active nav |
| ----------------------------------------------------- | -------------- | ------------------ | -------------------------------------- | ------------------------------ |
| Home, Products, the Platform section, every Core page | `core`         | none (no bit)      | Pinned K (sidebar group: lucide `Box`) | violet                         |
| License                                               | `license`      | chartreuse `solid` | lucide `KeyRound`                      | chartreuse                     |
| Config                                                | `config`       | yellow             | lucide `SlidersHorizontal`             | yellow                         |
| Release                                               | `release`      | cyan               | lucide `Package`                       | cyan                           |
| Distribution                                          | `distribution` | green              | **Star Cut**                           | green                          |
| Update                                                | `update`       | tangerine          | lucide `CircleArrowUp`                 | tangerine                      |
| Identity                                              | `identity`     | orchid             | lucide `UserRound`                     | orchid                         |
| Cloud Sync                                            | `sync`         | teal               | lucide `Cloud`                         | teal                           |

**Rules.**

- **What accents color.** Accents color identity and chrome only: nav marker, primary button,
  focus ring, links, selected row, sidebar glyph. **Status colors never change by section**:
  success is always success.
- **Gold appears only for signed things** (`SignedBadge`, key displays, signature verified) and as
  the K's bit on core pages.
- **The Star Cut** appears on Distribution and Update group labels, their `service-off` empty
  states, their `ServiceBadge`s, and the delivery cards on Home and Overview. It never indicates
  live update status (kit rule): an "update available" or "rolling out" state is a `StatusPill`.
- **The section bit in the header** is a deliberate, owner-approved extension of the kit's gold
  rule. It shows only in service sections; on core pages the K has no bit (BRAND.md §6,
  2026-10-03). The kit draws the bit only in the display cut (≥ 48 px). The header mark is 28 px.
  Open question **Q1** asks the brand lead to draw a service-cut bit (recommended) or to accept a
  48 px brand block.

### 2.5 URL scheme

The scheme is `#/p/<slug>/<section>/<page>[/<id>[/<tab>]][?<query>]`.

**Query parameters are page state.** All of these belong in the query:

- table sort, filters, search and cursor (`?status=expired&tier=pro&sort=-expires`);
- matrix deliverable, limit and view (`?deliverable=textures&view=readiness`);
- the time window (`?window=24`);
- simulator inputs (`?app=…&platform=…`).

The open drawer id is part of the path when the drawer shows an entity
(`devices/dev_123`), and part of the query when it shows a cell (`?cell=rel_1:appstore`).

**Old routes keep working.** `parseRoute` gains a redirect table, applied with
`history.replaceState`, so Back does not loop. The table is tested exhaustively (§7, chunk 2):

| Old hash                     | New hash                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `#/p/:s/overview`            | `#/p/:s`                                                                                                            |
| `#/p/:s/secrets`             | `#/p/:s/keys`                                                                                                       |
| `#/p/:s/licenses[/:id]`      | `#/p/:s/license/licenses[/:id]`                                                                                     |
| `#/p/:s/tiers`               | `#/p/:s/license/tiers`                                                                                              |
| `#/p/:s/fingerprints`        | `#/p/:s/license/enrollment`                                                                                         |
| `#/p/:s/config`              | `#/p/:s/config/catalog`                                                                                             |
| `#/p/:s/profiles[/:id]`      | `#/p/:s/config/profiles[/:id]`                                                                                      |
| `#/p/:s/releases`            | `#/p/:s/release/releases`                                                                                           |
| `#/p/:s/deliverables[/:id]`  | `#/p/:s/release/deliverables[/:id]`                                                                                 |
| `#/p/:s/compatibility`       | `#/p/:s/release/compatibility`                                                                                      |
| `#/p/:s/distribution`        | `#/p/:s/distribution/matrix`                                                                                        |
| `#/p/:s/distribution-matrix` | `#/p/:s/distribution/matrix`                                                                                        |
| `#/p/:s/distribution-health` | `#/p/:s/distribution/health`                                                                                        |
| `#/p/:s/updates`             | `#/p/:s/update/feed` (delivery access now at `distribution/access`)                                                 |
| `#/p/:s/identity`            | `#/p/:s/identity/portal`                                                                                            |
| `#/p/:s/<unknown>`           | **Not found** page (T8) naming the segment, with links to Overview and the palette. No more silent fallback (SH-8). |
| `#/productsfoo`              | Not found (exact match only)                                                                                        |

**Help links in other places.** `D/admin/*` pages and `lib/docsLinks.ts` link into the console
in prose only. The docs `console-tour.md` page is rewritten in chunk 2 (§7.2).

### 2.6 Routing mechanics

`route.ts` stays the single declaration and becomes `nav.ts` + `routes.ts`:

```ts
export const SECTIONS: NavSection[] = [
  { key: "core", label: "Core", service: null, items: [
      { page: "overview", label: "Overview", path: "", icon: LayoutDashboard, docs: "/docs/admin/products/" },
      … ] },
  { key: "license", label: "License", service: "license", items: [
      { page: "licenses", label: "Licenses", path: "license/licenses", icon: KeyRound, docs: …,
        children: [{ page: "license", path: ":id/:tab?", tabs: ["overview","keys","devices","config","history"] }] },
      … ] },
  …
];
```

- **Hash routing stays.** It needs no Worker change: `/manage/*` asset rewrites would touch
  `W/router.ts` and the assets binding. Open question **Q2** offers path routing as the
  alternative.
- **`<Link to={r.license(slug, id, "keys")}>`** renders a real `<a href>` (fixes SH-5). `r.*` are
  typed route builders generated from `SECTIONS`.
- **`useSearchParam`** and **`useTableUrlState`** give typed query state.
- **Navigation blocker.** `router.block(fn)` backs `useUnsavedChangesGuard`. It intercepts link
  clicks, `hashchange` (with restore) and the product switcher.
- **Remount policy.** Views no longer key on the whole route. They key on `slug` + `page`, so
  changing a query param or tab does not remount the page (fixes SH-6 side effects).
- **Code splitting.** `React.lazy` per section, with prefetch on sidebar hover or focus.
- **`document.title`** is `"{page title} · {product} · Polaris Key"`.

### 2.7 Customer portal IA

The portal is a different audience: a customer, not an operator. Its IA is flat and task-led.

| Page      | URL                                                           | Content                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in   | (no session)                                                  | Single sign-on button (IdP display name when available, else "Continue with single sign-on"); email link with sent, resend and change-email states; no "Refresh session" until a link is sent, then automatic detection on tab focus (POR-1, POR-2) |
| Home      | `#/`                                                          | Licenses grouped by product (product branding applied per group), a "Needs attention" strip with reasons, **Add a license** (claim), "Latest downloads for this device"                                                                             |
| License   | `#/licenses/:product/:id[/devices\|keys\|downloads\|details]` | Status with its **reason**, seat meter, devices (identifiable), keys (identifiable), downloads for this product, details (expiry, channels, version window, offline days)                                                                           |
| Downloads | `#/downloads`                                                 | Grouped by product, latest first, platform auto-detected with an "All platforms" toggle, notes and checksums                                                                                                                                        |
| Account   | `#/account`                                                   | Name and email, sign-in methods, linked licenses (with "How licenses link to you"), **Delete account** (typed confirmation; `DELETE /api/me`, API with no UI today), theme                                                                          |

The old `#/licenses` list folds into Home (a portal user has few licenses). It redirects to `#/`.
`#/profile` redirects to `#/account`, which also removes the name collision with console Profiles
(POR-14).

The portal top bar holds the Pinned K at 24 px (service cut, no bit; the portal is not sectioned),
the wordmark, nav, the account menu (theme, sign out) and a hamburger below 640 px (POR-15).

---

## 3. Page templates

Eight templates. Every inventoried view maps to one (§3.9). All templates share the `PageHeader`
contract (`components.md` §1.6):

- one `<h1>`;
- breadcrumb on detail pages;
- one primary action;
- up to two secondary actions, the rest in "More actions";
- danger actions last in the overflow menu.

### T1 · Overview (dashboard)

**For.** Home, product Overview, Distribution → Health, Platform.

```
┌ PageHeader ─────────────────────────────────────────────────────────────────┐
│ Title · description (scope, freshness "Updated 2 min ago" + Refresh)  [Primary]│
└─────────────────────────────────────────────────────────────────────────────┘
┌ Attention list (only when non-empty) ───────────────────────────────────────┐
│ ▲ item · why · [Action →]     (max 5, "Show all n")                          │
└─────────────────────────────────────────────────────────────────────────────┘
┌ StatTile ┐┌ StatTile ┐┌ StatTile ┐┌ StatTile ┐   ← 2–4 KPIs, each a link
└──────────┘└──────────┘└──────────┘└──────────┘
┌ Primary panel (2/3) ─────────────────────┐┌ Side panel (1/3) ──────────────┐
│ e.g. service tiles / funnel / table      ││ e.g. recent activity Timeline  │
└──────────────────────────────────────────┘└────────────────────────────────┘
```

- **Header.** No breadcrumb. The description states scope and freshness.
- **Attention list.**
  - Each item: `StatusPill` tone, an object `EntityLink`, a one-line reason, and one action button.
  - Items come from cached data (`useAttention`).
  - Ordered danger, then warning, then info; then by recency.
- **Tiles.** Independent queries, so each shows its own skeleton or error and one failing tile never
  blanks the page.
- **Responsive.** 4 → 2 → 1 tile columns; the side panel drops below the primary panel under
  1024 px.
- **Empty.** The `first-run` EmptyState replaces the tiles with a checklist when the scope has
  nothing yet. Home with zero products shows a first-run panel with **New product**.

### T2 · Collection (list or table)

**For.** Products, Devices, Activity, Licenses, Tiers, Profiles, Edge mint, Releases, Deliverables,
Content keys, Rollouts, Outlets, Outlet credentials, the Catalog read view.

```
┌ PageHeader: Title (count) · description ·  [Primary: New …]  [⋯] ──────────┐
├ Optional summary strip: 2–4 StatTiles or facet chips with counts ──────────┤
├ FilterBar: [Search…] [Status ▾] [Tier ▾] [chips ×]  · Columns · Density · ⤓ ┤
│   (bulk mode replaces it: "3 selected · [Disable…] · Clear")                │
├ DataTable ──────────────────────────────────────────────────────────────────┤
│ ☐ Primary (link) · secondary · status · … · ⋯                               │
├ Footer: "Showing 50 of 312" · [Load more] / pager ─────────────────────────┤
└────────────────────────────────────── Drawer (peek / create) ─────────────►┘
```

- **Row navigation.** The primary cell is a link to the record (T3) or a routed drawer. There are no
  `role=button` rows (UI-12).
- **Create.** Small objects (tier, profile, secret, credential) open in a `Drawer` from the end
  side. Objects with a one-time result (license, CI token) open a `Dialog` that becomes a
  `OneTimeSecretPanel`. Large objects (product) use a T6 wizard page.
- **URL state.** All of the FilterBar and pager state.
- **Responsive.** Below 768 px, `mobile="cards"` renders priority-1 columns as stacked cards, with
  the row actions in a kebab. The FilterBar collapses into a "Filters (2)" button that opens a
  bottom sheet.
- **States.** Loading uses skeleton rows that match the columns. Error renders inline in the table
  body with Retry. Empty is `first-run` (why and create). Filtered empty is `no-results` with Clear
  filters.

### T3 · Record (detail with tabs)

**For.** License, tier, profile, release, deliverable (pack), device (drawer form), Identity
sign-in, Outlet (drawer form).

```
┌ Breadcrumbs: Licenses / Studio Pro ─────────────────────────────────────────┐
│ H1 Studio Pro  [● Active]  [From manifest]                     [Primary] [⋯] │
│ ada@example.com · lic_01J… ⧉ · created 3 Sep 2026 · changed 2 h ago by Ada  │
├ PageTabs: Overview · Keys (2) · Devices (3/5) · Config · History ───────────┤
│                                                                             │
│  Tab content (templates nest: a tab can be a T2 table or a T4 form)         │
│                                                                             │
├ SaveBar (when the tab holds a dirty form) ──────────────────────────────────┤
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Header meta line.** Identity facts: email, id with copy, created, last modified by (the
  `modifiedBy`/`modifiedAt` the API already returns, LDT-9). No metadata card that repeats the tab
  counts.
- **Tabs.** Route segments (fixes LDT-4). A dirty tab shows a dot and stays mounted.
- **Overview tab.** A `DescriptionList` of the important facts plus the "effective" summary (for
  example, the effective update policy).
- **History tab.** The Activity `Timeline` filtered to this target. This uses **A-2** activity
  filters; until A-2 lands, the tab is hidden rather than faked.
- **Sticky condensed header** on scroll (title and primary action).
- **Not found.** A T8 not-found page naming the id, with a link back to the collection (PKD-2,
  LDT-14).

### T4 · Settings (sectioned form)

**For.** Services, Keys & secrets, Settings, Enrollment, Distribution → Access, Update → Feed,
Identity → Portal, Platform.

```
┌ PageHeader ─────────────────────────────────────────────────────────────────┐
├──────────────┬──────────────────────────────────────────────────────────────┤
│ On this page │ ┌ Section: General ─────────────────────── [From manifest ⓘ]┐│
│ · General    │ │ label            [ control              ]  help           ││
│ · Defaults   │ │ label            [ control              ]                 ││
│ · Repository │ └────────────────────────────────── [Revert to manifest…] ──┘│
│ · Danger     │ ┌ Section: Danger zone (danger border) ──────────────────────┐│
│              │ │ Delete product · consequences · [Delete product…]          ││
│              │ └────────────────────────────────────────────────────────────┘│
├──────────────┴──────────────────────────────────────────────────────────────┤
│ SaveBar: "2 changes in General" · [Discard] [Save changes]                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Sections are cards** with a two-column field layout: label and help on the left, control on the
  right (≥ 1024 px). Below 1024 px they stack.
- **"On this page"** is an anchor rail shown only when there are 3 or more sections and the width is
  at least 1280 px.
- **One form per independently-saved resource.** If a page edits two resources (two API rows),
  each section has its own SaveBar scope and the bar names the section. **Never one Save across two
  endpoints** (fixes UPS-1).
- **SourceBadge and Revert to manifest** sit in each section header. Revert is a `caution` confirm
  listing what the next resync will re-apply.
- **Danger zone** is the last section, with a `status.danger` border. Each action has its
  consequence line and a `danger` or typed confirm.

### T5 · Matrix / visualization

**For.** Distribution → Matrix, Release → Compatibility (matrix), Release → Channels (the lane
view).

```
┌ PageHeader + inline legend (glyph + label per state) ───────────────────────┐
├ Toolbar: Deliverable ▾ · Channel ▾ · View (Availability|Rollouts|Readiness) │
│          · Rows 20 ▾ · [‹ Newer] [Older ›]                                  │
├ Grid ───────────────────────────────────────────────────────────────────────┤
│              │ Outlet A ▾ │ Outlet B ▾ │ Outlet C ▾ │   ← sticky header       │
│ 2.4.0 stable │ ● Live 25% │ ◐ Review   │ — n/a      │                         │
│ 2.3.1 stable │ ● Live     │ ● Live     │ ▲ Held     │                         │
│ ↑ sticky row header                                                         │
└───────────────────────────────────────────── Cell drawer ─────────────────►┘
```

- **Grid.** The `Grid` primitive: one tab stop, arrow-key navigation, Enter opens the cell drawer.
  Each cell's accessible name is a full sentence.
- **Cells are summaries.** A glyph plus a short label plus at most one secondary line. **Actions
  never live in cells** (fixes MTX-1). They live in the cell drawer, which shows the full detail
  (records, submission, readiness blockers, rollouts with controls, history).
- **View modes** change only the cell summary, not the layout, and are in the URL.
- **Legend.** Always visible and textual.
- **Responsive.**
  - Below 768 px the grid becomes a **row list**: each release is a card listing its outlets as
    rows.
  - The full grid stays reachable via "View as grid", which scrolls horizontally with a sticky first
    column.
- **States.**
  - Empty states split by cause: "no releases yet" vs "no outlets declared" (MTX-9), each with its
    own next step.
  - A partial-data notice is shown when the server caps the window ("Showing the newest 20
    releases"), with no implementation leak (CMP-6).

### T6 · Flow (wizard)

**For.** New product (manual or GitHub), the Compatibility simulator (single step, form plus
result), create license (in a dialog, as steps).

```
┌ Breadcrumbs: Products / New product ────────────────────────────────────────┐
│ H1 New product                                                              │
├ Stepper: ① Source  ② Basics  ③ Catalog  ④ Defaults  ⑤ Review ──────────────┤
│ ┌ Step content ──────────────────────────────┐ ┌ Aside: what happens next ┐ │
│ │ fields…                                    │ │ explanation + docs link  │ │
│ └────────────────────────────────────────────┘ └──────────────────────────┘ │
├ Footer: [Cancel]                                  [Back] [Continue →]       │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Full page** when the flow has 3 or more steps or produces a durable result (product). **Dialog
  with steps** when it has 2–3 short steps (license).
- **Review step** before any irreversible create. **Result step** shows one-time material through
  `OneTimeSecretPanel` and offers next actions ("Open product", "Set 2 missing secrets"; fixes
  PRD-8).
- **Unsaved guard** across steps. Back keeps values. Step state is in the URL (`?step=catalog`) so a
  refresh does not lose progress (drafts in `sessionStorage`, never secrets).

### T7 · Editor (document)

**For.** Catalog editor, profile payload, license config overrides.

```
┌ Breadcrumbs: Catalog / Edit ── H1 Edit catalog · v7 → v8  [From manifest ⓘ] ┐
├ Toolbar: [Search keys…] [Kind ▾] [Changed only ☐] · Mode (Form | JSON) ────┤
├────────────────────────┬─────────────────────────────────────────────────────┤
│ Entry list (grouped)   │ Entry editor / payload rows                         │
│ ▸ General   3 · 1 ✎    │  key · kind · label …                               │
│ ▸ Network   5          │  value control · management state · provenance     │
│   ▲ 1 error            │                                                     │
├────────────────────────┴─────────────────────────────────────────────────────┤
│ SaveBar: "+2 −1 ~3 · 1 error" · [Discard] [Review changes →]                │
└──────────────────────────────────────────────── Review drawer (DiffViewer) ►┘
```

- **Dirty state is first-class.** Per-row markers, per-group change and **error** counts (MPE-2),
  "Changed only" filter, and jump-to-first-error.
- **Review before write.** "Review changes" opens a `Drawer` with a structured `DiffViewer`,
  warnings (removed keys still referenced, management-state escalations, secrets changed), then the
  final confirm button.
- **Concurrency.**
  - If the server version moves while editing (catalog `schemaVersion`; for profiles and licenses,
    `modifiedAt`), the bar shows "Changed on the server" with Review / Discard.
  - The catalog uses **A-6** `expectedVersion` to make this enforceable.
- **Errors only count against changed rows.** Pre-existing invalid values are flagged but do not
  block unrelated saves, unless the server would refuse them; the server stays authoritative
  (fixes MPE-2).

### T8 · State pages

**For.** Not found, service off, unknown product, session expired, boot.

| State               | Content                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Service off**     | `EmptyState kind="service-off"` in the service's accent and glyph: "The License service isn't enabled for DJDL." **Enable License** (goes to Services with the row focused and pre-toggled, unsaved) + docs                                                                                                                                                                                                  |
| **Not found**       | Names the missing thing ("No license `lic_123` in DJDL"), links to its collection and to the palette                                                                                                                                                                                                                                                                                                         |
| **Unknown product** | Lists the closest slugs (edit distance ≤ 2) + "All products"                                                                                                                                                                                                                                                                                                                                                 |
| **Session expired** | **Superseded by SIGN-IN.md §3.12:** "Your session ended" renders in place on the shared card with the email chip and Continue. As first written: a non-dismissible dialog over the current page: "Your session ended. Sign in again to continue; your unsaved changes stay in this tab." **Sign in** opens `/manage/login?returnTo=<current hash>` in the same tab after stashing drafts in `sessionStorage` |
| **Boot**            | The brand mark (display cut, 48 px, gold bit), "Loading console…" in a live region; on failure an `ErrorState` with Retry and Sign in                                                                                                                                                                                                                                                                        |

### 3.9 View → template map

| Today's view                                                           | New page(s)                                                                                                            | Template                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Dashboard                                                              | Home                                                                                                                   | T1                                |
| Products (+ Create/Edit/Secret/RotateKey dialogs)                      | Products; New product; edit moves to product Settings                                                                  | T2; T6                            |
| ProductOverview                                                        | Core → Overview                                                                                                        | T1                                |
| Services / ServicesCard                                                | Core → Services                                                                                                        | T4                                |
| Devices                                                                | Core → Devices (+ device drawer)                                                                                       | T2 (+T3 drawer)                   |
| Secrets                                                                | Core → Keys & secrets                                                                                                  | T4                                |
| EdgeMintRecipes                                                        | Config → Edge mint                                                                                                     | T2                                |
| OutletCredentials                                                      | Distribution → Outlet credentials                                                                                      | T2                                |
| Activity                                                               | Core → Activity                                                                                                        | T2 (timeline)                     |
| Settings                                                               | Core → Settings                                                                                                        | T4                                |
| Licenses                                                               | License → Licenses                                                                                                     | T2                                |
| LicenseDetail + licenses/\*                                            | License → license record                                                                                               | T3 (tabs nest T2, T4, T7)         |
| Tiers + tiers/dialogs                                                  | License → Tiers, tier record                                                                                           | T2, T3                            |
| FingerprintPolicy                                                      | License → Enrollment                                                                                                   | T4                                |
| Catalog + catalog/\*                                                   | Config → Catalog, Catalog editor                                                                                       | T2, T7                            |
| Profiles, ProfileDetail, PayloadEditor                                 | Config → Profiles, profile record                                                                                      | T2, T3 + T7                       |
| Releases (+ReleaseBuilds, ResyncButton, health/sync cards)             | Release → Releases, release record, Repo sync drawer                                                                   | T2, T3                            |
| ChannelsPanel + PolicyActionDialog                                     | Release → Channels                                                                                                     | T5 (lanes)                        |
| Deliverables, DeliverableDetail                                        | Release → Deliverables, pack record                                                                                    | T2, T3                            |
| ContentKeys                                                            | Release → Content keys                                                                                                 | T2                                |
| Compatibility                                                          | Release → Compatibility (Matrix, Simulator)                                                                            | T5, T6                            |
| Distribution (overview)                                                | split: chain → Services; rollouts → Distribution → Rollouts; hooks → removed (developer internals; documented in docs) | T4, T2                            |
| Matrix                                                                 | Distribution → Matrix                                                                                                  | T5                                |
| UpdateHealth                                                           | Distribution → Health                                                                                                  | T1                                |
| UpdateSettings                                                         | Update → Feed; Distribution → Access                                                                                   | T4, T4                            |
| Identity                                                               | Identity → Portal; Identity → Sign-in                                                                                  | T4; T3                            |
| (none)                                                                 | Platform section (Settings, Deployment, Operations, Store connections, Package feeds); Outlets & feeds                 | T4, T1, T1, T2, T2; T2            |
| Portal SignIn, Dashboard, Licenses, License detail, Downloads, Profile | Sign in, Home, License, Downloads, Account                                                                             | portal variants of T1, T3, T2, T4 |

---

## 4. Component system

Full API sketches, states and a11y contracts are in [admin/components.md](admin/components.md).
Everything builds on the brand package (§0.3).

| Group            | Components                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Replaces / fixes                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Shell**        | `AppShell`, `TopBar`, `BrandBlock` (`SectionMark`), `ProductSwitcher`, `EnvironmentBadge`, `Sidebar`/`SidebarGroup`/`SidebarItem`, `CommandPalette`, `PageHeader`, `PageTabs`, `Breadcrumbs`, `ThemeMenu`, `UserMenu`                                                                                                                                                                                                                                                                                                          | Shell.tsx; SH-2, 3, 4, 5, 10–15                         |
| **Actions**      | `Button` (`loading` always disables; `disabledReason`; default `type="button"`), `IconButton` (label required → tooltip), `ActionMenu`, `CopyButton`/`useCopy`                                                                                                                                                                                                                                                                                                                                                                 | UI-1, 2, 3; 26 inline docs links → `DocsLink`           |
| **Forms**        | `Form`/`useAdminForm`, `FormField` (render-prop wiring for any control incl. Select), `Input`, `NumberInput` (nullable, percent), `Textarea`, `Select` (`allowEmpty`, option descriptions), `Combobox`, `OrderedMultiSelect`, `Checkbox`/`Switch` with label, `RadioCards`, `SegmentedControl`, `DateInput` (local day, explicit instant), `VersionInput`, `ChannelPicker`, `SecretInput`, `CodeEditor` (lazy), `SaveBar`, `useUnsavedChangesGuard`                                                                            | UI-6, 7; SCF-1, 2; TIR-1; LDT-2; LIC-3, 5; MPE-1; UPS-2 |
| **Overlays**     | `Dialog` (sizes; bottom sheet < 640 px; `dismissible`), `ConfirmDialog` (`intent`, `consequences[]`, `typedConfirmation`, inline errors), `Drawer` (routed), `OneTimeSecretPanel`, `Tooltip`, `Popover`                                                                                                                                                                                                                                                                                                                        | UI-9, 10; LIC-2; DEV-2; EMR-3                           |
| **Feedback**     | sonner toasts (persistent errors, undo, dedupe), `Callout` (info/success/warning/danger/**signed**), `PageSkeleton` + live region, `EmptyState` (first-run with the **stationary star**, no-results, service-off, not-found), `ErrorState` + `errorCopy`                                                                                                                                                                                                                                                                       | UI-11, 13, 14; EMR-2                                    |
| **Data display** | `DataTable` (sort, search, facets, column visibility, selection + bulk, client/cursor/offset pagination, virtualization, sticky axes, mobile cards, URL state), `FilterBar`, `DescriptionList`, `StatusPill` (+ central `lib/status.ts` vocabulary), `SignedBadge` (gold), `ServiceBadge`/`ServiceGlyph`, `SourceBadge`, `CodeBlock`, `JsonViewer`, `DiffViewer` (structured + text), `KeyDisplay`, `Hash`, `IdChip`, `Timestamp`, `Duration`, `Version`, `EntityLink`, `Timeline`, `Grid` (ARIA grid for matrices), `Stepper` | UI-4, 12, 15; MTX-1, 3, 4; CMP-2; ACT-2, 4; DEV-1       |
| **Charts**       | `StatTile`, `Sparkline`, `Meter`, `Funnel`, `BarList`; each with "Show as table"                                                                                                                                                                                                                                                                                                                                                                                                                                               | DSH-1; UHL-1, 5; DEV-4                                  |
| **Hooks**        | `useMe`, `useProducts`, `useProduct`, `queries.ts`, `mutations.ts` (declared invalidation), `useTableUrlState`, `useSearchParam`, `useAttention`, `useShortcut`                                                                                                                                                                                                                                                                                                                                                                | SH-1, 16; CC-1 to CC-4                                  |

**A dev-only gallery.** `#/__kit` (compiled only when `import.meta.env.DEV`) renders every
component in every state in both themes and every section accent. It is the review surface for
chunk 3. It is cheaper than Storybook, and needs no new tooling.

---

## 5. Interaction and content conventions

### 5.1 Action placement

| Action kind                      | Where                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The one primary action of a page | `PageHeader` primary (right on desktop; full-width under the title on phones)                                                          |
| Create in a collection           | `PageHeader` primary ("New tier", "Create license"); also `n`                                                                          |
| Page-level secondary actions     | `PageHeader` secondary (≤ 2 visible), the rest in "More actions"                                                                       |
| Row actions                      | a trailing `ActionMenu` per row; the single most common action may be an inline ghost button (for example, "Disconnect" in the portal) |
| Bulk actions                     | the bulk bar that replaces the FilterBar while rows are selected                                                                       |
| Form save                        | `SaveBar` (sticky) for T4 and T7; dialog footer for dialog forms. **Never** a Save button at the bottom of a long card (SVC-3)         |
| Destructive actions              | last in overflow menus after a separator; in T4 pages, in the Danger zone section                                                      |
| Matrix actions                   | only in the cell drawer, never in cells                                                                                                |
| "Set this elsewhere"             | always a link or button to that place, never prose ("Platform → Services"; fixes SET-3, FPP-2, DOV-4)                                  |

### 5.2 Destructive-action policy

Four levels. Every action in the console is assigned one in `lib/actions.ts`, and a test asserts the
assignment.

| Level                          | Meaning                                              | Confirmation                                                     | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **L0 · reversible, local**     | No effect outside the console, or trivially undone   | none; toast with **Undo** where an inverse exists                | dismiss an attention item, save viewer preferences, clear filters, narrow a product's Polaris Key audience to the people who can add it, save Polaris Key group labels (PS-06)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **L1 · reversible, impactful** | Changes what devices or customers see, can be undone | `ConfirmDialog intent="caution"` with a `consequences` list      | prepare signing key, activate signing key (after its trust window), disable license, pause rollout, resume, unpin, mark or clear critical, set minimum supported, promote, pin, revert to manifest, disable a service, resync from repo, mark Sentry candidate dismissed, set rollout percentage, assign or release a store app (Platform → Store connections); on the App Store page and Commerce (A-17g): create or reuse an App Store version, add a build to TestFlight groups, cancel a review submission, create an In-App Purchase, set its first price, and every other Distribute step that a later step or App Store Connect can change, undo a licence relink on Users (I-12, within 72 hours), turn a product's manifest-authoritative mode on or off (ST-20), change how Polaris Key lists a product or turn a way to add it on or off (PS-06)                                                                                                                                                                                                                                                                                                                                                              |
| **L2 · irreversible or broad** | Cannot be undone, or affects many devices            | `ConfirmDialog intent="danger"`; confirm button repeats the verb | revoke license key, deauthorize device, confirm Sentry candidate (halts the rollout), yank release, halt rollout, complete rollout, revoke edge-mint approval, delete tier, delete profile, delete outlet credential, revoke CI token, retire signing key, override readiness, publish a catalog that removes keys (with an acknowledgement checkbox listing referencing profiles), answer a build's export compliance (A-17g: it cannot be changed through the API afterwards), detach or relink a user's licence on Users (I-12; a relink also needs a fresh sign-in and a reason), make a break-glass claim on a manifest-authoritative product (ST-20; a reason, at most 7 days)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **L3 · catastrophic**          | Destroys a product, an account or the trust root     | `ConfirmDialog intent="danger"` with **`typedConfirmation`**     | delete product (type the slug; this is the value sent as `confirmSlug`, fixing PRD-4), revoke a signing key (type the kid), break-glass activate (type the kid), re-seal KEK sweep on Platform (type "reseal"), delete portal account (customer types `delete`), release a held App Store version (type the app's name as App Store Connect shows it, sent as `confirm`; A-17a), complete an App Store phased release and change an In-App Purchase's availability (the same typed app name; owner decisions, 2026-10-04), submit an App Store version for App Review and change an existing In-App Purchase price (the same typed app name; notes/S-14 §7.1, A-17g), delete a license (type `delete <id>`; a bulk deletion types `delete <n> licenses`; owner request, 2026-10-05), delete a user's data of this product on Users (type `delete`; I-12), show a product on Polaris Key to everyone signed in (type the slug; notes/S-21 owner decision 5, PS-06), **Reassign…** and **Make floating…** on a licence record (I-12's relink tool with a step-up, a reason and the 72-hour undo; type the licence's name, else its id; S-24 D20, LX-30), **Disable unused keys…** on a batch (type the batch label; LX-30) |

**Rules.**

- The confirm button names the action ("Yank 2.4.0"), never "Confirm".
- Consequences are a list of concrete effects, in the docs' voice.
- A confirm dialog **stays open on error** and shows the mapped error inline.
- **Visual weight follows severity:**
  - Yank is `danger` and Unyank is `outline` (fixes REL-5).
  - Pause is `caution` and Halt is `danger` (fixes MTX-10).
  - "Mark critical" is `caution`, not destructive (PAD-5).
- One-time secrets use `OneTimeSecretPanel` (§4.4 of components), never a plain dialog.

### 5.3 Optimistic vs confirmed updates

- **Confirmed by default.** Every server write shows a pending state (button `loading`, row-level
  pending marker) and updates the UI only from the server response, followed by declared
  invalidation. The data is security state (licenses, keys, rollouts, signing) where a lie, however
  brief, is worse than 150 ms of latency.
- **Optimistic only for viewer preferences:** theme, density, column visibility, sidebar
  collapse, recent products. These are local.
- **Long operations** (resync, readiness refresh, KEK re-seal): the button shows progress; on
  completion a result **panel**, not just a toast, lists what changed (`ResyncResult.updated[]`,
  `refused`, `packSets`; fixes RSY-3).

### 5.4 Mutation → invalidation table

Declared in `mutations.ts`. A unit test enumerates every mutation and fails if one lacks an entry.

| Mutation                                              | Invalidates                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| product create / delete                               | `me`, `products`                                                                                                                                                               |
| product update                                        | `products`, `product(slug)`                                                                                                                                                    |
| services update / revert                              | `product(slug)`, `services(slug)`, plus every query of a section whose enablement changed                                                                                      |
| resync from repo                                      | everything under `product(slug)`: catalog, profiles, tiers, services, release._, update._, distribution.access, identity                                                       |
| channel policy (promote/pin/…/floor), yank, unyank    | `release.releases`, `release.channels`, `release.health`, `release.deliverables`, `release.compat.*`, `release.packReleases.*`, `distribution.matrix.*`                        |
| rollout start / set / verb                            | `distribution.matrix.*`, `distribution.rollouts`, `distribution.health`, `release.compat.*` (liveness overlay)                                                                 |
| readiness refresh / override / clear                  | `distribution.readiness`, `distribution.matrix.*`, `release.compat.*`                                                                                                          |
| Sentry confirm / dismiss, auto-halt settings          | `distribution.health`, and on confirm also `distribution.rollouts` and `distribution.matrix.*`                                                                                 |
| delivery access save / revert                         | `distribution.access`, `release.deliverables`                                                                                                                                  |
| outlet capabilities narrow / revert (chunk 9)         | `distribution.outlets`                                                                                                                                                         |
| distribution key put / delete (chunk 9)               | `distribution.keys`                                                                                                                                                            |
| store connector control (chunk 9)                     | `distribution.connectors`, plus everything "rollout start / set / verb" invalidates                                                                                            |
| catalog publish                                       | `config.catalog`, `config.profiles.*`, every `license(id)` (overrides re-validate)                                                                                             |
| profile payload / create / delete                     | `config.profiles`, `config.profile(id)`, `license.licenses` (on delete)                                                                                                        |
| tier create / patch / delete                          | `license.tiers`, `license.licenses`                                                                                                                                            |
| license create / patch / enable / disable / overrides | `license.licenses`, `license(id)`, `core.devices.summary`, `license.batches` (a batch counts its licences' states)                                                             |
| batch Disable unused keys (LX-30)                     | as a license disable                                                                                                                                                           |
| Make floating / Reassign / relink undo (I-12, LX-30)  | `core.users`, `license.licenses` (with each record's holder moves), `core.devices`, `core.activity`                                                                            |
| key mint / revoke                                     | `license(id)`, `license.licenses` (the list shows key counts)                                                                                                                  |
| device deauthorize / reset                            | `core.devices.*`, `core.device(id)`, `license(id)` and `license.licenses` (device counts); from the product Devices page, which does not know the license, every `license(id)` |
| secret set                                            | `product(slug)` (setup), `secrets(slug)` (A-5)                                                                                                                                 |
| signing prepare / activate / retire / revoke          | `product(slug)`, `keys(slug)` (A-4)                                                                                                                                            |
| edge-mint approve / revoke                            | `config.mint`, `product(slug)`                                                                                                                                                 |
| outlet credential put / delete                        | `distribution.credentials`, `distribution.health` (Sentry configured)                                                                                                          |
| portal settings                                       | `identity.portal`, `distribution.storefronts.polaris-key` (PS-06: the listing state lives in that row)                                                                         |

### 5.5 Keyboard

| Keys                                      | Action                                                                                                | Scope     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------- |
| `⌘K` / `Ctrl+K`, `/`                      | Command palette (`/` focuses the page search when the page has one)                                   | global    |
| `?`                                       | Shortcut sheet                                                                                        | global    |
| `g h` · `g p`                             | Home · product switcher                                                                               | global    |
| `g o` `g l` `g c` `g r` `g m` `g a` `g s` | Overview · Licenses · Catalog · Releases · Matrix · Activity · Settings (when the section is enabled) | product   |
| `n`                                       | The page's create action                                                                              | T2        |
| `j` / `k`, `Enter`, `x`                   | Move row focus, open, toggle selection                                                                | T2 tables |
| arrows, `Home`/`End`, `Enter`             | Move, row ends, open drawer                                                                           | T5 grids  |
| `⌘S` / `Ctrl+S`                           | Save (SaveBar)                                                                                        | T4, T7    |
| `Esc`                                     | Close the topmost overlay; on the SaveBar, discard (with confirm)                                     | global    |
| `⌘\` / `Ctrl+\`                           | Collapse or expand the sidebar                                                                        | global    |

**Rules.**

- Shortcuts never fire in text inputs or editors.
- Every shortcut is listed in the sheet and shown as a `Kbd` hint in menus and palette rows.
- No single-key shortcut performs a write.

### 5.6 Focus management

- **On route change:** focus moves to the page `<h1>` (`tabIndex=-1`) and a polite live region
  announces "{title}, page loaded". Skip link first.
- **Dialogs and drawers:** focus goes to the first field (forms) or the least destructive
  button (confirms); a trap; Escape closes unless busy; focus returns to the invoker or, if the
  invoker is gone (a deleted row), to the collection's heading.
- **After a create:** focus goes to the new record's heading (navigated) or to the new row (drawer
  create), which is highlighted for 2 s (`bg-accent-subtle`).
- **After a failed submit:** focus goes to the first invalid field, and the SaveBar summary links to
  each error.
- **Grids:** roving tabindex. Leaving the grid and returning restores the last cell.

### 5.7 URL state

**Belongs in the URL:**

- page, tab, entity id, open entity drawer;
- filters, search, sort, cursor and offset;
- matrix deliverable, view and limit;
- time windows;
- simulator inputs;
- wizard step.

**Does not belong in the URL:**

- secrets and draft values, which go to `sessionStorage` (wizard drafts, never secret values);
- viewer preferences (`localStorage`).

Query keys are short, stable and documented in `routes.ts` beside each page:

| Key                                     | Meaning                          |
| --------------------------------------- | -------------------------------- |
| `q`                                     | search                           |
| `sort`                                  | sort (`-` prefix for descending) |
| `status`, `tier`, `platform`            | facets (comma-separated multi)   |
| `cursor` / `offset`                     | pagination                       |
| `view`, `deliverable`, `window`, `cell` | page state                       |

### 5.8 Copy

- **Voice:** the docs'. Declarative, precise, second person when instructing. It explains the why
  and names the consequence, and is candid about limits ("Store rollouts are read-only here; App
  Store Connect owns them."). No exclamation marks, no "Oops", no emoji.
- **Sentence case** everywhere: titles, buttons, labels, menu items.
- **Product names over slugs** in prose ("DJDL"); the slug appears as mono metadata.
- **Canonical verbs.** One per action, matching the docs:

  | Use                                                                                  | Not                                                   |
  | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
  | **Resync from repo**                                                                 | Re-sync, Resync from GitHub, Re-sync from linked repo |
  | **Delete product** (and toast "Product deleted"; the docs explain it is a tombstone) | Disable product, Tombstone                            |
  | **Prepare signing key**, **Activate**, **Retire**, **Revoke**                        | Rotate                                                |
  | **Mint key** (license keys), **Mint offline bundle**                                 | Create key                                            |
  | **Revoke** (keys, CI tokens, edge-mint approvals)                                    | Delete (for those)                                    |
  | **Yank** / **Unyank** (releases)                                                     | Revoke (for releases)                                 |
  | **Deauthorize** (console) / **Disconnect** (portal, customer-facing)                 | Remove device                                         |
  | **Revert to manifest**                                                               | Reset, Hand back                                      |
  | **Publish version 8** (catalog)                                                      | Save catalog                                          |

- **Glossary fixes.** "device" not "machine"; "outlet" not "store surface"; "kind" not "type" for
  config/secret/flag; "Enrollment" (keyless) vs "activation" (key).
- **Every raw enum gets a label** via `lib/status.ts` or `lib/labels.ts`. Examples:
  `requires-license` → "License required"; `manual`/`oidc` → "Manual" / "Single sign-on";
  `github` → "GitHub"; `null` → "None" (SVC-5, LIC-8, OVR-5).
- **Empty-state copy** says what the thing is, why you'd want one, and the action. For example:
  "Tiers are reusable license templates: a profile plus policy defaults. Create one to stop
  repeating policy on every license."

### 5.9 Formats and error messages

**Dates and times** (`lib/format.ts`, the one formatter, replacing 5):

| Context                 | Format                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Tables                  | relative under 7 days ("3 h ago"), else date ("3 Sep 2026"); the absolute instant in a tooltip and an sr-only span |
| Detail pages            | "3 Sep 2026, 14:05 CEST · 3 h ago" (the zone always shown)                                                         |
| Calendar dates (expiry) | `DateInput` semantics: the operator's local day, end of day; displayed with the zone                               |
| Exports and copy        | ISO 8601 UTC                                                                                                       |
| Locale                  | `Intl` with the browser locale; 24 h or 12 h per locale                                                            |

**Numbers.**

- `Intl.NumberFormat`, tabular figures in tables.
- Basis points render as percent with up to 2 decimals ("12.5 %"). Rates use 1 decimal.
- Bytes use decimal units ("12.4 MB"), matching store consoles. Counts get separators.

**Versions and ids.**

- Versions and ids are mono.
- Long hashes use `Hash` (first 6 … last 4, plus copy).

**Error messages.** `errorCopy(error, context)` reads `ApiError {status, code, reason, errors,
fields}` (`api.ts:1586`) and returns `{title, description, action}`:

| Status / code                                           | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Description / action                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 401 `unauthorized`                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Session-expired page (T8), drafts stashed                                                       |
| 403 `forbidden` "csrf"                                  | "Your session token is out of date"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Auto-refetch `/me` once and retry the mutation once; on failure: "Reload the page."             |
| 403 `forbidden`                                         | "You can't do that"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Server message                                                                                  |
| 404 `not_found`                                         | "{Thing} not found"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Context names the thing; a link to its collection                                               |
| 409 `bad_request` + `references`                        | "{Thing} is still in use"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Lists the references as links ("Used by 3 licenses")                                            |
| 409 (catalog, A-6)                                      | "The catalog changed since you started"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Review / Discard                                                                                |
| 422 `bad_request` + `fields`                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Inline on the fields; the SaveBar summary "Fix 2 fields"                                        |
| 422 + `errors[]` (service coherence)                    | "These services depend on each other"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | One line per code via `SERVICE_ERROR_MESSAGES`, each with a fix action ("Enable Release too")   |
| 4xx + `reason` (release policy)                         | per `RELEASE_POLICY_ERROR_MESSAGES` (12 today)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | extended to all 18 release reasons                                                              |
| 4xx + `reason` (distribution)                           | new `DISTRIBUTION_ERROR_MESSAGES` for `rollout_mirrored`, `invalid_transition`, `stale_release`, `release_yanked`, `no_rollout`, `no_override`, `candidate_closed`, the App Store Connect reasons (`credential_pin_missing`, `credential_pin_mismatch`, `not_configured`, `store_refused`, `unknown_version`, `no_phased_release`, `not_held`, `unknown_beta_group`, `no_webhook_secret`, `confirmation_required`, `confirmation_mismatch`; A-17g's Distribute and App Store products: `idempotency_key_required`, `idempotency_conflict`, `unknown_build`, `build_expired`, `build_not_ready`, `already_answered`, `version_not_editable`, `no_build`, `unknown_submission`, `not_cancelable`, `unmapped_product`, `iap_missing`, `iap_type_mismatch`, `unknown_price_point`, `iap_not_ready`, `first_iap_portal`, `unknown_iap_version`, `unknown_background_asset_version`, `background_asset_not_ready`, `write_denied`), `unknown_track` | e.g. `stale_release`: "Someone changed this rollout. The matrix has been refreshed; try again." |
| 429 `rate_limited`                                      | "Too many requests"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | "Wait a moment and try again."                                                                  |
| 413, 400 `invalid_json`                                 | "The request was too large / malformed"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | a client bug; "Copy details"                                                                    |
| 503 (KEK)                                               | "The platform keyring is unavailable"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | links to Platform                                                                               |
| 500 `catalog_unavailable`, `document_not_representable` | specific titles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | "Copy details"                                                                                  |
| network failure                                         | "Can't reach Polaris Key"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Retry; nothing changed                                                                          |
| unknown                                                 | "The server refused this ({status} {code})"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | "Copy details"                                                                                  |

**API-side fix.** `W/services/distribution/admin.ts:296,649` and `updateHealthAdmin.ts:99` flatten
`reason` on 404. Chunk 9 restores it; this is a narrative-only admin change (**A-9**).

### 5.10 Permissions and read-only states

There is one privilege level today: platform admin (`W/admin/authz.ts:1-13`). The UI is
nonetheless built so a read-only role becomes a gate change, not a redesign:

- **`useCan(action)`** returns `true` for every action today. Every write control reads it. When
  it returns false, the control renders `disabledReason="Read-only session"`, and SaveBars and
  danger zones collapse to a single "Read-only" notice.
- **State-based read-only** states are rendered the same way, with specific reasons:

  | State                | Reason shown                                                            |
  | -------------------- | ----------------------------------------------------------------------- |
  | Mirrored rollout     | "App Store Connect owns this rollout."                                  |
  | Manifest-owned block | editable; editing claims it, which the SourceBadge popover explains     |
  | Active signing key   | "Retire is unavailable for the active key. Activate another key first." |
  | Not repo-linked      | "This product isn't linked to a repository."                            |
  | Service off          | the section is hidden; a deep link renders the service-off page         |

- **Hidden vs disabled.** Hide what cannot apply to this product (a service it does not run).
  Disable, with a reason, what applies but is not possible right now.

### 5.11 Pills mean attention

A pill (a filled, rounded status shape) is the console's "look here". So (owner, 2026-10-04):

- **Only an issue, or a neutral fact, is a pill.** "Needs setup", "1 needs attention", "Halted",
  "Expires in 3 days" are pills; so are neutral facts a reader scans for, such as "Schema v8" or
  "Not bound".
- **A healthy state is never a pill.** On a card or a page title it is simply absent: a healthy
  product card on Home shows no "Setup complete", and its service glyphs take that row; a
  finished Overview checklist is reopened from the header's "Setup checklist" action, not a chip.
  Where the state is the value a row or column exists to show ("Enabled", "Active", "Answering"),
  `StatusPill` draws `success` as quiet status text: the icon and the word in the success colour,
  with no frame.
- **Pills sit at the right edge.** In a card header (`data-card-header`: a `Panel`, an Overview
  tile, a Home product card) the pill ends the row, with only controls after it; in a table the
  pill column is the last column, aligned to the end.
- The layout lint enforces the placement (`right-align/pill-right`); `StatusPill` enforces the
  healthy-state rule for every caller.

### 5.12 Motion

The console uses the one motion system of [notes/S-23](../research/2026-09-29-godot-omniplatform/notes/S-23-motion-system.md) (shared with the portal, the
sign-in card and the UI kits; EXPERIENCE §7.2 maps it onto the journeys). Phase MO builds it:
MO-02 (the layer: `src/ui/motion/`, `src/motion.css`), MO-04 (navigation), MO-08 (overlays and
controls), MO-09 (data surfaces), MO-10 (shell), MO-11 (moments and counters).

| Template or element      | Motion                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell (top bar, sidebar) | never moves during navigation; the phone nav drawer slides from its edge                                                                                                           |
| Route change             | sibling pages fade through (`route`); T2 → T3 drill-downs slide forward, Back slides back (`forward` / `back`, by route depth); the record key flies into the header               |
| T3 Record tabs           | the indicator morphs, the panel fades through (`tab`)                                                                                                                              |
| T2 Collection            | filters, sorts, creates and deletes move rows (`list`, at most 30 named rows, then only rows on screen); new rows are tinted, then fade; chips pop; the bulk bar enters and leaves |
| T1 Overview, Home        | tiles and the attention list stagger on first load; headline numbers count up; meters fill; §0.7 moments celebrate once per product                                                |
| Dialogs, drawers, menus  | enter and exit from the tokens; drawers slide from the edge; phone dialogs rise as sheets; popovers come from their side                                                           |
| Loading                  | `PageSkeleton` / `Skeleton` with a 150 ms grace and a sheen; never a spinner or "Loading…" for content                                                                             |
| Status                   | pill colours ease and the word pops; the word always carries the meaning                                                                                                           |
| Controls                 | buttons, chips and tiles press (0.98); hover colours at `micro`; focus rings never animate                                                                                         |

**Rules.** Optimistic updates (§5.3) apply the new state first and animate it; a rollback is an
instant swap plus the inline error, never a shake. Only `transform` and `opacity` animate, except
the expand region, small colour changes and SVG strokes. A transition that blocks input lasts at
most `slow` plus `micro`. Typing never animates results (the palette, search-as-you-type tables).
Under reduced motion (OS or the MO-12 preference) every change is an instant swap. Motion values
reach the DOM only as stylesheet rules, data attributes and CSSOM properties set by the layer, so
the CSP (`adminCspParity`, `e2e/csp.e2e.test.ts`) does not change. Every e2e suite runs with
reduced motion; `e2e/motion.e2e.test.ts` runs with it on (MO-03).

---

## 6. Redesigns of the key areas

The wireframes are low fidelity. Glyph legend:

| Glyph       | Meaning                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| `◆`         | gold / signed                                                                          |
| `★`         | Star Cut                                                                               |
| `●`         | success / live                                                                         |
| `◐`         | in progress                                                                            |
| `▲`         | warning                                                                                |
| `✕`         | danger                                                                                 |
| `○`         | neutral                                                                                |
| `⧉`         | copy                                                                                   |
| `⋯`         | menu                                                                                   |
| `▾`         | select                                                                                 |
| `◇ ◈ ▣ ★ ◉` | service glyphs: License, Config, Release, Distribution and Update (Star Cut), Identity |
| `⊙`         | pinned                                                                                 |
| `⊘`         | revoked                                                                                |
| `◯`         | current set member                                                                     |
| `⟳`         | rolling out                                                                            |
| `✎`         | changed in the draft                                                                   |
| `ⓘ`         | opens an explanatory popover                                                           |
| `↗`         | external link                                                                          |
| `☐` `☑`     | checkbox                                                                               |

### 6.1 Console home

**Purpose.** "What needs me across all products?" Fixes DSH-1 to DSH-7 (and relies on chunk 2's SH-1 fix).

**Data.** `useProducts`, and no read of its own per card. `GET /products` carries every product's
setup, onboarding, services, signing and logo (`presentation.icon`: the hosted icon as image-host
URLs). Since the owner polish of 2026-10-07 the cards show no per-service facts, so Home no longer
reads `GET /summary` (**A-8**: one fact per service for every product, in four grouped queries);
the route and `useSummary` stay for A-8's fleet facts.

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [K◆] Polaris Key        [ Search or jump to…            ⌘K ]          Docs   ◐   (AL) │
├───────────┬───────────────────────────────────────────────────────────────────────────┤
│ ⌂ Home    │ Home                                                    [ + New product ] │
│ ▦ Products│ 4 products · session ends 18:40                                           │
│ ⊡ Platform│                                                                           │
│           │ Needs attention                                                     5     │
│           │ ┌───────────────────────────────────────────────────────────────────────┐ │
│           │ │ ✕ DJDL     Edge-mint recipe "studio" changed since approval  [Review →]│ │
│           │ │ ▲ DJDL     2 releases held by readiness on App Store       [Open matrix]│ │
│           │ │ ▲ Diceroll  Missing secret OIDC_CLIENT_SECRET               [Set secret]│ │
│           │ │ ▲ Diceroll  Staged signing key ready to activate            [Review →] │ │
│           │ │ ○ Atlas    No catalog published yet                         [Publish →]│ │
│           │ └───────────────────────────────────────────────────────────────────────┘ │
│           │                                                                           │
│           │ Recent products                                     [ All products → ]    │
│           │ ┌────────────────────────────────┐ ┌────────────────────────────────┐     │
│           │ │ [logo] DJDL  ▲ 2 need attention│ │  [D]  Diceroll                 │     │
│           │ │        djdl                    │ │       diceroll                 │     │
│           │ │ ────────────────────────────── │ │ ────────────────────────────── │     │
│           │ │ ◇ ◈ ▣ ★ ⟳ ◉ ☁                  │ │ ◇ ◈ ▣                          │     │
│           │ └────────────────────────────────┘ └────────────────────────────────┘     │
│           │                                                                           │
│           │ Recent activity (all products, A-2b)               [View activity →]     │
│           │  · 14:02  Ada  published catalog v8            DJDL                       │
│           │  · 13:40  CI   rollout 2.4.0 → 25 % on App Store DJDL                     │
└───────────┴───────────────────────────────────────────────────────────────────────────┘
```

- **Recent products.** Home shows the **six most recently changed** products. **All products**
  opens the Products table, which keeps search, the facets and the sort (EXPERIENCE C17); Home has
  no filter or sort of its own.
- **Product cards** (owner request 2026-10-06; the directions are in
  [console-product-card](console-product-card/README.md). **Owner polish 2026-10-07:** the
  ledger of direction B is replaced by this simpler card):
  - **The name is the card's one link to the product.** Its hit area stretches over the card
    (`::after`), so a click anywhere opens Overview (DSH-3). Focus on it rings the whole card
    (`has-[a[data-card-link]:focus-visible]`).
  - **Header:** the product's logo, its name (up to two lines) and its slug. The logo is the
    hosted `presentation.icon` copy, else the `listing.icon` copy, as the 64 and 128 px variants.
    With no copy, or when it fails to load, the logo is a neutral monogram tile, with no spinner.
    When the product needs something, one pill ends the header: the issue named, or "N need
    attention" (the Needs attention list above names each). Healthy draws nothing (§5.11).
  - **Services:** one row of icons, one per service the product runs, in the service table's
    order, each named (`aria-label` and `title`) and linking to its service's page as a sibling
    above the name's stretched hit area. No per-service facts, no rows, no footer; the row is
    pinned to the card's bottom, so the cards in a row share one bottom edge.
  - **Phones** (below `sm`): the card is one line, the name and one pip per service in that
    service's accent (`data-service` scoping, the brand tokens), the pips named together as one
    image ("Runs License, Config and Release"). The logo, slug, pill and icon row step aside.

- **Figures:** Products, Need attention and Linked to a repository. There is no "Setup complete"
  figure: healthy is silence (EXPERIENCE C2). Below 1280 px an odd last tile spans its row, so none
  is left alone beside empty space.
- **Attention items** are typed (`AttentionItem {product, severity, kind, target, action}`). The
  kinds:

  | Kind                                 | Source                                   |
  | ------------------------------------ | ---------------------------------------- |
  | `secret.missing`                     | `setup.secrets`                          |
  | `catalog.none`                       | catalog 404                              |
  | `signing.staged`                     | A-4                                      |
  | `mint.pending`, `mint.changed`       | `config/mint`                            |
  | `readiness.held`                     | `distribution/readiness`                 |
  | `rollout.halted`, `sentry.candidate` | `distribution/update-health`             |
  | `license.expiring`                   | licenses with `expiresAt` within 14 days |
  | `onboarding.next`                    | `onboarding.nextActions`                 |
  | `release.health`                     | `release/health` (when not healthy)      |

- **First run (zero products).** The stationary star empty state: "Register your first product.
  Link a GitHub repository with a `.pkey/` directory, or start manually." Actions: **Link a
  repository** and **Start manually**, both opening the T6 wizard with the source preselected
  (DSH-6).
- **Recent activity across products** needs **A-2b** (a platform-wide feed). Without it, this panel
  is omitted, not faked.

### 6.2 Product overview

**Purpose.** "Is this product healthy, and what is it running?" Fixes OVR-1 to OVR-8.

```
┌ Breadcrumbs: Products / DJDL ─────────────────────────────────────────────────────────┐
│ H1 DJDL   djdl ⧉   [Linked to vladzaharia/djdl]          [ Create license ] [⋯]       │
│ Runs 6 services · last resync 2 h ago · created 12 Mar 2026                           │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Needs attention (3)   ✕ Edge-mint "studio" changed since approval        [Review →]   │
│                       ▲ 2 releases held on App Store                     [Matrix →]   │
│                       ▲ 3 licenses expire within 14 days                 [View →]     │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ ◇ License ───────────┐┌ ◈ Config ────────────┐┌ ▣ Release ───────────┐             │
│ │ 1,284 active         ││ Catalog v8 · 42 keys ││ 2.4.0 latest         │             │
│ │ 3 expiring · 12 dis. ││ 6 profiles           ││ stable → 2.4.0       │             │
│ │ 2,931 devices ▁▂▃▅▆  ││ [From manifest]      ││ ● health ok          │             │
│ │ Licenses →           ││ Catalog →            ││ Releases →           │             │
│ └──────────────────────┘└──────────────────────┘└──────────────────────┘             │
│ ┌ ★ Distribution ──────┐┌ ★ Update ────────────┐┌ ◉ Identity ──────────┐             │
│ │ 1 rollout · 25 %     ││ Feed: licensed       ││ Portal on            │             │
│ │ 2 held · 0 halted    ││ Downloads: entitled  ││ SSO + email link     │             │
│ │ Matrix →             ││ Feed →               ││ Portal →             │             │
│ └──────────────────────┘└──────────────────────┘└──────────────────────┘             │
│ (tiles appear only for enabled services; each tile is its section's accent)           │
├──────────────────────────────────────────────┬────────────────────────────────────────┤
│ Setup (shown until complete) 5 of 7          │ Trust & SDK                       ◆    │
│ ● Signing key active                         │ Signing key  kid pk-2026-03  ◆ Active  │
│ ● Catalog published                          │ Public key   MCowBQYDK2VwAyEA… ⧉       │
│ ▲ Set OIDC_CLIENT_SECRET        [Set →]      │ JWKS         key.plrs.im/djdl/.well… ⧉ │
│ ○ Issue a first license         [Create →]   │ [Keys & secrets →]                     │
│ (each item: icon + text status, never color)│ SDK quick start  [JS ▾] [Swift] [Godot]│
│                                              │ ┌ code ───────────────────────── ⧉ ┐   │
│                                              │ └──────────────────────────────────┘   │
├──────────────────────────────────────────────┴────────────────────────────────────────┤
│ Recent activity                                                    [View activity →]  │
│  ● 14:02 Ada published catalog v8 · ● 13:40 CI set rollout 2.4.0 to 25 % on App Store │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**Rules.**

- **Only enabled services get a tile** (OVR-1). The tile is a `data-service` scope. Its numbers
  come from that service's list queries, loaded per tile.
- **The checklist** derives from `setup` + `onboarding.nextActions` + real state:
  - "Issue a first license" is done when any license exists (OVR-2).
  - No item links to the page itself.
  - The list is not truncated: it shows "Show 3 more" instead of `slice(0,7)`.
  - It hides entirely once complete. A "Setup complete" chip in the header reopens it.
- **Trust & SDK.**
  - Signing material uses gold `SignedBadge` and `KeyDisplay` with copy (OVR-6).
  - The snippet comes from the onboarding data (`configUrl`, `activateUrl`) with tabs per SDK; the
    version is read from the latest release, not hard-coded.
- **The header primary action** depends on what is enabled: "Create license" when License is on;
  else "Publish catalog" when Config is on; else "Enable services".

### 6.3 Releases and packs

#### 6.3.1 Releases (collection)

```
┌ H1 Releases  (48)   Health ● OK · synced 2 h ago [Repo sync ▸]   [ Resync from repo ] ┐
├ [Search version or title…] [Channel ▾] [Status ▾] [Platform ▾] [Yanked ☐]   Columns  ┤
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Version        Channels         Published     Builds        Packs   Signed    ⋯       │
│ 2.4.0 ↗        stable · beta    3 h ago       ⌘ ⊞ L ▢      2 pins  ◆ rk-09   ⋯       │
│ 2.4.0-rc.2     beta             2 d ago       ⌘ ⊞ L         2 pins  ◆ rk-09   ⋯       │
│ ~~2.3.9~~ Yanked  —             9 d ago       ⌘ ⊞           —       ◆ rk-09   ⋯       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Showing 48 · client-side                                                               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Version** links to the release record. ↗ is `sourceUrl` (REL-9).
- **Builds** shows platform glyphs with labels in an sr-only list.
- **Signed** shows the release record's signer in gold. App release records are signed by the CI
  release key (AGENTS.md rule 2).
- **Row menu:** Promote to…, Pin on…, Yank… (danger). Each opens the matching dialog with the
  release preselected.
- **Health pill and "Repo sync ▸"** open a **Repo sync drawer** containing:
  - health checks (GitHub-specific copy only for GitHub-sourced products; REL-9);
  - last sync attempt;
  - lists (no truncation at 12; REL-8);
  - Resync from repo (L1 confirm; result panel).
- **What moves out.** ManifestNote and DistributionCard are deleted. Their facts move to the Repo
  sync drawer and to product Settings respectively (REL-2, REL-3).

#### 6.3.2 Release record

```
┌ Releases / 2.4.0 ──────────────────────────────────────────────────────────────────────┐
│ H1 2.4.0  [● Live on stable]  ◆ Signed by rk-2026-09     [ Promote… ] [⋯ Pin, Yank…]  │
│ "Spring update" · published 3 Oct 2026, 11:02 CEST · seq 412 · GitHub release ↗       │
├ Builds & files · Packs (2) · Channels · Distribution · History ───────────────────────┤
│ Builds & files                                       [Show signatures & checksums ☐] │
│ ┌ macOS · arm64 · dmg · build 412 · min macOS 13 ─────────────────────────────────┐   │
│ │ PolarisApp-2.4.0.dmg   48.2 MB   3f9a1c…8d02 ⧉   R2 · GitHub (synced)  ⓘ        │   │
│ └─────────────────────────────────────────────────────────────────────────────────┘   │
│ ┌ Windows · x64 · msi … ────────────────────────────────────────────────────────────┐ │
```

- **Builds** are cards, not a nested table (RBD-1). Location badges explain themselves in a
  popover. Artifact `access` is shown.
- **The Packs tab** lists pinned pack releases as `EntityLink`s to the pack record
  (RBD-2), with required and delivery flags.
- **The Channels tab** shows where this release is served (per channel, per platform), with the
  promote/pin context.
- **The Distribution tab** is this release's matrix row as a list (outlet → availability, rollout,
  readiness), with a link to the matrix filtered to it.
- **The History tab** is Activity filtered to this release (A-2).

#### 6.3.3 Channels (lane view)

```
┌ H1 Channels   Deliverable [ App ▾ | textures | audio ]          How channels resolve ⓘ ┐
├────────────────────────────────────────────────────────────────────────────────────────┤
│ stable  [Set in console] · last change 2 h ago by Ada                [Promote…] [⋯]   │
│  Pointer  2.4.0 (pinned ⊙)        Includes  —                                         │
│  Serves   macOS 2.4.0 · Windows 2.4.0 · Linux 2.3.9 ▲ no Linux build in 2.4.0         │
│  Policy   Minimum supported 2.0.0 · Critical ○ no · Rollback floor 2.1.0 [Lower…]     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ beta    [From manifest] · includes stable                            [Promote…] [⋯]   │
│  Pointer  newest eligible (2.4.0-rc.2)                                                │
│  …                                                                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ ▲ Stranded floor on "nightly" (channel no longer declared)                 [Clear…]   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **One lane per channel** instead of a 10-column table (CHN-2). Each lane spells out the pointer,
  serves, newest model in words, and links "How channels resolve" to the docs (CHN-4).
- **Platforms with no build** say why ("no Linux build in 2.4.0").
- **Visible actions.** Promote is visible per lane. Pin, Unpin, Set minimum supported, Mark
  critical, Lower or clear floor, and Revert to manifest sit in the lane menu, and each field also
  has an inline edit affordance (CHN-3).
- **The deliverable switcher** covers pack channels (CHN-1). For packs, the policy row includes
  the **pack floor per `contentApi` line**. This needs `contentApi` in `ChannelPolicyBody`, a
  client-only change because the API accepts it.
- **Promote and Pin dialogs** use a release `Combobox` (version, channel, published date; PAD-2).
  Their consequences differ explicitly:
  - "Promote moves the pointer; newer releases still flow if the pointer is unpinned."
  - "Pin freezes the channel at this release."

#### 6.3.4 Deliverables and the pack record

- **Deliverables (T2).** Columns: Deliverable (link; the app row links to Releases; DLV-1), Kind,
  Binding, Latest, Gate, Pinned by. Low-value columns (Type, Required, Baseline, Delivery) default
  to hidden and are available in "Columns" (DLV-2).
  - The gate cell links to **Distribution → Access** with that deliverable selected (DLV-3).
  - A "Not pinned" warning carries its next step ("Pin it from an app release's manifest, or switch
    the binding to `compatible`"; DLV-4).
- **Pack record (T3).**

```
┌ Deliverables / textures ───────────────────────────────────────────────────────────────┐
│ H1 textures  godot.pck · compatible · required          [⋯ Open in Compatibility]      │
│ Gate: entitled "hd-textures" · latest 1.3.0 · 14 releases                              │
├ Releases · Channels · Delivery · Files ───────────────────────────────────────────────┤
│ Current per channel:  stable 1.3.0 (contentApi 3, 4) · beta 1.4.0-rc.1 (contentApi 4)  │
│ Version      Channel  Published  Variants  Signed                Pinned by    ⋯       │
│ 1.3.0        stable   1 d ago    3         ◆ content key ck-07   2.4.0, 2.3.9 ⋯       │
│ ~~1.2.4~~ Yanked                 …                                                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Releases tab.**
  - Signer in gold (PKD-4).
  - Version only, with seq in the tooltip (PKD-5).
  - "Pinned by" are links (PKD-8).
  - Row menu: **Yank…** and **Unyank** (PKD-1). `yankRelease` takes any `releaseId`; chunk 8 adds
    a worker test confirming pack releases are accepted, otherwise this action is deferred and the
    copy changed.
  - Opening a row goes to a drawer with variants as cards (parsed axes shown as `axis: value` chips;
    PKD-6), deltas, and **Files** as a virtualized, searchable, path-tree list (PKD-7).
- **Channels tab.** That pack's lanes (§6.3.3).
- **Delivery tab.** Its gate, editable here and on Access (the same form component).
- **Files tab.** The file browser for a chosen release and variant.

#### 6.3.5 Compatibility matrix and simulator

```
┌ H1 Compatibility   [ Matrix | Simulator ]                     How to read it ↗ ┐
├ Packs [ all ▾ ] · Channel [ any ▾ ] · [Live only ☐] · App releases 1–10 of 48 [‹ ›]   ┤
│ Legend: ● Compatible  ⊙ Pinned  ▲ Held  ✕ Incompatible  ⊘ Revoked  ◯ Current set      │
├────────────────────┬──────────────────────────────┬────────────────────────────────────┤
│                    │ textures                     │ audio                              │
│ App release        │ 1.4.0-rc1  1.3.0◯  ~~1.2.4~~ │ 2.1.0◯   2.0.0                     │
│ 2.4.0 · cAPI 4 ●L  │ ●          ⊙ Cur.  ⊘         │ ● Cur.   ●                          │
│ 2.3.9 · cAPI 3 ●L  │ ✕          ●       ⊘         │ ●        ⊙ Cur.                     │
│ (●L = live on ≥1 outlet; ▲ held on App Store)                                          │
└────────────────────┴──────────────────────────────┴────────────────────────────────────┘
  Cell drawer: state · reason (visible text) · unsatisfied requirements · links:
  [Open pack release] [Open app release] [Simulate this device →]
```

- **The `Grid` primitive** gives sticky axes, keyboard access and full-sentence cell names. The
  reason lives in the drawer, never in a `title` (CMP-2, CMP-7). `current` is a ring plus the word
  "Current"; `yanked` is a strike plus "Yanked", in headers too.
- **Header and errors.** A page header now exists (CMP-1). The error state is `ErrorState` with
  Retry (CMP-3).
- **Paging** is labelled honestly: "App releases 1–10 of 48; pack columns show the releases relevant
  to these". Jump-to-version uses a combobox (CMP-5).
  - The current API pages app and pack releases together. An optional **A-10** `packWindow`
    parameter would decouple them. The UI does not depend on it.
- **The overlay** reads from the shared `distribution.matrix` query, so rollout actions invalidate it
  (CMP-4).
- **"Live" outside the window** reads "Not in the newest 50 releases tracked by Distribution", not
  internals (CMP-6).
- **Simulator (T6, single step):**

```
┌ Inputs ─────────────────────────────────┐ ┌ Result ─────────────────────────────────────┐
│ App release [ 2.3.9  (stable) ▾ ]  ⓘ    │ │ Decision  ▲ Update offered → 2.4.0           │
│ Platform    [ macOS ▾ ]                 │ │ because: newer on stable; not critical       │
│ Outlet      [ direct ▾ ]                │ │ Feed      composable · target 2.4.0 · bucket 37│
│ Channel     [ stable ▾ ]                │ │ Pack set  ps_9f…  ✓ matches reported         │
│ Variant     texture [etc2▾] tier [hd▾]  │ │ ┌ Pack     Binding     Target   Floor  Runs ┐│
│ Device id   [ dev_…            ] ⓘ      │ │ │ textures compatible 1.3.0    1.2.0  ●    ││
│ Reported pack set [ ps_…        ] ⓘ     │ │ │ audio    pinned     2.0.0    —      ●    ││
│ [ Simulate ]                            │ │ └──────────────────────────────────────────┘│
│ (inputs in the URL; sharable)           │ │ Notes · Errors · [Copy result as JSON ⧉]     │
└─────────────────────────────────────────┘ └──────────────────────────────────────────────┘
```

- **Inputs.**
  - App release is a combobox over **all** releases from the releases query, not the matrix page
    (CMP-8).
  - Platforms come from the release's builds, so there is no hard-coded list.
  - Variant is per-axis selects derived from the pack declarations' `variantKeys`, with free text
    as a fallback.
  - `channel` is exposed (CMP-10). Each input has help text (CMP-9).
- **The result** clears and shows a skeleton when inputs change (CMP-9). It renders the full
  response: decision with reason, feed target and bucket, `set[]`, active vs expected per pack,
  gates, floors and revocations (CMP-10).

### 6.4 Distribution matrix

**Purpose.** "Where is each release, and what is it doing there?" Fixes MTX-1 to MTX-10.

```
┌ H1 Matrix  ★                                                       [ Start rollout… ] ┐
│ Releases × outlets for App · halts reach devices via the signed feed ⓘ (server effect)│
├ Deliverable [App ▾] · Channel [any ▾] · View [Availability|Rollouts|Readiness] · 20 ▾ ┤
│ Legend: ● Live  ◐ In review  ○ Not available  ▲ Held  ✕ Rejected/Halted  ⟳ Rolling   │
├──────────────────────┬────────────────┬────────────────┬────────────────┬──────────────┤
│                      │ direct  ⓘ      │ App Store ⓘ    │ Google Play ⓘ  │ AltStore ⓘ   │
│                      │ self-hosted    │ store · mirror │ store · mirror │ self-hosted  │
│ 2.4.0   stable  3 h  │ ● Live         │ ◐ In review    │ ⟳ Live · 25 %  │ ▲ Held       │
│ 2.3.9   stable  9 d  │ ● Live         │ ● Live         │ ● Live         │ ● Live       │
│ 2.4.0-rc.2 beta 2 d  │ ● Live ⟳ 50 %  │ ○ —            │ ○ —            │ ○ —          │
└──────────────────────┴────────────────┴────────────────┴────────────────┴──────────────┘

Cell drawer (2.4.0 × Google Play) ───────────────────────────────────────────────────────
│ Availability  ● Live since 3 Oct 11:40 · per build: arm64 Live (reported by connector) │
│ Submission    Released · submitted 2 Oct 18:00 · reviewed 3 Oct 09:12                 │
│ Readiness     ● Ready                                                                 │
│ Rollouts                                                                              │
│  stable  ⟳ Rolling out  [■■■□□□□□□□] 25 %   mirrored from Google Play                 │
│          Store rollouts are controlled in Google Play; here they are read-only.       │
│          [Open Play controls ▸]   (connector actions when configured)                 │
│ History  ● 13:40 CI set 25 % · ● 11:40 connector reported live                        │
```

**Cell summary by view:**

| View                   | Summary                                                         |
| ---------------------- | --------------------------------------------------------------- |
| Availability (default) | availability glyph and label, plus a rollout % if one is active |
| Rollouts               | the rollout state and %, or "—"                                 |
| Readiness              | Ready / Held (n blockers) / Not ready (MTX-2)                   |

**Cell drawer:**

- **Availability:** per-build records, each with its source and `since` (MTX-3).
- **Submission:** timeline.
- **Readiness:** blockers as `EntityLink`s to pack releases, with **Override…** (L2, reason
  required) and **Clear override**, plus a page-level **Refresh readiness** (all of this API exists
  with no UI today).
- **Rollouts:** per channel, a `Meter` plus the server-allowed verbs only. Disallowed verbs are
  hidden (MTX-1).
  - **Set percentage…** uses `POST …/rollouts/:outlet/:channel {releaseId, bp}` (MTX-5). It opens a
    stepped control (1, 5, 10, 25, 50, 100 % or custom) and states the bucket effect.
  - Mirrored rollouts are read-only with the owning store named.
- **Store connector controls:** App Store Connect phased release pause, resume and complete; Play
  rollout fraction, halt, resume and complete. These live in the drawer under "Store controls", L1
  or L2 by verb, and appear only when the connector is configured (`GET …/connectors`). Completing
  an App Store phased release releases the version to every user, so it is L3: the dialog asks for
  the app's name, sent as `confirm` (owner decision, 2026-10-04).
- **History:** Activity filtered to the rollout target (A-2).

**Other rules:**

- **Start rollout…** (header) is a dialog: deliverable, outlet, channel, release (combobox) and the
  initial % (MTX-5).
- **The deliverable picker** covers packs (MTX-6). Row limit 20 or 50 (the server cap).
- **The server's `effect.note`** is shown once, in the header description with a popover. It is not
  repeated in dialogs (MTX-10). Distribution's hard-coded caveat is deleted (DOV-1).
- **Lookups** are indexed into `Map`s once per response (MTX-8).
- **Mobile.** The grid becomes the release-card list (T5 responsive rule).

**Rollouts page (T2).** Every rollout:

- Columns: deliverable, outlet, channel, release (`Version` link), a `Meter` with %, state, source,
  updated by and when (DOV-3).
- Row menu: the allowed verbs.
- Facets: state and outlet.
- Halted rows sort first.

**Outlets & feeds page (T2 + drawer).**

- Outlets from `GET …/distribution/outlets`: id, kind, transport (supported or not), capabilities
  with **Narrow capabilities…** and **Revert to manifest**.
- A **Feeds** column: for feed-capable outlet kinds (`altstore`, `altstore-pal`, `obtainium`,
  `fdroid-repo`, `direct` for Scoop, `flathub`), the per-channel public feed URLs with copy, derived
  from the documented URL scheme (`D/services/distribution/feeds.md`). The "listed only when"
  rules are shown in a popover.
- **Distribution keys** as a section: `GET/PUT/DELETE …/distribution/keys`, entries and observations
  (dismiss).

**Access page (T4).**

- An app section plus **one section per pack** (UPS-5, DLV-3), each with mode (`RadioCards`: public,
  authenticated, licensed, entitled; descriptions inline) and entitlement (for `entitled`, a catalog
  flag combobox).
- `SourceBadge` and Revert per section. Each section saves on its own (UPS-1).

**Health page (T1).**

- Window `SegmentedControl` (1 h · 6 h · 24 h · 72 h, up to `maxWindowHours`; UHL-2).
- Per rollout, a `Funnel` (offered → downloaded → applied → confirmed, with step conversion), plus
  reverted, pack-failed and boot-rollback as danger bars. "Show as table" on each (UHL-1).
- The auto-halt card shows the **last reading** (UHL-3) and the settings form (`NumberInput percent`
  for rates, nullable, range-validated; UHL-4, UHL-5), with **Reset to defaults** (uses
  `autoHalt.defaults`).
- Trips and alerts as a `Timeline`.
- Sentry candidates with tabs Open / Decided (UHL-7). Confirm is L2, "halts the rollout". The
  "Sentry not configured" state links to Outlet credentials.

**Outlet credentials (T2 + drawer).**

- The table from `outlet-credentials`: id, kind, outlet, pin, created, last used, last result
  (visible text; OUT-6).
- "Set credential" drawer: **Kind first** (OUT-3), then kind-specific fields, then the pin with the
  right `inputMode` per kind (OUT-4).
- **Rotate** is an explicit row action. Reusing an id from the create drawer warns ("A credential
  with this id exists; saving rotates it"; OUT-2).
- Copy covers Sentry (OUT-7).
- Connector cards (App Store Connect, Google Play) from `GET …/connectors`, each with its status and
  its configuration actions: App Store Connect **Release this version**, **TestFlight public link**
  and **Webhook setup**; Google Play **Update priority** and **Settings**. Rollout-shaped
  connector verbs stay in the matrix cell drawer.

**Notes (chunk 9 as built, 2026-10-04).** Where the build differs from the text above:

- **Where things live.** The pages are in `src/console/areas/distribution/` (Matrix with its
  `CellDrawer`, Rollouts, Outlets & feeds, Access, Health, Outlet credentials, the shared
  `RolloutDialogs` and `StoreControls`) and `src/console/areas/update/FeedPage.tsx`; their reads
  are one fetcher per key family in `areas/distribution/data.ts`. The matrix key is
  `qk.matrix(slug, "<deliverable>:<limit>")`; `qk.health(slug, windowHours)` gained the window;
  `qk.outlets`, `qk.distributionKeys` and `qk.connectors` are new, with their writes in
  `mutations.ts` (`setRollout`, the three readiness writes, capability narrow and revert, key put
  and delete, `connectorControl`).
- **No server effect note.** The matrix response carries no `effect` (inventory MTX-10 described
  one that `services/distribution/matrix.ts` does not return), so the header states the effect in
  its own words and links the docs; nothing is repeated in the dialogs. The hard-coded caveat is
  gone with `Distribution.tsx` (DOV-1).
- **No History section yet.** The cell drawer's History needs A-2 (activity filters, chunk 5);
  per T3 it is hidden rather than faked until A-2 lands.
- **Paging.** The matrix API takes a `limit` (20 or 50) and no offset, so there is no
  Newer/Older pager; a full matrix says "Showing the newest N releases" and offers 50.
- **Health defaults to 24 h** and always sends `windowHours`; the auto-halt rates are `percent`
  `NumberInput`s, required and strictly between 0 and 100 % (the server refuses `null`, so they
  are not nullable). The Auto-halt panel shows the last reading's time; the per-rollout reading is
  in each funnel's rates line.
- **Outlet credentials.** Delete stays L2 (§5.2) with the confirm repeating the verb; OUT-7's
  "typed confirmation" is not added. The `asc-webhook-secret` kind offers **Generate the secret**
  (`generate: true`). A 409 `app_assigned_elsewhere` (the platform store connection, A-16) is
  worded in the pin and set forms; the App Store Connect card shows whose key it uses
  (`setup.credentialSource`, `platformSource`) and the connectors section links the store
  connections docs. The platform Store connections page itself is A-16's (the Platform section).
- **Access.** A pack's gate is a catalog-flag `Combobox` while Config is on, a text field
  otherwise; the app's `entitled` describes Release's channel and version window. A pack's gate is
  enforced (P4-05: pack blobs and registry reads require the flag); the app row's `entitlement`
  is stored but never consulted, because app delivery under `entitled` is the window, so it is
  not offered. `?deliverable=<pack>` focuses that
  pack's section (DLV-3).
- **Update → Feed** saves metadata access, the compatibility window and the artifact policy as
  three forms (each its own PATCH with only its fields) and lists the endpoint URLs per channel;
  artifact access is shown read-only with a link to Access.
- **A-9** shipped: the rollout, readiness-override and Sentry-candidate 404s carry `reason`, and
  `DISTRIBUTION_ERROR_MESSAGES` words the five new reasons.
- **Tests.** The admin suite went from 987 to 1037. Dropped with
  their behaviour: `distribution.test.tsx`'s three (the chain card moved to Services, the
  descriptor hooks card is removed, the read-only rollouts list became Rollouts). Rewritten:
  `distributionMatrix` (5 → 15), `updateHealth` → `distributionHealth` (4 → 12), `updateSettings`
  → `updateFeed` (22 → 18; the delivery-access cases moved to `distributionAccess`, 9) and the
  eight outlet-credential cases of `secrets.test.tsx` → `outletCredentials` (16); new
  `distributionRollouts` (8) and `distributionOutlets` (11). `e2e/distribution.e2e.test.ts` opens
  every page, drawer and dialog under the Worker's CSP.

**App Store Distribute and App Store products (A-17g, 2026-10-04).** notes/S-14 §8.2 and §8.3 as
built, on A-17d's and A-17e's connector routes:

- **Distribution → App Store** is a T6 flow with an aside. Steps (`?step=`, with `?build=` and
  `?version=`): Build (polled every 10 s while a build is processing), Export compliance (only
  when unanswered), Release notes (per locale; saved to TestFlight here and to the version's
  What's New in Version), TestFlight (groups, beta review), Version (reuse or create, attach the
  build, release option, phased release), Preflight (deep links for what the API cannot do) and
  Submit (typed). An earlier unfinished step wins over the asked one once Apple's answers are in.
  The aside lists App Store Connect's versions and open review submissions, with **Release…**,
  phased **Pause…**/**Resume…**/**Release to everyone…** and **Cancel submission…**.
- **Distribution → Commerce** holds **App Store products** (T2): each `app-store` mapping beside
  Apple's state, with Create in App Store, Add or edit a locale, Set price (a change is typed and
  carries Apple's irreversibility warning) and Make available everywhere (always typed).
- Every write goes through `AscActionDialog`: one `Idempotency-Key` per opened intent, kept across
  retries in the same dialog, so the Worker's ledger resumes a half-finished step. Typed levels ask
  for the app's name (the console does not know it; the Worker compares). The release-notes and
  IAP-localization seeds are the seams the shared listing model (A-18b) fills.
- The Outlet credentials App Store card links to **Distribute**.

### 6.5 Licenses

#### 6.5.1 Licenses (collection)

```
┌ H1 Licenses (1,296)                                              [ + Create license ] ┐
├ ┌ Active 1,284 ┐ ┌ Expiring ≤14 d 3 ┐ ┌ Expired 9 ┐ ┌ Disabled 12 ┐  ← facet tiles     ┤
├ [Search name, email, id…] [Status ▾] [Tier ▾] [Channel ▾] [Sign-in ▾]  Columns ⤓ CSV  ┤
├────────────────────────────────────────────────────────────────────────────────────────┤
│ ☐ Holder                     Status        Tier       Expires        Seats    Keys  ⋯ │
│ ☐ Studio Pro                 ● Active      Pro        30 Sep 2027    ■■■□□ 3/5  2    ⋯ │
│   ada@example.com                                                                     │
│ ☐ Lab 3                      ▲ Expires 4d  Edu        7 Oct 2026     ■□□□□ 1/5  1    ⋯ │
│ ☐ Old seat                   ○ Expired     —          2 Jan 2026     0/—        1    ⋯ │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 3 selected · [ Disable… ]  [ Export ]  · Clear                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Status.** Computed client-side from `status` + `expiresAt` (LIC-1): Active, Expires in N days
(≤ 14), Expired, Disabled. The **Expires** column is sortable.

**Seats.** A `Meter` of `deviceCount` over the effective device limit ("—" when unlimited),
with its source under it (LX-14a): the licence's own limit, else the tier's, else a `deviceLimit`
entitlement, else the product default, as the Worker reports it (`effectiveDeviceLimit`,
`deviceLimitSource`).

**Other columns.** Channels and Sign-in (Manual, Single sign-on) are hidden by default (LIC-8). The
id moves to the record header.

**Facet tiles** filter the table. They are buttons with `aria-pressed`.

**Scale.**

- The list is unpaged today, so client mode with virtualization, search over name, email and id, and
  CSV export (LIC-7).
- **A-3b** adds server search and a cursor for licenses when products exceed about 5k licenses. The
  table's `pagination.mode` flips to `cursor` with no UI change.

**Bulk.** Disable and Enable (L1, listing the count and the effect) and Export.

**New license** (S-24 §8, replacing the Create license dialog) is a drawer wizard over Licenses
(`?setup=new-license&step=…`, SETUP.md §1.1), five steps, then Done:

1. **Product and tier:** the product as context (a picker only from Home or the palette), tier radio
   cards by rank with each tier's summary, **New tier…**.
2. **Who it's for:** **Someone specific** (Recommended: email required, name optional; "When
   ada@example.com signs in with that email, it's in their library", never saying whether an account
   exists) or **Anyone with the key** (floating; **How many keys**, 1–500, and a **Batch label**).
3. **Limits:** devices (the tier's or set for this licence, LX-14a), expiry, offline days, **More
   options** (channels, version window, profiles in order, LIC-3), and the effective-policy aside
   naming each value's source (LIC-4).
4. **Delivery:** Email the key and show it once (default for someone specific), Email the key, Show
   it once; floating: Show it once or Download a CSV.
5. **Review:** the summary with **Change** per row, the `AutoList` of what Polaris Key will do, and
   an action-named primary ("Create and email license", "Create 50 keys").

**Done** replaces the body: the `OneTimeSecretPanel` with the delivery result, or **Download CSV**
for a batch (the drawer stays open until the keys are downloaded or copied), then Open license,
Open batch, Create another and, for the first licence, Try it.

**Holder column and filters (S-24 §8.8).** The list's Holder cell shows name and email, "Waiting for
ada@…", or **Floating** (muted) with "anyone with the key"; filters **Holder** (Anyone, In an
account, Waiting, Floating) and **Batch**.

**Batches (LX-30).** A product with batches gets a **Batch** column (the label, linking to the
batch) and facet, and **Batches** among the page's secondary actions. Filtered to one batch, the list
says so and links to it. **Batches** (`#/p/<slug>/license/batches`, not in the sidebar) lists them
with used of count; a **batch page** shows its label, created and by whom, the tier, used of count,
unused and disabled, the plain statement "Keys can't be downloaded again" (the Worker kept only
hashes), **Show its licenses**, and **Disable unused keys…** (L3, typed batch label; the Worker
compares). Disable unused keys disables only the batch's active licences no device ever used.

#### 6.5.2 License record

```
┌ Licenses / Studio Pro ─────────────────────────────────────────────────────────────────┐
│ H1 Studio Pro  [● Active]   Expires 30 Sep 2027 (in 361 days)       [ Mint key ] [⋯]  │
│ ada@example.com · lic_01J9… ⧉ · Single sign-on · changed 2 h ago by Ada               │
│ ⋯ = Edit holder… · Device limit… · Mint offline bundle… · View in activity · ─── ·   │
│     Disable license…                                                                   │
├ Overview · Keys (2) · Devices (3/5) · Config overrides · History ─────────────────────┤
│ Terms                                     [From tier "Pro" ⓘ]          (T4 form)      │
│  Tier            [ Pro ▾ ]       ▲ Downgrading to Edu: 3 devices > limit 1, grandfathered│
│  Expires         [ 30 Sep 2027 ]   ends 23:59 CEST                                    │
│  Max offline     [   ] days   Blank uses the tier or product default (30)             │
│  Channels        ☑ stable  ☑ beta  ☐ pr (every PR build)                              │
│  Versions        min [ 2.0.0 ]  max [      ]                                          │
│  Profiles        1 base-pro ↕  2 studio-overrides ↕   [ + Add profile ]               │
│ Effective policy (what devices receive)                                               │
│  Device limit 5 (tier) · offline 30 d (product) · channels stable, beta · ≥ 2.0.0     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ SaveBar: 2 changes · [Discard] [Save terms]                                            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Overview tab.**

- **One "Terms" form** holds every policy field: tier, expiry, max offline, channels, versions and
  **profiles**. This ends the split between the Edit dialog and the Policy tab (LDT-1), and makes
  profiles editable (LDT-3).
- The holder line (S-24): "Ada Lovelace · ada@example.com · In an account", "Waiting for
  ada@example.com", or "Floating · anyone with the key", with the batch it came from. **Assign…** on a
  floating licence (its primary action; an info callout "Not in anyone's account" says what floating
  means, D5); in the overflow **Send a new key…** (assigned), **Reassign…** and, in the danger part,
  **Make floating…** (I-12's relink tool: step-up, reason, notice, 72-hour undo, typed confirmation of
  the licence's name, else its id). Edit holder edits the name only. The newest move shows as a callout
  with **Undo…** while its 72 hours run. Beside the holder line, a licence with no account shows
  "Key entries {used} of {limit}" while Identity is on (PX-W9). **Send a new key…** and Assign's
  **Email them the key** wait for LX-27's `send-key` route (LX-30 shipped without them).
- Cleared values send `null`. This needs **A-3**, the worker accepting `null` for `maxOfflineDays`
  (LDT-2), and the same for tiers (TIR-1).
- The downgrade warning is a `Callout tone="warning"` using the server's `deviceCount` (LDT-12).
  A limit set on the license beats any tier, so a tier change then raises no warning.

**Device limit…** (LX-14a; SIGN-IN.md D-53) opens a side sheet for this one license, seat or
Account-wide: a number field whose placeholder is the inherited value ("Inherits 5 from Pro"),
**Save** and **Use inherited limit** (sends `deviceLimit: null`). Below the active device count it
warns "4 devices are signed in. None is signed out; new devices are refused until the count is
under 3." It never deauthorizes. Precedence: the license's own `device_limit`, else the tier's,
else a `deviceLimit` entitlement (profiles, store grants, overrides), else the product default;
the signed document's `deviceLimit` entitlement carries the same number. The header, the
Effective policy row, the Seats meter and the list show the effective limit with its source
("3 · set on this license", "5 · from Pro", "5 · product default"). Each change is audited as
`license.device_limit.set`, old → new.

**Disable license** is a danger-menu action with an L1 confirm, replacing the Switch (LDT-7).
Enable is the primary action while disabled.

**Keys tab.**

- A table: label, hash (`Hash`, first 6 … last 4; LDT-11), status, created, created by (name
  resolved where the actor is known), last used.
- Revoked keys collapse under "Show 3 revoked".
- Revoke is L2 danger. **Mint key** uses `OneTimeSecretPanel` (LIC-2).

**Devices tab.**

- The shared `DeviceTable` (the same component as Core → Devices, scoped to this license; DEV-8).
- A Seats meter.
- Row actions appear only when valid: Deauthorize only for authorized devices (LDT-10); Reset
  binding only when a fingerprint exists.
- A row opens the shared **device drawer**, which shows hardware facts, probes and fingerprint
  components as visible text (LDT-15, DEV-3).

**Config overrides tab.** The T7 payload editor:

- inherited values with provenance chips ("from profile base-pro", "catalog default");
- a "Changed only" filter;
- review before save.

Each failure state is explicit (LDT-5, LDT-6):

| Failure       | Shows                                                |
| ------------- | ---------------------------------------------------- |
| Config off    | service-off inline                                   |
| Catalog fails | ErrorState                                           |
| Profile fails | warning Callout "Inherited values may be incomplete" |

**History tab.** Activity filtered to `license:<id>` (A-2).

**Offline bundle** (from the menu) is a dialog: request code (32-character validation), grace days,
include config (when Config is on). The result is a `OneTimeSecretPanel` with a reliable download
(LDT-13).

#### 6.5.3 Tiers and Enrollment

**Tiers (T2).**

- Columns: label, id, profile (link; TIR-9), expiry ("365-day term"; TIR-6), device limit, channels,
  versions, **Used by** (count of licenses, computed from the licenses query; TIR-2).
- Rows link to the **tier record (T3)**:
  - an Overview form (nullable numbers; client validation for min ≤ max; TIR-1, TIR-3);
  - a Used by tab (a license table filtered `tier=<id>`).
- Delete is disabled with a reason while used ("Used by 12 licenses") and L2 when unused.
- Create is a drawer with one pane (TIR-8).

**Enrollment (T4).** Sections:

1. **Registration.** A read-out of declared vs enforced, plus **Change in Services** as a button
   (FPP-2).
2. **Fingerprint policy.** A mode `RadioCards` (Off, Lenient, Normal, Strict) replaces the switch
   plus mode (FPP-1). A per-section `SourceBadge`. Revert lists both the fingerprint policy and
   auto-issue (FPP-3).
3. **Probes.** A sortable table, plus "Probes come from `.pkey/product`" and **Resync from repo**
   (FPP-4).

### 6.6 Catalog and config editor

#### 6.6.1 Catalog (read view, T2)

```
┌ H1 Catalog  v8 · 42 keys   [From manifest ⓘ next resync re-applies .pkey/schema]      ┐
│                                              [ Edit catalog ] [⋯ Version history (A-6)]│
├ [Search key, label, description…] [Kind ▾ config/secret/flag] [Category ▾] [State ▾]  ┤
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Key                      Kind     Default        Management   Category   User grant   │
│ network.proxy.url        config   —              Default      Network    —            │
│ license.hd_textures      flag     false          Enforced     Content    ✓            │
│ sentry.dsn               secret   (write-only)   Hidden       Telemetry  —            │
└────────────────────────────────────────────────────────────────────────────────────────┘
  Key drawer: label, description, schema summary, widget/ui, dependsOn/appliesTo,
  "Overridden by": profiles (from cached profile payloads, fetched lazily) and tiers via
  profile; licenses need A-7b, else "License overrides aren't indexed" note.
```

- **A dense table** replaces one card per entry (CAT-7). Search, kind, category and state facets.
- **The header carries ownership** (CAT-3).
- **The first publish works.** With no catalog, the empty state's **Create catalog** opens the editor
  seeded with `{schemaVersion: 1, entries: []}` (CAT-1).
- `ConfigEntry` in `api.ts` is replaced by importing the type from `@polaris-key/catalog`, including
  `dependsOn` and `appliesTo` (CAT-8).

#### 6.6.2 Catalog editor (T7)

```
┌ Catalog / Edit ── H1 Edit catalog  v8 → v9 (draft)  [From manifest ⓘ]                 ┐
├ [Search…] [Kind ▾] [☐ Changed only]  · Mode [ Form | JSON ]      [ + Add entry ]      ┤
├────────────────────────────┬───────────────────────────────────────────────────────────┤
│ Network            3  ✎1   │ network.proxy.url                          [⋯ Remove]    │
│  · network.proxy.url ✎     │ Kind      (•) config ( ) secret ( ) flag                 │
│  · network.timeout         │ Label     [ Proxy URL                    ]               │
│ Content            2       │ Category  [ Network ▾ ]                                  │
│ Telemetry          1  ▲1   │ Schema    type [string ▾] format [uri ▾] (advanced: JSON)│
│  · sentry.dsn ▲            │ Default   [                              ]               │
│                            │ Management default (•) Default ( ) Enforced ( ) Hidden   │
│                            │ User grant ☐   UI: widget [auto ▾] help […] order [ ]    │
├────────────────────────────┴───────────────────────────────────────────────────────────┤
│ +1 key · −0 · ~2 changed · 1 error        [Discard draft]   [ Review changes → ]      │
└────────────────────────────────────────────────────────────────────────────────────────┘

Review drawer ─────────────────────────────────────────────────────────────────────────────
│ Publish version 9                                                                      │
│ ✕ Removed  telemetry.legacy   referenced by profiles: base-pro, studio  ▲ breaking     │
│ + Added    network.timeout    integer · default 30                                     │
│ ~ Changed  network.proxy.url  label "Proxy" → "Proxy URL"                              │
│ ▲ This catalog is manifest-owned: the next Resync from repo re-applies .pkey/schema.   │
│ ☐ I understand removed keys are dropped from 2 profiles' payloads                      │
│ [ Back to editing ]                                          [ Publish version 9 ]     │
```

- **Form mode** (open question **Q5**). A per-entry structured form with the common fields
  (key, kind, label, category, description, schema basics by type, default, management default,
  user grant, UI hints).
  - Schema "advanced" opens a JSON fragment editor validated by `@polaris-key/catalog`, which is the
    same validator the server and SchemaForm use (CAT-5).
- **JSON mode.** CodeMirror with the catalog validator as a linter (line and column), plus Format
  (CAT-4). Switching modes keeps one draft.
- **The draft persists** in `sessionStorage`, so closing never silently loses it (CAT-6). The bumped
  version is in the title (CAT-6).
- **Review** uses the structured `DiffViewer`:
  - Removed keys are cross-checked against cached profile payloads.
  - A breaking removal requires the acknowledgement checkbox (L2).
  - Errors stay inline, with no duplicate toast (CAT-6).
- **Concurrency.** Publish sends `expectedVersion` (**A-6**). A 409 opens "The catalog changed since
  you started" with a diff against the new server version.

#### 6.6.3 Profiles and payload editing

- **Profiles (T2).** Columns: name (link), id, description (wraps to 2 lines with full text in the
  drawer; PRF-7), **Used by** (tiers + licenses, computed from cached queries), last modified. The
  row is the link (PRF-4).
- **Profile record (T3).**
  - Header: **Edit details…** for name and description (**A-7**, a PATCH route; PRF-1) and
    **Delete…** (disabled with "Used by 2 tiers, 5 licenses" while referenced; PRF-2).
  - Tabs: Payload (T7 editor), Used by, History.
  - The id shows once, in the meta line (PRF-3).
  - Back navigation is guarded (PRF-6).
  - Create errors are distinguished: "That id is already in use" vs "Publish a catalog first"
    (PRF-5).
- **The payload editor** (shared by profiles and license overrides) is `ManagedPayloadEditor`
  rebuilt on `useAdminForm`:
  - It re-seeds only when not dirty (MPE-1).
  - Errors count only against changed rows; per-group error counts; jump-to-error (MPE-2).
  - Review drawer with the effective value per key (MPE-3).
  - Value-aware search (MPE-4).
  - The synthetic group is named "More settings" to avoid colliding with a real "Advanced"
    category (MPE-4).

#### 6.6.4 Edge mint (T2)

- **Always present.** The first-run state explains edge-mint recipes and that they are authored in
  `.pkey/release` (EMR-1).
- **Table columns:**
  - recipe id;
  - status (Approved / **Needs approval** / **Changed since approval**, with distinct tone and
    icon; EMR-2);
  - secret usage (link to Keys & secrets);
  - changed fields (visible list);
  - identity trust (shown once, in the page header callout; EMR-4).
- **Approve** is a drawer:
  - the recipe's fields, read-only, in a diff against the last approval;
  - the public-mint acknowledgement checkbox when registration is open;
  - Approve (L1).
  - On a 409 (stale) the drawer stays open with "This recipe changed while you were reviewing" and
    reloads the diff (EMR-3).
- **Revoke approval** is L2.

### 6.7 Keys & secrets

```
┌ H1 Keys & secrets                                                                      ┐
│ Signing keys, write-only product secrets, and CI publishing credentials for DJDL.      │
├ On this page: Signing keys · Secrets · CI publishing ─────────────────────────────────┤
│ ┌ Signing keys ◆ ───────────────────────────────────────── [ Prepare signing key ] ─┐ │
│ │ ◆ pk-2026-03   Active     since 12 Mar 2026   Ed25519   public key MCow…Qa ⧉      │ │
│ │ ◆ pk-2026-10   Staged     activatable in 3 min (after trust refresh)   [Activate…]│ │
│ │ ○ pk-2025-11   Retired    12 Mar 2026                               [⋯ Revoke…]   │ │
│ │ JWKS  https://key.plrs.im/djdl/.well-known/jwks.json ⧉ · Trust set JSON [View]    │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Secrets ───────────────────────────────────────────────────────── [ Set secret ] ─┐ │
│ │ Name                    Usage       Status         Updated      Required by       │ │
│ │ OIDC_CLIENT_SECRET      general     ▲ Missing      —            .pkey/product     │ │
│ │ EDGE_MINT_STUDIO_KEY    edge-mint   ● Configured   3 Sep 2026   recipe "studio"   │ │
│ │ (values are write-only: Polaris Key never returns them)                           │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ CI publishing ────────────────────────────────────────────────────────────────────┐ │
│ │ Trusted publisher  vladzaharia/djdl · workflow release.yml · env production [Edit]│ │
│ │ CI tokens          label · scopes · expires · last used           [ Issue token ] │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Gold = signing.**

- Signing keys carry the `SignedGlyph`. This is the page where gold carries the most meaning.
- The CI release key and delegated content keys are listed read-only with links: "App release
  records are signed by your CI release key; content keys are delegated per pack → Content keys."

**Signing keys.** This needs **A-4** (`GET …/keys`: kid, status, alg, publicKey, createdAt,
activateAfter, retiredAt).

- **The flow:** Prepare (L1) → staged row with a live countdown to `activateAfter` → **Activate**
  (L1; becomes active) → the old key goes to retired → Revoke (L3, type the kid).
- **Break-glass activation** before `activateAfter` is behind a disclosure, L3, and explains the
  trust-cache risk.
- This fixes SET-1 and OVR-3.
- **Without A-4,** the section shows the active key from `product.signing` plus a just-prepared key
  persisted in `sessionStorage` until activated, and says "Staged and retired keys aren't listed yet".

**Secrets.**

- Rows are the union of `setup` required secrets and **A-5** (`GET …/secrets`: names, usage,
  updatedAt, never values). Without A-5, only required secrets are listed (as today), with that
  limit stated (SEC-2).
- **Set secret** is a drawer with name, `SecretInput` and usage.
  - Overwriting a configured secret requires ticking "Replace the existing value" (SEC-3).
  - Required-secret rows have a "Set" row action that preselects the name (SEC-4).

**CI publishing.**

- The trusted-publisher policy form (`GET/PUT …/ci-publisher`; workflow, environment, scopes,
  repository ids).
- The CI tokens table (`GET/POST/DELETE …/ci-tokens`). Issue uses `OneTimeSecretPanel`; Revoke is
  L2.
- All of this API has no UI today.

### 6.8 Activity

```
┌ H1 Activity                                       [ Export loaded (CSV) ] [ Refresh ] ┐
├ [Search summary…] [Actor ▾] [Action ▾ license.*, key.*, …] [Target ▾] [Last 7 days ▾] ┤
│ (A-2 present: server filters. Absent: "Filtering the 150 loaded entries" notice)      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Today                                                                                  │
│  14:02  (AL) Ada Lovelace   published catalog version 8          Catalog v8 →          │
│  13:40  (◈) CI release.yml  set rollout 2.4.0 to 25 % on App Store   2.4.0 × App Store │
│  13:12  (AL) Ada Lovelace   disabled license                     Studio Pro →          │
│           ▸ "Chargeback; customer notified" (summary, expandable)                     │
│ Yesterday                                                                              │
│  …                                                                                     │
├ [ Load older ] · 150 loaded · retention 180 days ─────────────────────────────────────┤
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **A `Timeline` grouped by day,** with a toggle to a table view (When, Actor, Action, Target,
  Summary).
- **Verbs.** Actions are humanized from the audit action codes (`license.disable` → "disabled
  license"). The raw code is shown in the expanded row and filterable.
- **Targets** are `EntityLink`s (ACT-2). Runtime rows (blank actor) show a system glyph and
  "Polaris Key".
- **Filters.** Actor, action (grouped by area), target kind and id, and date range, all in the URL.
  This needs **A-2** (server-side filters on `GET …/activity`); until then, filters apply to loaded
  entries, and the page says so (ACT-1).
- **Per-record History tabs** use the same component with a fixed target filter (A-2 required).
- **A platform-wide feed** (`#/platform` and Home) needs **A-2b**.
- No focusable `<time>` (ACT-4). Loading and refresh announce through the page live region (ACT-5).

### 6.9 Settings

```
┌ H1 Settings                                                                            ┐
├ On this page: General · License defaults · Repository · Storage · Danger zone ────────┤
│ ┌ General ──────────────────────────────────────────────────────────────────────────┐ │
│ │ Display name  [ DJDL                 ]                                            │ │
│ │ Admin group   [ djdl-admins          ]  Metadata only. It grants nothing: console │ │
│ │                                          access is platform-wide. Why? ↗          │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ License defaults (shown when License is on) ──────────────────────────────────────┐ │
│ │ Default max offline days [ 30 ]   Default device limit [ 5 ]                      │ │
│ │ The compatibility window lives in Update → Feed. [Open Feed →]                    │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Repository ───────────────────────────────────────────────────────────────────────┐ │
│ │ Linked to github.com/vladzaharia/djdl · App installed ✓ · last sync 2 h ago ●     │ │
│ │ [ Resync from repo ]  re-applies .pkey/: services, catalog, tiers, profiles, …    │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Storage ──────────────────────────────────────────────────────────────────────────┐ │
│ │ Blob collector (dry run): 1.2 GB eligible after grace · earliest deletion 9 Oct   │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Danger zone ──────────────────────────────────────────────────────────────────────┐ │
│ │ Delete product   Tombstones DJDL: every license is disabled and every device token│ │
│ │                  is evicted. The slug stays reserved.        [ Delete product… ]  │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
├ SaveBar (per section: "General: 1 change") ───────────────────────────────────────────┤
```

- **General and License defaults** are separate save scopes on the same `PATCH /products/:slug`.
  They are one resource, so a single SaveBar is acceptable here; the bar lists both sections'
  changes.
- **Clearing works:** an empty admin group sends `null` (PRD-6, which needs A-3 on the worker for
  `adminGroup`). A blank display name is a validation error (`name` is `NOT NULL`). The client never
  drops blanks silently.
- **Repository.** Resync is L1 with a result panel (RSY-3).
- **Danger zone.** Delete product is L3: type the slug, which is sent as `confirmSlug`.
  - Afterwards: invalidate `me` and `products`, navigate to Home, and toast "Product deleted"
    (SET-2).
  - The copy matches the docs: "Delete", described as a tombstone (PRD-3, DOC-3).
- **What moves out:** signing (to Keys & secrets) and compat (Update → Feed). The registry's ⋯
  menu shrinks to Open, Settings, Resync and Delete; no duplicate edit dialogs (PRD-5).

### 6.10 Customer portal

#### 6.10.1 Sign in

> **Superseded** by [SIGN-IN.md](SIGN-IN.md) §3.3–§3.4 (identifier-first card, email code and link,
> provider row, passkeys). Kept for history.

```
┌──────────────── centered, max-w 26rem ────────────────┐
│ [K] Polaris Key                                       │
│ Sign in to manage your licenses and downloads.        │
│ [ Continue with single sign-on              ]         │
│ ─────────────── or ───────────────                    │
│ Email  [ you@example.com            ]                 │
│ [ Email me a sign-in link ]                           │
│                                                       │
│ After sending:                                        │
│ ✉ Check ada@example.com. The link expires in 10 min. │
│   Opened it on this device? This tab signs you in     │
│   when you come back to it.                           │
│   [Resend] · [Use a different email]                  │
└───────────────────────────────────────────────────────┘
```

- **The tab really updates.** After sending, the tab re-checks `/api/me` on `visibilitychange` and
  `focus`, and every 5 s for 10 minutes while visible (POR-1).
- **The email form validates.** It is required and type `email`, and its errors are inline (POR-2).
- **Failures are told apart.** A `/api/me` or capabilities network failure renders "Can't reach the
  portal" with Retry, not the sign-in form or "unavailable" (POR-3).

#### 6.10.2 Home

```
┌ [K] Polaris Key   Home  Downloads                                  (AL ▾)             ┐
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Your licenses                                                  [ + Add a license ]    │
│ ▲ 1 needs attention: "Lab 3" expires in 4 days — contact your provider to renew.      │
│                                                                                        │
│ DJDL  (product branding: name, mark if provided)                                       │
│ ┌ Studio Pro ───────────────────────┐ ┌ Lab 3 ─────────────────────────────┐           │
│ │ ● Active · Pro                    │ │ ▲ Expires in 4 days · Edu           │           │
│ │ Devices ■■■□□ 3 of 5              │ │ Devices ■□□□□ 1 of 5                │           │
│ │ Expires 30 Sep 2027               │ │ Expires 7 Oct 2026                  │           │
│ │ Includes HD textures, beta        │ │ Includes stable                     │           │
│ │ [ Manage ]                        │ │ [ Manage ]                          │           │
│ └───────────────────────────────────┘ └─────────────────────────────────────┘           │
│ Latest downloads for macOS                                       [All downloads →]    │
│  DJDL 2.4.0 · macOS · 48 MB            [ Download ]                                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Status says why.** The status pill states the reason (Expired, Disabled, Offline grace ended,
  Expires in N days), with "Disabled" winning over generic attention (POR-7).
- **Cards are not links.** The title is a heading and **Manage** is the link (POR-8). Tier labels
  replace ids. Entitlements show "+2 more".
- **Add a license** is a dialog:
  - a mono key input with the product-specific prefix hint;
  - on success, it navigates to the claimed license (POR-6);
  - it is also offered from the empty state, only when claim is enabled.
- **The empty state** speaks to a signed-in user: "No licenses are linked to ada@example.com yet.
  Licenses link automatically when the email matches, or add one with its key." (POR-5).
- **Load errors** show `ErrorState` with Retry, never zeros (POR-4).

#### 6.10.3 License and devices

```
┌ Home / Studio Pro ─────────────────────────────────────────────────────────────────────┐
│ H1 Studio Pro   DJDL · ● Active · Pro                                                  │
│ Expires 30 Sep 2027 · works offline for up to 30 days · channels stable, beta          │
├ Devices (3 of 5) · Keys · Downloads · Details ────────────────────────────────────────┤
│ ┌ ⌘ Ada's MacBook Pro ──────────────────────────────────────────────────────────────┐ │
│ │ macOS 15.1 · arm64 · app 2.4.0 · last seen 2 h ago · added 3 Sep 2026            │ │
│ │                                                              [ Disconnect… ]     │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ ⊞ Studio PC (unnamed device dev_8f2c…) ───────────────────────────────────────────┐ │
│ │ Windows 11 · x64 · app 2.3.9 · last seen 14 days ago                              │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ▸ 2 disconnected devices                                                              │
└────────────────────────────────────────────────────────────────────────────────────────┘

Disconnect dialog:  Disconnect "Ada's MacBook Pro"?
  · It stops working at its next check-in (or within 30 days offline).
  · It frees a seat: 2 of 5 will be in use.
  · You can activate it again later with your license key.
  [ Keep device ]                                    [ Disconnect device ]
```

- **Devices are cards** with a platform icon, the label or a "Unnamed device" fallback, platform,
  arch and app version from fields the API already returns (POR-11).
- **Seat usage** is shown. Disconnected devices collapse.
- **The disconnect confirm** lists its consequences (POR-11).
- **Keys** show label, hash prefix (`Hash`), status and last used, with "Lost a key? Your license
  key can't be shown again; contact your provider." (POR-10).
- **The Downloads tab** is filtered to this product. It shows notes and SHA-256 with copy, and the
  disabled reason as visible text (POR-12).
- **The Details tab** shows max offline days, channels and version window (POR-9).

#### 6.10.4 Downloads and Account

- **Downloads.**
  - Grouped by product, newest first.
  - The visitor's platform comes first, from UA-CH or UA, with "All platforms".
  - Each artifact shows its size, SHA-256 and access reason as text.
  - A `formatDate` fix: `publishedAt` null reads "Unpublished date", never "No expiry" (POR-13).
- **Account.**
  - Name and email; how licenses link (verified email, sign-in subject, claimed keys).
  - Theme (System / Dark / Light).
  - Sign out.
  - **Delete account** (L3: type `delete`; `DELETE /api/me`; explains that licenses stay with the
    product and are only unlinked) (POR-14).

---

## 7. Implementation plan

### 7.1 Chunk order

Each chunk is one reviewable branch, green on the full gate (AGENTS.md "The green gate"), and keeps
the console shippable. Chunks 4–10 are area chunks: they are independent after chunk 3 and can run
in parallel on disjoint files. Chunk 12 (portal) can start after chunk 3.

| #   | Chunk                                                                                                    | Depends on |
| --- | -------------------------------------------------------------------------------------------------------- | ---------- |
| 0   | `@polaris-key/brand` lands (separate package; not this plan)                                             | —          |
| 1   | Platform migration: React 19, Tailwind v4, brand tokens, fonts, theme                                    | 0          |
| 2   | App shell, navigation, router, data layer                                                                | 1          |
| 3   | Component system                                                                                         | 2          |
| 4   | Home, products registry, new-product wizard, Platform section (scaffold and Deployment)                  | 3          |
| 5   | Core: overview, services, devices, settings, keys & secrets, activity                                    | 3          |
| 6   | License: licenses, license record, tiers, enrollment                                                     | 3          |
| 7   | Config: catalog read and editor, profiles, payload editor, edge mint                                     | 3          |
| 8   | Release: releases, release record, channels, deliverables, packs, content keys, compatibility, simulator | 3          |
| 9   | Distribution and Update: matrix, rollouts, outlets and feeds, access, health, credentials, feed          | 3          |
| 10  | Identity: portal, sign-in                                                                                | 3          |
| 11  | Docs and console tour rewrite, a11y sweep, visual baseline                                               | 4–10       |
| 12  | Customer portal                                                                                          | 3          |

### 7.2 Chunk detail

#### Chunk 1 · Platform migration (no visual redesign beyond tokens)

**IDs closed.** SH-15, SH-18, SH-19, SH-20.

**Scope.**

- `react`/`react-dom` 19 and `@types/*`.
- `radix-ui` unified.
- `tailwindcss` v4 with `@tailwindcss/vite`. Delete `tailwind.config.ts`, `postcss.config.js` and
  `autoprefixer`.
- `styles.css` becomes `@import "@polaris-key/brand/tailwind.css"` plus `fonts.css` plus an alias
  layer mapping old utility names (`bg-card`, `text-muted-foreground`, `bg-primary`…) to brand
  tokens, so every existing view renders branded with no view edits.
- Theme: `ThemeProvider` with `system | dark | light` on `data-theme`, a pre-paint inline script in
  `manage.html` and `index.html` (SH-15), and a `matchMedia` listener.
- The `forwardRef` removal codemod. The `font-medium`/`font-semibold` codemod to 400/700 (SH-19).
  **Decision (lead, chunk 1 review):** no codemod. `styles.css` aliases `--font-weight-medium` to
  400 and `--font-weight-semibold` to 700 (Rubik's only two weights, `font-synthesis: none`), so
  every existing `font-medium`/`font-semibold` renders deterministically with no view edits. The
  area chunks write `font-normal`/`font-bold` as they rebuild each view, and the aliases go with
  the last old view (chunk 11).
- `data-service` values to brand `ServiceId`s, with `tools/services.json` and `gen:services`
  (§0.3).
- Favicons and manifest from the kit's `04-web/key`.

**Files.** `package.json`, `vite.config.ts`, `styles.css`, `tailwind.config.ts` (deleted),
`postcss.config.js` (deleted), `components/theme.tsx`, `components/brand/Logo.tsx` (re-exports brand
marks), `index.html`, `manage.html`, all `components/ui/*` (forwardRef), `tools/services.json`,
`src/services.generated.ts` (regenerated) and the other languages' generated service files if
`console.accent` is emitted there.

**Tests.**

- All 458 pass unchanged. RTL queries are role and label based, so the token swap should not affect
  them.
- New: `theme.test.tsx` (system resolution, persistence, pre-paint script parity) and a token alias
  smoke test.

**Risks.**

- Tailwind v4 renames: `shadow-sm`→`shadow-xs`, `ring` defaults to 1 px, `outline-none`→
  `outline-hidden`, opacity utilities. Run `@tailwindcss/upgrade` and then review the diff.
- React 19 test warnings (`act`).
- Browser floor: Safari 16.4+ and Chrome 111+, for both SPAs. Acceptable for an operator console;
  for the portal, note it in the docs.
- Rubik with no medium weight changes visual hierarchy in places; the codemod's role table decides
  each case.

#### Chunk 2 · App shell, navigation, router, data layer

**IDs closed.** SH-1 to SH-14, SH-16 (including SH-7 query state and SH-9 the vestigial
`normalizeView`), CC-1 to CC-4 (through the invalidation table).

**Scope.**

- `nav.ts` and `routes.ts` (the §2.3 page set, typed builders), `Link`, query params, the blocker,
  the redirect table (§2.5), the not-found page, `document.title`.
- `AppShell`, `TopBar`, `BrandBlock` (section bit), `ProductSwitcher`, `Sidebar` (groups, glyphs,
  collapse, routed `Drawer` on mobile), `CommandPalette` (navigation and products sources only),
  `UserMenu`, `ThemeMenu`, `EnvironmentBadge` (A-1), the skip link, focus-on-route.
- TanStack Query: `queries.ts`, `mutations.ts` with the invalidation table (§5.4), `useMe`,
  `useProducts`, `useProduct`. Port `context.tsx` callers by an adapter (`useResource` →
  `useQuery`), so views keep working until their area chunk.
- Existing views are mounted at their new URLs unchanged, apart from the deleted topbar `<h1>`. Each
  view's `<h2>` is promoted to `<h1>` through a temporary `LegacyPage` wrapper.
- **Docs, in the same chunk** (the drift gates): rewrite `D/admin/console-tour.md` for the new
  sections; update every `docs` path in `nav.ts`; keep `lib/docsLinks.ts` valid.

**Files.** `route.ts` → `nav.ts` + `routes.ts`, `App.tsx`, `components/Shell.tsx` (replaced by
`console/shell/*`), `context.tsx` (adapter, then deleted in chunk 11), `api.ts` (`ApiError`
unchanged; add `me` fields), `main.tsx` (`QueryClientProvider`), and the worker for A-1
(`W/admin/handlers/me.ts`, `wrangler.toml` vars).

**Tests.**

- `route.test.ts` is rewritten: every page parses and round-trips; **every old URL in §2.5
  redirects**; unknown segments resolve to not-found; query codecs.
- `shell.test.tsx` is rewritten:
  - sections by enablement;
  - section bit color token per section;
  - the switcher keeps the page;
  - the mobile drawer is inert or closed and Escape closes it;
  - `aria-current`.
- New tests:
  - `mutations.test.ts`: every mutation declares invalidation.
  - `palette.test.tsx`.
  - The worker `me` test for `environment` and `sessionExpiresAt`.
  - `docsLinks.test.ts` (worker) must stay green.

**Risks.**

- Breaking bookmarks (mitigated by the redirect table and its tests).
- Hash `replaceState` interplay with the blocker.
- Section-gating flicker: keep "show all while loading".

**Notes (chunk 2 as built, 2026-10-03).** Where the build differs from the text above:

- **Owner requirements added in this chunk.**
  - Sidebar section headers are collapsible disclosure buttons (Radix Collapsible: `aria-expanded`,
    `aria-controls`, Enter and Space). **Only the active section is open** (owner, 2026-10-03): the
    section holding the current page is always open and cannot be collapsed (its header is
    `aria-disabled`), and every other section starts collapsed. Expanding a collapsed section by
    hand is a temporary peek: it lasts while you move between pages of the active section, and
    entering another section collapses every peek and opens the new one. Nothing is persisted (an
    earlier build stored collapsed sections under `pk-admin-nav-collapsed:<sub>`; that key is no
    longer read or written). The open and close animation uses `--pk-duration-base` and
    `--pk-ease-standard`, with `motion-reduce:animate-none`. A collapsed header keeps its accent
    rule.
  - **Section headers carry no icon** (owner clarification, overriding §2.4's "section glyph" and
    components.md §1.4's group-label glyph). Every nav item has a lucide icon, including
    Deliverables, Compatibility, Matrix and Health (SH-4). `route.test.ts` fails if any page lacks
    an icon; `shell.test.tsx` fails if a header renders one. The chevron is the disclosure
    indicator, not an icon. `NavSection.glyph` stays in `nav.ts` for later badges and empty states.
- **Brand block: 48 px in a 64 px top bar**, not 28 px in 56 px. BRAND.md §6 and the owner decision
  settle Q1 that way. With `fix/logo-no-core-bit` merged, `BrandBlock` passes the route's section
  to `LogoMark`: no bit on Home, Products, Platform and Core pages (and the boot screen), the
  section's accent in a service section. The owner-approved palette from that branch (Config
  yellow, Release cyan, Update tangerine) reaches the sidebar through the brand tokens.
- **The whole §2.3 page set is declared now.** Pages that a later area chunk builds carry
  `ready: false` and a `host`, and their URLs redirect (with `replaceState`) to the page that holds
  the capability today: Edge mint and Outlet credentials → Keys & secrets, Channels → Releases,
  Content keys → Deliverables, Access → Update → Feed, Sign-in → Portal, Outlets & feeds →
  Matrix, the catalog editor → Catalog, the simulator → Compatibility, New product → Products,
  Platform → Home. Records that are not built yet (tier, release, the routed device drawer)
  redirect to their collection. The sidebar and palette list only built pages. Each area chunk
  flips `ready` and deletes `host`.
- **Rollouts** mounts today's Distribution overview (chain, rollouts, hooks) until chunk 9.
- **Writes go through `mutate(method, ...args)`** (`console/data/mutations.ts`), which runs the
  declared invalidation after the server confirms. The table is keyed by API method, covers all 47
  writes, and `mutations.test.ts` fails on a write with no entry, an entry that is not a write, or
  any `api.<write>(` call in `src/` that bypasses `mutate`. The three views that refreshed after a
  _failed_ write (an edge-mint 409, an outlet-credential delete, the license record's `refresh`)
  keep that through the adapter's `invalidate(qk…)`.
- **Query defaults:** `staleTime` 30 s, focus refetch on, **no automatic retries** (a failed read
  shows its error and a Retry the operator controls).
- **Not yet:** the 1024–1279 px "expand as an overlay" behaviour (the rail toggles inline there);
  the unsaved-changes guard hook (the router's `blockNavigation` it builds on is here; the hook is
  chunk 3's); `useTableUrlState` (chunk 3, on `useSearchParam` and the codecs in `routes.ts`).
- **Small departures:** the sidebar landmark is `nav[aria-label="Console"]` (it also holds the
  platform links); the `QueryClientProvider` is mounted in `App.tsx`; under 640 px the top bar
  drops its Docs link (the account menu keeps "Docs home"); a `PageErrorBoundary` keeps a page that
  throws from taking the shell down; the shortcut sheet (`?`) and the global `g` shortcuts ship
  here because the user menu links to them (SH-14).
- **CSP-safe scroll lock.** Radix's overlays lock background scroll with `react-remove-scroll`,
  whose `react-style-singleton` injects an inline `<style>` that the Worker's `style-src 'self'`
  blocks (every dialog, menu, popover and drawer logged a violation and the page behind still
  scrolled). `vite.config.ts` aliases `react-style-singleton` to `src/lib/styleSingleton.ts`: the
  same API and reference counting, the CSS applied through a constructable stylesheet
  (`adoptedStyleSheets`), falling back to `insertRule` on an existing same-origin sheet, never a
  `<style>` element. `test/styleSingleton.test.tsx` covers the shim; `e2e/csp.e2e.test.ts`
  (`pnpm --filter @polaris-key/admin test:e2e`, run in CI's `console` job) opens the palette, the
  account and theme menus, the shortcut sheet, a dialog, the switcher and the mobile drawer in
  Chromium under the Worker's exact policy and requires zero violations and a real scroll lock.
- **The mobile drawer closes** when the window grows past 1024 px (a `matchMedia` listener), so
  its modal layer cannot stay mounted, invisible, over the desktop layout.
- **Page headings stay `<h2>` elements.** `LegacyPage` promotes each legacy view's first `<h2>`
  with `aria-level="1"` (so assistive technology and `getByRole("heading", { level: 1 })` see one
  level-1 heading) rather than rendering an `<h1>`, which would mean editing every view; the area
  chunks replace it with `PageHeader`'s real `<h1>`.
- **Bundle:** third-party code is split into `vendor`, `vendor-radix`, `vendor-query` and
  `vendor-cmdk`, each under Vite's 500 kB warning.
- **A-1:** `environment` is `null` when `PKEY_ENVIRONMENT` is unset or unrecognised (the badge
  stays hidden, as in production); `sessionExpiresAt` is the session's signed `exp`, in epoch
  seconds. Admin routes are narrative-only, so no OpenAPI or transcript change.

#### Chunk 3 · Component system

**IDs closed.** UI-1 to UI-15 (including UI-5, the card header actions slot, and UI-8, tab variants
and `forceMount`), SH-17 (the templates' responsive rules and bottom-sheet dialogs).

**Scope.** Everything in `components.md` §2–§7 that chunk 2 did not build:

- `Button` (fixes UI-1/2/3), `IconButton`, `ActionMenu`, `CopyButton`;
- the forms layer (`useAdminForm`, `FormField`, all controls, `SaveBar`, guard);
- `Dialog`, `ConfirmDialog` (typed), `Drawer`, `OneTimeSecretPanel`;
- sonner `Toaster`, `Callout`, `PageSkeleton` + live region, `EmptyState` (star motif),
  `ErrorState` + `errorCopy` (+ `DISTRIBUTION_ERROR_MESSAGES`);
- `DataTable` v2 + `FilterBar`;
- `DescriptionList`, `StatusPill` + `lib/status.ts`, `SignedBadge`, `ServiceBadge`, `SourceBadge`;
- `CodeBlock`, `JsonViewer`, `DiffViewer`, `KeyDisplay`, `Hash`, `IdChip`, `Timestamp`, `Duration`,
  `Version`, `EntityLink`;
- `Timeline`, `Grid`, `Stepper`;
- `StatTile`, `Sparkline`, `Meter`, `Funnel`, `BarList`;
- `lib/format.ts`, `lib/version.ts`, `lib/labels.ts`, `lib/actions.ts` (destructive levels);
- the `#/__kit` gallery.

The old `components/ui/*` stays as thin re-exports until chunk 11 deletes it.

**Tests.** Per component: states, keyboard and a11y. Add `vitest-axe` and run axe on each kit story
in jsdom, in both themes. Specifically:

- `ConfirmDialog` typed gating and the inline error.
- `OneTimeSecretPanel` close guard.
- `DataTable` URL state, facets, selection, cursor and virtualized rows.
- `useAdminForm` does not re-seed while dirty.
- `Grid` arrow navigation.
- `errorCopy` table-driven over every code and reason in §5.9.
- `lib/actions.ts` assigns a level to every action.
- `DateInput` zone semantics (LIC-5).

**Risks.**

- Scope creep: the gallery is the acceptance surface, and the lead reviews it before the area chunks
  fan out.
- Bundle size: CodeMirror is lazy; check the main bundle stays under 250 KB gzip.

**Notes (chunk 3 as built, 2026-10-04).** Where the build differs from the text above:

- **Where things live.** Components are in `src/ui/` (data table under `src/ui/data-table/`,
  charts under `src/ui/charts/`), the form layer in `src/ui/form.tsx`, the console-aware pieces
  (`PageHeader`, `PageTabs`, `Breadcrumbs`, `EntityLink`, `DeviceTable`) in
  `src/console/components/`, the templates in `src/console/templates/` (T1 `Dashboard`, T2
  `Collection`, T4 `Settings`), and `useTableUrlState` in `src/console/`. The templates are shaped
  so the S-13 Platform pages (Settings on T4 with a per-row `SourceBadge` and `SaveBar`;
  Deployment and Operations on T1 with full-width table panels) and the S-12 package Feeds pages
  (T2) can be built on them without new primitives; the gallery's template stories use those
  shapes with fixture data. No page was built here.
- **The old `components/ui/*`.** `Button`, `Spinner`, `Tooltip`, `Skeleton`, `Dialog`,
  `ConfirmDialog` and `Toaster` are thin re-exports of `src/ui` (`ConfirmDialog` keeps the legacy
  defaults: destructive confirm, no close on success). `Badge`, `Card`, `Checkbox`, `DataTable`
  (v1), `DropdownMenu`, `EmptyState`, `Field`, `Input`, `Label`, `Select`, `Switch`, `Tabs`,
  `Textarea` and `Toast` keep their own code: their props differ from the new components', so a
  re-export would change every legacy view. Each area chunk moves its views to `src/ui`; chunk 11
  deletes whatever is left.
- **UI-5** is closed by the header slots of the template cards (`Panel.action`,
  `SettingsSection.actions`, `SettingsRow.source`) and `DataTable`'s density; there is no
  stand-alone `Card` component. **UI-8**: `PageTabs` is the underline style, route tabs (`to`) or
  panel tabs, and `TabPanel` keeps a dirty panel mounted (the `forceMount` case, LDT-4).
- **CSP, proved in a browser.** `e2e/kit.e2e.test.ts` (part of `pnpm --filter @polaris-key/admin
test:e2e`) builds the gallery with `VITE_PK_KIT=1` into `dist-kit/` (git-ignored; the shipped
  `dist/` never contains the gallery) and opens every dialog size, each confirm level, a confirm
  with its inline error, both drawers, the one-time secret and its close guard, the action menu,
  `Select`, `Combobox`, a `SourceBadge` popover, a facet popover, a tooltip, toasts and the lazy
  CodeMirror editor in Chromium under the Worker's exact policy: zero violations, a real scroll
  lock on every modal overlay (through the `react-style-singleton` shim), released on close, and
  a phone-width bottom-sheet dialog. It also fails on any console error at load. It found, and
  this chunk fixes, two more inline `<style>` sources besides sonner's: CodeMirror's `style-mod`
  (a Vite transform lets it adopt a constructable sheet on the document, not only in shadow
  roots) and Radix Select's viewport (the transform drops the element; `styles.css` carries its
  two rules). Each transform fails the build if the library's code changes shape.
- **A DataTable render loop, fixed.** `react-table` queues `resetPageIndex()` after every
  row-model recompute, and the table fed it a fresh `sorting` array every render, so any second
  render (a theme change; the virtualizer's first measure on a phone) re-rendered every table
  forever and froze the page. `sorting` and `columnVisibility` are memoized and `autoResetAll` is
  off (the table pages itself through `state.offset`/`cursor`). jsdom does not reproduce it; the
  e2e suite checks the gallery is quiet at 390 px and 1440 px, before and after a theme change.
- **Accessibility tests.** `test/kit.test.tsx` renders all 64 stories in both themes and
  runs `vitest-axe` on each: zero violations. `color-contrast` is off there (jsdom computes no
  colour; the brand package's contrast suite covers the tokens) and so is `region` (a story is a
  fragment). `Grid` cells carry an explicit `role="gridcell"`.
- **Tests added** (per the list above): `test/ui/confirmDialog`, `oneTimeSecret`, `dataTable`
  (facets, selection, j/k/x, cursor and offset paging, virtualized rows, CSV),
  `tableUrlState` (round trip, namespacing, a hash change restoring filters), `forms`
  (`useAdminForm` never re-seeds while dirty; `keepMine`, `acceptServer`, server field errors;
  `DateInput` stores the end of the local day across zones and a DST change, LIC-5), `grid`
  (roving tab stop, arrows, Home/End, Ctrl+Home/End, activation, return to the last cell),
  `test/lib/errorCopy` (table-driven over every §5.9 code and reason), `actions` (every action
  has a level), `status`, `labels`, `diff`, `highlight`, plus the value, badge, feedback, chart,
  copy, menu and dialog suites. The admin package runs 986 unit tests.
- **Small departures.** The release policy copy moved from `api.ts` to
  `lib/releasePolicyMessages.ts` (re-exported by `api.ts`) so a test that mocks `api.js` can still
  load `errorCopy`. `ConfirmDialog.confirmVariant` accepts `null`, the value a cva variant prop
  can carry in the legacy views.
- **Bundle.** The console's first load (`manage.html`'s scripts and stylesheet) is 226 KB gzip.
  CodeMirror is a separate chunk loaded on first use and is not in the shipped build until a page
  uses `CodeEditor`.

#### Chunks 4–10 · Area chunks

Each area chunk follows the same recipe:

1. Rebuild the area's pages on the templates, per §6.
2. Delete the old view files.
3. Move or re-target that area's tests.
4. Fix every inventory ID listed in the table below.
5. Add the API additions it owns.
6. Update the area's docs pages.

| Chunk  | Pages                                                                                                                               | Old files removed                                                                                                                               | Inventory IDs closed                                                              | API additions                                 | Docs pages updated                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **4**  | Home, Products, New product wizard, Platform section (scaffold and Deployment)                                                      | `Dashboard.tsx`, `Products.tsx`, `products/*`                                                                                                   | DSH-1–7, PRD-1–5, PRD-7–12, SH-10                                                 | A-8 (optional), A-2b (optional)               | `admin/products.md`, `admin/kek.mdx` (Platform pointer)                                                    |
| **5**  | Overview, Services, Devices and device drawer, Settings, Keys & secrets, Activity                                                   | `ProductOverview.tsx`, `Services.tsx`, `services/*`, `Devices.tsx`, `Settings.tsx`, `Secrets.tsx` (see the mount note below), `Activity.tsx`    | OVR-1–8, SVC-1–7, DEV-1–8, SET-1–6, SEC-1–6, ACT-1–6, PRD-6, RSY-3                | A-2, A-3 (product fields), A-4, A-5           | `admin/services-enablement.md`, `admin/secrets-and-keys.md`, `admin/activity.md`                           |
| **6**  | Licenses, license record (its Devices tab reuses chunk 3's `DeviceTable` and drawer), tiers, tier record, Enrollment                | `Licenses.tsx`, `LicenseDetail.tsx`, `licenses/*`, `Tiers.tsx`, `tiers/*`, `FingerprintPolicy.tsx`                                              | LIC-1–10, LDT-1–17, TIR-1–9, FPP-1–5                                              | A-3 (license/tier nullables), A-3b (optional) | `admin/licenses-and-devices.md`, `admin/bundles.md`                                                        |
| **7**  | Catalog, catalog editor, profiles, profile record, payload editor, Edge mint                                                        | `Catalog.tsx`, `catalog/*`, `Profiles.tsx`, `profiles/*`, `SchemaForm.tsx` (split), `ManagedPayloadEditor.tsx` (rebuilt), `EdgeMintRecipes.tsx` | CAT-1–10, SCF-1–7, MPE-1–5, PRF-1–8, EMR-1–5                                      | A-6, A-7, A-7b (optional)                     | `services/config/catalog.md`, `services/config/profiles.md` (console sections)                             |
| **8**  | Releases, release record, repo sync drawer, Channels, Deliverables, pack record, Content keys, Compatibility (matrix and simulator) | `Releases.tsx`, `releases/*`                                                                                                                    | REL-1–10, CHN-1–6, PAD-1–6, RBD-1–2, RSY-1–2, DLV-1–5, CKY-1–3, PKD-1–8, CMP-1–11 | A-10 (optional); verify pack yank             | `services/release/*` console mentions; `admin/console-tour.md` touch-up                                    |
| **9**  | Matrix, Rollouts, Outlets & feeds, Access, Health, Outlet credentials, Update → Feed                                                | `Distribution.tsx`, `distribution/*`, `UpdateSettings.tsx`, `OutletCredentials.tsx`                                                             | MTX-1–10, DOV-1–4, UHL-1–8, UPS-1–7, OUT-1–7                                      | A-9                                           | `admin/distribution-matrix.md`, `services/distribution/update-health.md`, `services/update/eligibility.md` |
| **10** | Identity → Portal, Sign-in                                                                                                          | `Identity.tsx`                                                                                                                                  | IDN-1–5                                                                           | —                                             | `services/identity/*` console mentions                                                                     |

**Temporary mounts.** Chunk 5 replaces `Secrets.tsx` with Keys & secrets, but Edge mint moves in
chunk 7 and Outlet credentials in chunk 9. Until those land, chunk 5 keeps `EdgeMintRecipes` and
`OutletCredentials` mounted at the bottom of Keys & secrets under a "Moving to Config / Distribution"
heading. Chunks 7 and 9 each delete their temporary mount. Every chunk therefore leaves every
capability reachable, whatever order 5, 7 and 9 merge in.

**Tests in area chunks.**

- **Keep every behavioral assertion that still applies.** About 458 tests exist; each area chunk
  states its count before and after, and may drop a test only when the behavior it asserted is
  deliberately removed (for example the Distribution "HooksCard"). The PR lists those tests.
- **Rewrite queries for the new structure.** Headings become `h1`. Tabs become links. Drawers
  replace inline sections.
- **Add, per page:**
  - loading, empty, error and no-results states;
  - the main mutation with its invalidation;
  - the destructive confirm level;
  - URL round-trip of filters;
  - an axe pass.
- **Fixture reuse.** `test/releaseFixture.ts` and similar stay the source of fixtures.

**Risks in area chunks.**

- **Behavior drift.** Mitigated by the inventory IDs: each PR lists the IDs it closes, and
  reviewers check them.
- **Cross-area components** (DeviceTable, EntityLink) are built in chunk 3, never inside an area
  chunk, so parallel area chunks touch disjoint files.

#### Chunk 4 as built (2026-10-04)

**IDs closed.** DSH-1 to DSH-7, PRD-1 to PRD-5, PRD-7 to PRD-12, SH-10. PRD-6 stays with chunk 5
(product Settings, A-3). The `confirmSlug` auto-fill (lead decision, 2026-10-03) is fixed for both
callers.

**Where things live.** `src/console/pages/global/` holds Home, Products, the wizard
(`ProductNew`) and the attention model (`attention.ts`); `src/console/pages/platform.tsx` is the
Platform section's lazy chunk (Deployment and the Platform activity panel), with Settings in
`platformSettings.tsx`, Operations in `platformOperations.tsx` and Store connections in
`platformStores.tsx` beside it;
`src/console/components/DeleteProductDialog.tsx` is the one L3 product delete, used by Products and
by the product Settings danger zone. The product helpers moved from `views/products/util.ts` to
`src/lib/products.ts`. `views/Dashboard.tsx`, `views/Products.tsx` and `views/products/*` are
deleted.

**Where the build differs from §6.1 and the table above:**

- **Attention on Home** comes from the registry row alone: `GET /products` carries each product's
  setup state (`nextActions`: missing secrets, signing key, edge-mint approvals and secret usage,
  release setup), which the worker computes for every product on every read. So Home lists
  attention for all products with no per-product fetch and no cap of 12. The kinds that need other
  reads (readiness, rollouts, Sentry, expiring licenses) wait for **A-8**, which this chunk does
  not add; nothing is guessed meanwhile.
- **A-2b** (a platform-wide activity feed) is not added, so Home has no recent-activity panel
  (§6.1: omitted, not faked). Platform activity (`platform_audit`, A-12) is a panel on Deployment.
- **The registry links instead of duplicating** (PRD-5): Edit, Set secret and Prepare signing key
  left the row menu for "Open settings" and "Open keys & secrets"; Resync from repo (L1) and
  Delete product (L3) stay. `api.deleteProduct(slug, confirmSlug)` takes the typed value.
- **The wizard** keeps Basics, Catalog and Defaults for the manual path and drops the
  compatibility window (PRD-7). Its result shows the public signing key with copy through
  `KeyDisplay` (the public key is not one-time material, so it is not a `OneTimeSecretPanel`).
  `useUnsavedChangesGuard` gained an `allow` option so the wizard's own `?step=` changes pass.
- **The Platform section** (§2.1, §2.3): `nav.ts` declares `platform-settings`,
  `platform-deployment`, `platform-operations`, `platform-stores` and `platform-feeds` in a
  `PLATFORM_GROUP`; only Deployment is `ready`. A redirect now follows a chain in one step
  (`#/platform` → Settings → Deployment). The deployment endpoint is
  `GET /manage/api/platform/deployment` (singular, as A-11 shipped it).
- **Tests.** Admin unit tests: 990 before, 1031 after. Rewritten or moved: `dashboard.test.tsx`
  (5) became `home.test.tsx` (12); `products.test.tsx` (13) became `products.test.tsx` (15),
  `productOverview.test.tsx` (the 2 Overview checklist tests, moved unchanged) and
  `productNew.test.tsx` (10, including the 3 create tests); new `platform.test.tsx` (18). Dropped
  as deliberately removed behaviour: the Dashboard's greeting, "schema vN" badge and constant
  Access and Session tiles (DSH-1, DSH-4), and the registry's own Set secret and Prepare signing
  key dialogs (PRD-5; both remain on Keys & secrets and Settings). Every page
  has loading, empty, error and no-results tests, its main mutation with its invalidation, its
  confirm level, a URL round trip and an axe pass. `queryKeyShapes.test.ts` now requires the
  registry list to have exactly one reader, the shell's `useProducts`.

#### Chunk 6 as built (2026-10-04)

Where the License build differs from the text above:

- **Where things live.** The pages are in `src/console/pages/license/` (`LicensesPage`,
  `CreateLicenseDialog`, `LicenseRecord` with `LicenseTerms`, `LicenseKeys`, `LicenseDevices`,
  `LicenseConfig` and `LicenseDialogs`, `TiersPage`, `TierRecord` with `TierForm`,
  `EnrollmentPage`, and `shared.tsx`); `pages/license.tsx` routes between them. The tier record
  is routed (`tiers/:id`, tabs `overview` and `used-by`).
- **History tab.** A-2 is chunk 5's, so the license record ships with Overview, Keys, Devices and
  Config overrides, and **More actions → View in activity** opens Activity with `?q=<license
id>` (LDT-17). The History tab joins the record's `tabs` in `nav.ts` once A-2 lands.
- **Device drawer.** The Devices tab uses chunk 3's `DeviceTable`; a row opens the routed device
  drawer (`devices/:id`), which chunk 5 builds with the facts as visible text (LDT-15, DEV-3).
  Until it lands that URL resolves to the Devices page.
- **Config overrides** keep the current `ManagedPayloadEditor` (chunk 7 rebuilds it) with the
  §6.5.2 failure states; once opened, the tab stays mounted so a draft survives a tab switch.
- **Expiry on create** is explicit: the tier's term (the body omits `expiresAt`, so the server
  derives it, R3-06), No expiry (`null`), or a date (the end of the local day, LIC-5).
  `maxOfflineDays` is checked against the server's 1 to 365.
- **Fingerprint mode.** Off is `enabled: false` (enforcement off for every tier); the other modes
  are `enabled: true` with that `defaultMode`. A stored `enabled` with `defaultMode: "off"` reads
  as Off with a note that tiers with their own mode still enforce it.
- **Kit additions.** `DataTable` column `meta.defaultHidden`, and no action menu on a row without
  a valid action; `OneTimeSecretPanel.actions`; `useUnsavedChangesGuard({ allow })` for a
  record's own route tabs; `device.resetBinding` (L1) in `lib/actions.ts`.
- **A-3** is in the Worker for the license and tier `PATCH` routes (product `adminGroup` is chunk
  5's); A-3b is not built: the list stays in client mode.
- **Temporary home.** `views/legacyBits.tsx` holds the three helpers the legacy `Devices.tsx`
  and `profiles/ProfileDetail.tsx` imported from `licenses/shared.tsx`; it goes with them.
- **Tests.** The four License suites (47 tests) are replaced by `licenses`, `licenseRecord`,
  `tiers`, `enrollment` and `licenseModel` (94 tests; the admin package goes from 987 to 1,036). Two assertions moved to the device
  drawer with the hardware and software columns: "shows the truncated hwid and the software
  summary" and "marks a device that never sent a fingerprint as unverified".

#### Chunk 7 as built (2026-10-04)

Config: Catalog, the catalog editor, Profiles, the
profile record, the payload editor and Edge mint, at `src/console/pages/config/`. Where the build
differs from the text above:

- **Where things live.** `SchemaForm.tsx` is split into `src/schema/` (`entry.ts`: the validator,
  entry helpers and the one set of kind/state tables; `SchemaField`, `ManagementStateControl`,
  `ManagedField`; `catalogValidation.ts`: the editor's whole-catalog checks and JSON lint).
  `ManagedPayloadEditor.tsx` is rebuilt in place, so the license override tab keeps its import;
  its `onSubmit` may resolve or reject, and the draft stays until the refetch shows the server
  holding it (a swallowed failure never loses the draft). `OverridesEditor.tsx` changed one import
  line, and three `licenses.test.tsx` assertions follow the new row copy.
- **Used by (PRF-2, PRF-8)** is the server's, not computed from cached queries: the profile list
  carries `usedBy` counts and the profile detail the tiers and licenses (`GET …/config/profiles`).
  The license list's fetcher is chunk 6's, and the delete guard needs exact counts.
- **Profile History** is not a tab yet: it needs A-2 (activity filtered by target), which is
  chunk 5's. The record's tabs are Payload and Used by; `nav.ts` declares only those.
- **Create (PRF-5).** The server now refuses a taken id (`409 profile_exists`): `POST` used to
  upsert, so a duplicate id silently replaced that profile's payload. "Publish a catalog first" is
  the New profile button's disabled reason when the catalog is missing.
- **A-7b** (catalog usage) is built: the key drawer's "Overridden by" and the review's breaking
  removals read it. Catalog ownership (CAT-3) is `From manifest` for a repo-linked product
  (`releaseSource: "github"`), whose next resync re-applies `.pkey/schema`.
- **The payload JSON control** is a mono textarea with Format; CodeMirror is the catalog editor's
  JSON mode only.
- **Temporary mount.** Edge mint left Keys & secrets (`views/Secrets.tsx` no longer mounts it);
  the shell and palette tests that used Edge mint as their not-ready page now use Sign-in.
- **API additions** are admin routes (narrative-only under rule 10), covered by
  `packages/worker/test/configAdmin.test.ts`, audited where they write (`profile.update`); no
  migration.

#### Chunk 4P-1 as built (2026-10-04)

**Platform → Settings** (`#/platform/settings`, T4) is built on A-13's settings API, and
`platform-settings` is `ready` in `nav.ts`, so `#/platform` now lands on Settings. The page is
`src/console/pages/platformSettings.tsx`, in the Platform lazy chunk. Its help link is
`/docs/admin/platform-settings/`, and the Keyring section links `/docs/admin/kek/`.

- **Background jobs.** Each of the four settings is its own save scope:
  - The source badge shows _Code default_, _Deploy var_ or _Set in console_ (by whom and when).
  - Switches apply on flip. Integers use a per-row `SaveBar`. The byte cap is entered in MiB and
    bounded to [1, 32], so it can only be lowered.
  - Confirm levels come from the registry's `confirm` for each direction. An L0 change applies at
    once, with Undo in the toast: Undo restores the previous runtime value or deletes the new
    one. L1 is a caution `ConfirmDialog` that lists the consequences. L2 and above would send
    `confirm: <key>`, and L3 adds the typed key; no setting uses either yet.
  - Revert is always confirmed (L1 at least) and names the value that comes back.
  - Every write sends `expectedVersion`. On a 409 the row offers **Reload**. A typed number
    survives the reload (`keepMine`), and Save retries it with the new version.
  - A ceiling hard off shows as _Locked off by deploy var_ with the reason. An unreadable store
    shows as _Off: store unreadable_ and disables the controls.
- **Read-only inventory.** Identity & access, Delivery and Email list the deploy-time values,
  each flagged when a legacy name supplied it. Limits holds the code constants and starts
  collapsed. The API's warnings are shown above the sections.
- **Keyring.** This closes the "KEK has no console UI" gap, read-only. It shows KEK secret
  presence, the `PLATFORM_KEK_ACTIVE` and `PLATFORM_KEK_ID` kid names, and from
  `GET /products/kek` the active kid, the ring with per-kid counts and the re-seal progress
  (remaining, unopenable). A 503 shows "The platform keyring is unusable". The L3 re-seal sweep
  is not in this chunk: it stays the runbook's `POST`.
- **Secrets.** Presence only, with what each secret is for and what being unset means.
- **History.** The `platform.setting.*` rows of `GET /platform/activity`, filtered on the client.
  Each fetch reads up to 5 pages until it has 10 matches. The rows show the value before and
  after. The query key is `["platform", "activity", "settings"]`, so a settings write's
  invalidation of the platform trail also refreshes Deployment's activity panel. That panel now
  words the two setting actions.
- **Tests.** The new `platformSettings.test.tsx` has 20 tests. `platform.test.tsx`,
  `route.test.ts`, `palette.test.tsx` and the CSP e2e follow the new `ready` entry. The CSP e2e
  also opens a setting's confirmation and records zero violations.

#### Chunk 11 · Docs, a11y sweep, visual baseline, cleanup

**IDs closed.** DOC-1 to DOC-6.

**Scope.**

- Delete `components/ui` re-exports, `context.tsx` and `LegacyPage`.
- A final `console-tour.md` pass (DOC-1 to DOC-6 fixed).
- A manual screen-reader pass (VoiceOver and NVDA) on the eight templates.
- 360 px checks.
- A Playwright visual baseline of the `#/__kit` gallery and of fixture-backed pages, in both themes
  and 3 widths. It is optional in CI; it runs in the existing browser job's Playwright install.

**Tests.** Visual baseline (non-blocking at first); the axe sweep.

#### Chunk 12 · Customer portal

**IDs closed.** POR-1 to POR-17.

**Scope.**

- Split `portal/App.tsx` into `portal/pages/*` on the shared kit and TanStack Query.
- The portal IA (§2.7), Sign in states (POR-1 to POR-3), Home, License, Downloads, Account
  (`DELETE /api/me`), the theme menu, the mobile menu.
- `document.title` per route. Per-product capabilities via `?product=`. Product branding per group.

**Tests.**

- Existing `portal.test.tsx` and `portalServices.test.tsx` adapted.
- New flows (POR-17):
  - magic-link sent state and focus re-check;
  - network error vs signed out;
  - claim navigates to the license;
  - disconnect consequences;
  - downloads platform grouping;
  - account deletion typed confirm;
  - an axe pass.

**Risks.**

- The portal is customer-facing: keep the URL redirects (`#/licenses` → `#/`,
  `#/profile` → `#/account`).
- Keep the wire calls identical; the portal parses the flat error shape (`W/core/errors.ts:54-64`).

### 7.3 API additions

These are the admin API changes the UI needs. Admin routes are narrative-only: `adminApi` is in
`NARRATIVE_ONLY` (`packages/worker/test/routeCoverage.test.ts:34`), so rule 10's OpenAPI coverage
does not apply. Each addition still needs:

- a worker test;
- an audit row where it mutates;
- the `D/admin/*` narrative update;
- no change to any public wire route, so no corpus or transcript regeneration.

| ID       | Addition                                                                                                                                   | Why the UI needs it                                                         | Without it                                                                   | Chunk        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------ |
| **A-1**  | `GET /me` adds `environment` (`"prod" \| "staging" \| "dev"`, from a new `PKEY_ENVIRONMENT` var per `[env.*.vars]`) and `sessionExpiresAt` | Environment badge; session-expiry display                                   | badge hidden; expiry omitted                                                 | 2            |
| **A-2**  | `GET …/activity` accepts `action` (prefix), `actor`, `targetKind`, `targetId`, `since`, `until`                                            | Activity filters; per-record History tabs                                   | client-side filtering of loaded pages; History tabs hidden                   | 5            |
| **A-2b** | `GET /activity` (platform-wide, same filters)                                                                                              | Home and Platform recent activity                                           | panels omitted                                                               | 4            |
| **A-3**  | `PATCH` bodies accept `null` to clear: license `maxOfflineDays`, tier `policyExpiryDays` / `policyDeviceLimit`, product `adminGroup`       | "Blank uses the default" becomes true (LDT-2, TIR-1, PRD-6)                 | fields can't be cleared; help text is changed to say so                      | 5, 6         |
| **A-3b** | `GET …/license/licenses` gains `q`, `status`, `tier`, `limit`, `cursor`                                                                    | Scale beyond ~5k licenses                                                   | client mode (fine below ~5k)                                                 | 6 (optional) |
| **A-4**  | `GET …/keys`: kid, status, alg, publicKey, createdAt, activateAfter, retiredAt (no private material)                                       | Signing-key lifecycle UI (SET-1); activate, retire and revoke become usable | active key only, plus a session-local staged key                             | 5            |
| **A-5**  | `GET …/secrets`: name, usage, updatedAt, requiredBy (values never)                                                                         | A secrets inventory (SEC-2)                                                 | required secrets only                                                        | 5            |
| **A-6**  | `GET …/config/catalog/versions` (list) and `/versions/:n`; `PUT …/config/catalog` accepts `expectedVersion` (409 on mismatch)              | History, diff against any version, safe concurrent publish                  | no history menu; publish is last-writer-wins, with the risk stated in review | 7            |
| **A-7**  | `PATCH …/config/profiles/:id` `{name?, description?}`                                                                                      | Edit profile details (PRF-1)                                                | details are immutable after create; the UI says so                           | 7            |
| **A-7b** | `GET …/config/catalog/usage?key=`: profiles and licenses overriding a key                                                                  | "Overridden by" incl. licenses                                              | profiles only, from cached payloads                                          | 7 (optional) |
| **A-8**  | `GET /summary`: per product, license counts by state, expiring, devices, rollouts by state, attention items                                | Home at scale                                                               | Home composes from per-product queries (cap 12)                              | 4 (optional) |
| **A-9**  | Distribution 404s keep `reason` (`W/services/distribution/admin.ts:296,649`, `updateHealthAdmin.ts:99`)                                    | Precise error copy                                                          | generic not-found copy                                                       | 9            |
| **A-10** | `GET …/release/compat` accepts `packWindow` separately from `offset`                                                                       | Decoupled matrix paging                                                     | joint paging, labelled honestly                                              | 8 (optional) |

**Client-only changes, with no API work:**

- `contentApi` in `ChannelPolicyBody` (pack floors);
- `entitlement` in `saveDeliveryAccess`;
- `methods` and `channel` in `SimulateParams`;
- rollout start and set via the existing `POST …/rollouts/:outlet/:channel`;
- outlets, readiness, distribution keys, connectors, CI publisher and tokens, KEK, blob GC through
  existing routes.

### 7.4 Gates each chunk runs

- **Every chunk:**
  - `mise exec node@22 -- pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`,
    `pnpm --filter @polaris-key/admin build`, `pnpm --filter @polaris-key/worker assemble`,
    `pnpm --filter @polaris-key/docs check:links`.
  - The pre-commit hook (`gen:corpus --check`, `gen:services --check`, typecheck).
- **Chunk 1:** `pnpm gen:services -- --check` after the `tools/services.json` accent change.
- **Chunk 2 and any chunk touching docs links:** `packages/worker/test/docsLinks.test.ts` (help-link
  drift gate) and `check:links`.
- **Chunks with worker additions (A-\*):** `pnpm --filter @polaris-key/worker typecheck:workerd` and
  `test:workerd`.
- **`gen:transcripts`:** no wire changes are planned, so `gen:transcripts -- --check` must stay
  green. If it does not, the chunk changed a public route by mistake.

---

## 8. Open questions for the lead

1. **Q1 · Section bit optical cut.** The kit draws the K's terminal bit only in the display cut
   (≥ 48 px). The header mark is 28 px.
   - **(a) Recommended:** the brand package draws a service-cut (24-unit grid) terminal bit, used
     only by `SectionMark`.
   - **(b)** The brand block grows to a 48 px display mark in a 64 px top bar.
2. **Q2 · Routing.**
   - **(a) Recommended:** keep hash routing with the new scheme and redirects. No Worker change.
   - **(b)** Path routing under `/manage/*` and `/`. Needs an asset fallback in `W/router.ts`, plus
     redirects from hash URLs.
3. **Q3 · New runtime dependencies.** `@tanstack/react-query`, `@tanstack/react-table`,
   `@tanstack/react-virtual`, `react-hook-form`, `cmdk`, `sonner`, `diff`, and CodeMirror 6
   (`@codemirror/*`, lazy). Dev-only: `vitest-axe`. Approve the set, or name substitutions.
4. **Q4 · API additions.** Approve A-1, A-2, A-3, A-4, A-5, A-6 and A-7 as part of their area
   chunks (each degrades gracefully without the addition), or defer some. A-2b, A-3b, A-7b, A-8 and
   A-10 are optional and can wait.
5. **Q5 · Catalog editor scope for v1.**
   - **(a) Recommended:** structured per-entry form plus JSON mode plus review diff.
   - **(b)** JSON/YAML mode plus review diff only, with the form in a follow-up. Saves about a third
     of chunk 7.

## Lead decisions (2026-10-03)

- **Q1 (section bit at header size):** pending the brand package's legibility proof (BRAND.md "the section bit"); chunk 2 implements whichever the brand contract specifies.
- **Q2:** keep hash routing.
- **Q3:** approved: TanStack Query/Table/Virtual, react-hook-form, cmdk, sonner, jsdiff, CodeMirror 6 (lazy), vitest-axe.
- **Q4:** approved: A-1…A-7 land inside their area chunks; A-8…A-10 as the chunks need them.
- **Q5:** catalog editor v1 ships the structured per-entry form plus JSON and diff.
- **Bugs found by the audit** (double-submit `Button`, disabled-button tooltips, stale session, auto-filled `confirmSlug`, first catalog publish, refetch wiping edits, non-atomic Update settings save) are fixed in the chunk that owns each view; the `confirmSlug` auto-fill is fixed in chunk 4 at the latest because it defeats a guard.

## Owner decisions (2026-10-04)

- **Platform section** (notes/S-13 §11): the reserved single Platform page becomes a sidebar
  section with Settings, Deployment, Operations, Store connections and Package feeds; `#/platform`
  redirects to Settings; a version chip in the account menu links to Deployment. Operations data is
  hybrid, self-reported first. The first four runtime-editable settings are `LAZY_DELTAS`,
  `LAZY_DELTA_MAX_BYTES` (lower only), `BLOB_GC_MODE` and `BLOB_GC_GRACE_DAYS`, with ceiling
  precedence for kill switches, audited in `platform_audit`. Chunk 4 builds the section and
  Deployment; the other pages land in their own work packages.

## PS-06 amendment (2026-10-06): the Polaris Key storefront

- **Distribution → Storefronts** renders a built-in store (`builtIn` on the storefront view: an
  adapter whose operations are `first-party`, PS-01) as **Built in: always connected**, with its
  capabilities badged **Built in** and **Manage** to its own page. Add to storefronts leaves it out
  (SETUP.md D48: the built-in storefront has no wizard). A storefront's own page is a record of the
  Storefronts page, `distribution/storefronts/<id>`, one `STORE_PANELS` line per store that has one.
- **Distribution → Storefronts → Polaris Key** (T4, the §2.3 row above) is PS-06's panel and the
  Discover tab SETUP.md §2.10 describes, built before UX-54's page shell exists. It writes only
  through Identity's portal settings (`updatePortalSettings`) at the levels in §5.2, and its
  persona preview takes no field that names a person (S-21 owner decision 11).
- **Distribution → Listing → Fit report** gains a store switcher kept in the URL (`?store=`), so a
  storefront's page links straight to its own row.
