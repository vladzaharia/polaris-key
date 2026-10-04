# U-09 Collections backend: records with CAS and `*`, `inc`, `record_fields` merge, `set_elements` OR-set, wildcard collections, `ownerRead` and `server` classes with console writes, unlicensed limits

| Field       | Value                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U3 collections)                                                                                                                                                                                                                        |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                                                       |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-19](U-19-security-review.md)                                                                                                                                                              |
| Unblocks    | [U-22](U-22-collections-sdk-node-react-python.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md), [U-11c](U-11c-console-data-records.md), [U-24b](U-24b-privacy-records.md), [U-16](U-16-developer-backend-api.md), [U-17](U-17-receipts-e2e-public.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                        |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                                                                            |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                    |

## Goal

Collections are stored: records with compare-and-swap and `*`, `inc`, per-field merge (`record_fields`), the OR-set (`set_elements`), wildcard collections, the `ownerRead` and `server` access classes with console writes, unlicensed limits, transcripts and scenario additions.

## Why

Collections come after saves (owner order, [S-17 owner decisions](../../notes/S-17-user-data-sync.md)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md).
- [S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model), [S-17 §5.4](../../notes/S-17-user-data-sync.md#54-sync-protocol), [S-17 §5.5](../../notes/S-17-user-data-sync.md#55-conflict-strategies-and-developer-merge-hooks) (records), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-09.

## Scope

**In:** the record tables and ops in the DO, access classes, console writes, limits, transcripts, scenarios.

**Out** (and where it belongs instead):

- SDKs (→ U-22, U-23); public collections (→ U-17).

## Design notes

- `server` collections are never delivered to devices.

## Steps

1. Records and CAS. 2. Merge and OR-set. 3. Access classes and transcripts.

## Acceptance criteria

- [ ] The records transcripts of [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact) pass, including OR-set add concurrent with remove and a stale remove.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- sync records
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

- U-22 and U-23 build SDKs on it.

The role agent sets `--set U-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-09 done`.
