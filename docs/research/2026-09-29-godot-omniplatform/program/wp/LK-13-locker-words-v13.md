# LK-13 Words v1.3: glossary, BRAND, UI-KITS §1.6, PORTAL, EXPERIENCE, AGENTS.md rules 4 and 8

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                                |
| Size        | 0.25 engineer-weeks                                                               |
| Depends on  | none                                                                              |
| Unblocks    | [LK-14](LK-14-console-locker-identity.md), [LK-15](LK-15-docs-locker-identity.md) |
| Role        | `pkey-implementer`                                                                |
| Plan mode   | no                                                                                |
| Gates       | docs-links, docs-generated                                                        |
| Human input | none                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Goal

Words v1.3: the glossary, BRAND §1.5/§7.1/§7.2/§14.4/§15, UI-KITS §1.6, PORTAL, EXPERIENCE, and AGENTS.md rules 4 and 8. Executes `plans/LK-00.md` §14.1, §14.6, §14.7; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §14.1, §14.6, §14.7 (plus its §0, §1, A1, A2 and A3 notes).

## Scope

Exactly `plans/LK-00.md` §14.1, §14.6, §14.7. Anything else is another package's row in §14.6.

## Acceptance criteria

- [ ] `lint:docs` and `check:links` pass; `pnpm gen --check` clean; ux-rows clean
- [ ] AGENTS.md rules 4 and 8 and "Where docs live" read as §14.7 words them
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-13 in-review` when it hands off; the lead sets `done` after review.
