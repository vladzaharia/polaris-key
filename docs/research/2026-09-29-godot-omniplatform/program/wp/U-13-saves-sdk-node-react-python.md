# U-13 Saves SDK in Node, React and Python: `saves.list/read/write/revisions`, conflict objects and `keep()`, saves attach merge, React `<SaveConflict/>`, flush-before-exit warnings

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U2 merge and saves)                                                                                           |
| Size        | 1–1.4 engineer-weeks                                                                                                                |
| Depends on  | none                                                                                                                                |
| Unblocks    | none                                                                                                                                |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                   |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen constants --check`; all six SDKs (`parity:check`); UI kit screenshots |
| Human input | none                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                           |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [U-22](U-22-collections-sdk-node-react-python.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [U-22](U-22-collections-sdk-node-react-python.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Saves are the template of the one records store; the saves SDK is U-22's v1 surface.

- Dependencies cleared on closing (they were U-01, U-10 and U-08), so nothing in the graph waits on or through a closed package.
- `planRef` removed on closing (it executed U-01's plan, [`plans/U-01.md`](../plans/U-01.md)).

## Goal

Node, React and Python expose saves: `saves.list/read/write/revisions`, conflict objects and `keep()`, the saves branch of the attach merge, React's `<SaveConflict/>`, and flush-before-exit warnings.

## Why

[S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches); saves depend only on U-05, U-08 and U-10, not on collections ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md).
- [S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-13.

## Scope

**In:** the API in three SDKs, the React UI component, transcripts, scenarios, parity rows.

**Out** (and where it belongs instead):

- Swift, Kotlin, Godot (→ U-25).

## Design notes

- Saves are never overwritten silently.

## Steps

1. Node and Python. 2. React and `<SaveConflict/>`. 3. Transcripts and scenarios.

## Acceptance criteria

- [ ] Three SDKs replay the saves transcripts and scenarios; screenshots for `<SaveConflict/>`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-15b documents it.

The role agent sets `--set U-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-13 done`.
