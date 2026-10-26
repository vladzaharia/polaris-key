# CC-08 Node SDK Cloud Connect: LAN (multicast-dns), TCP, relay, cloudConnect API

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.7–0.9 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-05](CC-05-peer-engine.md), [CC-06](CC-06-connect-identity.md), [CC-07](CC-07-relay-do.md), [CC-26](CC-26-device-key-stores.md)                     |
| Unblocks    | [CC-09](CC-09-react-connect.md), [CC-15](CC-15-nearby-mode-v.md), [CC-17](CC-17-docs-help.md), [CC-18](CC-18-security-review.md)                       |
| Role        | `pkey-sdk-porter`                                                                                                                                      |
| Plan mode   | no                                                                                                                                                     |
| Gates       | all-sdks, corpus-runner, drift-gate, security-review                                                                                                   |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Node SDK Cloud Connect: LAN (multicast-dns), TCP, relay, cloudConnect API. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
