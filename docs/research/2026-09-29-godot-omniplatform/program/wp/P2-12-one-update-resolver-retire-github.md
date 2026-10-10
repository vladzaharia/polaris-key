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
