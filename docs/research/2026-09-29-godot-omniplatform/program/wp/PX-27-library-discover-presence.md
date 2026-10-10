# PX-27 Library and Discover presence

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md)                                                          |
| Size        | 0.5–0.8 engineer-weeks                                                                               |
| Depends on  | [PX-24](PX-24-library-added-just-now.md), [ST-36](ST-36-owner-polish-portal-fixes-simple-product.md) |
| Unblocks    | none                                                                                                 |
| Role        | `pkey-implementer`                                                                                   |
| Plan mode   | no (no wire change)                                                                                  |
| Gates       | portal-e2e, ui-snapshots                                                                             |
| Human input | none                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Goal

Library and Discover tiles draw the cover at its whole 16:9 frame, with a key tile, a 'Missing a license?' strip, the compact header lockup and the portal's display-size heading.

## Why

The portal's art-led presentation is the brand direction (B12); the built tiles crop the art and the wordmark is about 1.5 times the mockups'.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B12.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- LibraryTile and DiscoverTile draw the cover edge to edge at 16:9, capped at 280 px.
- 'Have a license key?' end tile in the 2-7 grid: dashed border, key glyph, 'Activate it to add its product here.', outlined Activate license; spans the row at two columns.
- 'Missing a license?' strip: 'Sent to another email?' (Sign-in methods link) and 'Bought in a store?'.
- Header lockup at the compact size (PORTAL §0.3); page h1 at the display step 48/52 desktop and 32/36 phone, no full stop and no slogan label (B12).
- Attention shelf: only the single most urgent item is solid; others are outlined. `dir="auto"` on tile names, hero h2, attention titles and palette rows. Header account name hidden at 640-899 px.

**Out** (and where it belongs instead):

- ProductArt.tsx and LibraryHero (→ PX-30).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B12 (program/BRAND-TRANSITION.md); section change portal-01. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `distribution.download-page`, `portal.library-12`, `portal.library-empty`.

## Acceptance criteria

- [x] e2e baselines for library and discover at 360, 390, 768, 1024, 1440 and 1920 in both themes with no horizontal scroll.
- [x] The 768 px three-product grid has no half-empty row.
- [x] axe clean; no chartreuse; UX self-look in BUILT mode (one pass, no review round).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set PX-27 in-review` when it hands off; after review the lead adds the last commit `--set PX-27 done`.

## Corrections found against the code (PX-27 build)

- Tiles already drew 16:9 art; the cap (280 px, whole art contained over a blurred copy) and a
  short no-art tile (icon large and centred on the tint, name starting the body, M9) were added.
- The header account name was already hidden below 1180 px, which covers 640-899 px.
- The Needs attention shelf keeps its grid of cards (existing 3-column assertion); only the most
  urgent item (suspended, ended, device limit, expiring soon) is solid, the rest outlined.
- The page-title token is new (`text-page-title`, 48/52; `-sm`, 32/36); `text-display` stays 40 px
  for the product pages (PX-31 owns those).
- Not done, owned elsewhere: the one-product hero's flat no-art slab and the solid button's
  accent colour (neutral action ink, B2) belong to PX-30 and the Button variant package.
