# U-36 Core key ring: D1 tables, core.keyring store, /devices/keyring routes, recovery, adopt, reset, transcripts

| Field       | Value                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17)                                                                                                                                                                                                                           |
| Size        | 0.9–1.2 engineer-weeks                                                                                                                                                                                                                         |
| Depends on  | [U-33](U-33-e2e-files-contract.md), [U-19](U-19-security-review.md), [CC-03](CC-03-core-device-keys.md), [CC-01](CC-01-combined-plan.md)                                                                                                       |
| Unblocks    | [U-12](U-12-privacy-settings-portal.md), [U-11a](U-11a-console-data-settings.md), [U-38](U-38-e2e-client-node-react-python.md), [U-39](U-39-e2e-client-swift-kotlin.md), [U-40](U-40-e2e-client-godot.md), [U-43](U-43-security-review-e2e.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                          |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                                                                                            |
| Gates       | plan-mode, migration, table-owners, rule-10, drift-gate, threat-model, workerd, security-review                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                      |

## Goal

Core key ring: D1 tables, core.keyring store, /devices/keyring routes, recovery, adopt, reset, transcripts. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
