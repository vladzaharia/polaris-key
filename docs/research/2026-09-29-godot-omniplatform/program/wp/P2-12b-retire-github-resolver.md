# P2-12b Retire the GitHub-resolved resolver

| Field       | Value                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation K: Corpus lane (wire trains, serial)) |
| Size        | 0.3–0.5 engineer-weeks                                                                                   |
| Depends on  | [P2-12](P2-12-one-update-resolver-retire-github.md)                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                   |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                    |
| Plan mode   | yes: executes the approved [`plans/P2-12.md`](../plans/P2-12.md) (2026-10-08) §6.8                       |
| Gates       | `plan-mode`                                                                                              |
| Human input | none                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                |

## Goal

The GitHub-resolved resolver is deleted, in the next v0.9.x after P2-12's switch. Done when every acceptance criterion holds and the green gate passes.

## Why

P2-12's switch routes the legacy appcast, `/update/version` and `/release/dl` through `resolve.ts`. The old path stays one release only so the comparison job can run against it once in production (D8). This package removes it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [`plans/P2-12.md`](../plans/P2-12.md) D1, D8, §6.8 and §11.

## Scope

**In** (§6.8):

- `gateway.ts:345-756`, after `floorRelease` moves to `sync.ts` and `installationToken` to `githubApp.ts`.
- The GitHub-resolution imports in `services/update/feed.ts`, `legacyPolicyFor`, and `cachedResolution` if nothing else calls it.
- `CHANNEL_PERMISSIONS` and `InstallationTokenScope.channelWorkflow`, so the installation token stops asking for `actions` and `pull_requests`.
- The `update-resolver` job, `resolveChannel`'s `channelTags` argument, `floorChannelOf`'s read of `channel_workflow`, and resync's and the system product's writes of the two dormant columns.

**Out** (and where it belongs instead):

- The `channel_workflow` and `beta_branch` columns stay dormant (§6.6, §10).

## Design notes

- It ships only when the post-switch dry run shows zero blocking rows and nothing was rolled back. That fact is a P0-24 ledger row, not a day count.

## Steps

1. Confirm the post-switch dry run and record it in P0-24.
2. Delete §6.8's list; run the green gate; hand off.

## Acceptance criteria

- [ ] The post-switch production fact is recorded in P0-24.
- [ ] `rg -n "channelTagsFor|resolveSelector\b|resolveMovingSelector|legacyPolicyFor|CHANNEL_PERMISSIONS" packages/worker/src` finds nothing.
- [ ] Transcripts byte-identical.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

`plans/P2-12.md` §11, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set P2-12b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-12b done`.
