# CC-25 Noise IK fast reconnect for known peers

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-05](CC-05-peer-engine.md)                                                                                                                          |
| Unblocks    | none                                                                                                                                                   |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                  |
| Plan mode   | yes: needs its own plan before code                                                                                                                    |
| Gates       | plan-mode, corpus, all-sdks                                                                                                                            |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Noise IK fast reconnect for known peers. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
