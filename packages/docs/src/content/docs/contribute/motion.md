---
title: "Add motion"
description: "Move a surface on the shared motion system: the tokens, the pattern for each change, the rules, and how to test it."
type: "reference"
lastReviewed: "2026-10-23"
sidebar:
  order: 11
---

Motion is one system across the console, the portal (Polaris Locker) and the UI kits. The note [S-23](https://github.com/vladzaharia/polaris-key/blob/main/docs/research/2026-09-29-godot-omniplatform/notes/S-23-motion-system.md) is the specification;
this page is the way in. Use a pattern below instead of writing a new keyframe.

## Tokens

The tokens live in `MOTION` in `packages/brand/src/tokens/scales.ts`. `pnpm gen brand` emits them
to each language. Never type a duration, a distance or a curve.

| Surface            | Where the tokens are                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| Console and portal | `--pk-duration-*`, `--pk-ease-*`, `--pk-motion-distance-*` in `tokens.css` |
| React and elements | the same CSS variables                                                     |
| Swift              | `KitTokens.Motion`                                                         |
| Kotlin             | `Motion`                                                                   |
| GDScript           | `DURATION_*_MS` and `MOTION_DISTANCE_*`                                    |

The per-surface mapping, with each platform's native curves, is in
[UI-KITS §4.8](https://github.com/vladzaharia/polaris-key/blob/main/docs/design/UI-KITS.md). Sign-in's is [SIGN-IN §3.18](https://github.com/vladzaharia/polaris-key/blob/main/docs/design/SIGN-IN.md).

## Patterns

The admin app's `src/motion.css` holds the patterns as classes and data attributes. Its JavaScript
half is `src/ui/motion/`.

| Change                                 | Use                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Dialog, popover, menu, toast in or out | `Presence`; `[data-state]` with `.pk-transient` or `animate-pk-in`           |
| Route, tab, step, theme                | `viewTransition(update, { type })`                                           |
| Element that flies to a new place      | `viewTransition` with `shared`; `.pk-vt-hero`, `.pk-vt-key`                  |
| First load of a grid or list           | `.pk-stagger`                                                                |
| Row added, removed, filtered, sorted   | `viewTransition` with `list`; `.pk-vt-scope` and `.pk-row`                   |
| Row that is new                        | `highlight(el)`                                                              |
| Inline confirm, disclosure             | `Expand`                                                                     |
| First success                          | `Celebration` with `celebrateOnce(key)`; `SuccessCheck` for a repeat success |
| Loading                                | `.pk-skeleton` inside `.pk-skeleton-group`                                   |
| Button, tile, chip                     | `.pk-pressable`; `.pk-lift` for a tile                                       |
| Progress                               | `setMeter(el, fraction)` on `.pk-meter-fill`                                 |
| Number that changes                    | `CountUp`                                                                    |
| Status word that changes               | `.pk-pop-in`, on an element keyed by the word                                |

## Rules

The rules are S-23 §6.2 (performance), §6.5 (accessibility), §6.6 (reduced motion) and §6.7 (CSP).
The ones that fail a review:

- Animate `transform` and `opacity`. The exceptions are named in §6.2.
- Reduced motion is an instant swap. A new duration comes from a token, so it collapses with the
  rest. Read it with `useReducedMotion()` only to skip work.
- Motion never carries state alone. The final DOM is in place before the animation runs.
- No `style=""`, no `<style>`. Set dynamic values through the CSSOM or a data attribute.
- Nothing that blocks input outlasts `slow` plus `micro`. Typing never triggers motion.
- Wait on `animation.finished`, never on a timer.

## Test it

- `packages/admin/test/motionLint.test.ts` bans `transition-all`, arbitrary `duration-[…]` and
  `ease-[…]`, and `style` that sets `transition`, `animation` or `transform`.
- `packages/admin/e2e/motion.e2e.test.ts` runs the pattern smoke in Chromium with motion on,
  asserting token durations, View Transitions and zero CSP violations. Every other e2e suite runs
  with reduced motion.
- Add a case beside your surface's e2e file. Set `PK_SHOTS_DIR=<dir>` to also write a frame strip
  of each pattern, in both themes and reduced, for the pull request.
- `PK_MOTION_PERF=1` is planned (MO-13.4): frame times at 4× CPU. It is opt-in and never asserted in CI.
- `PK_MOTION_BROWSER=firefox` or `webkit` runs the smoke suite in that engine. CI runs Firefox in
  the `console` job.

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin exec vitest run -c vitest.e2e.config.ts e2e/motion.e2e.test.ts
```

The console's other extension points are in [Add a page](/docs/contribute/console/).
