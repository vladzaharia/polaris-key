# UK-64 Kit gaps the matrix pins: version-too-new keeps Try again, the paywall portal hand-off, OfflineActivation's two steps

| Field       | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Phase       | UK: UI kits                                                           |
| Size        | 0.4–0.6 engineer-weeks                                                |
| Depends on  | [I-37c](I-37c-device-poll-denied.md)                                  |
| Unblocks    | none                                                                  |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`) |
| Plan mode   | yes                                                                   |
| Gates       | x                                                                     |
| Human input | none                                                                  |
| Repo        | `vladzaharia/polaris-key`                                             |

## Goal

Brings every kit to the states `ui-matrix.json` pins. Executes `plans/UIM-05.md`; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `plans/UIM-05.md`.

## Scope

Exactly `plans/UIM-05.md`: step A (the corpus rows and keys) and steps B1 and B2 (the ports and baselines), one branch, one merge.

## Acceptance criteria

- [x] Version too new keeps Try again, the paywall hands off only for an https `offers.url`, OfflineActivation draws its two numbered steps
- [x] `pnpm gen --check` clean; the `plans/UIM-05.md` section 9 commands pass

## Hand-off

The role agent sets `--set UK-64 in-review` when it hands off; the lead sets `done` after review.
