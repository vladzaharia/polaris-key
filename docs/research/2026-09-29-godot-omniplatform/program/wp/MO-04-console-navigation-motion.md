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

## Steps

1. Wrap navigation in the router.
2. Add the tab and segmented indicators.
3. Extend the smoke suite.
4. Record a strip of each with `tools/strips.mjs`'s technique for the PR.

## Acceptance criteria

- [ ] A sibling route change, a drill-down and Back each start a View Transition with `data-vt` `route`, `forward` and `back` (smoke suite).
- [ ] Focus lands on the new page's `h1` and the live region announces it, as today.
- [ ] A tab switch morphs the indicator and fades the panel; keyboard tab order is unchanged.
- [ ] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

MO-09 and MO-11 rely on the router not starting a route transition for query-only changes. The role agent sets `--set MO-04 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-04 done`.
