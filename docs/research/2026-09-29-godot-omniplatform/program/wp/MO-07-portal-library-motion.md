# MO-07 Portal Library and Discover motion: first-load stagger, tile lift and press, developer art fades in on decode, grid ↔ list morph, the "Added just now" ring, Discover tiles

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 2: areas)                                                                        |
| Size        | 0.4–0.6 engineer-weeks                                                                                                |
| Depends on  | [MO-03](MO-03-e2e-motion-determinism.md), [PX-16](PX-16-discover-page.md)                                             |
| Unblocks    | [MO-13](MO-13-motion-qa-closeout.md)                                                                                  |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | admin unit tests; portal e2e (visual baselines regenerated with reduced motion) and the smoke suite; `adminCspParity` |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Goal

The Library feels alive on arrival without slowing anyone down: tiles arrive in a short stagger on first load only, lift under the pointer, press on click, show their art without a pop, switch between grid and list as one morph, and a just-added product carries its ring.

## Why

The grid is static and art pops in as it loads (`LibraryTile.tsx`, `ProductArt.tsx`; notes/S-23 §4.2). Strip: `portal-01-library-load-dark.png` (prototype).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `portal/pages/{LibraryPage,DiscoverPage}.tsx`, `portal/components/{LibraryTile,LibraryList,LibraryToolbar,ProductArt,DiscoverTile,DiscoverTeaser}.tsx` as they are after PX-16 merges.

## Scope

**In:**

- `.pk-stagger` on the grid and list containers for the first mount only (a refetch keeps keys and does not remount; filtering does not restagger).
- `.pk-lift` and `.pk-pressable` on tiles; `.pk-lift-art` scale on hover (pointer devices only).
- ProductArt: the image fades in on `load` (a data attribute set in the handler, CSS transition), no layout shift (the box keeps its aspect).
- Grid ↔ list toggle runs `viewTransition(…, { type: "list" })` within the 30-row budget.
- PX-16's just-added state: the ring appears with `pk-pop-in` once; the text "Added just now" carries the meaning.

**Out** (and where it belongs instead):

- Tile → hero shared element (→ MO-05).

## Design notes

- Waits for `wp/PX-16-discover-page` and `integ/identity-store-1`, which own these files today.
- The twelve-product Library is the long case: stagger caps at 6 steps (180 ms).

## Files it touches

`portal/pages/{LibraryPage,DiscoverPage}.tsx`, `portal/components/{LibraryTile,LibraryList,LibraryToolbar,ProductArt,DiscoverTile}.tsx`, tests, `e2e/motion.e2e.test.ts`. In flight: `wp/PX-16`, `integ/identity-store-1`.

## Steps

1. Stagger and lift.
2. Art fade-in.
3. Grid ↔ list morph.
4. Ring; smoke cases; strips.

## Acceptance criteria

- [ ] First load staggers at most 6 steps; a refetch or filter does not restagger (test).
- [ ] Art never shifts layout (layout lint at zero).
- [ ] The view toggle runs one list transition.
- [ ] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

None beyond the patterns. The role agent sets `--set MO-07 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-07 done`.
