# P2-12 One update resolver: retire the GitHub-resolved appcast and version path

| Field       | Value                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation K: Corpus lane (wire trains, serial)) |
| Size        | 1–1.5 engineer-weeks                                                                                     |
| Depends on  | [P0-26](P0-26-core-manifest-ingest-pipeline.md)                                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                   |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                    |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/P2-12.md` first; no code before a human approves it               |
| Gates       | `plan-mode`, `rule-9`                                                                                    |
| Human input | plan approval (`plans/P2-12.md`)                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **UC-05** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.

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
2. Wait for the approved `plans/P2-12.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Transcripts byte-identical (golden tests)
- [ ] The GitHub-resolved resolver is deleted
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P2-12 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-12 done`.
