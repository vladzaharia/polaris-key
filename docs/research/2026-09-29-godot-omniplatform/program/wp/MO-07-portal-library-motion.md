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

## Corrections found while building (2026-10-06)

Checked against `main` at `221d18a85`; where the brief and the code disagreed, the code won:

- **"PX-16's just-added state" is the Discover tile's.** On `main` it is a green edge with
  **In your library** on the art and **Open <product>** (PORTAL.md §4.16); the words that carry
  the meaning are "In your library", not "Added just now". The plate pops in once (`pk-pop-in`)
  and the ring fades in once (`pk-content-in`, opacity only: `pk-pop-in` scales from 0.9, which
  would pass a 1 px ring inside the card's edge), when an Add goes through on screen; a tile
  already added when it mounts (`?added=` after a reload) just shows them. The ring moved from
  the card (`ring-1`) to an `aria-hidden` overlay outside the card's clip; the final pixels are
  unchanged.
- **The Library's 24-hour "Added just now" ring is not on `main`.** EXPERIENCE §0.7 (frame 7)
  and MO-06's Out list point it here, but it is a feature, not motion: new copy, a new rule on
  `addedAt`, and a new tile layout, and it would re-record the visual baselines of every scenario
  with the 60-second-old Mossgarden fixture. Left out; proposed as a follow-up for the portal
  (PX) owner. Its motion, when it lands, is the same `pk-pop-in`.
- **`.pk-lift` cannot sit on the card**: the card clips its art (`overflow-hidden`), which also
  clips the lift's shadow (the prototype has the same latent bug). Tiles get a wrapper that
  carries the lift.
- **`.pk-pressable` on a Library tile would press it for its own buttons too**: `:active`
  matches every ancestor of the pressed element. An additive pattern in `motion.css`,
  `.pk-pressable-card:has(.pk-press-link:active)`, presses the tile only for its link. Discover
  tiles have no link of their own, so only their Add button presses (MO-08's `Button`).
- **MO-12 has landed**: the reduced-motion checks cover both `prefers-reduced-motion` and the
  stored preference (`pk-admin-motion` → `html[data-motion="reduce"]`).
- **The console layout lint does not cover the portal**, so "art never shifts layout" is checked
  directly in the e2e suite: the art boxes measured before and after the image loads, and no
  `layout-shift` entry with a source inside `[data-art]`.
- **The e2e cases are in their own file**, `e2e/libraryMotion.e2e.test.ts` (as MO-10 did with
  `shellMotion.e2e.test.ts`), because MO-04, MO-05 and MO-09 extend `e2e/motion.e2e.test.ts` in
  parallel.
- **"First load"** means the page's first mount in this document, with its data still pending,
  outside a View Transition, and only until the first render with the data has committed
  (`useFirstLoad` in `src/portal/stagger.ts`). A return to the page (cached or not) does not
  stagger, nor does a refetch (also one that changes the layout tier: empty → grid, 1 → 2,
  7 → 8, 8 → 7, Discover's empty state → offers), a search, a filter, a sort or a view switch,
  and a list rendered while `html[data-vt]` is set never starts its stagger. This is the
  integration point with MO-05: Back from a product remounts the Library inside MO-05's `back`
  transition (the tile morph), so the stagger stays out of it without depending on MO-05's router.
- **The Grid/List transition names regions, not tiles**: the products section's heading and view,
  and the page's blocks (`.pk-vt-scope` on the page), so it costs the same for 8 or 800 products
  and stays far inside the 30-row budget.

## Files it touches

`portal/pages/{LibraryPage,DiscoverPage}.tsx`, `portal/components/{LibraryTile,LibraryList,ProductArt,DiscoverTile}.tsx`, new `portal/stagger.ts`, `src/motion.css` (additive: `.pk-pressable-card`, `.pk-img-in`), `test/portalLibraryMotion.test.tsx`, new `e2e/libraryMotion.e2e.test.ts`. `LibraryToolbar.tsx` needed no change (the toggle's transition lives in `LibraryPage`). In flight: `wp/PX-16`, `integ/identity-store-1` (both merged since).

## Steps

1. Stagger and lift.
2. Art fade-in.
3. Grid ↔ list morph.
4. Ring; smoke cases; strips.

## Acceptance criteria

- [x] First load staggers at most 6 steps; a refetch or filter does not restagger (test).
- [x] Art never shifts layout (layout lint at zero).
- [x] The view toggle runs one list transition.
- [x] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [x] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations. (2026-10-06: `test:e2e` had zero CSP violations; its 8 failures were main's at this branch's merge point, in files this branch does not touch, and are fixed on main by `e3e8042c4`. The portal's linux baselines match unchanged: 197/197 in Playwright's image.)

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

None beyond the patterns. The role agent sets `--set MO-07 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-07 done`.
