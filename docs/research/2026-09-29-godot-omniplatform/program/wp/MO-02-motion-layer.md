# MO-02 The motion layer in the console app: `src/ui/motion/` (`viewTransition`, `useReducedMotion`, `Presence`, `CountUp`, `setMeter`, `highlight`, `Celebration`) and `src/motion.css` (keyframes, the nine patterns, gated View Transition rules), exit animations for every Radix overlay, sonner on the tokens, the missing `pk-refetch`, and a motion lint

| Field       | Value                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 1: foundation)                                                                                                                                |
| Size        | 0.6–1 engineer-weeks                                                                                                                                                               |
| Depends on  | [MO-01](MO-01-brand-motion-tokens.md)                                                                                                                                              |
| Unblocks    | [MO-03](MO-03-e2e-motion-determinism.md), [MO-08](MO-08-console-overlay-controls-motion.md), [MO-10](MO-10-console-shell-motion.md), [MO-12](MO-12-reduce-motion-preference.md)    |
| Role        | `pkey-implementer`                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                 |
| Gates       | `adminCspParity` after the admin build; `pnpm --filter @polaris-key/admin test` (unit + the new motion lint); `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations |
| Human input | none                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                          |

## Goal

Both apps (console and portal) load one bundled `src/motion.css` and can import `src/ui/motion`; every Radix overlay animates **out** as well as in; toasts run on the tokens; the layer is CSP-clean, does nothing under reduced motion, and a lint keeps new code on the tokens.

## Why

Today no overlay animates out (Radix unmounts at once; `prototype/motion/shots/today-portal-activate-close.png`), `animate-pk-refetch` is used but undefined (`ui/loading.tsx:57`), and there is no shared way to run a View Transition, a count or a success moment. notes/S-23 §4.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `packages/admin/src/styles.css` (keyframes, `@theme`), `src/main.tsx` and `src/portal/main.tsx` (entries), `vite.config.ts` (the CSP shims), `ui/Dialog.tsx`, `ui/Popover.tsx`, `ui/toast.tsx`, `ui/loading.tsx`, `ui/LiveRegion.tsx`.

## Scope

**In:**

- `src/motion.css` (new), imported from both entries **after** `styles.css`: the keyframes and patterns of `prototype/motion/motion.css` §2–§6 on the MO-01 tokens; the View Transition rules gated by `html[data-vt]` with the console main region selected as `main#content` and the portal's as its main element, so `AppShell.tsx` and `PortalShell.tsx` need no edit.
- **Exit animations without touching component files:** `.animate-pk-in[data-state="closed"]` and `.animate-pk-overlay-in[data-state="closed"]` run the exit keyframes (Radix Presence waits for `animationend`); side-aware entry from `[data-side]` for popper content.
- sonner: map its transition durations to `--pk-duration-*` in `motion.css` (its own reduced-motion rule stays).
- Define `pk-refetch` (an indeterminate sweep, transform only, stopped under reduced motion) for `.animate-pk-refetch`.
- `src/ui/motion/`: `reducedMotion()` and `useReducedMotion()` (media query **or** `html[data-motion="reduce"]`); `viewTransition(update, { type, shared, list })` returning `{ updateCallbackDone, finished }` (synchronous update; React callers wrap state in `flushSync`; skips a running transition; list budget 30 rows, then only rows on screen; no-op without the API or under reduced motion); `<Presence open>` for non-Radix transients; `useCountUp` / `<CountUp>` (frame timestamps, `aria-hidden` visible text plus a visually hidden final value); `setMeter(el, value)`; `highlight(el)`; `<Celebration momentKey>` (check draw + six sparks, once per stored key, `aria-hidden`, static check under reduced motion).
- `test/motionLint.test.ts`: fails on `transition-all`, arbitrary `duration-[…]` / `ease-[…]`, raw `ms` values in class strings, JSX `style` that sets `transition`, `animation` or `transform`, and new `animate-pulse` (today's 12 sites allowlisted by path until MO-09 and MO-10 clear them).
- Unit tests for the layer (jsdom: the API is absent, so every function must no-op cleanly).

**Out** (and where it belongs instead):

- Wiring transitions into the routers (→ MO-04, MO-05).
- Component-specific motion (drawer slide → MO-08; bottom sheet → MO-10; tables → MO-09).
- E2E reduced-motion switches and the motion smoke suite (→ MO-03).

## Design notes

- CSP (D8): the layer writes data attributes, classes and CSSOM properties only; no `style=""`, no `<style>`, no inline script. `prototype/motion/tools/csp-probe.mjs` shows what is allowed.
- Do **not** edit `styles.css`: `wp/UX-10-shared-layer` and `integ/ux-1a-ha` change it. Tailwind `--animate-*` aliases for the new keyframes can move there after UX-10 merges (MO-10).
- Names are applied only under the matching `data-vt` type (notes/S-23 §3.4 item 1): a permanently named element paints over dialog scrims.
- The page takes no input during a View Transition (§3.3): keep route and tab transitions at `base` + `micro`.
- `Celebration` keys live in `localStorage` (`pk-moment:<key>`), wrapped in try/catch.

## Files it touches

New: `src/motion.css`, `src/ui/motion/{index,viewTransition,reducedMotion,Presence,CountUp,meter,highlight,Celebration}.ts(x)`, `test/motion/*.test.ts(x)`, `test/motionLint.test.ts`. Edited: `src/main.tsx`, `src/portal/main.tsx` (one import each). No in-flight branch touches these.

## Steps

1. Port `motion.css` onto the MO-01 tokens; add the exit selectors keyed on the existing utility classes and the sonner mapping.
2. Port `motion.js` to TypeScript modules and React wrappers.
3. Import `motion.css` in both entries.
4. Write the unit tests and the motion lint.
5. Run the e2e suites and fix any test that asserted an overlay was gone synchronously (use Playwright's auto-waiting `toBeHidden`).

## Acceptance criteria

- [ ] Every Radix overlay (Dialog, Drawer, Popover, Tooltip, DropdownMenu, Select, the ⌘K palette, the portal's JumpPalette) has an exit animation from the tokens: a unit or e2e check reads `getAnimations()` on a closing node.
- [ ] `.animate-pk-refetch` animates (and does not under reduced motion).
- [ ] `viewTransition()` runs `update` synchronously and returns resolved promises when the API is missing or motion is reduced (unit tests).
- [ ] `<CountUp>` exposes exactly one accessible number (axe and a test).
- [ ] The motion lint passes on `main`'s code with the allowlist, and fails on a fixture containing each banned pattern.
- [ ] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

MO-03 to MO-12 import from `src/ui/motion` and use the classes in `src/motion.css` (`pk-stagger`, `pk-expand`, `pk-skeleton`, `pk-pressable`, `pk-lift`, `pk-pill`, `pk-pop-in`, `pk-vt-*`). The API names above are the contract. The role agent sets `--set MO-02 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-02 done`.
