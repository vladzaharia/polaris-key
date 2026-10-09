# ST-49 Console route ledger and Page moved map

| Field       | Value                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (Brand transition (2026-10-09))                      |
| Size        | 0.3–0.5 engineer-weeks                                                                              |
| Depends on  | [ST-29](ST-29-admin-route-table-can-usecan.md), [ST-45](ST-45-platform-product-sidebar-contexts.md) |
| Unblocks    | none                                                                                                |
| Role        | `pkey-implementer`                                                                                  |
| Plan mode   | no (no wire change)                                                                                 |
| Gates       | drift-gate, console-csp-parity                                                                      |
| Human input | none                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                           |

## Goal

One `ROUTE_LEDGER` map (0.9 page id to 1.0 route) feeds every Page moved entry and a generated ADMIN.md §2.8. Every removed page id opens Page moved naming its new home: no redirect, no alias.

## Why

0.9 removals are removals, not aliases. A single ledger replaces ad-hoc 'redirect for one release' wording (ST-08) and gives the 47-row URL inventory a test.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B16.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- Extend P0-31's MOVED map into `ROUTE_LEDGER` covering every 0.9 `nav.ts` page id and its record and tab routes.
- `pnpm gen` writes ADMIN.md §2.8 with `--check`.
- A test fails when a `PageId` leaves `nav.ts` without a ledger row.
- The deleted override-migration page reads 'deleted (U-27)'.

**Out** (and where it belongs instead):

- Building the replacement pages (→ ST-08, ST-09, ST-45 and area packages).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B16 (program/BRAND-TRANSITION.md); section change admin-4-17. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

- [ ] Every 0.9 URL in the 47-row inventory resolves to live content or a Page moved page.
- [ ] The drift check is part of the green gate.
- [ ] The lead may fold this package into ST-45.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set ST-49 in-review` when it hands off; after review the lead adds the last commit `--set ST-49 done`.
