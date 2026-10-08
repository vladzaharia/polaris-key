# ST-23 Environment export, diff and promote; "Copy settings from product" as a one-time template (D5, D6)

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 5: governance and environments) |
| Size        | 0.8–1.1 engineer-weeks                                                                |
| Depends on  | [ST-18](ST-18-promote-export.md)                                                      |
| Unblocks    | none                                                                                  |
| Role        | `pkey-implementer`                                                                    |
| Plan mode   | no                                                                                    |
| Gates       | rule 10 (OpenAPI + `routeCoverage`)                                                   |
| Human input | none                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                             |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive condition (the note): Environment export/diff/promote and copy-from-product (C-46). Copy-from-product returns as a New Product wizard step when a third product exists. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Environment export/diff/promote and copy-from-product (C-46). Copy-from-product returns as a New Product wizard step when a third product exists.

- Optional now (was required).

## Goal

Settings can be exported, diffed and promoted between D1 environments, and "Copy settings from product" copies another product's settings once as a template.

## Why

D6 rejects a per-product environment dimension; the owner's D5 makes copy-from-product a one-time template, separate from live inheritance ([S-18 owner decisions](../../notes/S-18-settings-architecture.md) item 2: live inheritance with a fan-out preview and an L2 confirm).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-23, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D6.

## Scope

**In:**

- Environment diff and promote; copy-from-product (one-time, audited, no link kept).

**Out** (and where it belongs instead):

- The channel axis (a follow-up).

## Design notes

- A template copy never creates an inheritance link.

## Steps

1. Diff and promote.
2. Copy template.

## Acceptance criteria

- [ ] A copied product does not change when the source changes later (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set ST-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-23 done`.
