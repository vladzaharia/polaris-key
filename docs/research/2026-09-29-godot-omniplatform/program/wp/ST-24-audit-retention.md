# ST-24 Settings audit retention: latest row per setting kept beyond 180 days, NDJSON history export

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 5: governance and environments) |
| Size        | 0.3–0.4 engineer-weeks                                                                |
| Depends on  | none                                                                                  |
| Unblocks    | none                                                                                  |
| Role        | `pkey-implementer`                                                                    |
| Plan mode   | no                                                                                    |
| Gates       | rule 10 (OpenAPI + `routeCoverage`)                                                   |
| Human input | none                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                             |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [P0-18](P0-18-table-ownership-owner-stores-one-audit.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [P0-18](P0-18-table-ownership-owner-stores-one-audit.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Keep-latest-per-setting retention and NDJSON export are properties of the one audit writer.

- Dependencies cleared on closing (they were ST-04), so nothing in the graph waits on or through a closed package.

## Goal

Settings audit keeps the latest row per setting beyond the 180-day retention, and history exports as NDJSON.

## Why

D9 ([S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.6](../../notes/S-18-settings-architecture.md#46-audit-history-and-concurrency), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-24, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D9.

## Scope

**In:**

- Retention job change; NDJSON export route.

**Out** (and where it belongs instead):

- Other audit streams.

## Design notes

- The kept row must survive every purge.

## Steps

1. Job.
2. Export.

## Acceptance criteria

- [ ] The latest row per setting survives a purge (scheduled-job test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set ST-24 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-24 done`.
