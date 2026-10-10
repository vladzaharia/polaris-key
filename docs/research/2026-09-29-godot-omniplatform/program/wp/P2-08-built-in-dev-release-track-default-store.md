# P2-08 Built-in dev release track and default store track maps

| Field       | Value                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation I: Packages, updates and packs)                                                                                                                                                                                                                                                  |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                                                                                                                                                                                                                              |
| Depends on  | none                                                                                                                                                                                                                                                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-09](P2-09-demote-release-down-release-track.md), [P2-11](P2-11-updates-page-updaters-shipped-platforms.md), [P2-13](P2-13-portal-channel-picker-sha-256.md), [P2-14](P2-14-optional-split-dev-channel-from-dev.md), [D-03](D-03-diceroll-after-p3.md), [F-36](F-36-feed-cleanup-on-default-dev-main.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                               |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/P2-08.md` first; no code before a human approves it                                                                                                                                                                                                                                                          |
| Gates       | `plan-mode`, `rule-9`                                                                                                                                                                                                                                                                                                                               |
| Human input | plan approval (`plans/P2-08.md`)                                                                                                                                                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                           |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **UC-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/P2-12.md`](../plans/P2-12.md) §7: legacy surfaces get `dev` only after P2-12's switch, and only if P2-08 teaches `classifyChannel` (`channels.ts:58-84`) and `policyChannelOf` the `dev` selector.

## Goal

Built-in dev release track and default store track maps, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **UC-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.1, §3.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.1, §3.2, for **UC-01**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.

## Scope

**In:**

- BUILT_IN_CHANNELS gains dev (packages/shared-manifest/src/index.ts:1149); discovery update.channels from known channels minus pr-<n> (services/update/index.ts:56-63); default track maps for Play, TestFlight, Steam, Microsoft Store and Snap; the tier and licence pickers offer dev, and choosing it stores ['beta','dev'] (the 'dev includes beta' rule is applied at write time; the wire predicate is unchanged, WIRE-CONTRACT-V4 §5.1 rule 4) with the R3-01 hint (a dev grant still bypasses the window for 0.0.0-dev builds until P2-14); docs services/release/channels.md; our SDK prereleases publish on dev. Contract change: a documentation row listing dev as built in, no predicate change.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **UC-01**; DX consolidation I: Packages, updates and packs.
- Plan mode (contract row): the plan is approved before any code.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/P2-08.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 7 mockup item(s):** `distribution.channel-app-store`, `distribution.publish-result`, `distribution.publish`, `packages.promote`, `packages.release-tracks-stale`, `packages.release-tracks`, `packages.updates`.

## Acceptance criteria

- [ ] No corpus change; signed documents byte-identical
- [ ] stable, beta and dev exist for every product with no declaration
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `releases/release-tracks`, `updates/*`, `packs/*`; `help/beta`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P2-08 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-08 done`.
