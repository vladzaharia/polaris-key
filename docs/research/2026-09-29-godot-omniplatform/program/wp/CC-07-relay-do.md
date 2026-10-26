# CC-07 Relay Durable Object: ConnectRelayDO, tickets, quotas, meter (relay paused in production)

| Field       | Value                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md)                                                                                                                      |
| Size        | 0.9–1.2 engineer-weeks                                                                                                                                                                                                                                                      |
| Depends on  | [CC-05](CC-05-peer-engine.md), [CC-06](CC-06-connect-identity.md), [CC-01](CC-01-combined-plan.md)                                                                                                                                                                          |
| Unblocks    | [CC-08](CC-08-node-connect.md), [CC-10](CC-10-python-connect.md), [CC-11](CC-11-swift-connect.md), [CC-12](CC-12-kotlin-connect.md), [CC-14](CC-14-godot-connect.md), [CC-16](CC-16-console-section.md), [CC-18](CC-18-security-review.md), [CC-24](CC-24-relay-mailbox.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                       |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                                                                                                                         |
| Gates       | plan-mode, wrangler, migration, table-owners, rule-10, drift-gate, threat-model, workerd, security-review                                                                                                                                                                   |
| Human input | quota numbers (O-2), accepted in combined Q7                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                   |

## Goal

Relay Durable Object: ConnectRelayDO, tickets, quotas, meter (relay paused in production). Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
