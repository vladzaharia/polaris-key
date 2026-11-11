# CC-31S One pipeline: security sign-off and cryptographer part P7

| Field       | Value                              |
| ----------- | ---------------------------------- |
| Phase       | CC                                 |
| Size        | 0.15–0.2 engineer-weeks            |
| Depends on  | [CC-31U](CC-31U-links-pipeline.md) |
| Unblocks    | none                               |
| Role        | `pkey-implementer`                 |
| Plan mode   | x                                  |
| Gates       | x                                  |
| Human input | none                               |
| Repo        | `vladzaharia/polaris-key`          |

## Goal

Security passes over the pipeline of [CC-31U](CC-31U-links-pipeline.md) and the cryptographer packet part P7.

## Why

Write-ups are kept out of the public repository until released. Findings are fixed in CC-31U, not here.

## Read first

- `AGENTS.md` (always).
- `plans/CC-18-U-44-U-45-signoff.md`

## Acceptance criteria

- [ ] The findings are closed and the cryptographer's P7 verdict is recorded.

## Hand-off

The role agent sets `--set CC-31S in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-31S done`.
