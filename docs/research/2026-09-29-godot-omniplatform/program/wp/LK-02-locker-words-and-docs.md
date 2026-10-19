# LK-02 Words: glossary, BRAND §14.4, PORTAL, SIGN-IN, EXPERIENCE and UI-KITS amendments (D8)

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Phase       | LK: Polaris Locker                                                       |
| Size        | 0.25 engineer-weeks                                                      |
| Depends on  | none                                                                     |
| Unblocks    | [LK-08a](LK-08a-locker-copy-constants.md), [LK-09](LK-09-locker-docs.md) |
| Role        | `pkey-implementer`                                                       |
| Plan mode   | no                                                                       |
| Gates       | docs-links, docs-generated                                               |
| Human input | none                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                |

## Goal

Words: glossary, BRAND §14.4, PORTAL, SIGN-IN, EXPERIENCE and UI-KITS amendments (D8). Executes `plans/LK-00.md` §2.3, D8; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §2.3, D8 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §2.3, D8. Anything else is another package's row in §9.

## Acceptance criteria

- [ ] docs `lint:docs` and `check:links` pass; `pnpm gen --check` ux-rows clean
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-02 in-review` when it hands off; the lead sets `done` after review.
