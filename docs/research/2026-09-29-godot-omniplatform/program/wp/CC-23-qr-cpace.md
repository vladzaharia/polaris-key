# CC-23 QR pairing, CPace, server-recorded contact links

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-19](CC-19-inter-account-links.md)                                                                                                                  |
| Unblocks    | none                                                                                                                                                   |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                    |
| Plan mode   | yes: needs its own plan before code                                                                                                                    |
| Gates       | plan-mode, threat-model                                                                                                                                |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

QR pairing, CPace, server-recorded contact links. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
