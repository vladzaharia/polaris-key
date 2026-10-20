# LK-17 Hard cutover: remove the customer.host switch, 301 old customer URLs, console hash hand-off

| Field       | Value                                              |
| ----------- | -------------------------------------------------- |
| Phase       | LK: Polaris Locker                                 |
| Size        | 0.5–0.75 engineer-weeks                            |
| Depends on  | [LK-03](LK-03-customer-host-and-origin.md)         |
| Unblocks    | [LK-11](LK-11-cutover.md)                          |
| Role        | `pkey-implementer`                                 |
| Plan mode   | no                                                 |
| Gates       | rule-9, rule-10, drift-gate, workerd, threat-model |
| Human input | none                                               |
| Repo        | `vladzaharia/polaris-key`                          |

## Goal

Hard cutover: remove the customer.host switch, 301 old customer URLs, console hash hand-off. Executes `plans/LK-00.md` §16; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §16 (plus §7.1–7.5, §7.10 and A4).

## Scope

Exactly `plans/LK-00.md` §16. Remove the `customer.host` setting, its modes and its L2 change; the customer site is `polaris.locker` exactly when `CUSTOMER_ORIGIN` is set. Old customer URLs on `key.plrs.im` answer 301 to `polaris.locker`; the console hands off by hash. Update the settings, platform-inventory, docs-reference and spec outputs with `pnpm gen`. Anything else is another package's row in §9.

## Acceptance criteria

- [ ] No `customer.host` setting, mode or test remains; `CUSTOMER_ORIGIN` unset behaves as the old `off`
- [ ] Old customer URLs 301 while `CUSTOMER_ORIGIN` is set and are untouched while it is not
- [ ] `pnpm gen --check` clean; `pnpm --filter @polaris-key/worker test` and `test:workerd`
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-17 in-review` when it hands off; the lead sets `done` after review.
