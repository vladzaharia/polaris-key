# U-10 Saves backend: begin, streamed upload with sha256, finalize, revisions, metadata policies, R2 GC alarm, per-principal data keys, `requiresFlag`, unlicensed saves limits

| Field       | Value                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U2 merge and saves)                                                                                                                                                             |
| Size        | 1.4–1.95 engineer-weeks                                                                                                                                                                               |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-19](U-19-security-review.md)                                                                                                       |
| Unblocks    | [U-13](U-13-saves-sdk-node-react-python.md), [U-25](U-25-saves-sdk-swift-kotlin-godot.md), [U-11b](U-11b-console-data-saves.md), [U-24a](U-24a-privacy-saves.md), [U-17](U-17-receipts-e2e-public.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                 |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                     |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `wrangler.toml`                                               |
| Human input | a dedicated R2 bucket for save blobs per environment, binding `SYNC_SAVES`, no bucket lock (plans/U-01.md Q4), plus an EU twin if U-24 offers residency                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                             |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** a dedicated bucket, binding `SYNC_SAVES`, with no bucket lock (Q4), created by the owner before U-10 starts (plus an EU twin if U-24 offers residency); `PUT` in `CORS_ALLOW_METHODS`; `requiresFlag` through `syncAccess`.

## Goal

Saves are stored: begin, streamed upload with sha256 (multipart only above 100 MB), finalize, revisions, metadata policies, an R2 GC alarm, per-principal data keys for crypto-shredding, `requiresFlag`, and the unlicensed saves limits.

## Why

Saves are the Godot path's goal ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages), "The Godot path"). Content-addressed objects make concurrent uploads safe ([S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md).
- [S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model) (R2 layout), [S-17 §5.4](../../notes/S-17-user-data-sync.md#54-sync-protocol), [S-17 §5.5](../../notes/S-17-user-data-sync.md#55-conflict-strategies-and-developer-merge-hooks) (saves), [S-17 §5.7](../../notes/S-17-user-data-sync.md#57-quotas-and-limits), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-10.

## Scope

**In:** save routes, `saves` and `revisions` tables in the DO, R2 `u/<product>/<subject>/<sha256>`, GC alarm, data keys, limits, transcripts.

**Out** (and where it belongs instead):

- SDKs (→ U-13, U-25); export and deletion of saves (→ U-24a).

## Design notes

- Saves are off for signed-in users with no licence unless the product sets `unlicensed.saves` (owner default: 1 MiB, saves off).
- Downloads are `octet-stream` with `attachment`; no public URLs (T9).

## Steps

1. Routes and DO tables. 2. R2 and GC. 3. Limits, transcripts.

## Acceptance criteria

- [ ] Begin, upload and finalize, including a hash mismatch, are recorded as transcripts and pass.
- [ ] Unreferenced objects are collected (test); unlicensed limits enforced (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- sync saves
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

- U-13 and U-25 build SDKs on it; U-24a adds export and shredding.

The role agent sets `--set U-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-10 done`.
