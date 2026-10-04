# U-22 Collections SDK in Node, React and Python: `collection`, `put`, `update` with the CAS loop, `add` and `remove`, `onConflict`, records attach merge

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U3 collections)                                                                              |
| Size        | 1–1.4 engineer-weeks                                                                                               |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-09](U-09-collections-backend.md), [U-08](U-08-merge-prompt.md)                 |
| Unblocks    | [U-15c](U-15c-docs-records.md)                                                                                     |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                               |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                  |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`) |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

Node, React and Python expose collections: `collection`, `put`, `update` with the CAS loop, `add` and `remove`, `onConflict`, and the records branch of the attach merge.

## Why

[S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md); [S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-22.

## Scope

**In:** the API in three SDKs, transcripts, scenarios, parity rows.

**Out** (and where it belongs instead):

- Swift, Kotlin, Godot (→ U-23).

## Design notes

- One outstanding compare-and-swap per target (scenario).

## Steps

1. API. 2. Transcripts and scenarios.

## Acceptance criteria

- [ ] Three SDKs replay the records transcripts and scenarios.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-15c documents it.

The role agent sets `--set U-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-22 done`.
