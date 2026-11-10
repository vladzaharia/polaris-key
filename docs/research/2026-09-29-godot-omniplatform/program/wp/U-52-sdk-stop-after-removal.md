# U-52 SDKs stop syncing after a per-product removal

| Field       | Value                                   |
| ----------- | --------------------------------------- |
| Phase       | U                                       |
| Size        | 0.2–0.3 engineer-weeks                  |
| Depends on  | [U-12](U-12-privacy-settings-portal.md) |
| Unblocks    | none                                    |
| Role        | `pkey-sdk-porter`                       |
| Plan mode   | no                                      |
| Gates       | drift-gate, all-sdks                    |
| Human input | none                                    |
| Repo        | `vladzaharia/polaris-key`               |

## Goal

After the portal's "Remove my data from <Product>" (U-12), every SDK drops its local sync root and stops syncing when the Worker answers `account_required`. Add the scenario row (to `sync-scenarios.json`, if the current scenarios lack it) and make each SDK pass it.

## Why

Split from the U-12 plan.

## Read first

- `AGENTS.md` (always).
- `plans/U-12-PX-18.md` §3 follow-up (b)

## Acceptance criteria

- [ ] A scenario row covers `account_required` after removal; all six SDKs drop the root and stop.

## Hand-off

The role agent sets `--set U-52 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-52 done`.
