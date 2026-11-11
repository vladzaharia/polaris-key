# CC-30S Cloud Pairing security sign-off and cryptographer part P6

| Field       | Value                           |
| ----------- | ------------------------------- |
| Phase       | CC                              |
| Size        | 0.15–0.2 engineer-weeks         |
| Depends on  | [CC-30](CC-30-cloud-pairing.md) |
| Unblocks    | none                            |
| Role        | `pkey-implementer`              |
| Plan mode   | x                               |
| Gates       | x                               |
| Human input | none                            |
| Repo        | `vladzaharia/polaris-key`       |

## Goal

Security passes over [CC-30](CC-30-cloud-pairing.md) and the cryptographer packet part P6.

## Why

Write-ups are kept out of the public repository until released. Findings are fixed in CC-30, not here.

## Read first

- `AGENTS.md` (always).
- `plans/CC-18-U-44-U-45-signoff.md`

## Acceptance criteria

- [ ] The findings are closed and the cryptographer's P6 verdict is recorded.

## Hand-off

The role agent sets `--set CC-30S in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-30S done`.
