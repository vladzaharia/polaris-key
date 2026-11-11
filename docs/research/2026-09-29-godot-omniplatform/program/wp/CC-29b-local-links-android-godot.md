# CC-29b Local links on Android and Godot

| Field       | Value                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC                                                                                                                                                                                               |
| Size        | 0.15–0.2 engineer-weeks                                                                                                                                                                          |
| Depends on  | [CC-29](CC-29-local-links.md), [CC-19](CC-19-inter-account-links.md), [CC-20](CC-20-direct-transfer.md), [CC-23L](CC-23L-local-links-plan.md), [CC-29.15](CC-29.15-local-pairing-kit-api.md)     |
| Unblocks    | [CC-29K](CC-29K-local-links-kit-screens.md), [CC-29S](CC-29S-local-links-signoff.md), [CC-29X](CC-29X-live-pairing-test.md), [CC-31U](CC-31U-links-pipeline.md), [CC-30](CC-30-cloud-pairing.md) |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                                                                                                         |
| Plan mode   | yes                                                                                                                                                                                              |
| Gates       | plan-mode, drift-gate, all-sdks                                                                                                                                                                  |
| Human input | none                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                        |

## Goal

CC-29b.A: Android `:platform` `PeerNsd` handles `m=q` and `m=l`, the Keystore-wrapped store, an instrumented loopback test. CC-29b.G1-G4: Godot `core/peer/cpace.gd`, modes `q` and `l` with the `local` rows, `services/connect/local_links.gd`, and the native lanes (Apple CryptoKit, Windows Monocypher, Android `:platform`) with export checks and parity. It also carries the kit-API work of CC-29.15 §8: Android keeps the `platform` member in the sealed store; Godot adds `renew()`, `dials_left()`, `on_change` and `cancel_join()`, the `LocalCode` fields, `on_interrupted` and `on_end`, the error `reason` and `cap`, and `platform`, and its runner replays the `local.nameplateMemory` and `local.joinReasons` sub-sections.

## Why

Follows CC-29 (the contract, corpus and the other SDKs). `plans/GODOT-CONNECT-2.md`: CC-19b.G and CC-20b.G also unblock this package.

## Read first

- `AGENTS.md` (always).
- The CC-23L plan §10 (CC-29b rows)

## Acceptance criteria

- [ ] The Android instrumented loopback test passes (`ci:android`).
- [ ] The Godot runner replays the `cpace`, handshake and `local` rows; the CI matrix and export checks pass.

## Hand-off

The role agent sets `--set CC-29b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-29b done`.
