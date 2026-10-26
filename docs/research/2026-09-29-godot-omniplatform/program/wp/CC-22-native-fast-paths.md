# CC-22 Native fast paths: tvOS DeviceDiscoveryUI, Wi-Fi Aware, Nearby Connections (Play flavour)

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-11](CC-11-swift-connect.md), [CC-12b](CC-12b-android-connect.md)                                                                                   |
| Unblocks    | none                                                                                                                                                   |
| Role        | `pkey-sdk-porter`                                                                                                                                      |
| Plan mode   | no                                                                                                                                                     |
| Gates       | ci:macos, ci:android                                                                                                                                   |
| Human input | Wi-Fi Aware hardware                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Native fast paths: tvOS DeviceDiscoveryUI, Wi-Fi Aware, Nearby Connections (Play flavour). Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
