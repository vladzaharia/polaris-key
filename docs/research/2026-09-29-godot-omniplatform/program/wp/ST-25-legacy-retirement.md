# ST-25 Legacy settings retirement: `artifacts_access`, `products.branding_json`, bespoke route aliases, access-mode copy; coverage allow-list empty

| Field       | Value                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 5: governance and environments)                                                                         |
| Size        | 0.4–0.55 engineer-weeks                                                                                                                         |
| Depends on  | [ST-11](ST-11-sql-only-settings.md), [ST-14](ST-14-portal-settings.md), [ST-17](ST-17-resync-dry-run.md), [ST-19b](ST-19b-manifest-settings.md) |
| Unblocks    | none                                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                                              |
| Plan mode   | no                                                                                                                                              |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; rule 10 (OpenAPI + `routeCoverage`)                                        |
| Human input | none                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                       |

## Goal

Legacy settings are retired: `release_config.artifacts_access`, `products.branding_json`, the bespoke route aliases and the access-mode copy; the coverage `PENDING` list is empty.

## Why

D12 and D16 ([S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold)); [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else) lists the retirements.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-25, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D12, D16.

## Scope

**In:**

- Confirm no reader diverges, then stop writing and drop; remove aliases; copy-only access-mode unification.

**Out** (and where it belongs instead):

- Any wire enum change (none, D16).

## Design notes

- Drops follow the replayable-migration convention.

## Steps

1. Reader audit.
2. Drops.
3. Alias removal.

## Acceptance criteria

- [ ] `PENDING` is empty.
- [ ] Route coverage passes after alias removal.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None: closes the ST phase.

The role agent sets `--set ST-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-25 done`.
