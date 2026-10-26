# CC-21 WebRTC data channels for browsers (signalling over the relay, STUN)

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.7–1 engineer-weeks                                                                                                                                   |
| Depends on  | [CC-09](CC-09-react-connect.md)                                                                                                                        |
| Unblocks    | none                                                                                                                                                   |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                   |
| Plan mode   | yes: needs its own plan before code                                                                                                                    |
| Gates       | plan-mode, rule-10, security-review                                                                                                                    |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

WebRTC data channels for browsers (signalling over the relay, STUN). Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
