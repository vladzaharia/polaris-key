# U-01b Cloud Sync amendment: two stores, one conflict vocabulary, quota as an entitlement

| Field       | Value                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (DX consolidation G: Managed config and Cloud Sync)                                                                  |
| Size        | 1.4–1.9 engineer-weeks                                                                                                                    |
| Depends on  | [P0-44](P0-44-corpus-generator-split-corpus-lane-right.md)                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-05](U-05-cloud-sync-do.md), [U-10](U-10-saves-backend.md), [U-09](U-09-collections-backend.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                     |
| Plan mode   | yes: executes the approved [`plans/U-01b.md`](../plans/U-01b.md) (2026-10-08) §2–§4 and its §6.1 items                                    |
| Gates       | `plan-mode`, `rule-9`, `corpus`, `drift-gate`, `docs-generated`, `cli-bundle`                                                             |
| Human input | none                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **U-01b** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync).

## Approved plan (2026-10-08)

[`plans/U-01b.md`](../plans/U-01b.md) amends [`plans/U-01.md`](../plans/U-01.md) and is this package's scope. Its Q2 made U-01b the executor (`pkey-implementer`, 1.4–1.9 weeks, after P0-44), as HA-12 was. Where the plan and this brief differ, the plan wins.

## Goal

The Cloud Sync contract slice lands in the W-SYNC slot: the contract text, client-core, the catalog and manifest vocabulary, `sync-scenarios.json` v2 and the lenient trust-policy reader, so that U-05 can build on them. Done when every acceptance criterion holds and the green gate passes.

## Why

The consolidation replaced U-01's licence layer, save routes and per-store vocabularies with two stores (synced settings and records with files), one conflict vocabulary and quota as an entitlement ([`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.3, §1.5, C-02, C-25–C-27; [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md) §5.5 and §8). U-05, U-09 and U-10 build on this slice.

## Read first

- `AGENTS.md` (always), `CLAUDE.md` (plan mode), and the skills `authoring-pkey-manifests` and `adding-a-catalog-entry`.
- [`plans/U-01b.md`](../plans/U-01b.md) in full, then [`plans/U-01.md`](../plans/U-01.md) for what it does not replace (§0 lists it).

## Scope

**In** (`plans/U-01b.md` §7 item 1):

- §2.3's `WIRE-CONTRACT-V4.md` §13 text and §2.5's `shared-protocol` and client-core changes (routes, the `sync` state, `importLocal`).
- §3: `@polaris-key/catalog` (types, `syncedSettings`, templates, constants), `@polaris-key/manifest` (every §3.2 row with its rule-9 mutation entry and schema), settings, the console edits of §3.3, mirrors, skills, docs and the glossary.
- §4: `sync-scenarios.json` to `syncScenariosVersion` 2 (Q1), with its Godot mirror, the constants and the parity rows.
- §6.1's U-01b items, including the lenient trust-policy reader that U-05 relies on.
- The §7 precondition, read-only on production: no active catalog carries `"cloudSync"` or `"sync":"device"`, and no product manifest carries `cloudSync`. If one does, U-01b gains a P0-49 dependency and the `cloudsync-vocabulary` job.

**Out** (and where it belongs instead):

- The Durable Object, routes, quota and pause (→ U-05, U-19); records, files and their routes (→ U-09, U-10); SDK verbs (→ U-06, U-07, U-20, U-21); conflicts (→ U-08); saves (→ U-22, U-23).
- The other briefs' changes in §11 (→ the lead, on approval).

## Design notes

- No signed-corpus change. `PROTOCOL_VERSION` 4, `corpusVersion` 2, `DISCOVERY_VERSION` 2, `transcriptVersion` 1.
- Every retired name is removed with no alias (owner, 2026-10-07): `setConfig`, `clearConfig`, the `device` scope, `onAttach`, `cloudSync.saves`, `cloudSync.open`, `.pkey/product` `cloudSync` and discovery's `endpoints.saves`. Each retired manifest field is a validator error naming its replacement.
- The lenient trust-policy reader is never reverted while U-05 is deployed (§7, Rollback).

## Steps

1. Verify the plan's line references against the code (the code is the fact) and record any correction here, in the same branch.
2. Run the §7 precondition and record the result in the PR.
3. Implement §7 item 1 in one corpus-lane hold; run the green gate; hand off.

## Acceptance criteria

- [ ] Every command in `plans/U-01b.md` §10 passes.
- [ ] No signed corpus file changes; `sync-scenarios.json` is v2 with its Godot mirror.
- [ ] Every §3.2 row has its rule-9 mutation entry and schema change.
- [ ] The §7 precondition result is recorded in the PR.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

`plans/U-01b.md` §10, then the full green gate in `AGENTS.md`.

## Hand-off

U-05 builds on the contract text, the routes in client-core, the lenient trust-policy reader and `sync-scenarios.json` v2. The role agent sets `--set U-01b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-01b done`.
