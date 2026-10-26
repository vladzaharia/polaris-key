# CC-03 Core device keys, lifecycle event, pkey-proof/1 and device-proof.json: device_keys, PUT /<p>/devices/keys, registerDeviceKeys, onDeviceChange

| Field       | Value                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md)                               |
| Size        | 0.8–1 engineer-weeks                                                                                                                                                                 |
| Depends on  | [CC-04](CC-04-wire-v5.md), [CC-01](CC-01-combined-plan.md)                                                                                                                           |
| Unblocks    | [I-13](I-13-exchange-endpoint.md), [I-40](I-40-account-initiated-pairing.md), [CC-06](CC-06-connect-identity.md), [CC-26](CC-26-device-key-stores.md), [U-36](U-36-core-key-ring.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                                  |
| Gates       | plan-mode, migration, table-owners, rule-10, corpus, corpus:mirror, drift-gate, threat-model, workerd, docs:privacy, security-review                                                 |
| Human input | none                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                            |

## Goal

Core device keys, lifecycle event, pkey-proof/1 and device-proof.json: device_keys, PUT /<p>/devices/keys, registerDeviceKeys, onDeviceChange. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
