# CC-15 Nearby mode v in every SDK: adverts, SAS, the vouch records and the cloudConnect.nearby API (no UI)

| Field       | Value                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md)                                                             |
| Size        | 0.8–1 engineer-weeks                                                                                                                                                                                               |
| Depends on  | [CC-08](CC-08-node-connect.md), [CC-10](CC-10-python-connect.md), [CC-11](CC-11-swift-connect.md), [CC-12b](CC-12b-android-connect.md), [CC-14](CC-14-godot-connect.md), [I-40](I-40-account-initiated-pairing.md) |
| Unblocks    | [CC-18](CC-18-security-review.md), [CC-19](CC-19-inter-account-links.md), [CC-20](CC-20-direct-transfer.md), [I-47](I-47-node-python-auto-signin.md), [U-42](U-42-kit-sync-screens.md)                             |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                 |
| Gates       | all-sdks, threat-model, security-review                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                          |

## Goal

Nearby mode v in every SDK: adverts, SAS, VOUCH\__, cloudConnect.nearby._ (protocol and API, no UI). Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
