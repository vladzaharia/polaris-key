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

- The plan's bind hop covers `authorize` only. A device confirmation made on the customer host
  would also lose its flow binder: the IdP calls back on the API host, and `__Host-pk_lcb` set on
  the customer host never reaches it. LK-04 adds a second hop of the same kind
  (`GET /<p>/identity/auth/device/continue?bind=`, one new route: OpenAPI, `routeCoverage`,
  CORS-excluded) and widens the device page's `form-action` to the API host.
- The device page was already served by LK-03/A1 with a 302 to the API host; it is now served on
  the customer host by running the product's own device handler there (`dispatch.ts`), and the
  product's page on the API host 303s to `<customer>/device`.
- Owner direction mid-package (2026-10-19): no `customer.host` switch. `customerHostMode()` now answers `on` whenever `CUSTOMER_ORIGIN` is usable and `off` otherwise, without reading the setting; the hops, the device page and the transcripts follow that. The setting, its console row, `CUSTOMER_HOST` and LK-03's switch tests are vestigial: retiring them is a follow-up (settings page, `env.ts`, platform inventory).
- `apiOrigin()` in `core/customerHost.ts` is gone: nothing reads it.

## Hand-off

The role agent sets `--set LK-04 in-review` when it hands off; the lead sets `done` after review.
