# LK-06 Locker shell: the portal and the card on the Locker identity and `data-brand`; copy says `{brandName}`

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | LK: Polaris Locker                                                             |
| Size        | 1–1.5 engineer-weeks                                                           |
| Depends on  | [LK-01](LK-01-brand-locker-kit.md), [LK-03](LK-03-customer-host-and-origin.md) |
| Unblocks    | [LK-08a](LK-08a-locker-copy-constants.md), [LK-11](LK-11-cutover.md)           |
| Role        | `pkey-implementer`                                                             |
| Plan mode   | no                                                                             |
| Gates       | console-csp-parity, portal-e2e, ui-snapshots                                   |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

## Goal

Locker shell: the portal and the card on the Locker identity and `data-brand`; copy says `{brandName}`. Executes `plans/LK-00.md` §2, §7.6, §8; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §2, §7.6, §8 (plus its §0, §1, A1 and A2 notes).
- `.claude/agents/pkey-ux-reviewer.md` (the quality bar).

## Scope

Exactly `plans/LK-00.md` §2, §7.6, §8. Anything else is another package's row in §9.

## Acceptance criteria

- [ ] `pnpm ui:lint` and `pnpm ui:report` pass; admin build and worker assemble succeed
- [ ] pkey-ux-reviewer passes the mockups, then the built screens (BUILT mode)
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-06 in-review` when it hands off; the lead sets `done` after review.
