# LK-03 Customer host, `customerOrigin()`, `customer.host`, `/signin` made host-aware (A2), `/device` `/tv` served on it, reserved slugs

| Field       | Value                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                                                                                                                                                                                       |
| Size        | 1–1.25 engineer-weeks                                                                                                                                                                                                                    |
| Depends on  | none                                                                                                                                                                                                                                     |
| Unblocks    | [LK-04](LK-04-cross-host-sign-in.md), [LK-05](LK-05-passkeys-related-origins.md), [LK-06](LK-06-locker-shell-portal-card.md), [LK-07](LK-07-worker-pages-and-mail.md), [LK-10](LK-10-console-locker-words.md), [LK-11](LK-11-cutover.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                       |
| Gates       | rule-9, rule-10, drift-gate, workerd, threat-model                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                |

## Goal

Customer host, `customerOrigin()`, `customer.host`, `/signin` made host-aware (A2), `/device` `/tv` served on it, reserved slugs. Executes `plans/LK-00.md` §4, §7.1–7.5, §7.13; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §4, §7.1–7.5, §7.13 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §4, §7.1–7.5, §7.13. Anything else is another package's row in §9.

## Acceptance criteria

- [ ] `pnpm gen --check` settings, platform-inventory, transcripts clean
- [ ] `pnpm --filter @polaris-key/manifest test` (reserved slugs, schema parity)
- [ ] `pnpm --filter @polaris-key/worker test` (customerHost, customerOrigin, the switch, routeCoverage, adminCspParity); `test:workerd`
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-03 in-review` when it hands off; the lead sets `done` after review.
