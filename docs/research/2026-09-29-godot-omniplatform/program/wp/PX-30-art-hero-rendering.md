# PX-30 Art and hero rendering

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md)                                                          |
| Size        | 0.3–0.5 engineer-weeks                                                                               |
| Depends on  | [PX-24](PX-24-library-added-just-now.md), [ST-36](ST-36-owner-polish-portal-fixes-simple-product.md) |
| Unblocks    | [PX-29](PX-29-focused-task-frame.md)                                                                 |
| Role        | `pkey-implementer`                                                                                   |
| Plan mode   | no (no wire change)                                                                                  |
| Gates       | portal-e2e, ui-snapshots                                                                             |
| Human input | none                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Goal

ProductArt never upscales a tile variant into a banner; heroes never crop the art at 1180 px and wider; short and landscape screens keep Download in view.

## Why

Built banners show stair-stepped edges and empty blocks at 1024-1179 px.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B4, B12.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- ProductArt picks the hosted variant at least as wide as drawn size times devicePixelRatio. Never read canvas pixels (B4); hosted art, else the flat stored `tintColor`.
- LibraryHero at 1024-1179: art contained over a blurred cover copy; at 1180 and wider uncropped. Landscape phone hero side by side from about 560 px; stacked hero at 1023x900 keeps Download on the first screen.
- Minors: the command palette placeholder reads 'Jump to…' at the floor; RTL device names align to start; attention copy states the action once; Avatar must not call `name.trim()` on null.

**Out** (and where it belongs instead):

- Tile layout (→ PX-27).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B4, B12 (program/BRAND-TRANSITION.md); section change portal-02. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

- `B6.10`, `OR-fullbleed-art`: Assert full-bleed 16:9 art and no text drawn over customer art.

## Acceptance criteria

- [x] Baselines at 1024, 1180, 1440, 1920, 844x390 and 390 in both themes. (Real-browser geometry assertions and screenshots at every size, plus 1023x900, both themes, with art, without and with a long name: e2e/portalArtHero.e2e.test.ts; committed linux baselines updated for the changed library screens, the contested ones left to the integration regeneration.)
- [x] A unit test that the chosen variant is at least drawn width times DPR (test/portalArtVariant.test.tsx); [ ] UX review in BUILT mode (the lead runs it).
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set PX-30 in-review` when it hands off; after review the lead adds the last commit `--set PX-30 done`.

## Implementation notes (PX-30)

- Verified against the code: the Worker hands the library one ladder width (1280); `ProductArt` now
  rewrites a ladder variant URL to the narrowest rung (640 / 1280 / 1920) at least drawn width times
  devicePixelRatio (`portal/model/artVariant.ts`), never down on resize, with one retry on the URL as
  given before the tint fallback. No canvas read in ProductArt. (`ProductIcon`'s corner-pixel
  `iconShape` is a separate icon mask, outside this package.)
- `ProductArt fit="contain"` draws a blurred cover copy behind the uncropped art; no text over art.
- Evidence (real Chromium, built SPA): /Users/vlad/Repos/pk-wt/\_evidence/PX-30/hero-<art|noart|long>-<size>-<theme>.png.
