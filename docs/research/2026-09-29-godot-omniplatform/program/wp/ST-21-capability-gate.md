# ST-21 Capability gate `can()` on every settings write; `useCan` reads capabilities

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 5: governance and environments) |
| Size        | 0.5–0.7 engineer-weeks                                                                |
| Depends on  | none                                                                                  |
| Unblocks    | none                                                                                  |
| Role        | `pkey-implementer`                                                                    |
| Plan mode   | no                                                                                    |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL                                     |
| Human input | none                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                             |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [ST-29](ST-29-admin-route-table-can-usecan.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [ST-29](ST-29-admin-route-table-can-usecan.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> can() belongs on every admin route, not only settings writes; the registry capability becomes the settings routes' capability.

- Dependencies cleared on closing (they were ST-05), so nothing in the graph waits on or through a closed package.

## Goal

Every settings write checks a capability with `can()`, and the console's `useCan` reads capabilities from the server.

## Why

D10: capability field and gate now, roles later ([S-18 §4.8](../../notes/S-18-settings-architecture.md#48-authorization)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.8](../../notes/S-18-settings-architecture.md#48-authorization), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-21, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D10.

## Scope

**In:**

- `can()` on every settings write; capability on each registry entry; `useCan`.

**Out** (and where it belongs instead):

- Per-product roles (→ ST-22).

## Design notes

- Today's admin group remains the only role.

## Steps

1. Gate.
2. Console hook.
3. Tests.

## Acceptance criteria

- [ ] Every settings route checks `can()` (route coverage test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-22 adds roles behind the same gate.

The role agent sets `--set ST-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-21 done`.
