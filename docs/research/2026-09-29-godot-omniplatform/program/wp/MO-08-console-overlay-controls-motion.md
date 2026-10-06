# MO-08 Console overlays and controls: the Drawer slides from the edge, popovers, menus, selects and tooltips enter from their side, press states on buttons, icon buttons, switches, radio cards and copy buttons, the Button hover filter transitioned, the ⌘K palette

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | MO: Motion system (notes/S-23) (wave 2: areas)                                 |
| Size        | 0.4–0.6 engineer-weeks                                                         |
| Depends on  | [MO-02](MO-02-motion-layer.md)                                                 |
| Unblocks    | [MO-13](MO-13-motion-qa-closeout.md)                                           |
| Role        | `pkey-implementer`                                                             |
| Plan mode   | no                                                                             |
| Gates       | admin unit tests; `test:e2e` (CSP suite opens every overlay); `adminCspParity` |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

## Goal

Every control answers the hand: buttons press, the drawer slides from its edge, menus come from where they open, and nothing snaps.

## Why

There is no `active:` state anywhere; `hover:brightness-110` snaps because `filter` is not transitioned; the drawer rises like a dialog (`ui/Button.tsx:25-40`, `ui/Drawer.tsx:86`; notes/S-23 §4.2). Strip: `console-06-drawer-open-dark.png`.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `packages/admin/src/ui/{Drawer,Popover,Tooltip,ActionMenu,Select,Combobox,Button,IconButton,Switch,RadioCards,CopyButton}.tsx`, `console/shell/CommandPalette.tsx`.

## Scope

**In:**

- Drawer: `pk-drawer` enter (`slow`·`emphasized`) and exit (`base`·`exit`) from the inline end; the scrim fades.
- Popover, Tooltip, ActionMenu, Select, Combobox: side-aware entry (`data-side`), `fast` exit.
- Button, IconButton: `pk-pressable` (0.98 on `:active`, not when disabled or busy); transition `filter` with the colours, or replace `brightness-110` with a token colour.
- Switch thumb on `spring`; RadioCards border and check at `micro`; CopyButton's "Copied" swap pops.
- CommandPalette: exit; the result list never animates while typing; the selection highlight moves at `micro`.

**Out** (and where it belongs instead):

- `ui/Dialog.tsx` bottom sheet and the phone nav (in flight in UX-10 → MO-10).

## Design notes

- None of these files is in an in-flight branch on 2026-10-05.
- Press scale never on a row of buttons that would shift neighbours (scale is visual only, no layout).
- **Corrections against the code (2026-10-05, at implementation):** MO-02 already gives every
  popper (Popover, Tooltip, ActionMenu, Select in its default `popper` position, Combobox through
  `PopoverContent`) its side-aware entry and `fast` fade-out, keyed on `animate-pk-in` plus Radix's
  `data-side`, and already gives the ⌘K palette its exit; step 2 and the palette's exit are pinned
  by tests here rather than re-implemented. A start-side Drawer needs the opposite edge, so
  `src/motion.css` gains one custom property (`--pk-drawer-from`, set by
  `.pk-drawer[data-drawer-side="start"]`), the only edit outside the listed files. There is no
  accent or danger hover token, so the filled Button variants mix their token colour with 10 %
  white (`color-mix(in oklab, …)`) instead of `brightness-110`, and the motion lint gains a
  `hover-filter` rule.

## Files it touches

`ui/{Drawer,Popover,Tooltip,ActionMenu,Select,Combobox,Button,IconButton,Switch,RadioCards,CopyButton}.tsx`, `console/shell/CommandPalette.tsx`, tests.

## Steps

1. Drawer slide.
2. Side-aware popper entry.
3. Press states and the filter fix.
4. Palette.

## Acceptance criteria

- [x] The drawer animates in from the edge and out again (smoke suite).
- [x] Every button has a visible press response and none when disabled.
- [x] No hover change snaps (motion lint and a test on Button's classes).
- [x] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [x] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

MO-10 applies the same sheet treatment to `ui/Dialog.tsx` after UX-10. The role agent sets `--set MO-08 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-08 done`.
