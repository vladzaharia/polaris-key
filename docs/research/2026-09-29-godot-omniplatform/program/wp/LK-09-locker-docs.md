# LK-09 Docs: Help door words and host (D7), the 26 developer pages, a badges page

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                           |
| Size        | 0.5–0.75 engineer-weeks                                                      |
| Depends on  | [LK-02](LK-02-locker-words-and-docs.md), [DOC-03b](DOC-03b-public-access.md) |
| Unblocks    | none                                                                         |
| Role        | `pkey-implementer`                                                           |
| Plan mode   | no                                                                           |
| Gates       | docs-links, docs-generated, drift-gate                                       |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Goal

Docs: Help door words and host (D7), the 26 developer pages, a badges page. Executes `plans/LK-00.md` D7, §2.3; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` D7, §2.3 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` D7, §2.3. Anything else is another package's row in §9.

## Acceptance criteria

- [ ] docs `lint:docs`, `check:links` pass; `drift-gate` docs-csp clean
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-09 in-review` when it hands off; the lead sets `done` after review.
