# CC-30 Cloud Pairing: the relay mailbox, link rooms and device-token tickets

| Field       | Value                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CC                                                                                                                                                                                                   |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                               |
| Depends on  | [CC-31U](CC-31U-links-pipeline.md), [CC-29](CC-29-local-links.md), [CC-29b](CC-29b-local-links-android-godot.md), [CC-29K](CC-29K-local-links-kit-screens.md), [CC-19](CC-19-inter-account-links.md) |
| Unblocks    | [CC-30S](CC-30S-cloud-pairing-signoff.md)                                                                                                                                                            |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                |
| Plan mode   | x                                                                                                                                                                                                    |
| Gates       | x                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                            |

## Goal

Cloud Pairing: the relay mailbox, link rooms and device-token tickets, in the Worker and every SDK.

## Why

It is a wire change (AGENTS.md rule 2), so it runs in plan mode against the CC-31 plan.

## Read first

- `AGENTS.md` (always).
- [CC-31U](CC-31U-links-pipeline.md)
- [CC-29](CC-29-local-links.md)

## Acceptance criteria

- [ ] The corpus is regenerated and every SDK passes it; `pnpm gen --check` is clean.
- [ ] Every new validator rule has a mutation-table entry.
- [ ] Every screen passes `pkey-ux-reviewer` in BUILT mode.

## Hand-off

The role agent sets `--set CC-30 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-30 done`.
