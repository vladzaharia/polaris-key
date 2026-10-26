# CC-19 Inter-account links: mode p SAS pairing, CONTACT, mode c, product opt-in, kit approval UI

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.9–1.2 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-15](CC-15-nearby-mode-v.md)                                                                                                                        |
| Unblocks    | [CC-23](CC-23-qr-cpace.md)                                                                                                                             |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                   |
| Plan mode   | yes: needs its own plan before code                                                                                                                    |
| Gates       | plan-mode, all-sdks, corpus, threat-model, pkey-ux-reviewer, security-review                                                                           |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Inter-account links: mode p SAS pairing, CONTACT, mode c, product opt-in, kit approval UI. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

- This package builds UI: the `pkey-ux-reviewer` gate applies.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
