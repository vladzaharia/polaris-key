# PX-26 Wide and zoomed layouts: content max widths, 1920 px and 200% zoom in the console and portal quality bar

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                           |
| Size        | 0.2–0.4 engineer-weeks                                                                               |
| Depends on  | [PX-20](PX-20-quality-bar.md)                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-63](UK-63-ux-bar-console-portal.md)                      |
| Role        | `pkey-implementer`                                                                                   |
| Plan mode   | no                                                                                                   |
| Gates       | `portal-e2e`, `console-csp-parity`, `ci`; visual baselines re-recorded with the reason in the commit |
| Human input | none                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Owner direction (2026-10-08)

- **Content max widths.** Wide windows use the width with side-by-side panels and cap the line length; content never stretches edge to edge.
- **Wide and zoomed checks.** The console and portal e2e, visual and layout-lint checks add the wide desktop (1920 px) and 200% zoom rows of [UI-KITS.md](../../../../design/UI-KITS.md) §7.1 to 1440 and 390 px, in both themes.

## Goal

No console or portal screen stretches edge to edge or breaks at 1920 px or at 200% zoom, and CI proves it. Done when every acceptance criterion holds and the green gate passes.

## Why

PX-20's quality bar checks 1440 and 390 px only. The owner asked on 2026-10-08 that every screen use wide windows well and stay usable at 200% zoom. A follow-up to a front-end PX package takes the next free number (README §8), so this is PX-26 rather than a suffix of PX-20.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- `wp/PX-20-quality-bar.md` (how the suite is built: `packages/admin/e2e/portalStates.ts`, `portalQuality.e2e.test.ts`, the Playwright image and `e2e:baselines`).
- [PORTAL.md §8](../../../../design/PORTAL.md#8-responsive-rules); `docs/design/BRAND.md` §7.6 (console density and layout); `packages/ui-qa` (`pnpm ui:lint`).

## Scope

**In:**

- A content max width for every console and portal page layout, with side-by-side panels where the width allows; documented in BRAND.md §7.6.
- The 1920 px and 200% zoom variants in the console and portal e2e and visual suites, both themes; the horizontal-scroll assertion at both.
- The same two sizes in `pnpm ui:lint --html` for the built console and portal pages.

**Out** (and where it belongs instead):

- The kits' size matrix (→ each UK package, against UI-KITS.md §7.1); the docs site (→ DOC-02b).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Wide and zoom: at 1920 and 2560 the canvas fills the window while its content column caps at 1760 and centres; the masthead tile aligns to the content edge; the Home split keeps 2fr/1fr up to the cap. At 200% zoom (720 CSS px) the canvas goes edge to edge, the tile hides and the h1 clamps to 24/32. Add a 400% row (1280x1024 at 400% = 320x256 CSS px, WCAG 1.4.10) beside 1920 and 200%. (admin-1-32, overview-06, portal-30, site-12)
- Forced colours and contrast: a `forced-colors: active` render in both themes and a `prefers-contrast: more` render of every PX-20 §4 state; add an `@media (forced-colors: active)` block to `packages/admin/src/styles.css` (icons CanvasText; selected tabs and radio cards get a 2 px ButtonText border; buttons 1 px ButtonText; StatusPill and SignedBadge keep a visible border; focus ring Highlight). Outside forced colors the ring, selected, hover and checked states keep their service accent (B17), measured at 3:1 UI and 4.5:1 text in both themes. (admin-1-32, overview-06, portal-30, site-12)
- Assertions: no page-level horizontal scroll; any table that scrolls sideways sits inside `role=region` with an accessible name and `tabindex=0`. Focused flows (free-device, download, activate) are centred at 1280 and 1920 with no empty half beside a narrow column; display headings reflow at 200% zoom and 320 px without truncation, including RTL and long product names; the Library 2-7 grid and Discover keep the 1248 px content width at 1920. (admin-1-32, overview-06, portal-30, site-12)
- [ ] The e2e and `ui:lint --html` suites include the rows; baselines re-recorded with the reason; a forced-colors Playwright run over Home, Licenses, the portal Library and the login card shows every control boundary and selected state. (admin-1-32, overview-06, portal-30, site-12)

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

1. Measure today's pages at 1920 px and 200% zoom; list what stretches or breaks.
2. Add the max widths and layouts; add the variants; re-record baselines with the reason; hand off for code and UX review.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- `doc:BRAND#7.7-empty-states-and-illustration`: Acceptance line: every empty state uses the stationary-star motif (BRAND 7.7); EmptyState.tsx exists but nothing verified it.

## Acceptance criteria

- [ ] Every §4 state renders at 1920 px and at 200% zoom in both themes, with no horizontal scroll (e2e).
- [ ] No content column exceeds the documented max width at 1920 px (test).
- [ ] `pnpm ui:lint --html` passes on the built pages at both sizes.
- [ ] `pkey-ux-reviewer` passes the wide and zoomed screens in a real browser.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
mise exec node@22 -- pnpm ui:lint
```

## Hand-off

The role agent sets `--set PX-26 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-26 done`.
