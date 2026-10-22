# P2-12 One update resolver: retire the GitHub-resolved appcast and version path

| Field       | Value                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation K: Corpus lane (wire trains, serial))                                                                                        |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                            |
| Depends on  | [P0-26](P0-26-core-manifest-ingest-pipeline.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md)                                                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-09](P2-09-demote-release-down-release-track.md), [P2-12b](P2-12b-retire-github-resolver.md), [SP-44](SP-44-updates-for-package-manager-installs.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                           |
| Plan mode   | yes: executes the approved [`plans/P2-12.md`](../plans/P2-12.md) (2026-10-08), PR 1 and PR 2; P2-12b deletes the old path                                                                       |
| Gates       | `plan-mode`, `rule-9`                                                                                                                                                                           |
| Human input | djdl's channel workflow changes before PR 2, and djdl drops the two settings right after PR 2 deploys ([`plans/P2-12.md`](../plans/P2-12.md) Q2)                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                       |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **UC-05** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.

## Approved plan (2026-10-08)

[`plans/P2-12.md`](../plans/P2-12.md) is the scope: PR 1 (release N) and PR 2 (release N+1, the switch) of its §7. It wins over the text below where they differ.

- `release.channelWorkflow` and `release.betaBranch` are removed at the switch, not deprecated: PR 2 makes them a validator error naming the replacement and migrates `products/djdl/product.json` (D7).
- PR 2 merges only under the switch rule (§6.5). Deleting the GitHub-resolved resolver is [P2-12b](P2-12b-retire-github-resolver.md)'s.

## Plan follow-through (2026-10-09)

Approved [`plans/P2-08.md`](../plans/P2-08.md) (2026-10-09) meets the condition in `plans/P2-12.md` §7: P2-08 teaches `classifyChannel` and `defaultIncludes` the `dev` selector (and the matching write-time include), so legacy surfaces serve `dev` after this package's switch.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- It unblocks Python's `update.check()` against the real Worker, and SP-44.

## Corrections (2026-10-22)

The code is the fact; the plan wins on substance. Recorded by P2-12.1 (lead decisions L-P1 to L-P5 accepted 2026-10-22).

1. **Moved anchors.**
   - In `services/release/gateway.ts`: `serveReleaseSurface` is at `:322`, `installationToken` `:474`, `policyChannelOf` `:498`, `resolveSelector` `:531`, `resolveMovingSelector` `:644`, `floorRelease` `:792`, `channelTagsFor` `:826`.
   - In `services/release/resolve.ts`: `resolveCandidates` `:283`, `channelMembers` `:339`, `DeliverableState` `:488`, `loadDeliverableState` `:502`, `resolveInState` `:572`, `legacyPolicyFor` `:728`.
   - Elsewhere: `cachedResolution` is at `ghCache.ts:103`; the sync's metadata write is at `store.ts:960-964`; descriptor ingest's `json_set` is at `descriptor.ts:920`.
   - The validator checks are at `shared-manifest/src/index.ts:2284-2296`. The schema has the root (`:31-38`), the wrapped (`:121-126`) properties and `$defs` `:217`.
   - The registry entries are at `manifestSettings.ts:110-157` and `settingsColumns.ts:80-81`. The system product is now `console/systemProduct.ts`.
2. **d2e14bb27 (2026-10-12), after the plan.** A per-product `releaseUpstream` budget of 4,000 GitHub calls an hour (`meterUpstreamCalls`, `gateway.ts:137-215`) and a 503 `upstream_rate_limited` answer on legacy surfaces. The comparison job's old-path probes and the freshness syncs are charged to it (L-P3); `UpstreamRateLimitedError` maps to `upstream-error` and pauses the job. The `R6-release` and `R10-dos` tests must account for it, and their resolution rows move to byte reads in P2-12.10/.11.
3. **`/release/dl` is Release's:** `services/release/source.ts:295` `serveLegacyDownload`. `/distribution/dl` is Distribution's through `releaseCatalog` and is not touched.
4. **Signed release records** (`pkey-release+jws`) are stored in `release_records` and never rewritten (`records.ts:18`). `listedAssets` lives in `release_metadata.metadata_json` only.

5. **The legacy view's floor is not the live route's floor in two cases (SR-P1 N1, recorded by P2-12.3).** The live path floors by `floorChannelOf`: `beta` with a `channel_workflow` is never floored, and `pr-<n>` and `dev` are never floored. `resolveInState` floors every canonical channel with a recorded floor, so for a product with a channel workflow the store view can answer 404 where the live route answers. P2-12.7's comparator gives this its own class (`beta-workflow-floor`).
6. **A yanked floor falls back by store membership (SR-P1 N2).** `effectiveFloor` picks the fallback among the rows the channel would pick (`channelCandidates`), so on `beta` the fallback can be a stable release (beta includes stable). The live path's `yankedFloorFallback` ranks tags directly. P2-12.7's comparator gives this its own class (`beta-yanked-floor-fallback`).
7. **Caller list of the `serveReleaseSurface` move.** The callers are `services/update/feed.ts` and `services/release/surfaces.ts` (not `routes.ts` or `source.ts`); the surface's constants (the two per-IP rate limits, the edge-cache key and kinds, `ARTIFACT_KINDS`, `runSurface`) moved with it to `release/surface.ts`. `harden`, `upstreamUnavailable` and `meterUpstreamCalls` stay in `gateway.ts`. `policyChannelOf` was already in `channels.ts` (P2-12.2).
8. **`storeRelease()` takes `(db, product, releaseId)`, not a row.** It reads the whole row and its artifacts by key, so a narrow resolution row (SR-P1 N3) can never be rendered. A descriptor file whose `artifact_id` is not a GitHub asset id (`file:<name>`) is not offered in GitHub's shape. `digest` is GitHub's `sha256:<hex>` only when it has that exact shape (lower-cased first), else the row's `sha256`, else absent (SR-P1 N5). `content_type` is the store's derived kind type; the compute steps never relay it (R6-04).
9. **The compute steps and the comparator (recorded by P2-12.4).** `services/update/feed.ts` exports `computeVersion` and `computeAppcast`, each taking `"legacy" | "store"`; the served routes pass `"legacy"`. The store step reads the `v<version>` twin through `storeReleaseByTag` (the legacy view's rows only) and still fetches the Sparkle sidecar and DMG from GitHub by asset id (P2-12.5 changes what it changes). `services/update/resolverCompare.ts` holds `buildProbes`, `runProbe`, `classifyDifference` and `compareProbe`; it reads store tables only through `release/storeRelease.ts` (`tableCrossings`). `/update/version` accepts no `v`-prefixed pin on either step (`classifyChannel` rejects it), so that probe is 404 on both and compares identical. Class order: `stale-store`, `beta-workflow-floor`, `beta-yanked-floor-fallback`, `descriptor-channel`, `descriptor-files`, `workflow-channel`, `beyond-page-cap`, `beta-includes-stable`, `duplicate-version`, else `unexpected`. A legacy-side 503 or throw is `upstream-error`; a store-side throw or 503 is `unexpected`. A sync-recorded channel floor masks `beyond-page-cap` for the live route (it fetches the floor release by tag), so that class shows only where a floor is absent or cleared.

P2-08's `dev` selector is done (3f3eaf34e): `policyChannelOf` already has `dev`, which satisfies §7's condition.

## Goal

One update resolver: retire the GitHub-resolved appcast and version path, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **UC-05** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.1, §3.2, §4.1, §4.2, §4.3, §5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.1, §3.2, §4.1, §4.2, §4.3, §5, for **UC-05**.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- Appcast, /version and legacy downloads resolve from release rows through resolve.ts for every product; the GitHub API only at ingest; a backfill of artifacts for linked products without rows; no per-product fallback flag: a P0-49 job compares old and new resolver output byte for byte per product in production before the switch, and the old path stays one release for a deploy rollback, then goes; golden byte tests for legacy-only products and a plan for legacy SUFeedURLs; release.betaBranch and release.channelWorkflow deprecated (registry deprecated, manifest warnings). W-UP train, after W-LX's prerequisites in the corpus lane.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track K (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **UC-05**; DX consolidation K: Corpus lane (wire trains, serial).
- Plan mode (transcripts byte identical): the plan is approved before any code.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. PR 1: `plans/P2-12.md` §7 row 1. The lead and the owner then run step 2 in production.
3. PR 2: §7 row 3, once the switch rule holds; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 2 mockup item(s):** `packages.updates-failing`, `packages.updates`.

## Acceptance criteria

- [ ] Transcripts byte-identical (golden tests)
- [ ] PR 2 merges under §6.5's switch rule, recorded in the P0-24 ledger
- [ ] The freshness bound of §6.7 holds (test)
- [ ] Every command in `plans/P2-12.md` §11 up to the P2-12b line passes
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `releases/release-tracks`, `updates/*`, `packs/*`; `help/beta`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

`plans/P2-12.md` §11, then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P2-12 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-12 done`.
