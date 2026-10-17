# P0-26 Core manifest ingest pipeline

| Field       | Value                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                               |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                |
| Depends on  | [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md), [P0-18](P0-18-table-ownership-owner-stores-one-audit.md)                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-12](P2-12-one-update-resolver-retire-github.md), [ST-17](ST-17-resync-dry-run.md), [ST-43](ST-43-new-product-wizard.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                               |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/P0-26.md` first; no code before a human approves it                                                                          |
| Gates       | `plan-mode`                                                                                                                                                         |
| Human input | plan approval (`plans/P0-26.md`)                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                           |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-12** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Core manifest ingest pipeline, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-12** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, for **CQW-12**.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- Move product-wide link and resync orchestration from services/release/{linkRepo,resync,linkExisting}.ts into core/ingest/; services contribute through manifestIngest; Release keeps the GitHub fetch and release_config; HA-12's core.presentation resync moves here; enables repo-less ingest for the New Product wizard (ST-43) and ST-17's dry-run plan.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-12**; DX consolidation B: Foundations (code quality the feature tracks build on).
- Plan mode (ingest semantics): the plan is approved before any code.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/P0-26.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Golden 'statements produced' tests identical before and after (harness and fixtures committed, 2026-10-17; the pipeline is not yet moved onto them)
- [ ] Resync, link and the deploy hook call one pipeline
- [ ] Plan approved (cross-cutting ingest semantics)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Progress and continuation (2026-10-17)

Done on `wp/P0-26-ingest` (plan commit order):

1. **Commit 1, the golden harness.** `packages/worker/test/ingest/{recordingDb,world,golden.test}.ts` and
   `test/fixtures/ingest/golden.json`, captured from the pre-pipeline code. 12 scenarios
   (35 captures, stable over repeated runs): link (full with ST-42 choices, minimal), resync
   (unchanged, changed, console claims, drops, every refusal, break-glass, each service off),
   link-existing (applied, refused after the write), the deploy hook (first link, re-link over a
   claim, static tokens and an expired break-glass) and the dry runs. It compares per-table writes
   in order (audit as a multiset), the end state, the masked result and D1 round trips (may not
   grow). A first run with `INGEST_GOLDEN_CAPTURE=1` only adds a missing key.
2. **D6.** `parseManifest` returns `warnings` on the ok arm; Action bundle regenerated.
3. **D7.** `RemovedBy` accepts `ST-` ids; the six rows are retagged (`edgeMintApproval` permanent,
   `settingsBackfill` P0-49, `settingsClaims` ST-17, `core/products/store.ts` profiles ST-43). 14
   `P0-26` rows remain (6 `SEAMS`, 8 `WRITE_SEAMS`), exactly the ones the pipeline deletes.

**P0-26a (2026-10-17, same branch).** Link and resync run on the Core pipeline:

- `core/ingest/{types,pipeline,core,rows,shared,manifestSecrets,constants}.ts` and the facet
  `contributes.manifest` (`core/contributions.ts`). Contributors: Core (`core/ingest/core.ts`),
  License, Config, Identity, Release, Distribution (`services/<slug>/ingest.ts`).
- Deviation from the plan's shape: a contributor lists its refusals as lazy `checks`, which the
  pipeline runs in `REFUSAL_ORDER` and stops at the first, then calls `prepare`. This keeps a
  refused ingest's D1 reads equal to the old code's (D4: round trips may not grow) and the first
  refusal in the old order. The method is `run`, not `apply` (a plain function has an `apply`,
  so a stale `ManifestIngest` would type-check as an `Ingest`).
- `resyncRepo` / `linkRepo` / `registerFromManifest` are now the GitHub source adapters. The
  descriptor hooks (`manifestIngest`, `manifestIngestAlways`, `manifestIngestFor`) STAY: the
  deploy hook (`linkSystemProduct`) still runs them until P0-26b. The contributors call the same
  statement functions, so there is one implementation of each row.
- Goldens: all pass; the audit rows in the end-state dump are sorted (multiset) and
  `13-link-secret-default` is D5 delta 1 (both listed in the golden header). D5 deltas 2 and 3
  belong to the dry runs (26b). New: `test/ingest/documents.test.ts` (D8).
- Builders moved to their owners; 6 `WRITE_SEAMS` and 3 `SEAMS` rows gone. 5 `P0-26` rows remain.
- Two small undeclared changes: link now writes a tier's `rank` and `policyOfflineGraceDays`
  (the old link insert omitted them, so a first link lost them until the next resync), and
  `ingest` stays optional, falling back to the registry `mount.ts` bound (`BOUND_INGEST`).

**P0-26b (2026-10-17, branch `wp/P0-26b`).**

1. The deploy hook runs on the pipeline (`scope: "system"`, D3): Core writes the product's
   presentation, the manifest-authoritative publisher and the ended break-glass claims (as `tail`),
   Release the `release_config` upsert and deliverables, License/Identity/Distribution only their
   row settings, Config nothing. `linkSystemProduct` takes `env` first. Goldens 11a/11b identical.
2. The dry runs call `Ingest.plan` (`core/ingest/plan.ts` holds `planRepoManifest`'s body, now
   `planManifest`; the refusals are the contributors' own checks, run without stopping). D5 deltas
   2 and 3 are goldens 14a-14c (listed in the golden header).
3. The old hooks (`manifestIngest`, `manifestIngestAlways`, `manifestIngestFor`, the registry types),
   `NO_INGEST` and `BOUND_INGEST` are gone; `ingest` is required (D2) in `linkRepo`, `resyncRepo`,
   `linkExistingProduct`, `prepareCreate`, `prepareLink`, `planResync` and `linkSystemProduct`.
4. No `P0-26` row remains in `tableCrossings`. Config owns `schemaStore.ts` and `profileStore.ts`.
   `setFingerprintPolicy`, `setAutoIssuePolicy` and `setServices` stay: about 25 test files call
   them, and they are not production callers; `settings-writes` lists them as before.
5. `contribute/architecture.md` describes `contributes.manifest`.
6. The shims are removed (`release/manifestSecrets.ts`, the `resync.ts` and `linkRepo.ts`
   re-exports). `release/public.ts` re-exports `screenCatalog` / `withStoredSecrets` from Core for
   the console's backfill.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-26 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-26 done`.
