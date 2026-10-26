# CC-18 Security review of Cloud Connect before production: cross-subject, relay abuse, revocation, vouch

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-07](CC-07-relay-do.md), [CC-08](CC-08-node-connect.md), [CC-15](CC-15-nearby-mode-v.md)                                                            |
| Unblocks    | none                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                     |
| Plan mode   | no                                                                                                                                                     |
| Gates       | threat-model, security-review                                                                                                                          |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Security review of Cloud Connect before production: cross-subject, relay abuse, revocation, vouch. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
