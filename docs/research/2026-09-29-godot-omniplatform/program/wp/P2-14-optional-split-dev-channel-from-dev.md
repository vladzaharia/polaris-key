# P2-14 Optional: split the dev channel from the dev-build bypass

| Field       | Value                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation K: Corpus lane (wire trains, serial)) |
| Size        | 0.6–0.9 engineer-weeks                                                                                   |
| Depends on  | [P2-08](P2-08-built-in-dev-release-track-default-store.md), [LX-18](LX-18-licensing-wire.md)             |
| Unblocks    | none                                                                                                     |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                    |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/P2-14.md` first; no code before a human approves it               |
| Gates       | `plan-mode`, `corpus`, `drift-gate`, `all-sdks`                                                          |
| Human input | plan approval (`plans/P2-14.md`)                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **UC-08** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial).

## Goal

Optional: split the dev channel from the dev-build bypass, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **UC-08** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, for **UC-08**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- A license.devBuilds entitlement carries the R3-01 bypass so granting the dev channel never widens the version window; gate-matrix rows; all SDK gates. Rides W-LX as an optional appended member.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track K (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **UC-08**; DX consolidation K: Corpus lane (wire trains, serial).
- Wire change: an all-languages event (contract, catalog, corpus, SDKs; CLAUDE.md plan mode).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/P2-14.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Granting dev no longer bypasses the version window
- [ ] Gate matrix rows appended
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm gen corpus --check
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P2-14 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-14 done`.
