# ST-44 One Home; delete GET /manage/api/summary; slim product list

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation C: Products, onboarding and Integration)             |
| Size        | 0.8–1.2 engineer-weeks                                                                                                |
| Depends on  | [ST-36](ST-36-owner-polish-portal-fixes-simple-product.md), [ST-38](ST-38-service-table-five-features-one-service.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-47](ST-47-legacy-setup-retirement.md), [ST-52](ST-52-palette-search.md)   |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | `console-csp-parity`                                                                                                  |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-08** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-12, UX-67.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/LX-41.md`](../plans/LX-41.md) §13: the server attention read gains one kind: a `license:subscriptions` token that expires within 14 days while the product has a live `external` subscription.

## Goal

One Home; delete GET /manage/api/summary; slim product list, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-08** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **OB-08**.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- Home with attention, Platform ready (UX-67) and product cards with a table toggle and facets; the Products page retires with a redirect; a server attention read GET /manage/api/attention (UX-12) composed from the descriptors' integration prerequisites and the health kinds, replacing attention.ts's client derivation from productSetupView and the summary; delete GET /manage/api/summary, admin/lib/summary.ts, useSummary, qk.summary and its 14 invalidations, and mark ADMIN.md's A-8 fleet facts dropped; a slim GET /products projection; the 'Setup complete' facet becomes Verified.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-08**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Home layout (B4): Needs attention (about 62%) and Platform ready (about 38%) side by side from 1280 px, stacked below; readiness never narrower than 280 px. Attention rows are at most two lines (pill, product and message on line one, the fix link right-aligned on line one). No stat tiles repeating the attention count (EXPERIENCE §4). (admin-1-14, overview-13)
- Product shelf: cover cards use a 72 px ProductArt banner in Cards view only (hosted presentation art, else the flat stored `tintColor`; never a generated gradient and never read canvas pixels). Without art, the icon on the section-neutral subtle surface. Status chips stay on the tile's first visible row. (admin-1-14, overview-13)
- If covers are adopted, the slim `GET /manage/api/products` projection carries `presentation.header` (image-host URL variants) and `tintColor` beside `presentation.icon`, so Home makes no per-card read. This is a manage-API field addition, not a wire or SDK contract; run the admin API docs drift gate if the route table is generated. (admin-1-14, overview-13)
- [ ] Home at 360, 390, 834, 1024 (rail), 1440 and 1920 in both themes with no horizontal scroll and no collapsed column; 20 products in Cards view stay scannable (Table view offered, facets unchanged); covers lazy-load and reserve their box (no layout shift); `products.home` re-rendered at 1440 and 1920. (admin-1-14, overview-13)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 5 mockup item(s):** `products.home`, `products.overview-a`, `products.overview-b`, `products.overview-c`, `products.overview`.
- `overview-21`: Failed long-running tasks keep a durable home: an attention item on Home plus a record (EXPERIENCE 0.3 J-2).

## Corrections and notes (ST-44 build, 2026-10-20)

- Verified against code: `GET /manage/api/summary` had no client reader (`useSummary` was unread since
  the 2026-10-07 polish); ADMIN.md carries no A-8 text any more, so the note says the fleet facts are
  dropped where the Platform context is described. The Home attention model was client-side
  (`global/model/attention.ts` over each list row's `setup`); it is deleted.
- The slim `GET /products` row drops the setup state, signing block, modules, portal settings and
  claims (one `productSetupView` per product per list read before). `GET /products/:slug` keeps the
  full row; the list adds `verified` (an SDK sighting exists, for the Integration verified facet) and
  `presentation.header`. `useProduct`'s list placeholder therefore lacks those members until the
  detail row arrives (Overview already honours `isPlaceholderData`).
- `GET /manage/api/attention` (area `console`, filtered by product visibility and per-item area):
  failed resync, missing required secret, missing signing key, secret not marked for edge minting,
  edge-mint recipe awaiting approval, store credential expiring within 14 days or expired. The
  LX-41 subscription-token kind needs the subscriptions table, which has not landed: it joins with
  LX-41. `GET /manage/api/platform/ready` (area `platform`) is new (UX-67's readiness read did not
  exist): keyring, portal sessions, console sign-in, background jobs, email sender, store accounts,
  platform packages. "Reserved names reviewed" and "Team access" are not built (no stored
  acknowledgement; the member roster is groups plus role bindings).
- Not built from products.home: the Polaris Key system product card (the console list keeps the
  system product out, F-03); the checklist has seven rows, not nine; per-product `tintColor` (HA-12 has not
  stored one: a cover without hosted art is the icon on the neutral subtle surface, as the brand
  transition says); the Platform sidebar context, breadcrumb and 3px context rule (ST-45).
- Layout lint: `data-head-count` (a count beside its title is not a far-right pill) and
  `data-top-aligned` (a row of cards drawn top-aligned on purpose) are narrow exemptions in
  `layoutProbe.ts`, both from products.home.

## Acceptance criteria

- [x] Summary route and hooks deleted (OpenAPI, routeCoverage); ADMIN.md A-8 marked dropped
- [x] One Home for cards and table; attention comes from one server read
- [x] The card stays ST-36's name/slug header plus feature glyphs (the mockup amends service icons to feature icons), pips on phones (no added facts; the cover is the brand-transition addition)
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `operate/platform/settings`; `operate/console/tour` regenerated.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-44 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-44 done`.
