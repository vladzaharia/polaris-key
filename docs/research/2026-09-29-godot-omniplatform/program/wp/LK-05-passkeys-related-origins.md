# LK-05 Passkeys through Related Origin Requests

| Field       | Value                                      |
| ----------- | ------------------------------------------ |
| Phase       | LK: Polaris Locker                         |
| Size        | 0.5 engineer-weeks                         |
| Depends on  | [LK-03](LK-03-customer-host-and-origin.md) |
| Unblocks    | [LK-11](LK-11-cutover.md)                  |
| Role        | `pkey-implementer`                         |
| Plan mode   | no                                         |
| Gates       | rule-10, workerd, threat-model             |
| Human input | none                                       |
| Repo        | `vladzaharia/polaris-key`                  |

## Goal

Passkeys through Related Origin Requests. Executes `plans/LK-00.md` §7.7; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §7.7 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §7.7. Anything else is another package's row in §9.

## Acceptance criteria

- [ ] `test-workerd/passkeys.test.ts` passes on both origins
- [x] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-05 in-review` when it hands off; the lead sets `done` after review.
