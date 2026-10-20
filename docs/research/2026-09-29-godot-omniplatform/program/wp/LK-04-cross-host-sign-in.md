# LK-04 Cross-host sign-in: bind hop, extends the device page and global index (A1), Locker transcripts, contract text

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                                |
| Size        | 0.75–1 engineer-weeks                                                             |
| Depends on  | [LK-00](LK-00-polaris-locker-plan.md), [LK-03](LK-03-customer-host-and-origin.md) |
| Unblocks    | [LK-11](LK-11-cutover.md)                                                         |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)             |
| Plan mode   | yes: executes plans/LK-00.md                                                      |
| Gates       | plan-mode, drift-gate, rule-10, workerd, threat-model, docs-generated             |
| Human input | none                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Goal

Cross-host sign-in: bind hop, extends the device page and global index (A1), Locker transcripts, contract text. Executes `plans/LK-00.md` §3, §5, §7.8–7.9; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §3, §5, §7.8–7.9 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §3, §5, §7.8–7.9. Anything else is another package's row in §9.

## Acceptance criteria

- [x] transcripts: 46 existing byte-identical plus four new `locker-*.json`; `pnpm gen --check` transcripts, corpus, docs-reference clean
- [x] worker `test` and `test:workerd` pass; the device page and index are extended, not rebuilt (A1)
- [x] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Corrections to the brief (2026-10-19, from the code)

- Security review: a device-confirmation hop across hosts reopens R1-07 (a forwarded bind URL binds the victim's browser to the attacker's flow). It was removed: the device page stays on the API host and the customer host's `/device` and `/tv` 302 to it. Only the request hop remains.
- The device page keeps A1/LK-03's behaviour (302 to the API host's product page).
- Owner direction mid-package: no `customer.host` switch; LK-17 removed it and the package follows (`customerHostname(env) !== null` is the cutover).
- `apiOrigin()` in `core/customerHost.ts` is gone: nothing reads it.

## Hand-off

The role agent sets `--set LK-04 in-review` when it hands off; the lead sets `done` after review.
