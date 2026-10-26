# CC-20 Direct Transfer: peer-to-peer data between Cloud Connect peers (LAN or relay)

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.7–0.9 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-15](CC-15-nearby-mode-v.md)                                                                                                                        |
| Unblocks    | none                                                                                                                                                   |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                   |
| Plan mode   | yes: needs its own plan before code                                                                                                                    |
| Gates       | plan-mode, all-sdks, corpus, security-review                                                                                                           |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Direct Transfer: peer-to-peer data between Cloud Connect peers (LAN or relay). Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

- Named "Direct Transfer" (owner, 2026-10-26): peer-to-peer transfer of information between two clients already authenticated with each other via Cloud Connect, directly on the LAN or through the relay. It is a feature of the Cloud Connect service (contract O-7). Replaces "data transfer" in the plans.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
