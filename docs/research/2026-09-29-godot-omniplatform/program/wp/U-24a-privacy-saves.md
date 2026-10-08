# U-24a Privacy, saves half: save manifest and zip in exports, R2 prefix delete, crypto-shredding, residency option

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U2 merge and saves)                                                |
| Size        | 0.4–0.55 engineer-weeks                                                                  |
| Depends on  | none                                                                                     |
| Unblocks    | none                                                                                     |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package |
| Gates       | privacy docs; THREAT-MODEL; privacy review                                               |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [U-10](U-10-saves-backend.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [U-10](U-10-saves-backend.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Export and delete land with each store; shredding and prefix delete with files.

- Dependencies cleared on closing (they were U-12 and U-10), so nothing in the graph waits on or through a closed package.

## Goal

Saves are covered by export and deletion: a save manifest and zip in exports, R2 prefix deletion, crypto-shredding through the per-principal data keys, and the optional EU residency placement if the account supports it.

## Why

Split from S-17's U-24 row (its saves half) ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)); decisions 14 and 15 ([S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions)).

## Read first

- `AGENTS.md` (always); [S-17 §5.9](../../notes/S-17-user-data-sync.md#59-privacy), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-24, [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decisions 14 and 15.

## Scope

**In:** exports, deletion, shredding, residency option.

**Out** (and where it belongs instead):

- Records (→ U-24b).

## Design notes

- Tombstone re-apply covers DO and R2 (T11).

## Steps

1. Export. 2. Delete and shred. 3. Residency if available.

## Acceptance criteria

- [ ] Deletion removes saves and survives a simulated restore through shredding (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- sync privacy
```

## Hand-off

- None.

The role agent sets `--set U-24a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-24a done`.
