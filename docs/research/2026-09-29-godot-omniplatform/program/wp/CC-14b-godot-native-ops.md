# CC-14b Godot native lanes: AES-GCM and X25519 ops (CryptoKit, BCrypt plus Monocypher, :platform), discovery

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.8–1 engineer-weeks                                                                                                                                   |
| Depends on  | [CC-14](CC-14-godot-connect.md), [CC-12b](CC-12b-android-connect.md), [CC-26](CC-26-device-key-stores.md)                                              |
| Unblocks    | [U-40](U-40-e2e-client-godot.md)                                                                                                                       |
| Role        | `pkey-godot-engineer`                                                                                                                                  |
| Plan mode   | no                                                                                                                                                     |
| Gates       | ci:macos, ci:windows, ci:android, security-review                                                                                                      |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Godot native lanes: AES-GCM and X25519 ops (CryptoKit, BCrypt plus Monocypher, :platform), discovery. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan
