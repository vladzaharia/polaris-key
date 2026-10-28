# CC-10 Python Cloud Connect: cryptography Noise, zeroconf, asyncio, websockets

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.6–0.8 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-05](CC-05-peer-engine.md), [CC-07](CC-07-relay-do.md), [CC-26](CC-26-device-key-stores.md)                                                         |
| Unblocks    | [CC-15](CC-15-nearby-mode-v.md)                                                                                                                        |
| Role        | `pkey-sdk-porter`                                                                                                                                      |
| Plan mode   | no                                                                                                                                                     |
| Gates       | all-sdks, corpus-runner, security-review                                                                                                               |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Python Cloud Connect: cryptography Noise, zeroconf, asyncio, websockets. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

## Progress and continuation (2026-10-27)

CC-10.1 (identity) is done on `wp/CC-10.1-python-connect-identity`: `polaris_key.core.peer_cert` (the §15.2 and §15.3 verifiers, passing `peerCertCases`, `ringCases` and `peerAdmissionCases`), `client.connect` (`identity`, `current`, `list_devices`, `discovery_keys`, `leave`) with the `pkey.connect.v1` state file, and the `connect.identity` parity row. Still to do: Noise, zeroconf, asyncio transport, relay (`connect.noise`, `connect.protocol`, `connect.lan`, `connect.relay`, `connect.app`).
