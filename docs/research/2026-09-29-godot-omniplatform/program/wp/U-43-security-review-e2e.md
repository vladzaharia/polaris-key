# U-43 Security review: E2E crypto, key ring, recovery, downgrade

| Field       | Value                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17)                                                                                                                     |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                   |
| Depends on  | [U-34](U-34-client-core-e2e.md), [U-35](U-35-machine-v3.md), [U-36](U-36-core-key-ring.md), [U-38](U-38-e2e-client-node-react-python.md) |
| Unblocks    | none                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                       |
| Plan mode   | no                                                                                                                                       |
| Gates       | threat-model, security-review                                                                                                            |
| Human input | none                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                |

## Goal

Security review: E2E crypto, key ring, recovery, downgrade. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
