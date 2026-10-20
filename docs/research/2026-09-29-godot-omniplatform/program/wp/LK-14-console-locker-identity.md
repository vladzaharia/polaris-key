# LK-14 Console on the Locker identity: shell, titles, sign-in moment, data-brand, copy sweep

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                     |
| Size        | 1–1.25 engineer-weeks                                                  |
| Depends on  | [LK-01](LK-01-brand-locker-kit.md), [LK-13](LK-13-locker-words-v13.md) |
| Unblocks    | none                                                                   |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | console-csp-parity, ui-snapshots                                       |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

Console on the Locker identity: shell lockup, `document.title`, favicon and manifest, sign-in moment, `data-brand="locker"`, the copy sweep, and `pkey` output words. Executes `plans/LK-00.md` §14.1, §14.2, §14.6; do not restate the plan.

Amendment A4 (`plans/LK-00.md` §15) re-scopes this package: the console stays the Polaris Key Console (Key mark with the section bit, no `data-brand="locker"`); only customer-site words say Locker; add the root front door.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §14.1, §14.2, §14.6 (plus its §0, §1, A1, A2 and A3 notes).
- `.claude/agents/pkey-ux-reviewer.md` (the quality bar).

## Scope

Exactly `plans/LK-00.md` §14.1, §14.2, §14.6. Anything else is another package's row in §14.6.

## Acceptance criteria

- [ ] `pnpm gen --check` settings clean; admin build succeeds; console CSP parity passes
- [ ] ui-snapshots re-recorded
- [ ] pkey-ux-reviewer passes the mockups, then the built screens; every "Open in Polaris Locker" link reaches the customer site
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-14 in-review` when it hands off; the lead sets `done` after review.
