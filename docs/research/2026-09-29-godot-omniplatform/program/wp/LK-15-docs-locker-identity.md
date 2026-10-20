# LK-15 Developer docs on the Locker identity: chrome, the split, the prose sweep, READMEs

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                     |
| Size        | 0.75–1 engineer-weeks                                                  |
| Depends on  | [LK-01](LK-01-brand-locker-kit.md), [LK-13](LK-13-locker-words-v13.md) |
| Unblocks    | none                                                                   |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | docs-links, docs-generated, drift-gate                                 |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

Developer docs on the Locker identity: Starlight chrome, the split stated once on the landing and concepts pages, the 26 pages, the prose sweep, and package READMEs. Executes `plans/LK-00.md` §14.1, §14.2, §14.6; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §14.1, §14.2, §14.6 (plus its §0, §1, A1, A2 and A3 notes).
- `.claude/agents/pkey-ux-reviewer.md` (the quality bar).

## Scope

Exactly `plans/LK-00.md` §14.1, §14.2, §14.6. Anything else is another package's row in §14.6.

## Acceptance criteria

- [ ] `lint:docs`, `check:links` and the docs build pass; `pnpm gen --check` docs-csp and docs-reference clean
- [ ] pkey-ux-reviewer passes the built docs chrome
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-15 in-review` when it hands off; the lead sets `done` after review.
