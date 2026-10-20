# LK-07 Worker pages and customer mail on the Locker identity

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | LK: Polaris Locker                                                             |
| Size        | 1–1.25 engineer-weeks                                                          |
| Depends on  | [LK-01](LK-01-brand-locker-kit.md), [LK-03](LK-03-customer-host-and-origin.md) |
| Unblocks    | [LK-11](LK-11-cutover.md)                                                      |
| Role        | `pkey-implementer`                                                             |
| Plan mode   | no                                                                             |
| Gates       | email-snapshots, workerd                                                       |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

## Goal

Worker pages and customer mail on the Locker identity. Executes `plans/LK-00.md` §7.11–7.12; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §7.11–7.12 (plus its §0, §1, A1 and A2 notes).
- `.claude/agents/pkey-ux-reviewer.md` (the quality bar).

## Scope

Exactly `plans/LK-00.md` §7.11–7.12. Anything else is another package's row in §9.

Re-scoped by Amendment A3: operator mail (ungated), the download page and the bytes and registry landings (gated); see `plans/LK-00.md` §14.6. Amendment A4 (§15): operator and member mail stays Key.

## Acceptance criteria

- [ ] email snapshots updated and reviewed; worker `test:workerd` passes
- [ ] pkey-ux-reviewer passes the pages
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-07 in-review` when it hands off; the lead sets `done` after review.
