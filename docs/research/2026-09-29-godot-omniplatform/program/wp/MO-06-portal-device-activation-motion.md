# MO-06 Portal devices and activation moments: Remove/Replace inline confirm expands, freed devices leave the list, the seat meter and count animate, the Activate dialog morphs between steps and celebrates the first activation, FreeDevicePage success

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 2: areas)                                    |
| Size        | 0.5–0.8 engineer-weeks                                                            |
| Depends on  | [MO-03](MO-03-e2e-motion-determinism.md), [SP-08](SP-08-apple-platform-values.md) |
| Unblocks    | [MO-13](MO-13-motion-qa-closeout.md)                                              |
| Role        | `pkey-implementer`                                                                |
| Plan mode   | no                                                                                |
| Gates       | admin unit tests and axe; portal e2e and the smoke suite; `adminCspParity`        |
| Human input | none                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Goal

Freeing a device and activating a licence feel like events: the confirm opens in place, the row leaves and the list closes up, the meter drains or fills while the count changes, the Activate dialog morphs to its success state with one check and burst, and every change is also stated in text.

## Why

All of these are instant today (`DevicesCard.tsx:158-237`, `FreeDevicePage.tsx:203-215`, `ActivateDialog.tsx:220-248`; notes/S-23 §4.2) and EXPERIENCE §0.7's "It's yours" moment does not exist. Strips: `portal-04` to `portal-07`.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `portal/components/product/DevicesCard.tsx`, `portal/components/SeatMeter.tsx` (CSP-safe width table), `portal/pages/FreeDevicePage.tsx`, `portal/components/ActivateDialog.tsx`.
- [EXPERIENCE.md §0.7](../../../../design/EXPERIENCE.md) and [SIGN-IN.md §3.7](../../../../design/SIGN-IN.md) (Replace a device, the same expand pattern).

## Scope

**In:**

- DevicesCard: the inline Remove confirm uses `.pk-expand` (focus to its heading, back to the trigger on cancel, as today); removal runs `viewTransition(…, { type: "list" })` with the card as `.pk-vt-scope`; the toast keeps **Undo**.
- SeatMeter: segments ease colour and pulse once on change (`data-changed`); the continuous variant fills with `transform: scaleX` through `setMeter` (no width class swap mid-animation); the count uses `<CountUp>`.
- ActivateDialog: step changes run `viewTransition(…, { type: "dialog" })` with the panel as `pk-vt-dialog` (old content out `fast`, new in after `micro`, size morph `moderate`); the done step renders `<Celebration momentKey="first-activation:<account>">` once per account; focus moves to the step heading on `updateCallbackDone`.
- FreeDevicePage: the removed-device success uses the check (no burst: it is not a first-time moment).
- Smoke-suite cases: list exit names ≤ 30 rows; dialog morph; celebration shown once.

**Out** (and where it belongs instead):

- The sign-in card's LicenseChoice and Replace (→ SIGN-IN.md's packages, same patterns).
- Library tile ring "Added just now" (→ MO-07).

## Design notes

- Depends on SP-08 because `wp/SP-08-apple-platform-values` edits `DevicesCard.tsx` and `FreeDevicePage.tsx`.
- PX-17 (activate confirm step) also edits `ActivateDialog.tsx`; whichever lands second rebases. The motion change is additive (a wrapper and a class).
- The new state is in the DOM before any animation (D3); the live region announces "Studio PC removed. 1 of 3 devices in use."

## Files it touches

`portal/components/product/DevicesCard.tsx`, `portal/components/SeatMeter.tsx`, `portal/components/ActivateDialog.tsx`, `portal/pages/FreeDevicePage.tsx`, tests, `e2e/motion.e2e.test.ts`. In flight: `wp/SP-08` (DevicesCard, FreeDevicePage).

## Steps

1. Expand and list exit in DevicesCard.
2. Meter and count.
3. Dialog morph and the celebration.
4. Smoke cases and strips.

## Acceptance criteria

- [ ] Removing a device runs a list transition, the meter and count reach the new value, and the text says the new count (unit + e2e).
- [ ] The Activate success shows the celebration exactly once per account (a second activation shows the check only).
- [ ] axe passes on every state; focus order matches today's.
- [ ] Under `prefers-reduced-motion: reduce` (and `html[data-motion="reduce"]` once MO-12 lands) every change in scope is an instant swap: no View Transition starts and `document.getAnimations()` is empty after the interaction (checked in the motion smoke suite or a unit test).
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

The expand, list and dialog-morph usages here are the reference for the sign-in card's Replace and step morph. The role agent sets `--set MO-06 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-06 done`.
