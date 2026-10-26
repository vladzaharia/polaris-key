# CC-11 Swift Cloud Connect: CryptoKit, Network.framework Bonjour and AWDL, prompts

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.7–0.9 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-05](CC-05-peer-engine.md), [CC-07](CC-07-relay-do.md), [CC-26](CC-26-device-key-stores.md)                                                         |
| Unblocks    | [CC-15](CC-15-nearby-mode-v.md), [CC-22](CC-22-native-fast-paths.md)                                                                                   |
| Role        | `pkey-sdk-porter`                                                                                                                                      |
| Plan mode   | no                                                                                                                                                     |
| Gates       | all-sdks, corpus-runner, ci:macos, security-review                                                                                                     |
| Human input | two Apple devices on one LAN for e2e                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Swift Cloud Connect: CryptoKit, Network.framework Bonjour and AWDL, prompts. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
