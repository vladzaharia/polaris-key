# U-23 Saves SDK on the records store: Swift, Kotlin, Godot (absorbs U-25)

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U3 collections)                                                                                                      |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                     |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-09](U-09-collections-backend.md), [U-08](U-08-merge-prompt.md)                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                     |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                       |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                          |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`); CI: macOS; CI: Android |
| Human input | none                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                  |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> As U-22 for Swift, Kotlin and Godot (Godot first), formatVersion and saveCompat included. Absorbs U-25; conflict views in the rebuilt kits.

- Title: was "Collections SDK in Swift, Kotlin and Godot: the same with `Codable`, `@Serializable` and GDScript dictionaries".
- Absorbs U-25: As U-13 for Swift, Kotlin and Godot.

## Goal

Swift, Kotlin and Godot expose collections like U-22, with `Codable`, `@Serializable` and GDScript dictionaries.

## Why

[S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md); [S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-23.

## Scope

**In:** the API in three SDKs, transcripts, scenarios, parity rows.

**Out** (and where it belongs instead):

- Node, React, Python (→ U-22).

## Design notes

- Same rules as U-22.

## Steps

1. API. 2. Transcripts and scenarios.

## Acceptance criteria

- [ ] Three SDKs replay the records transcripts and scenarios; macOS and Android CI green.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-15c documents it.

The role agent sets `--set U-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-23 done`.
