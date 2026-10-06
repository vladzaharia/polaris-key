# MO-09 Console data surfaces: table rows enter, leave and reorder within the 30-row budget, facet chips pop, the bulk-action bar presence, status pills ease and pop, chart fills and counts animate, StatTile and Skeleton get the shimmer (no more `animate-pulse` in `ui/`), RefetchBar, Stepper

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 2: areas)                                                  |
| Size        | 0.6–1 engineer-weeks                                                                            |
| Depends on  | [MO-03](MO-03-e2e-motion-determinism.md)                                                        |
| Unblocks    | [MO-11](MO-11-console-moments-counters.md), [MO-13](MO-13-motion-qa-closeout.md)                |
| Role        | `pkey-implementer`                                                                              |
| Plan mode   | no                                                                                              |
| Gates       | admin unit tests and axe; `test:e2e` and the smoke suite; layout lint at zero; `adminCspParity` |
| Human input | none                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                       |

## Goal

Data changes are legible: created rows arrive tinted, deleted rows leave, filters and sorts move rows instead of replacing them, pills change colour and word without a jump, numbers and fills move to their values, and loading is a shaped skeleton with a gentle sheen.

## Why

Rows, chips, pills and charts all snap today; 12 `animate-pulse` sites contradict the Skeleton rule (notes/S-23 §4.2–§4.3). The 30-row budget comes from the frame measurements (§3.5). Strips: `console-01`, `console-03`, `console-08`.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `ui/data-table/{DataTable,FilterBar}.tsx` (`VIRTUALIZE_ABOVE`), `ui/{StatusPill,SignedBadge,Skeleton,loading,Stepper}.tsx`, `ui/charts/{Meter,BarList,Funnel,StatTile,Sparkline}.tsx`.

## Scope

**In:**

- DataTable: client-side filter, sort, create and delete run `viewTransition(…, { type: "list", list: tbody })` (the layer enforces 30 rows, then rows on screen); the virtualised path (> 200 rows) never animates; a created or edited row gets `highlight()`; the bulk-action bar uses `<Presence>`.
- FilterBar: chips `pk-pop-in` on add, fade on remove; counts are not animated (speed).
- StatusPill, SignedBadge: `pk-pill` colour transitions; a changed word pops (`pk-pop-in` keyed on the value).
- Charts: Meter, BarList, Funnel fills move with `transform: scaleX` (`transform-box: fill-box`) instead of snapping the SVG width; StatTile values use `<CountUp>` on first load only; StatTile's loading state is a `pk-skeleton`.
- Skeleton: the sheen (`pk-skeleton::after`), the 150 ms grace (`pk-skeleton-group`), content fade-in.
- RefetchBar: the MO-02 `pk-refetch` sweep.
- Stepper: the connector fills and the current step pops.
- Remove `animate-pulse` from `ui/` and tighten the motion lint allowlist.

**Out** (and where it belongs instead):

- `animate-pulse` on platform pages and Home (→ MO-10, files in flight).
- Page-specific counters (→ MO-11).

## Design notes

- `feat/license-delete` edits `DataTable.tsx` and `types.ts`; rebase if it merges first.
- React keeps keyed row elements, so `match-element` pairs survivors (verify in the smoke suite: a filter must move at least one row, not fade it out and in).
- Counts in chips and tables update instantly; only headline numbers count up.

## Corrections (found while building, 2026-10-06)

The code is the fact; these replace the brief where they disagree.

- **`animate-pulse` was already gone.** MO-10 retired the last sites, including `ui/charts/StatTile.tsx` (its loading state is already a `pk-skeleton` behind `pk-skeleton-group`), and emptied the motion lint allowlist (`PULSE_ALLOWLIST = {}`, asserted empty). Nothing was left to remove or tighten; `test/ui/dataMotion.test.tsx` re-checks that no Skeleton renders `animate-pulse`.
- **`feat/license-delete` had merged** before this package started; no rebase was needed.
- **The transition is started by the table, not by each control.** DataTable holds its rows and its view (search, facets, sort, page) for the one frame a `list` transition needs, so a filter or sort from anywhere moves the rows: its own facet menu and chips, a page's own control (the Licenses state tiles), and Back (S-23 §6.3: query-string changes are `list`). Typing in search, paging and refetches that change nothing never animate. While the old view is held, the controls (the facet menu, a chip's remove button) act on the live selection and only the chip row is drawn from the held one, so changes made inside that frame build on each other (review B1).
- **Four real-app findings needed `motion.css` rules** (list section, MO-09 block, additive): an open overlay (the facet menu, a closing dialog and its scrim, a toast) was painted under the moving rows, so it is named for the transition; the main region's route fade-through dimmed the whole page on every filter, so in a list transition it shows its new picture at once; collapsed table borders belonged to the table's picture and ghosted, so DataTable draws each row's line on its cells (`border-separate`); and rows entering from below the fold crossed survivors still moving, so a table's entering rows (`.pk-vt-table`) start after the survivors land (`micro` + `base`, then `fast`, ending by `slow` + `micro`).
- **The layer judged the 30-row budget only before the update**, so Clear filters on a long table (20 → 60 rows) named all 60 new rows. `viewTransition()` now judges it on each side of the update (one-line fix in `ui/motion/viewTransition.ts`, unit-tested).
- **The smoke cases live in `e2e/dataMotion.e2e.test.ts`**, not `e2e/motion.e2e.test.ts`, as MO-10's `shellMotion.e2e.test.ts` does, so the area packages built in parallel (MO-04, MO-05, MO-07) do not collide in one file.

## Files it touches

`ui/data-table/{DataTable,FilterBar}.tsx`, `ui/{StatusPill,SignedBadge,Skeleton,loading,Stepper}.tsx`, `ui/charts/*`, tests, `e2e/motion.e2e.test.ts`. In flight: `feat/license-delete` (`DataTable.tsx`).

As built: also `ui/charts/FillRect.tsx` (new), `ui/motion/changed.ts` (new), `ui/motion/viewTransition.ts` (the budget fix), `src/motion.css` (the MO-09 list block), `test/ui/dataMotion.test.tsx` and `e2e/dataMotion.e2e.test.ts` (new) instead of `e2e/motion.e2e.test.ts`.

## Steps

1. List transitions in DataTable with the budget.
2. Chips, bar, pills.
3. Charts and StatTile.
4. Skeleton and RefetchBar; remove `animate-pulse` from `ui/`.
5. Smoke cases (filter moves rows; 60-row table names ≤ 30); strips.

## Acceptance criteria

- [x] A filter on a 60-row table names at most 30 rows and moves (not re-enters) surviving rows (smoke suite: `e2e/dataMotion.e2e.test.ts`, both themes; Clear filters back to 60 rows names at most 30 too).
- [x] No `animate-pulse` remains under `src/ui/` (MO-10 had already removed the last site; the motion lint's allowlist is empty).
- [x] Chart fills animate by transform only (motion lint + test: `test/ui/dataMotion.test.tsx` scans `ui/charts/` for computed SVG widths and checks every fill is a full-width `pk-meter-fill`; the smoke suite measures a seat meter's fill at a fifth of its track).
- [x] Layout lint stays at zero (`e2e/layout.e2e.test.ts` green in the full `test:e2e` run).
- [x] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test): both variants in `e2e/dataMotion.e2e.test.ts`, plus unit tests.
- [x] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

MO-11 uses `<CountUp>`, `setMeter` and the pill behaviour on the pages. The role agent sets `--set MO-09 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-09 done`.
