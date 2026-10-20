# LK-08a Copy and constants: generators, ui-core, elements, React, Node, Python; ui-matrix

| Field       | Value                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                                                                         |
| Size        | 0.75–1 engineer-weeks                                                                                                      |
| Depends on  | [LK-00](LK-00-polaris-locker-plan.md), [LK-02](LK-02-locker-words-and-docs.md), [LK-06](LK-06-locker-shell-portal-card.md) |
| Unblocks    | [LK-08b](LK-08b-locker-copy-native.md), [LK-16](LK-16-locker-powered-by.md)                                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                      |
| Plan mode   | yes: executes plans/LK-00.md                                                                                               |
| Gates       | plan-mode, drift-gate, generator-goldens, modernity-lint                                                                   |
| Human input | none                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                  |

## Goal

Copy and constants: generators, ui-core, elements, React, Node, Python; ui-matrix. Executes `plans/LK-00.md` §3, §5, §6; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §3, §5, §6 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §3, §5, §6. Anything else is another package's row in §9.

Re-scoped by Amendment A3: all 14 en keys, both core "Can't reach" messages, the terminal kit's strings, and a `ui:lint` strings rule; see `plans/LK-00.md` §14.6.

## Acceptance criteria

- [x] `pnpm gen --check` brand, constants, ui-matrix, corpus clean; the ui-matrix row is added
- [x] generator goldens and modernity lint pass
- [x] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-08a in-review` when it hands off; the lead sets `done` after review.
