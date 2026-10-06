# MO-04 Console navigation motion: route fade-through, forward/back drill-down by route depth, licence key and record title as shared elements, record-tab indicator morph and panel fade-through, SegmentedControl thumb

| Field       | Value                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 2: areas)                                                     |
| Size        | 0.4–0.6 engineer-weeks                                                                             |
| Depends on  | [MO-03](MO-03-e2e-motion-determinism.md)                                                           |
| Unblocks    | [MO-13](MO-13-motion-qa-closeout.md)                                                               |
| Role        | `pkey-implementer`                                                                                 |
| Plan mode   | no                                                                                                 |
| Gates       | admin unit tests; `test:e2e` (the smoke suite gains console route and tab cases); `adminCspParity` |
| Human input | none                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                          |

## Goal

Moving around the console reads as one space: sibling pages fade through, drill-downs slide forward and Back slides back, a record's tabs move their indicator and fade their panel, and the chrome never moves.

## Why

Today a route change remounts the page instantly and tabs snap (notes/S-23 §4.2); the strips `console-04-row-to-record-light.png` and `console-05-tab-switch-dark.png` show the target.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `packages/admin/src/console/router.tsx` (hashchange, popstate, blockers), `console/shell/AppShell.tsx` (`PageContent key`, `useRouteFocus`; read only), `console/components/PageTabs.tsx`, `ui/SegmentedControl.tsx`, `console/useTableUrlState.ts`.

## Scope

**In:**

- `console/router.tsx`: navigation state updates run inside `viewTransition(() => flushSync(set…), { type })`; `type` is `forward` when the new hash path is deeper than the old, `back` when shallower, `route` otherwise; query-string-only changes use no route transition; the unsaved-changes blocker resolves first; `useRouteFocus`'s focus and scroll still happen (on `updateCallbackDone`).
- Shared elements by class, gated by `data-vt` in `motion.css`: the licence key cell in the licences table and the record header key (`pk-vt-key`); both `width: fit-content`.
- `PageTabs.tsx`: the active tab's underline carries `pk-vt-indicator`, the panel `pk-vt-tabpanel`; switching runs `viewTransition(…, { type: "tab" })`; dirty panels kept mounted stay so.
- `SegmentedControl.tsx`: the checked item's background as an indicator that morphs (`tab` type) or a transform-only thumb.
- Smoke-suite cases for route, forward/back and tab.

**Out** (and where it belongs instead):

- `AppShell.tsx` edits (in flight in `wp/UX-10`; the Suspense fallback skeleton is MO-10).
- Data-table row motion (→ MO-09).

## Design notes

- Do not edit `console/routes.ts` (four in-flight branches); compute depth from the hash path segments.
- The page takes no input during a transition: a new navigation skips the running one (the layer does it).
- Under reduced motion `viewTransition` runs the update directly (D3).

## Files it touches

`console/router.tsx`, `console/components/PageTabs.tsx`, `ui/SegmentedControl.tsx`, the licence table key cell's class (where it renders: `console/pages/license/LicensesPage.tsx` only if no in-flight branch touches it at start; otherwise defer the key pairing to MO-13), tests, `e2e/motion.e2e.test.ts`. No in-flight branch touches the first three.

## Corrections found while building (2026-10-06)

The code is the fact; these replace the brief where they differ.

- **There is no key column.** The Licenses table's primary cell is the licence **name** (Holder), and the record header's title is that name. The shared pair is therefore the name: the table cell is marked `data-vt-shared="pk-key"` and named for the old snapshot only (the router finds it inside the clicked `<Link>` and passes it as `shared` to `viewTransition`), and the record title carries `pk-vt-key`. Giving every row `pk-vt-key` would name 48 elements `pk-key` during a `forward` transition; a duplicate name aborts the transition. Both ends are `width: fit-content`.
- **`console/pages/license/LicenseRecord.tsx` is touched too** (not in the list above): the title is wrapped in the `pk-vt-key` span, and its four tab panels carry `pk-vt-tabpanel`. No in-flight branch touched it at start.
- **A record's route tabs are `tab`, not `forward`.** `/licenses/lic_1` → `/licenses/lic_1/keys` is one level deeper, so depth alone would slide the whole page. The router runs `tab` when both hashes have the same `viewKey` (the page or record, without tab and query; read from `routes.ts`, not edited), and `<Link transition="tab">` (passed by `PageTabs`) covers tabs kept in the query (`ListingPage`, `RolloutsPage`).
- **The first drill-down into an uncached record shows its skeleton**, so the name has no other end on the new page: it leaves with the list. It flies once the record is cached (the smoke suite checks both). Prefetching the record on row hover would make the first flight work too (proposed follow-up).
- **SegmentedControl uses the transform-only thumb**, not a View Transition: a snapshot paints above the live page, so a morphing background would cover the labels it passes, and a second `pk-indicator` on a page that also has `PageTabs` would be a duplicate name.
- **No page transition under an overlay.** A navigation made from the palette, a menu, a confirm or the phone navigation (the overlay open or still running its exit) swaps the page at once under the overlay's exit: the transition's snapshots would paint over it (S-23 §3.4). Tooltips do not count. Covered by a unit test and the smoke suite (palette → Tiers).
- **Route tabs on the other record pages** (`TierRecord`, `UserRecord`, `PackageRecord`, `FeedPage`, `ListingPage`, `RolloutsPage`) morph their indicator; their panels are not marked `pk-vt-tabpanel` yet, so the panel swaps at once there (proposed for MO-13).

## Steps

1. Wrap navigation in the router.
2. Add the tab and segmented indicators.
3. Extend the smoke suite.
4. Record a strip of each with `tools/strips.mjs`'s technique for the PR.

## Acceptance criteria

- [x] A sibling route change, a drill-down and Back each start a View Transition with `data-vt` `route`, `forward` and `back` (smoke suite).
- [x] Focus lands on the new page's `h1` and the live region announces it, as today.
- [x] A tab switch morphs the indicator and fades the panel; keyboard tab order is unchanged.
- [x] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

MO-09 and MO-11 rely on the router not starting a route transition for query-only changes. The role agent sets `--set MO-04 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-04 done`.
