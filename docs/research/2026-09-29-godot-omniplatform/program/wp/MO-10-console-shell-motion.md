# MO-10 Console shell motion (after UX-10 merges): the phone bottom sheet slides up, the phone nav drawer slides from the edge, the route Suspense fallback becomes a skeleton, sidebar and state pages, Tailwind aliases for the new keyframes, and `animate-pulse` retired on platform pages and Home

| Field       | Value                                                        |
| ----------- | ------------------------------------------------------------ |
| Phase       | MO: Motion system (notes/S-23) (wave 3: after UX-10)         |
| Size        | 0.4–0.7 engineer-weeks                                       |
| Depends on  | [MO-02](MO-02-motion-layer.md)                               |
| Unblocks    | [MO-13](MO-13-motion-qa-closeout.md)                         |
| Role        | `pkey-implementer`                                           |
| Plan mode   | no                                                           |
| Gates       | admin unit tests; `test:e2e` (CSP, layout); `adminCspParity` |
| Human input | none                                                         |
| Repo        | `vladzaharia/polaris-key`                                    |

## Goal

The shell moves like the rest: sheets and the phone nav slide from their edges, a lazy page loads behind a skeleton instead of a spinner and "Loading…", and no page pulses.

## Why

The phone nav and bottom sheet reuse the 4 px rise, `PageLoading` is a spinner with text, and platform pages pulse (`console/shell/AppShell.tsx:373,407-414`, `ui/Dialog.tsx:116-118`; notes/S-23 §4.2–§4.3).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `ui/Dialog.tsx`, `console/shell/{AppShell,Sidebar,StatePages,ShortcutSheet}.tsx`, `src/styles.css` (as they are after `wp/UX-10-shared-layer` merges), the platform pages listed below.

## Scope

**In:**

- `ui/Dialog.tsx`: below 640 px `pk-sheet` slides up (`slow`·`emphasized`) and down (`base`·`exit`).
- AppShell: the phone nav drawer slides from the inline start; `PageLoading` becomes `PageSkeleton` with the 150 ms grace; the sidebar rail toggle cross-fades labels (no width animation).
- Sidebar collapsible keeps its Radix height keyframes (allowed: the expand exception) on the new tokens; StatePages and ShortcutSheet use enter/exit.
- `styles.css`: `--animate-pk-*` aliases for the MO-02 keyframes so components can use Tailwind utilities.
- Replace `animate-pulse` in `console/pages/{platform,platformOperations,platformSettings,platformStores}.tsx` and `global/Home.tsx` with shaped skeletons; empty the motion lint allowlist.

**Out** (and where it belongs instead):

- Account menu Reduce motion row (→ MO-12).

## Design notes

- Start only after `wp/UX-10-shared-layer` (and `integ/ux-1a-ha`) merge: they rewrite these shell files, `Dialog.tsx` and `styles.css`. `platformSettings.tsx` is also edited by `wp/ST-06` and `wp/ST-01b`: rebase.

## Files it touches

`ui/Dialog.tsx`, `console/shell/{AppShell,Sidebar,StatePages,ShortcutSheet}.tsx`, `src/styles.css`, `console/pages/{platform,platformOperations,platformSettings,platformStores}.tsx`, `console/pages/global/Home.tsx`, tests. In flight: `wp/UX-10`, `integ/ux-1a-ha`, `wp/ST-06`, `wp/ST-01b`.

## Steps

1. Sheet and phone nav.
2. Skeleton fallback.
3. Aliases in `styles.css`.
4. Retire `animate-pulse`; empty the allowlist.

## Acceptance criteria

- [ ] No `animate-pulse` remains in `packages/admin/src` and the motion lint allowlist is empty.
- [ ] The phone sheet and nav slide in and out (smoke suite at 390 px).
- [ ] A lazy route shows a skeleton, never "Loading…" text.
- [ ] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

None beyond the patterns. The role agent sets `--set MO-10 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-10 done`.
