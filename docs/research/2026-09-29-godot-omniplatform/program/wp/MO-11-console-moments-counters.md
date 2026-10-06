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

### Corrections from the code (MO-11 build, 2026-10-06)

- **The attention list lives in `console/templates/Dashboard.tsx`** (`AttentionList`), so the stagger
  is there: an optional `stagger` prop fed by `useFirstLoad(page, pending)`. The moment model and
  its banner are a new `console/components/Moment.tsx`. `console/pages/core/Welcome.tsx` (UX-20's
  welcome, rendered on Overview) carries §0.7's "Product created" check. `src/motion.css`'s
  `.pk-countdown` pattern gains a start offset and a still picture (below).
- **No launch path on `main`** (UX-21 has not landed): "Product launched" is Overview's setup
  checklist finishing, judged only once every list it reads has loaded.
- **"First" must be new.** A product older than this feature already has its catalog and
  releases, so a moment counts only when its milestone is within a week: a release's
  `publishedAt`, or, for moments with no time of their own (catalog, store, launched), a stored
  sighting of the product _before_ the milestone within that week. Anything older is recorded as
  seen, silently.
- **First load = the page's first mount in the document**, not "data pending at mount": Overview
  gets its product at once from the products list (`placeholderData`), so a pending rule would
  never stagger. A route change's View Transition still suppresses it.
- **The trust window is 300 s** (`TRUST_CACHE_SECONDS`), so the ring drains over five minutes,
  started mid-window through `--pk-countdown-elapsed` (a negative delay).
- **Reduced motion and the ring**: S-23 §6.6 says rings "stay full"; this package follows the
  stricter rule that reduced motion reaches the _same_ end state, instantly: the ring is a still
  picture of the spent share (`--pk-countdown-spent`), updated with the seconds, with no animation.

## Steps

1. Celebrations.
2. Countdown and meter.
3. Staggers.
4. Smoke cases.

## Acceptance criteria

- [x] Each moment shows once per product (a stored key; a test).
- [x] The countdown text is accurate with motion off; the ring is `aria-hidden`.
- [x] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [x] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

None. The role agent sets `--set MO-11 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-11 done`.
