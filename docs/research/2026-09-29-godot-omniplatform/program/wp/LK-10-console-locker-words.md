# LK-10 Console: Locker words and links, the switch with its preflight, Connections callbacks, "Get a badge"

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | LK: Polaris Locker                                                             |
| Size        | 0.5–0.75 engineer-weeks                                                        |
| Depends on  | [LK-01](LK-01-brand-locker-kit.md), [LK-03](LK-03-customer-host-and-origin.md) |
| Unblocks    | [LK-11](LK-11-cutover.md)                                                      |
| Role        | `pkey-implementer`                                                             |
| Plan mode   | no                                                                             |
| Gates       | drift-gate, console-csp-parity, ui-snapshots                                   |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

## Goal

Console: Locker words and links, the switch with its preflight, Connections callbacks, "Get a badge". Executes `plans/LK-00.md` §7, §10; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §7, §10 (plus its §0, §1, A1 and A2 notes).
- `.claude/agents/pkey-ux-reviewer.md` (the quality bar).

## Scope

Exactly `plans/LK-00.md` §7, §10. Anything else is another package's row in §9.

## Acceptance criteria

- [ ] `pnpm gen --check` settings clean; admin build succeeds
- [ ] pkey-ux-reviewer passes the built screens
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-10 in-review` when it hands off; the lead sets `done` after review.
