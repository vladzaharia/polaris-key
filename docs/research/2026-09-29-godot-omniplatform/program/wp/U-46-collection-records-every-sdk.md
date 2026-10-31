# U-46 collection(): records beyond saves in every SDK

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17)                                                                                                                       |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                     |
| Depends on  | [U-09](U-09-collections-backend.md), [U-22](U-22-collections-sdk-node-react-python.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md) |
| Unblocks    | none                                                                                                                                       |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                       |
| Plan mode   | yes                                                                                                                                        |
| Gates       | plan-mode, all-sdks, corpus-runner, security-review                                                                                        |
| Human input | none                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                  |

## Goal

`cloudSync.collection(name)` in every SDK: get, ids, put, update, add, remove, delete and on, over the records engine and the host codec. Scope, slices and tests: the lead plan C-26 (alias of this package), slices C26.0 to C26.8, with the registry slice C26.2 done first.

## Plan

- Plan: C-26 (lead plan, 2026-10-31); [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) §2.7.

## Acceptance criteria

[ ] see plan
