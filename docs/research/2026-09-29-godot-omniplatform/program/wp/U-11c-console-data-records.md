# U-11c Console Data tab, records half: collections browser

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U3 collections)                                                    |
| Size        | 0.2–0.3 engineer-weeks                                                                   |
| Depends on  | none                                                                                     |
| Unblocks    | none                                                                                     |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package |
| Gates       | console CSP parity; rule 10 (OpenAPI + `routeCoverage`)                                  |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the registry hub area (S-18) for the Cloud Sync data settings.

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [U-11a](U-11a-console-data-settings.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [U-11a](U-11a-console-data-settings.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One browser for one store.

- Dependencies cleared on closing (they were U-11a and U-09), so nothing in the graph waits on or through a closed package.

## Goal

The console's Data tab has a collections browser for one subject.

## Why

Split from S-17's U-11 row (its records half) ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always); `docs/design/ADMIN.md`; [S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-11.

## Scope

**In:** the browser and console writes to `ownerRead` and `server` collections.

**Out** (and where it belongs instead):

- None.

## Design notes

- Writes audited and under step-up.

## Steps

1. Routes. 2. UI.

## Acceptance criteria

- [ ] Writes are audited (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set U-11c in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-11c done`.
