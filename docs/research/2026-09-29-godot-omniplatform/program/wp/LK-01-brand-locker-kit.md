# LK-01 Brand: the Locker kit in `@polaris-key/brand`

| Field       | Value                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                                                                                                                                                                                                                                          |
| Size        | 0.5–0.75 engineer-weeks                                                                                                                                                                                                                                                                     |
| Depends on  | none                                                                                                                                                                                                                                                                                        |
| Unblocks    | [LK-06](LK-06-locker-shell-portal-card.md), [LK-07](LK-07-worker-pages-and-mail.md), [LK-10](LK-10-console-locker-words.md), [LK-12](LK-12-locker-badges-in-use.md), [LK-14](LK-14-console-locker-identity.md), [LK-15](LK-15-docs-locker-identity.md), [LK-16](LK-16-locker-powered-by.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                          |
| Gates       | drift-gate, ci                                                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                   |

## Goal

Brand: the Locker kit in `@polaris-key/brand`. Executes `plans/LK-00.md` §8; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §8 (plus its §0, §1, A1 and A2 notes).
- `.claude/agents/pkey-ux-reviewer.md` (the quality bar).

## Scope

Exactly `plans/LK-00.md` §8. Anything else is another package's row in §9.

Amendment A3 (`plans/LK-00.md` §14.6): the 16 badge labels and the 320 CSS px floor are done; still to add is a test pinning `architecture.attribution`.

## Acceptance criteria

- [ ] `pnpm gen brand --check` clean; `pnpm --filter @polaris-key/brand test` (locker, locker-fidelity, contrast)
- [ ] pkey-ux-reviewer passes the kit preview
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-01 in-review` when it hands off; the lead sets `done` after review.
