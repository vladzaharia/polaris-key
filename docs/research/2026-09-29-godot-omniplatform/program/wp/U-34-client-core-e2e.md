# U-34 client-core E2E reference: crypto port, envelope, blinding, HPKE wrap, recovery code, CDC chunker, file formats, sync-vectors.json

| Field       | Value                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17)                                                                                                                                                                             |
| Size        | 1.3–1.7 engineer-weeks                                                                                                                                                                           |
| Depends on  | [U-33](U-33-e2e-files-contract.md), [CC-01](CC-01-combined-plan.md)                                                                                                                              |
| Unblocks    | [U-37](U-37-delta-files-worker.md), [U-38](U-38-e2e-client-node-react-python.md), [U-39](U-39-e2e-client-swift-kotlin.md), [U-40](U-40-e2e-client-godot.md), [U-43](U-43-security-review-e2e.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                            |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                                              |
| Gates       | plan-mode, corpus, corpus-runner, corpus:mirror, drift-gate, all-sdks, security-review                                                                                                           |
| Human input | none                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                        |

## Goal

client-core E2E reference: crypto port, envelope, blinding, HPKE wrap, recovery code, CDC chunker, file formats, sync-vectors.json. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
