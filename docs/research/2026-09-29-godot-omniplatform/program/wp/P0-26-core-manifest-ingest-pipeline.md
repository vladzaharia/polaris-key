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

- [ ] Golden 'statements produced' tests identical before and after
- [ ] Resync, link and the deploy hook call one pipeline
- [ ] Plan approved (cross-cutting ingest semantics)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-26 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-26 done`.
