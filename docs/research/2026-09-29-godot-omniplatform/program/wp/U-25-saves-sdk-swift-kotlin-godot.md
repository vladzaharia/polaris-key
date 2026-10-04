# U-25 Saves SDK in Swift, Kotlin and Godot (Godot first): the same plus conflict views in `PolarisKeyUI`, the Kotlin UI kit and Godot's `PKeySaveConflict`, `formatVersion` and `saveCompat`

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U2 merge and saves)                                                                                                                      |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                         |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-10](U-10-saves-backend.md), [U-08](U-08-merge-prompt.md)                                                                   |
| Unblocks    | [U-15b](U-15b-docs-saves.md)                                                                                                                                   |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                           |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                              |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`); UI kit screenshots; CI: macOS; CI: Android |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

Swift, Kotlin and Godot (Godot first) expose saves like U-13, with conflict views in `PolarisKeyUI`, the Kotlin UI kit and Godot's `PKeySaveConflict` scene, plus `formatVersion` and `saveCompat` metadata.

## Why

The end of the Godot path to save slots ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md).
- [S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-25 and "The Godot path".

## Scope

**In:** the API in three SDKs, three UI kit views, transcripts, scenarios, parity rows.

**Out** (and where it belongs instead):

- Node, React, Python (→ U-13).

## Design notes

- Godot sample code uses `bytes_to_var` without objects (T12).

## Steps

1. Godot. 2. Swift and Kotlin. 3. Transcripts and scenarios.

## Acceptance criteria

- [ ] Three SDKs replay the saves transcripts and scenarios; UI kit screenshots; macOS and Android CI green.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-15b documents it.

The role agent sets `--set U-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-25 done`.
