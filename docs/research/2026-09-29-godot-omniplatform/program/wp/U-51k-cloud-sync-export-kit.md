# U-51k Kit action "Download synced data"

| Field       | Value                                      |
| ----------- | ------------------------------------------ |
| Phase       | U                                          |
| Size        | 0.3–0.4 engineer-weeks                     |
| Depends on  | [U-51](U-51-cloud-sync-export-device.md)   |
| Unblocks    | none                                       |
| Role        | `pkey-implementer`                         |
| Plan mode   | no                                         |
| Gates       | ui-snapshots, pkey-ux-reviewer, drift-gate |
| Human input | none                                       |
| Repo        | `vladzaharia/polaris-key`                  |

## Goal

The Cloud Sync kit offers a "Download synced data" action in every kit, with a warning sheet that says first that the file is not encrypted. It calls `cloudSync.export()` (U-51) with a destination the person picks.

## Why

U-51 decision D8: U-51 ships the API, docs and Help; the kit surface is its own package, with ui-matrix rows, five kits and a UX review.

## Read first

- `AGENTS.md` (always).
- U-51 plan decision D8 and §3.4 (consent and where the file goes).

## Acceptance criteria

- [ ] The action and its warning sheet exist in every kit, pinned by ui-matrix rows, and pass the built UX review.

## Hand-off

The role agent sets `--set U-51k in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-51k done`.
