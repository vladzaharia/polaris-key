# LX-45 Bulk licence actions: extend expiry, change tier, comp, select-all-matching, preview and a server job

| Field       | Value                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (UX coverage (2026-10-09))                                                                                            |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                             |
| Depends on  | [LX-14](LX-14-console-licensing.md), [LX-44](LX-44-license-console-v2-tiers-entitlements.md), [ST-29](ST-29-admin-route-table-can-usecan.md), [ST-48](ST-48-console-shell-v2.md) |
| Unblocks    | none                                                                                                                                                                             |
| Role        | `pkey-implementer`                                                                                                                                                               |
| Plan mode   | no (no wire change)                                                                                                                                                              |
| Gates       | `rule-10`, `console-csp-parity`, `ui-snapshots`                                                                                                                                  |
| Human input | none                                                                                                                                                                             |
| Repo        | vladzaharia/polaris-key                                                                                                                                                          |

## Goal

From the licences table an operator can Disable, Enable, Delete, Export (exist) and also Extend expiry, Change tier and Comp many licences at once, with a preview of what changes, select-all-matching, and a server job that reports progress and partial failure.

## Why

Only Disable, Enable, Delete and Export are built. Extend, Change tier, select-all-matching, previews and the job have no owner.

## Read first

- AGENTS.md and the relevant skill.
- `program/ux-coverage.md` (the item list this package closes) and `program/ux-waves.md` (where it sits in the schedule).
- Brand transition decisions `program/BRAND-TRANSITION.md` (B-numbers) and the design docs the work touches.

## Scope

**In:**

- Bulk bar actions Extend expiry, Change tier and Comp with a preview step (count, examples, what will not change).
- Select-all-matching across pages and a server-side job with progress, partial-failure report and per-row reason.
- Uses LX-33's tier-change rules; no new entitlement semantics.

**Out** (and where it belongs instead):

- The single-licence Change tier dialog (LX-14).

## Screens and items this package closes

- no mockup screen; the items are listed in `ux-coverage.json` under this package id

## UX gate

New package from the UX coverage pass (2026-10-09). A built screen is done only when `pkey-ux-reviewer` passes it in BUILT mode and the pass is recorded: `node check.mjs --ux-review LX-45 pass "<evidence>"`. No wire change; do not derive APIs, entitlements or permissions from any mockup.

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

- [ ] Preview shows the exact count; a job that fails for some rows reports which rows and why, and Try again retries only those.
- [ ] pkey-ux-reviewer passes the bulk flows in BUILT mode (selection, preview, running, partial failure, success).
- [ ] The green gate passes (AGENTS.md), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set LX-45 in-review` when it hands off; after review, and after the UX review is recorded, the lead adds the last commit `--set LX-45 done`.
