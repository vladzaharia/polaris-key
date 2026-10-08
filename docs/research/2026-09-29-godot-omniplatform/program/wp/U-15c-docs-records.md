# U-15c Cloud Sync docs, records half: collections guide

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U3 collections)                                                    |
| Size        | 0.2–0.3 engineer-weeks                                                                   |
| Depends on  | none                                                                                     |
| Unblocks    | none                                                                                     |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package |
| Gates       | `check:links`                                                                            |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): dropped.** The id stays in the graph as `dropped` so it
> is not reused; do not build this package.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **drop** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> No collections guide: the v1 SDK surface is saves only; the records guide lands with the first non-save collection.

- Dependencies cleared on closing (they were U-15a, U-22 and U-23), so nothing in the graph waits on or through a closed package.

## Goal

Developers have a collections guide.

## Why

Split from S-17's U-15 row (its records half) ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always); [S-17 §5.3](../../notes/S-17-user-data-sync.md#53-catalog-and-manifest-extension), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-15.

## Scope

**In:** the collections page.

**Out** (and where it belongs instead):

- None.

## Design notes

- Never hand-edit generated pages.

## Steps

1. Page.

## Acceptance criteria

- [ ] Page exists and links resolve.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- None.

The role agent sets `--set U-15c in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-15c done`.
