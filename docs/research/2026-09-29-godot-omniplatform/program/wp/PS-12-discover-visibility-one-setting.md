# PS-12 Discover visibility: one setting

| Field       | Value                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (DX consolidation H: Distribution channels, storefronts and commerce)                   |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                                           |
| Depends on  | [LX-36](LX-36-access-policy-license-access-absorbs-ps.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md)                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-16](LX-16-licensing-contract.md), [PS-11](PS-11-storefront-closeout.md), [PX-32](PX-32-storefront-decision-panel.md) |
| Role        | `pkey-implementer`                                                                                                                                               |
| Plan mode   | no                                                                                                                                                               |
| Gates       | none beyond the green gate                                                                                                                                       |
| Human input | none                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                        |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **PS-12** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Goal

Discover visibility: one setting, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **PS-12** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.2, §3.1, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.2, §3.1, §4.4, for **PS-12**.
- [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md), for file and line evidence.

## Scope

**In:**

- storefront.polarisKey.visibility (unlisted | eligible | everyone) replaces listed, audience and offerPaths; eligible means accessFor() or a store or obtain path gives the person something; groupLabels become access-rule labels; backfill through a P0-49 job; PolarisKeyPanel simplified.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **PS-12**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Three settings become one
- [ ] Backfill report shows unchanged visibility for existing products
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set PS-12 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-12 done`.
