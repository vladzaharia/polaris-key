# U-08b Cloud Sync parked copies after an account merge

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Phase       | U                                                                                     |
| Size        | 0.5–0.7 engineer-weeks                                                                |
| Depends on  | [U-08](U-08-merge-prompt.md), [U-09](U-09-collections-backend.md)                     |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-08c](U-08c-merge-adopted-ring-rows.md)     |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                  |
| Plan mode   | yes                                                                                   |
| Gates       | plan-mode, drift-gate, all-sdks, rule-10, threat-model, ui-snapshots, security-review |
| Human input | none                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                             |

## Goal

A copy parked by an account merge (caps 64, charged to the quota) becomes a `MergeRequest` with cause `accountMerge`: V5 §13.2-§13.4 and §13.8 text, the Worker route and types, the `cloudsync-merge-parked` transcript, corpus v6 (rule 41, six scenarios, `syncScenariosVersion` 6), the parked fetch in client-core and every SDK (parity `sync.conflict.parked`), the cause rows in `ui-matrix` and the four kits, and the Help paragraph. Additive and unsigned; `PROTOCOL_VERSION` stays 5. Slices U-08b.0-D/UX are in `plans/U-08.md` §11.

## Why

Split from U-08 (D1) because it adds wire. E2E rows of an adopted ring are out of scope: they stay unreadable and are never deleted (D11), and belong to U-08c.

## Read first

- `AGENTS.md` (always).
- `plans/U-08.md` §8, §11, D1, D8, D11

## Acceptance criteria

- [ ] U-08b.0-.8, K0-K4 and D/UX are merged; `pnpm gen --check` and the worker `routeCoverage` and `cloudSyncParked` tests pass.
- [ ] An old SDK ignores `parked` and never calls the route; an old Worker answers an SDK without it.

## Hand-off

The role agent sets `--set U-08b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-08b done`.
