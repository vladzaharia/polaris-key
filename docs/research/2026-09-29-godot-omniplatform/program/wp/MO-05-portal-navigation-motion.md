# MO-05 Portal navigation motion: route transitions with scroll reset and heading focus, Library tile → product hero shared element, smooth section scroll gated by reduced motion, JumpPalette exit

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Phase       | MO: Motion system (notes/S-23) (wave 2: areas)                     |
| Size        | 0.4–0.6 engineer-weeks                                             |
| Depends on  | [MO-03](MO-03-e2e-motion-determinism.md)                           |
| Unblocks    | [MO-13](MO-13-motion-qa-closeout.md)                               |
| Role        | `pkey-implementer`                                                 |
| Plan mode   | no                                                                 |
| Gates       | admin unit tests; portal e2e and the smoke suite; `adminCspParity` |
| Human input | none                                                               |
| Repo        | `vladzaharia/polaris-key`                                          |

## Goal

Opening a product from the Library flies its art and name into the product hero, going back flies them home, every portal navigation resets scroll and focuses the new heading, and section links scroll smoothly only when motion is allowed.

## Why

The portal swaps routes instantly with no scroll reset or focus move, and `scrollIntoView({ behavior: "smooth" })` ignores reduced motion (`ProductPage.tsx:180`, `AccountPage.tsx:49`; notes/S-23 §4.2). Strips: `portal-02-tile-to-product-*.png`, `portal-08-back-to-library-dark.png`.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `packages/admin/src/portal/router.ts` (`useRoute`), `portal/App.tsx` (read only: in flight), `portal/components/product/ProductHeader.tsx`, `portal/pages/{ProductPage,AccountPage}.tsx`, `portal/focus.ts`, `portal/components/JumpPalette.tsx`.

## Scope

**In:**

- `portal/router.ts`: navigation through `viewTransition(…, { type })` (`forward` into a product, `back` to the Library or Discover, `route` between top-level pages); scroll to top and focus the `h1` on `updateCallbackDone` unless a pending heading focus (`portal/focus.ts`) or a deep-link section says otherwise.
- Shared element without editing `LibraryTile.tsx` (in flight): a delegated click listener in the router marks the clicked tile (`data-vt-source`) and the layer names its art and title for one transition; the product hero art and title in `ProductHeader.tsx` carry `pk-vt-hero` / `pk-vt-hero-title` (gated by type); both titles `width: fit-content`; the art shows only the new snapshot (motion.css).
- Smooth section scrolling uses `behavior: reducedMotion() ? "auto" : "smooth"`.
- JumpPalette: exits via MO-02's selectors; results never animate while typing.
- Smoke-suite cases for the portal route and the shared element.

**Out** (and where it belongs instead):

- Library grid stagger, tile lift and art fade-in (→ MO-07).
- Device and activation flows (→ MO-06).

## Design notes

- `portal/App.tsx` is edited by `wp/PX-16` and `integ/identity-store-1`; keep this package to `router.ts` and the listed files.
- Back from a product scrolls the Library to the tile it came from before the transition captures the new state, so the morph lands on the visible tile.

## Corrections (as built, 2026-10-06)

