# CM-27 Spike: store purchase parity (Microsoft Store, itch.io, consumables)

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred) (DX consolidation H: Distribution channels, storefronts and commerce) |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                            |
| Depends on  | none                                                                                                                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-28](CM-28-consumables-quantity-grants-from-store.md)                                                  |
| Role        | `pkey-spike-runner`                                                                                                                               |
| Plan mode   | no                                                                                                                                                |
| Gates       | none beyond the green gate                                                                                                                        |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CM-27** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Goal

Spike: store purchase parity (Microsoft Store, itch.io, consumables), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CM-27** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **CM-27**.
- [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md), for file and line evidence.

## Scope

**In:**

- Research only, every fact tagged: Microsoft Store collections and purchase API with Entra; itch.io download-key and owned-keys lookups; Apple consumable history and Play consume; EOS ecom. Decides CM-28's scope and the Microsoft Store and itch.io follow-ups.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CM-27**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A note with tagged facts and a recommended scope
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

No code: the research note under `notes/` carries the evidence and the recommendation.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set CM-27 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-27 done`.
