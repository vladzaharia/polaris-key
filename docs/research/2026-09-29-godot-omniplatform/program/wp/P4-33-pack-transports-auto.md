# P4-33 Pack transports auto

| Field       | Value                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| Phase       | P4: Packs (DX consolidation I: Packages, updates and packs)               |
| Size        | 0.6–0.9 engineer-weeks                                                    |
| Depends on  | [A-25](A-25-action-v2-channels-auto-thin-inputs.md)                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [D-05](D-05-diceroll-after-p6.md) |
| Role        | `pkey-implementer`                                                        |
| Plan mode   | no                                                                        |
| Gates       | `rule-9`                                                                  |
| Human input | none                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CP-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

## Goal

Pack transports auto, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CP-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.3, for **CP-01**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- transports.packs: auto in shared-manifest (Background Assets on Apple channels, Steam depots on Steam, Play Asset Delivery only when chosen, the CDN elsewhere); pkey storefronts sync runs the transport package and upload steps on A-25's Action; fallback to pkey-cdn without store credentials with a readiness note; the ASC connector adds asset-pack versions to submissions where the API allows.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CP-01**; DX consolidation I: Packages, updates and packs.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A pack ships on every channel with no per-transport CI step
- [ ] Missing credentials degrade to the CDN with a note
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P4-33 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-33 done`.
