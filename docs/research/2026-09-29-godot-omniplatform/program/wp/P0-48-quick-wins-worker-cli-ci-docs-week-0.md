# P0-48 Quick wins: Worker, CLI, CI and docs (week 0)

| Field       | Value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation A: Ground truth, decisions and quick wins) |
| Size        | 0.6–1 engineer-weeks                                                                                  |
| Depends on  | [UK-14](UK-14-node-terminal.md)                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                |
| Role        | `pkey-implementer`                                                                                    |
| Plan mode   | no                                                                                                    |
| Gates       | none beyond the green gate                                                                            |
| Human input | none                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **TrackA-QW2** in [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins).

## Goal

Quick wins: Worker, CLI, CI and docs (week 0), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **TrackA-QW2** in [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the "Quick wins" sections of the [audits](../../../2026-10-07-dx-consolidation/audits/) (each item in the scope carries its file and line).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **TrackA-QW2**.
- The "Quick wins" sections of the [audits](../../../2026-10-07-dx-consolidation/audits/).

## Scope

**In:**

- Each under a day: pkey sdk default base URL key.plrs.im (packages/cli/src/index.ts:849, after UK-14's rewrite of that file); widen the portal STORE_KINDS filter (services/distribution/page/customer.ts:242); delete 14 dead worker exports; fix reservedNames.ts:65,70 rule text and THREAT-MODEL:5139; fix 'six services' docs (build/onboarding.md:36); gen:settings --check in gate.sh; pkey feeds prune --apply after each stable tag (publish-sdks.yml); validate commerce mappings against the catalog (commerce/admin.ts:204); report-only transitive boundary test and a table-crossing test seeded with today's 17 crossings. The portal readBody cap is P0-16's and the licence-list paging is P0-29's, built once.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track A (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **TrackA-QW2**; DX consolidation A: Ground truth, decisions and quick wins.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Each item lands with a test or a check
- [ ] Boundary and table-crossing tests report today's baseline
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-48 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-48 done`.
