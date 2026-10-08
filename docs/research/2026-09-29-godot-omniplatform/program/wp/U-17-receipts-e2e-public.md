# U-17 Server-signed receipts (separate keyring), opaque end-to-end encrypted value type, public collections

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U4 later)                                                             |
| Size        | 1.2–2 engineer-weeks                                                                        |
| Depends on  | none                                                                                        |
| Unblocks    | none                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                       |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/U-17.md` first; it needs human approval before code  |
| Gates       | plan mode; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`) |
| Human input | none                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                   |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): dropped.** The id stays in the graph as `dropped` so it
> is not reused; do not build this package.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **drop** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Receipts keyring, end-to-end value type and public collections: three new concepts with no owner ask.

- Dependencies cleared on closing (they were U-09 and U-10), so nothing in the graph waits on or through a closed package.

## Goal

Optional extras: server-signed receipts on their own keyring, an opaque end-to-end encrypted value type with developer-held keys, and public collections.

## Why

Decisions 13 and 14 ([S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions)): later, outside the signed corpus.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/U-17.md` once approved; [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-17, [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decisions 13 and 14.

## Scope

**In:** the plan and whichever of the three the owner chooses.

**Out** (and where it belongs instead):

- None.

## Design notes

- Optional; a new signed artefact needs its own keyring and plan.

## Steps

1. Plan, approved. 2. Build.

## Acceptance criteria

- [ ] As the approved plan sets.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

- None.

The role agent sets `--set U-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-17 done`.
