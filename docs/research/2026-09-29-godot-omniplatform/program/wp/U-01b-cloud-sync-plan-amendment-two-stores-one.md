# U-01b Cloud Sync amendment: two stores, one conflict vocabulary, quota as an entitlement

| Field       | Value                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (DX consolidation G: Managed config and Cloud Sync)                                                                                                                         |
| Size        | 1.4–1.9 engineer-weeks                                                                                                                                                                           |
| Depends on  | [P0-44](P0-44-corpus-generator-split-corpus-lane-right.md)                                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-05](U-05-cloud-sync-do.md), [U-10](U-10-saves-backend.md), [U-09](U-09-collections-backend.md), [U-30](U-30-config-types-in-app-visibility-in-one.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                            |
| Plan mode   | yes: executes the approved [`plans/U-01b.md`](../plans/U-01b.md) (2026-10-08) §2–§4 and its §6.1 items                                                                                           |
| Gates       | `plan-mode`, `rule-9`, `corpus`, `drift-gate`, `docs-generated`, `cli-bundle`                                                                                                                    |
| Human input | none                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                        |

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

## Corrections found while executing (2026-10-09)

The code is the fact; these differ from `plans/U-01b.md` and are recorded here (Steps 1).

- **Platform settings live in Core's platform slice.** `cloudSync.writesPaused` and
  `cloudSync.quota.defaultBytes` are registered in `core/settings/platform.ts`, not in
  `services/sync/settings.ts`: the registry refuses a service slice that contributes a
  platform-scope entry (`core/settings/rules.ts`, `checkSlice`). The sync slice keeps only
  `cloudSync.ceiling.bytes`. The plan names no confirm level for the kill switch; it is L2 on, L1
  off (the `config.pause-writes` mockup confirms with a passkey).
- **`settingCases` carries the user-block issues.** "A row for an array-typed `merge`
  (refused)" cannot be a route: `syncedSettings` maps every entry. Each case therefore lists the
  `userSettingIssues` it expects (key, code, severity), and `routes` is `null` exactly when an
  issue is an error (the catalog never publishes). A second refused row pins the retired
  `device` scope.
- **The Node runner depends on `@polaris-key/catalog`** (for `syncedSettings` and
  `userSettingIssues`), so `conformance/runners/node/package.json` and `pnpm-lock.yaml` change.
- **`CLOUD_SYNC_SAVE_SLOTS` (16) is exported by `@polaris-key/catalog`** for the `saves`
  template; U-05 moves it to `@polaris-key/protocol/sync` as `SYNC_SAVE_SLOTS`, as §2.5 says.
- **Two mirror fixtures carried the old vocabulary.** `sdks/godot/tests/config/catalog.json`
  and `sdks/kotlin/config/src/test/resources/catalog.json` used `sync: "device"` and
  `cloudSync.saves`; they move to `local` and a `saves`-template collection, and the Godot and
  Kotlin mirror tests expect every Editable key in `USER_SETTINGS`.
- **The docs pages named by the docs plan do not exist yet.** `features/cloud-sync/*`, `help/sync`
  and `help/remove-from-library` arrive with DOC-03a, DOC-05b and DOC-09c (all `todo`). The
  content lands at its current homes, which those packages move: `services/sync/index.md` (the
  skeleton with its status line), `users/sync.md` (new) and `users/portal.md` (synced data).
- **The machine also refuses an invalid value** of a synced key with `bad_request` (D8's
  shipped `config.set` behaviour), after the lock checks and beside the 8 KiB bound.
- **The §7 precondition is read-only on production** and was not run from this branch; the lead
  runs it before merge (no active catalog carries `"cloudSync"` or `"sync":"device"`, no product
  manifest carries `cloudSync`).

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `config.cloud-sync`, `config.entry-setting`, `config.storage-default`.

## Acceptance criteria

- [x] Every command in `plans/U-01b.md` §10 passes (Kotlin's mirror test needs a JDK and is left to CI).
- [x] No signed corpus file changes; `sync-scenarios.json` is v2 with its Godot mirror.
- [x] Every §3.2 row has its rule-9 mutation entry and schema change.
- [ ] The §7 precondition result is recorded in the PR. It is read-only on production, so the lead runs it before merge (see the corrections above).
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/cloud-sync/*` (the skeleton arrives); `help/sync`; synced data in `help/remove-from-library`. They land at their current homes until DOC-03a, DOC-05b and DOC-09c build those trees (see the corrections above).
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

`plans/U-01b.md` §10, then the full green gate in `AGENTS.md`.

## Hand-off

U-05 builds on the contract text, the routes in client-core, the lenient trust-policy reader and `sync-scenarios.json` v2. The role agent sets `--set U-01b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-01b done`.
