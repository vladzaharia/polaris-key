# U-15b Cloud Sync docs, saves half: saves guide, Steam Cloud coexistence, Godot save security

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U2 merge and saves)                                                |
| Size        | 0.2–0.3 engineer-weeks                                                                   |
| Depends on  | none                                                                                     |
| Unblocks    | none                                                                                     |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package |
| Gates       | `check:links`                                                                            |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [U-15a](U-15a-docs-settings.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [U-15a](U-15a-docs-settings.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One Cloud Sync docs package.

- Dependencies cleared on closing (they were U-15a, U-13 and U-25), so nothing in the graph waits on or through a closed package.

## Goal

Developers have a saves guide, guidance on coexisting with Steam Cloud, and Godot save-security guidance.

## Why

Split from S-17's U-15 row (its saves half) ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always); [S-17 §5.14](../../notes/S-17-user-data-sync.md#514-threat-model-deltas) (T12), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-15.

## Scope

**In:** the saves pages.

**Out** (and where it belongs instead):

- Collections (→ U-15c).

## Design notes

- Never hand-edit generated pages.

## Steps

1. Pages.

## Acceptance criteria

- [ ] Pages exist and links resolve.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- None.

The role agent sets `--set U-15b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-15b done`.
