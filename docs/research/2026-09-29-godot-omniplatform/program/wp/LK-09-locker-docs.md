# LK-09 Docs: Help door words and host (D7), the 26 developer pages, a badges page

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                           |
| Size        | 0.25–0.5 engineer-weeks                                                      |
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

Re-scoped by Amendment A3: the Help door, the host, and a badges page for the 16 labels; see `plans/LK-00.md` §14.6.

## Acceptance criteria

- [ ] docs `lint:docs`, `check:links` pass; `drift-gate` docs-csp clean
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-09 in-review` when it hands off; the lead sets `done` after review.

## Progress and continuation

- 2026-10-19, slice 1 (words only): Help door under `packages/docs/src/content/docs/help/` says Polaris Locker (first mention) then Locker; titles changed, slugs unchanged. Owner chose a hard cutover (no switch), so on-screen strings and mail subjects also say Polaris Locker; no dual-state wording remains. Strings are the obvious Locker form; check them against the LK-06/07/08a strings when those merge.
- Remaining: (1) the host move to `polaris.locker/docs/help/` and the `what-is-polaris-locker` slug (`site-map.json` row + redirect + help-link tables), blocked on DOC-03b; (2) the badges page for the 16 labels, needs LK-12 destinations. Status stays in-progress.
