# U-08c Cloud Sync: rows of an adopted E2E ring after an account merge

| Field       | Value                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Phase       | U                                                                                                                 |
| Size        | 0.2–0.3 engineer-weeks                                                                                            |
| Depends on  | [U-38](U-38-e2e-client-node-react-python.md), [U-08b](U-08b-merge-parked-copies.md), [U-08](U-08-merge-prompt.md) |
| Unblocks    | none                                                                                                              |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                              |
| Plan mode   | yes                                                                                                               |
| Gates       | plan-mode, drift-gate, all-sdks                                                                                   |
| Human input | none                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                         |

## Goal

Make the E2E rows of an adopted ring readable after an account merge, where U-08b leaves them unreadable and kept.

## Why

Deferred from U-08b (D11) until U-38 (E2E key ring) lands. Scope and slices are to be fixed in a plan before the build.

## Read first

- `AGENTS.md` (always).
- `plans/U-08.md` §8 and D11

## Acceptance criteria

- [ ] A plan names the slices and is approved.
- [ ] An adopted ring's rows are readable and no row is deleted.

## Hand-off

The role agent sets `--set U-08c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-08c done`.
