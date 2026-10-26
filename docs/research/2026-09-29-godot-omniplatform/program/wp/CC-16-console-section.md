# CC-16 Console Cloud Connect section: setup, usage, linked devices

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.6–0.8 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-06](CC-06-connect-identity.md), [CC-07](CC-07-relay-do.md)                                                                                         |
| Unblocks    | none                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                     |
| Plan mode   | no                                                                                                                                                     |
| Gates       | rule-10, console-csp-parity, ui-snapshots, modernity-lint, pkey-ux-reviewer                                                                            |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Console Cloud Connect section: setup, usage, linked devices. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

- This package builds UI: the `pkey-ux-reviewer` gate applies.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