- **One route store.** `useRoute()` is called by the shell, by every `QuickAction` and by the
  sign-in page, so per-hook listeners would each start a transition. The router now keeps one
  store (`useSyncExternalStore`); the hash and route events, the delegated click listener and
  `history.scrollRestoration = "manual"` (the router places the page on every navigation; the
  browser's own restoration would move the outgoing page first) are installed once.
- **Navigation kinds.** `navigationKind()` adds two non-transition kinds to `forward`, `back` and
  `route`: `section` (same page, another section: it scrolls there, smooth only with motion, and
  focus stays, like an in-page link) and `params` (same page and section, other query: nothing
  moves, so typing never animates).
- **No View Transition while a dialog is on screen.** A JumpPalette jump (and Activate's "Open
  <product>") navigates while the dialog runs its exit; a transition then would lift the page
  above the scrim (S-23 §3.4 item 1). Such a navigation is an instant swap under the closing
  overlay, and the heading focus waits for the overlay to leave: a closing Radix dialog hands focus
  back to its opener when it unmounts, which would otherwise take focus off the new page's `h1`
  (`focusPageHeading()` in `router.ts`, used by the router, `ProductPage` and `JumpPalette`).
- **A third shared element, `pk-hero-icon`.** The product icon sits in front of the art's lower
  edge in both the tile and the hero; with only the art named, the flying art covered it and it
  popped back at the end (seen in the real-app strips). It now flies with the art and the name
  (`pk-vt-hero-icon` on the hero's `ProductIcon`; the tile's icon is named by the router).
- **`motion.css`, additive only:** the gated `pk-hero-icon` name and its `slow`·`emphasized`
  group, and `:only-child` rules so an unpaired hero end (a product opened from a toast, Back to a
  Library whose filter hides the tile) fades through with the main region instead of vanishing.
- **The tile's title needs no change.** `LibraryTile`'s name sits in a shrink-to-fit flex item, so
  its `h3` is already as wide as its text; only the hero's `h1` gains `width: fit-content` (`w-fit`).
- **`portal/focus.ts`** gains `pendingHeadingFocus()` (a read that does not consume), so the router
  leaves a pending request to the product page.
- **AccountPage's smooth scroll was already gated** by MO-12; it now uses the router's
  `scrollBehavior()` like ProductPage, and its deep-link effect runs on mount only (the router
  scrolls to a section the URL names later, so the page no longer undoes that with an instant
  scroll). Its `h1` is focusable (`tabIndex={-1}`); the Library's and Discover's headings are made
  focusable by the router at focus time, so `LibraryPage`/`DiscoverPage` (MO-07) stay untouched.
- **Fix round (review, 2026-10-06).** Back lands on the tile it came from with or without motion
  (the router owns scroll restoration); it remembers which of a product's tiles opened it (the
  Library can list a product twice: its attention list and its grid). A heading-focus request
  defers the router only when it is for the product being opened, so an unconsumed one never holds
  another page's focus; the focus also waits for a loading placeholder `h1` (inside `aria-busy`)
  to give way to the real one. `scrollBehavior()` is `instant` (not `auto`) under reduced motion.
  A link to a product's first section keeps the page at its top, as the deep link on mount does
  (`ProductPage` marks it with `data-first-section`). `pk-hero-icon` joins the shared-element
  group rule.
- **Strips** of the real app (tile → product and back, both themes, and reduced motion) were
  recorded locally with the S-23 `real-app.ts` method for review; committing real-app strips of
  every pattern is MO-13's.

## Files it touches

`portal/router.ts`, `portal/focus.ts` (one export), `portal/components/product/ProductHeader.tsx`, `portal/pages/ProductPage.tsx`, `portal/pages/AccountPage.tsx`, `portal/components/JumpPalette.tsx`, `src/motion.css` (additive rules), `test/portalNavigation.test.tsx`, `e2e/motion.e2e.test.ts`. No in-flight branch touches them on 2026-10-05.

## Steps

1. Wrap navigation; add scroll and focus.
2. Add the delegated source marking and the hero classes.
3. Gate smooth scrolling.
4. Extend the smoke suite; record strips.

## Acceptance criteria

- [ ] Library → product and back each run a View Transition that pairs `pk-hero` and `pk-hero-title` (smoke suite reads the pseudo-element animations).
- [ ] Every portal navigation leaves `scrollY` at 0 (or the deep-linked section) and focus on the page heading; screen readers hear the page once.
- [ ] Section links scroll instantly under reduced motion.
- [ ] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

MO-07 adds the Library's own motion on top; MO-06 uses the product page's focus contract. The role agent sets `--set MO-05 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-05 done`.
