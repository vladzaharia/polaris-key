# U-22 Saves SDK on the records store: Node, React, Python (absorbs U-13)

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U3 collections)                                                                              |
| Size        | 1–1.4 engineer-weeks                                                                                               |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-09](U-09-collections-backend.md), [U-08](U-08-merge-prompt.md)                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                             |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                               |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                  |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`) |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Records SDK for Node, React and Python with a saves-only v1 surface (cloudSync.saves, files through the SDK's verified-fetch transport); collection(name) reserved in api.json and shipped when a first adopter declares a non-save collection. Absorbs U-13; SaveConflict renders in UK-05.

- Title: was "Collections SDK in Node, React and Python: `collection`, `put`, `update` with the CAS loop, `add` and `remove`, `onConflict`, records attach merge".
- Absorbs U-13: Saves are the template of the one records store; the saves SDK is U-22's v1 surface.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: `cloudSync.saves` on records and files; `collection()` reserved. [`plans/SP-35.md`](../plans/SP-35.md) §12: `cloudSync.saves` as recorded.

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
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/cloud-sync/*` (the skeleton arrives); `help/sync`; synced data in `help/remove-from-library`.
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
