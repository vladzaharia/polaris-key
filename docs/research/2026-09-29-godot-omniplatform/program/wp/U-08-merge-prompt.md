# U-08 One conflict vocabulary and MergeRequest in six SDKs

| Field       | Value                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U2 merge and saves)                                                                                                                                                                                                                        |
| Size        | 0.4–0.55 engineer-weeks                                                                                                                                                                                                                                          |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-06](U-06-sdk-settings-node-python.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-20](U-20-sdk-settings-react.md), [U-21](U-21-sdk-settings-godot.md), [I-05](I-05-accounts-core.md), [U-09](U-09-collections-backend.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-22](U-22-collections-sdk-node-react-python.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md)                                                                                                                    |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                             |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                                                                                |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`); UI kit screenshots; transcripts and scenarios for empty and non-empty clouds and for a merged account with parked units                      |
| Human input | none                                                                                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                        |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One conflict vocabulary (lastWrite, max, min, merge, union, revision) and one MergeRequest with keep(...) across six SDKs; no onAttach (first sign-in is an ordinary sync). Prompt renders in the rebuilt kits only.

- Title: was "Merge prompt framework for collections and saves: `empty` flag, `MergeRequest` in six SDKs, merge prompt components in the four UI kits, parking added to U-05's account-merge hook".

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: §2.2, with `revision` the only case that prompts. The server side moves to U-09.

## Goal

The anonymous-to-signed-in merge prompt exists for collections and saves: the `empty` flag, `MergeRequest` in all six SDKs, merge prompt components in the four UI kits (Swift `PolarisKeyUI`, Godot `addons/polaris_key/ui`, React, Kotlin), and parking of colliding records and saves added to U-05's account-merge hook.

## Why

The owner ordered the merge and saves right after the MVP ([S-17 owner decisions](../../notes/S-17-user-data-sync.md)). Settings already upload at first sign-in without a prompt in U1; only the prompt framework waits for U2 ([S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decisions 8 and 17).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md).
- [S-17 §5.5](../../notes/S-17-user-data-sync.md#55-conflict-strategies-and-developer-merge-hooks), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-08, [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decisions 8 and 17.

## Scope

**In:** the framework and UI components; parking in the server-side merge hook.

**Out** (and where it belongs instead):

- Saves and records branches (→ U-13, U-25, U-22, U-23).

## Design notes

- Upload when the cloud is empty; otherwise per-tier policy; saves are never overwritten; prompt only on a real conflict.
- The absorbed subject's records and saves are parked, never deleted, until the prompt resolves.
- Account merge follows S-16 D21 (accepted 2026-10-04): per product the survivor's pairwise subject wins, the other becomes an alias, and the developer receives `subject.merged`. A merge starts only from proof of both accounts in one session, including the email-confirmation step's join offer when the confirmed email belongs to another account; it is never silent.
- "Anonymous-to-signed-in" means the device's first sign-in through the product (owner, 2026-10-04, final answers); a licence attach without sign-in never triggers it.
- The Godot slice can start as soon as U-21 lands.

## Steps

1. Server parking. 2. SDK `MergeRequest`. 3. UI kit components.

## Acceptance criteria

- [ ] Scenarios for empty and non-empty clouds and a merged account with parked units pass in all six SDKs.
- [ ] UI kit screenshots for the prompt.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:sync-scenarios -- --check
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-13, U-25, U-22 and U-23 add their merge branches.

The role agent sets `--set U-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-08 done`.
