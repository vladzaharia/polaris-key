# U-51 `cloudSync.export()` on the device

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase       | U                                                                                                                       |
| Size        | 0.4–0.6 engineer-weeks                                                                                                  |
| Depends on  | [U-38](U-38-e2e-client-node-react-python.md), [U-39](U-39-e2e-client-swift-kotlin.md), [U-40](U-40-e2e-client-godot.md) |
| Unblocks    | [U-51k](U-51k-cloud-sync-export-kit.md)                                                                                 |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                    |
| Plan mode   | yes                                                                                                                     |
| Gates       | plan-mode, drift-gate, all-sdks                                                                                         |
| Human input | none                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                               |

## Goal

`cloudSync.export()` in every SDK: a person gets their readable data back from the device, which is the only way E2E data comes out readable (the portal export carries ciphertext). Add the `api.json` row, the parity row and the SDK implementations.

## Why

CC-01 §4.3 calls for it, but `conformance/parity/api.json` has no row. It belongs with U-38, U-39 and U-40. Split from the U-12 plan.

## Read first

- `AGENTS.md` (always).
- `plans/U-12-PX-18.md` §3 follow-up (a)
- `plans/CC-01.md` §4.3

## Acceptance criteria

- [ ] The api row and parity row exist; every SDK exports readable data and its tests pass.
- [ ] `exportCases` passes in all six runners, and THREAT-MODEL T33 is written.

## Hand-off

The role agent sets `--set U-51 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-51 done`.
