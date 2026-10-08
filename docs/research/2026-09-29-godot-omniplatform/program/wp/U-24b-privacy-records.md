# U-24b Privacy, records half: records in exports and deletion

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U3 collections)                                                    |
| Size        | 0.2–0.3 engineer-weeks                                                                   |
| Depends on  | none                                                                                     |
| Unblocks    | none                                                                                     |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package |
| Gates       | privacy docs                                                                             |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [U-09](U-09-collections-backend.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [U-09](U-09-collections-backend.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Records export and delete land with the store.

- Dependencies cleared on closing (they were U-12 and U-09), so nothing in the graph waits on or through a closed package.

## Goal

Records are covered by export and deletion.

## Why

Split from S-17's U-24 row (its records half) ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always); [S-17 §5.9](../../notes/S-17-user-data-sync.md#59-privacy), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-24.

## Scope

**In:** records in exports and the delete cascade.

**Out** (and where it belongs instead):

- None.

## Design notes

- Tombstones carry no personal data.

## Steps

1. Export. 2. Delete.

## Acceptance criteria

- [ ] Deletion removes records and survives a simulated restore (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- sync privacy
```

## Hand-off

- None.

The role agent sets `--set U-24b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-24b done`.
