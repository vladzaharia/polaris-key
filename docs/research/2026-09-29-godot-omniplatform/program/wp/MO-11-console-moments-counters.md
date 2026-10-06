# MO-11 Console moments and counters: EXPERIENCE §0.7's first-time celebrations (first licence, first catalog publish, first release, store connected, product launched), the key-rotation countdown ring and refreshed-devices meter, Overview and Home attention lists stagger

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Phase       | MO: Motion system (notes/S-23) (wave 3: after UX-29 and UX-12)     |
| Size        | 0.4–0.6 engineer-weeks                                             |
| Depends on  | [MO-09](MO-09-console-data-motion.md)                              |
| Unblocks    | [MO-13](MO-13-motion-qa-closeout.md)                               |
| Role        | `pkey-implementer`                                                 |
| Plan mode   | no                                                                 |
| Gates       | admin unit tests; `test:e2e` and the smoke suite; `adminCspParity` |
| Human input | none                                                               |
| Repo        | `vladzaharia/polaris-key`                                          |

## Goal

The console marks its milestones once and quietly, and the pages that track progress (key rotation, rollouts) show it moving.

## Why

EXPERIENCE §0.7 lists the moments; none exists (notes/S-23 §4.2). The key rotation stepper (UX-29) has a countdown and a refreshed-devices line that would read better as a ring and a meter. Strip: `console-01-overview-load-dark.png`.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- [EXPERIENCE.md §0.7](../../../../design/EXPERIENCE.md)
- `console/pages/core/{Overview,Keys}.tsx`, `console/pages/global/Home.tsx`, `console/pages/license/CreateLicenseDialog.tsx` as they are after the UX branches merge.

## Scope

**In:**

- `<Celebration momentKey="<moment>:<product>">` on each §0.7 console moment, once per product.
- Keys: the rotation countdown as a `pk-countdown` ring (`--pk-countdown` through the CSSOM) with the seconds in text; the refreshed-devices percentage as a meter with `<CountUp>`.
- Overview and Home attention lists: `pk-stagger` on first load.

**Out** (and where it belongs instead):

- Anything outside the listed pages.

## Design notes

- `Overview.tsx` is edited by four in-flight branches and `Keys.tsx` by `wp/UX-29-key-rotation`; start when they merge.
- Never a pill; the burst is plain sparks, never the mark (D5); a celebration never blocks input.

## Files it touches

`console/pages/core/{Overview,Keys}.tsx`, `console/pages/global/Home.tsx`, `console/pages/license/CreateLicenseDialog.tsx`, tests. In flight: `wp/UX-29`, branches on `Overview.tsx`.

## Steps

1. Celebrations.
2. Countdown and meter.
3. Staggers.
4. Smoke cases.

## Acceptance criteria

- [ ] Each moment shows once per product (a stored key; a test).
- [ ] The countdown text is accurate with motion off; the ring is `aria-hidden`.
- [ ] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

None. The role agent sets `--set MO-11 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-11 done`.
