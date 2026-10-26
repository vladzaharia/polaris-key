# U-45 Security review: SDK key storage, backup items, background transfer

| Field       | Value                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17)                                                                                            |
| Size        | 0.3–0.4 engineer-weeks                                                                                          |
| Depends on  | [U-39](U-39-e2e-client-swift-kotlin.md), [U-40](U-40-e2e-client-godot.md), [U-41](U-41-background-transfers.md) |
| Unblocks    | none                                                                                                            |
| Role        | `pkey-implementer`                                                                                              |
| Plan mode   | no                                                                                                              |
| Gates       | threat-model, security-review                                                                                   |
| Human input | none                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                       |

## Goal

Security review: SDK key storage, backup items, background transfer. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
