# CC-30N Cloud Pairing direct path: WebRTC with TURN

| Field       | Value                     |
| ----------- | ------------------------- |
| Phase       | CC                        |
| Size        | 0.2–0.4 engineer-weeks    |
| Depends on  | none                      |
| Unblocks    | none                      |
| Role        | `pkey-implementer`        |
| Plan mode   | x                         |
| Gates       | x                         |
| Human input | none                      |
| Repo        | `vladzaharia/polaris-key` |

## Goal

A direct path for Cloud Pairing over WebRTC, with TURN as the fallback.

## Why

Optional and scheduled for a later stage.

## Read first

- `AGENTS.md` (always).
- [CC-30](CC-30-cloud-pairing.md)

## Acceptance criteria

- [ ] Scheduled by the owner before it starts.

## Hand-off

The role agent sets `--set CC-30N in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-30N done`.
