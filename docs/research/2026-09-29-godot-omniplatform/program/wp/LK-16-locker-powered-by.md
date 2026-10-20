# LK-16 Powered by Polaris Locker in every kit: micro mark, line and badge in seven SDKs, Godot credits

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                            |
| Size        | 0.75–1.25 engineer-weeks                                                      |
| Depends on  | [LK-01](LK-01-brand-locker-kit.md), [LK-08a](LK-08a-locker-copy-constants.md) |
| Unblocks    | none                                                                          |
| Role        | `pkey-sdk-porter`                                                             |
| Plan mode   | no                                                                            |
| Gates       | drift-gate, generator-goldens, all-sdks, golden-images                        |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Goal

Powered by Polaris Locker in every kit: the micro mark from `gen brand` (TS, Swift, Kotlin, GDScript, Python, terminal), `<PoweredByBadge>`, the line and badge in seven SDKs, and Godot credits. Executes `plans/LK-00.md` §14.2, §14.5, §14.6; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §14.2, §14.5, §14.6 (plus its §0, §1, A1, A2 and A3 notes).
- `.claude/agents/pkey-ux-reviewer.md` (the quality bar).

## Scope

Exactly `plans/LK-00.md` §14.2, §14.5, §14.6. Anything else is another package's row in §14.6.

## Acceptance criteria

- [x] `pnpm gen --check` brand clean; generator goldens, all-SDK suites and golden images pass (Kotlin: two `matrix/signIn-handoff` goldens still say "Polaris Key", a pre-existing LK-08b copy change, not re-recorded here)
- [ ] pkey-ux-reviewer passes the kit renders (line and badge, 320 px floor)
- [x] The relevant `plans/LK-00.md` §13 commands pass; scoped gate per SDK passes (see the report; the lead schedules the UX review).

## Hand-off

The role agent sets `--set LK-16 in-review` when it hands off; the lead sets `done` after review.
