# U-35 client-core machine v3: encryption mode and pin, locked, E2E max/min, encryptionSince; sync-scenarios.json v3

| Field       | Value                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17)                                                                                                                                                                                                           |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                                                                                                         |
| Depends on  | [U-33](U-33-e2e-files-contract.md), [CC-01](CC-01-combined-plan.md)                                                                                                                                                            |
| Unblocks    | [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [U-08](U-08-merge-prompt.md), [U-43](U-43-security-review-e2e.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                          |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                                                                            |
| Gates       | plan-mode, corpus, corpus-runner, drift-gate, security-review                                                                                                                                                                  |
| Human input | none                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                      |

## Goal

client-core machine v3: encryption mode and pin, locked, E2E max/min, encryptionSince; sync-scenarios.json v3. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
