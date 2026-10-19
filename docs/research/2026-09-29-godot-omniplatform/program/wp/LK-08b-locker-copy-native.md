# LK-08b The same in Swift, Kotlin and Godot

| Field       | Value                                     |
| ----------- | ----------------------------------------- |
| Phase       | LK: Polaris Locker                        |
| Size        | 0.5–0.75 engineer-weeks                   |
| Depends on  | [LK-08a](LK-08a-locker-copy-constants.md) |
| Unblocks    | none                                      |
| Role        | `pkey-sdk-porter`                         |
| Plan mode   | no                                        |
| Gates       | all-sdks, corpus:mirror, golden-images    |
| Human input | none                                      |
| Repo        | `vladzaharia/polaris-key`                 |

## Goal

The same in Swift, Kotlin and Godot. Executes `plans/LK-00.md` §6; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §6 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §6. Anything else is another package's row in §9.

Deferred until: customer.host is on in prod.

## Acceptance criteria

- [ ] `swift test`; `sdks/godot/tools/run_tests.sh`; Kotlin `:ui-core:test :conformance:test` (see §13)
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-08b in-review` when it hands off; the lead sets `done` after review.
