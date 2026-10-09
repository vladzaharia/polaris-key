# ST-48 Console shell v2: inset canvas, condensed masthead, section bands, route tabs, workbench

| Field       | Value                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (Brand transition (2026-10-09))                                                                 |
| Size        | 1.2–2 engineer-weeks                                                                                                                           |
| Depends on  | [ST-45](ST-45-platform-product-sidebar-contexts.md), [ST-29](ST-29-admin-route-table-can-usecan.md), [UK-58](UK-58-brand-expression-tokens.md) |
| Unblocks    | none                                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                             |
| Plan mode   | no (no wire change)                                                                                                                            |
| Gates       | console-csp-parity, ui-snapshots                                                                                                               |
| Human input | none                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                      |

## Goal

Every console page renders inside the v2 shell: an inset canvas, a condensed masthead, section head bands, underline route tabs and a table workbench, with neutral ink primary actions and the strengthened selected-nav marker in the section's service accent (B17).

## Why

The brand transition re-skins the console chrome. Doing it once in the shared layer keeps the area packages (ST-41, ST-43, ST-44, LX-14, LX-30, LX-44, P2-10) on shared components, not per-page CSS.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B2, B3, B4, B5, B6, B17.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- Canvas (B4): raised, rounded about 18 px, 3 px accent top rule, from 1024 px; full-bleed below; no glow, wash or gradient. Bounded measure 72ch; Features table full width.
- Masthead: ONE orientation line (glyph chip and crumbs; no eyebrow repeating the path, never 'Platform' on a product page, no 'WORKSPACE' label); h1 36/44 on collections and 32/40 on records (phone 24/32) with long-name clamp; 48 px flat service tile only at 1024 px and wider on feature landing pages (product icon on product Core pages, none on dense data pages); masthead at most 140/176 px.
- Section head bands (18/24 titles) without numerals (numbers only for ordered steps). Route tabs as an underline tablist, fading only when overflowing (not segmented).
- Table workbench: ONE bordered band for filters and table, 56 px rows (never 76), sentence-case heads, solid-outline chips; tablet is a contained scroll in a labelled focusable region with a sticky first column.
- Sidebar: neutral group labels with a 3 px accent bar. Selected nav is a subtle accent fill with a 3 px solid inset marker (B3), count badges keep their status colour; the focus ring, selected marker and fill, hover tint and checked controls take the accent of the service the element references (`data-service`, B17; core violet on platform and core pages), via the UK-58 state tokens, never ink.
- Primary action neutral ink via `action-neutral` (B2); danger stays red; accent marks context only, and every state colour (ring, selected, hover, checked, context border) is the nearest service accent (B17), a Config row in a mixed list is config yellow; status colours are never a service accent. Recessed inputs with a 3:1 border check.
- Dialogs and drawers: 3 px accent top rule and head band, ONE leading glyph (severity for confirmations, subject mark for records), titles at most 20/28, no service tile, no rule on destructive or caution dialogs, blurred backdrop with a reduced-transparency fallback.
- Ship builds is ONE identity (B5): Package glyph, Release cyan chrome on Releases, Release tracks, Rollouts, Channels, Packages, Updates and Health; crumb 'Ship builds › …'. Cloud Sync (one page) is one nav row.

**Out** (and where it belongs instead):

- Per-screen composition (→ area packages).
- Route ledger and Page moved (→ ST-49).
- Font-weight sweep (→ ST-50).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B2, B3, B4, B5, B6 (program/BRAND-TRANSITION.md); section changes admin-1-01, -02, -05..-09, -10, -11, -19; admin-2-03, -04..-14 (merged). No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

## Acceptance criteria

- [ ] Every console page renders inside the canvas with the masthead; one h1 per page; the masthead glyph tile is `aria-hidden`.
- [ ] First content starts at most 160 px below the top bar at 1440x900; no horizontal scroll at 360 and 390.
- [ ] `pnpm ui:lint` gains rules: no ordinal numerals in headings, one primary per region, masthead tile only at 1024 px and wider; also the UK-55 accent-as-status, state-accent and section-index rules.
- [ ] Baselines re-recorded with reasons at 1920, 1440, 1024 (rail), 834, 390 and 360 in both themes; `console-csp-parity` passes (no inline styles; accent values come from `data-service` stylesheet rules); axe zero; reduced motion.
- [ ] No glow, gradient, wash, coloured shadow or accent-tinted hairline anywhere (B6).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set ST-48 in-review` when it hands off; after review the lead adds the last commit `--set ST-48 done`.
