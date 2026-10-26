# U-38 E2E, ring and recovery client in Node, React and Python

| Field       | Value                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17)                                                                                                                                                                                   |
| Size        | 1–1.3 engineer-weeks                                                                                                                                                                                   |
| Depends on  | [U-34](U-34-client-core-e2e.md), [U-36](U-36-core-key-ring.md), [CC-26](CC-26-device-key-stores.md)                                                                                                    |
| Unblocks    | [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-22](U-22-collections-sdk-node-react-python.md), [U-42](U-42-kit-sync-screens.md), [U-43](U-43-security-review-e2e.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                      |
| Plan mode   | no                                                                                                                                                                                                     |
| Gates       | all-sdks, corpus-runner, drift-gate                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                              |

## Goal

E2E, ring and recovery client in Node, React and Python. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
