# PX-18 Portal Cloud Sync section (absorbs PX-W11)

| Field       | Value                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                           |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                               |
| Depends on  | [PX-04](PX-04-product-page-today.md), [U-05](U-05-cloud-sync-do.md), [U-12](U-12-privacy-settings-portal.md)                                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                   |
| Gates       | the AGENTS.md green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                            |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs PX-W11: the portal Cloud Sync section's API and CloudSyncCard; one card component shared with U-11a.

- Title: was "Cloud Sync section: `CloudSyncCard` on the product page, TOC entry, ⌘K action, export and delete; absent for products without the service".
- Depends on: added U-05 and U-12; removed PX-W11.
- Absorbs PX-W11: One portal Cloud Sync package (API and card). Its 'not on Identity' note was wrong.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: one quota number per tier, shown read-only with a link to Tiers, plus the ceiling and the pause state. Labels are read server-side.

## Corrections (2026-11-09)

The lead's U-12/PX-18 slice plan splits this package into PX-18.1 (the read-only card, its section,
nav entries and ⌘K action), PX-18.2 (export and removal from the card, the portal e2e states and
baselines) and PX-18.3 (PORTAL.md, Help and the BUILT UX pass). Checked against the code, these win
over the text below:

- The toggle is `services.sync` on the product view, not `services.cloudSync`. The data source is
  U-12.5's `GET /api/products/{product}/sync` (sizes and times only; a device is its label).
- End users never see "Cloud Sync": the section and card are **Sync Across Devices**
  (`account.cloudSync` in the kit copy catalog).
- PORTAL.md is a current-state document, not the UI and API spec: §4.4 and §7 say the `sync` route
  is reserved. The "§8 (360 px)" and "§9 (one h1)" references predate its rewrite; the checks live in
  PORTAL.md §6 and the portal e2e quality suite.
- One card shared with U-11a is not possible: U-11a built a console-only `Storage.tsx`. The shared
  parts are `ui/charts/Meter` and `storageTone`, which now lives beside it in `Meter.tsx`.
- Mockups 31 and 32 predate the Polaris Locker branding. Their Cloud-Sync-only "Delete synced data"
  is undone by the next push from any signed-in device, so the card's destructive action is the
  whole-product "Remove my data from <Product>" (PX-18.2). Their per-device "Up to date" and
  "Preferences only" have no data behind them: a device shows its last sync time only. Their "What's
  synced" data classes are not shown: the summary never names a collection.
- The ⌘K action is offered only when this tab already holds the top match's product view with
  sync on (library items carry no services).
- "Delete requires step-up" is the existing Remove my data route's gate, used from the card in
  PX-18.2.

## Goal

Products with Cloud Sync show `CloudSyncCard` (storage bar, data classes, per-device last sync, export, delete with step-up) with a `#/p/:product/sync` section, a TOC entry and a ⌘K action; products without the service show none of it.

## Why

Cloud Sync lives on the product page only ([PORTAL.md §4.4](../../../../design/PORTAL.md#44-product-pages-and-focused-flows)). The package brief is the scoped delivery record.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §7](../../../../design/PORTAL.md#7-parked-and-conditional-work) (this package's row) and [PORTAL.md §7](../../../../design/PORTAL.md#7-parked-and-conditional-work).
- [PORTAL.md §4.4](../../../../design/PORTAL.md#44-product-pages-and-focused-flows), [PORTAL.md §7](../../../../design/PORTAL.md#7-parked-and-conditional-work)
- `wp/U-12-privacy-settings-portal.md`
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `CloudSyncCard`, section route, TOC entry, palette action, export, delete with step-up.

**Out** (and where it belongs instead):

- Anything outside this brief belongs to its owning work package in the program graph.

## Design notes

- **Cloud Sync** appears only on the product page of a product whose `services.cloudSync` is on; there is no global Cloud Sync page, nav item or account section.
- **Overlap with the re-cut S-16/S-17 graph:** U-12 also names the product-page Cloud Sync section. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).

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

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-18:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-18 in-review`.

## Acceptance criteria

- [ ] Test: no sync UI anywhere (section, TOC, palette, route) when `services.cloudSync` is off.
- [ ] Delete requires step-up (test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

none.

The role agent sets `--set PX-18 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-18 done`.
