# CC-31 Plan: one pipeline for pairing, transfer and sync

| Field       | Value                               |
| ----------- | ----------------------------------- |
| Phase       | CC                                  |
| Size        | 0.1–0.2 engineer-weeks              |
| Depends on  | none                                |
| Unblocks    | [CC-31U](CC-31U-links-pipeline.md)  |
| Role        | `pkey-wire-planner` (planning only) |
| Plan mode   | no                                  |
| Gates       | x                                   |
| Human input | none                                |
| Repo        | `vladzaharia/polaris-key`           |

## Goal

The plan for one pipeline that pairing, Direct Transfer and Cloud Sync share: Automatic Pairing and the pairing payload. The build packages [CC-31U](CC-31U-links-pipeline.md) and [CC-30](CC-30-cloud-pairing.md) run in plan mode against it.

## Why

The plan is the lead's working document and is not committed to the repository. It is approved.

## Read first

- `AGENTS.md` (always).
- [CC-29](CC-29-local-links.md)

## Acceptance criteria

- [ ] The plan is approved; CC-31U builds against it.
- [ ] Registered as `done`.

## Hand-off

The role agent sets `--set CC-31 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-31 done`.
