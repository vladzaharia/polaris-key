# ST-11 SQL-only settings into the registry: lazy-delta per-product settings, email caps and `operator_policy_json`, each moved once

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 3: coverage)                          |
| Size        | 0.6–0.85 engineer-weeks                                                                     |
| Depends on  | [ST-09](ST-09-platform-settings-area.md), [ST-05a](ST-05a-one-settings-read-write-path.md)  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-25](ST-25-legacy-retirement.md)                 |
| Role        | `pkey-implementer`                                                                          |
| Plan mode   | no                                                                                          |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; drift gate (`--check`) |
| Human input | none                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                   |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> SQL-only settings into the one registry; depends on ST-05a only.

- Depends on: added ST-05a; removed ST-05.

## Goal

The SQL-only settings (per-product lazy-delta settings, email caps and `release_config.operator_policy_json`) become registry entries stored as `product_settings` rows, each moved exactly once.

## Why

These settings can be changed only with SQL today ([S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home)); [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else) gives the move rule.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home), [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-11.
- `docs/RUNBOOK.md`.

## Scope

**In:**

- Copy once into rows with one `origin = 'system'` audit row each; routes and matrix columns; RUNBOOK updates; old tables dropped one release later.
- `PENDING` shrinks.

**Out** (and where it belongs instead):

- Legacy retirement (→ ST-25).

## PENDING entries to remove

ST-06 left a shrinking allow-list in `packages/worker/scripts/settings-coverage.ts`. Its "PENDING owners" decision ([ST-06](ST-06-settings-docs-coverage.md#design-notes)) assigns this package the 3 entries below. Register each one in the settings registry (the note names the intended key, where there is one), then delete it from `PENDING` and lower `PENDING_CEILING` by the same count. `checkCoverage` refuses an entry that is both pending and registered, so the two edits land together.

- `table:lazy_delta_settings`
- `table:email_product_caps`
- `env:EMAIL_PRODUCT_DAILY_CAP` (`email.dailyCapDefault`)

## Design notes

- Each column is moved once and never touched again.

## Steps

1. Migration and copy.
2. Readers switched.
3. RUNBOOK.

## Acceptance criteria

- [ ] Every `PENDING` entry listed under "PENDING entries to remove" is registered and gone from `settings-coverage.ts`, `PENDING_CEILING` is 3 lower, and `settings-coverage.test.ts` passes.
- [ ] Every moved value reads back identically through the resolver (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- ST-25 drops the old tables.

The role agent sets `--set ST-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-11 done`.
