# CC-06 Connect identity on the Worker: certificates, rings, discovery keys, linked-devices route

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.6–0.8 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-02](CC-02-service-row.md), [CC-03](CC-03-core-device-keys.md), [CC-04](CC-04-wire-v5.md), [CC-01](CC-01-combined-plan.md)                          |
| Unblocks    | [CC-07](CC-07-relay-do.md), [CC-08](CC-08-node-connect.md), [CC-16](CC-16-console-section.md)                                                          |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                  |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                    |
| Gates       | plan-mode, migration, table-owners, rule-10, rule-6, drift-gate, threat-model, workerd, security-review                                                |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Connect identity on the Worker: certificates, rings, discovery keys, linked-devices route. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
