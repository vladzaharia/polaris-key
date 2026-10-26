# U-37 Delta files on the Worker: chunks mode (plan, put, get, reference counts, GC, transcripts)

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17)                                                                                                                                                                  |
| Size        | 0.7–0.9 engineer-weeks                                                                                                                                                                |
| Depends on  | [U-10](U-10-saves-backend.md), [U-34](U-34-client-core-e2e.md), [CC-01](CC-01-combined-plan.md)                                                                                       |
| Unblocks    | [U-11a](U-11a-console-data-settings.md), [U-22](U-22-collections-sdk-node-react-python.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md), [U-44](U-44-security-review-files.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                 |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                                   |
| Gates       | plan-mode, rule-10, drift-gate, threat-model, workerd                                                                                                                                 |
| Human input | none                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                             |

## Goal

Delta files on the Worker: chunks mode (plan, put, get, reference counts, GC, transcripts). Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
