# LK-12 Badges in use: `polaris.locker/<slug>`, the download page's badge link

| Field       | Value                                                         |
| ----------- | ------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                            |
| Size        | 0.25–0.75 engineer-weeks                                      |
| Depends on  | [LK-01](LK-01-brand-locker-kit.md), [LK-11](LK-11-cutover.md) |
| Unblocks    | none                                                          |
| Role        | `pkey-implementer`                                            |
| Plan mode   | no                                                            |
| Gates       | rule-10, docs-links                                           |
| Human input | none                                                          |
| Repo        | `vladzaharia/polaris-key`                                     |

## Goal

Badges in use: `polaris.locker/<slug>`, the download page's badge link. Executes `plans/LK-00.md` §7.1, §8; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §7.1, §8 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §7.1, §8. Anything else is another package's row in §9.

Re-scoped by Amendment A3: destinations for the extra badge labels, 320 px; see `plans/LK-00.md` §14.6.

Deferred until: LK-11 is live.

## Acceptance criteria

- [ ] worker `test` passes (routeCoverage); docs `check:links` passes
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-12 in-review` when it hands off; the lead sets `done` after review.

## Progress and continuation (2026-10-28)

Built: the Worker route and the download page's badge. Correction to the plan text: `/<slug>` is
not a new route kind. It is the existing bare-slug alias (`/{product}` in the spec); on the
customer host it now answers `302 /#/discover/<slug>` (no database read, no oracle). The download
page (bytes host) draws the 320 x 104 "Available on Polaris Locker" badge, linked to
`<customer origin>/<slug>`, only with a customer site and a direct download (text link under
360 px). Not built: destinations for the other 14 labels (they need their own real actions;
console "Get a badge" is LK-10) and the plrs.im website part (owner step OS-25).
