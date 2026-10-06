# MO-13 Motion QA closeout: frame strips of every pattern in the real app (both themes, reduced), the 4× CPU frame budget in CI-optional e2e, the contributor docs page and the component inventory updated

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 4: closeout)                                                                                                                                                                                                                                                                                                                                                             |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                        |
| Depends on  | [MO-04](MO-04-console-navigation-motion.md), [MO-05](MO-05-portal-navigation-motion.md), [MO-06](MO-06-portal-device-activation-motion.md), [MO-07](MO-07-portal-library-motion.md), [MO-08](MO-08-console-overlay-controls-motion.md), [MO-09](MO-09-console-data-motion.md), [MO-10](MO-10-console-shell-motion.md), [MO-11](MO-11-console-moments-counters.md), [MO-12](MO-12-reduce-motion-preference.md) |
| Unblocks    | none                                                                                                                                                                                                                                                                                                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                            |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                            |
| Gates       | `test:e2e` (the strips and frame checks run behind an opt-in variable); `pnpm --filter @polaris-key/docs check:links`; `adminCspParity`                                                                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                     |

## Goal

The motion system is proven in the real app, not just the prototypes: every pattern has a strip, every moment meets the frame budget at 4× CPU, and contributors have one page that says how to add motion.

## Why

The prototypes tuned the rules (notes/S-23 §3.4–§3.5); the app has to show the same results, and the limits in §11 (one machine, no Firefox) should be re-checked where possible.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- [`prototype/motion/tools/`](../../prototype/motion/tools/) (`strips.mjs`, `perf.mjs`, `real-app.ts`).
- `packages/docs/src/content/docs/contribute/`, `docs/design/admin/components.md`.

## Scope

**In:**

- `PK_MOTION_STRIPS=<dir>` mode in `e2e/motion.e2e.test.ts` writing a strip per pattern (both themes, plus reduced) with the CDP playback-rate technique.
- A frame check per moment at 4× CPU throttling: p95 ≤ 33 ms (opt-in, not a CI blocker on shared runners).
- Firefox: run the smoke suite in Firefox where Playwright's Firefox launches (CI's Linux runner) and record the result.
- A contributor page "Adding motion" (tokens, patterns, the rules, how to test) under `packages/docs/src/content/docs/contribute/`, and `docs/design/admin/components.md` rows for `src/ui/motion`.

**Out** (and where it belongs instead):

- New motion.

## Design notes

- The docs site is gated (AGENTS.md rule 11); a new page needs its `check:links` pass and, if linked from the console, the `docsLinks` tables.

## Files it touches

`e2e/motion.e2e.test.ts`, a new docs page, `docs/design/admin/components.md`.

## Steps

1. Strips mode.
2. Frame check.
3. Firefox run.
4. Docs.

## Acceptance criteria

- [ ] A strip exists for every pattern of notes/S-23 §6.1 in both themes and reduced, and the PR links them.
- [ ] Every moment meets p95 ≤ 33 ms at 4× CPU on the measuring machine (numbers in the PR).
- [ ] The docs page builds and `check:links` passes.
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin build
PK_MOTION_STRIPS=/tmp/strips mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
mise exec node@22 -- pnpm --filter @polaris-key/docs build && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

Marked done last; the phase is complete when it is. The role agent sets `--set MO-13 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-13 done`.
