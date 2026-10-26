# U-40 E2E, ring and recovery client in Godot (native lanes, measured GDScript fallback)

| Field       | Value                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17)                                                                                                                                               |
| Size        | 1–1.4 engineer-weeks                                                                                                                                               |
| Depends on  | [U-34](U-34-client-core-e2e.md), [U-36](U-36-core-key-ring.md), [CC-26](CC-26-device-key-stores.md), [CC-14b](CC-14b-godot-native-ops.md)                          |
| Unblocks    | [U-21](U-21-sdk-settings-godot.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md), [U-42](U-42-kit-sync-screens.md), [U-45](U-45-security-review-sdk-keys.md) |
| Role        | `pkey-godot-engineer`                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                 |
| Gates       | all-sdks, corpus-runner, corpus:mirror, drift-gate                                                                                                                 |
| Human input | none                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                          |

## Goal

E2E, ring and recovery client in Godot (native lanes, measured GDScript fallback). Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
