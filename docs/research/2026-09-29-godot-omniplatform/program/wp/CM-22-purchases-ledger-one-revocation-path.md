# CM-22 Purchases ledger and one revocation path

| Field       | Value                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred) (DX consolidation H: Distribution channels, storefronts and commerce)                                                              |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                         |
| Depends on  | [LX-11](LX-11-commerce-rework.md), [LX-12](LX-12-licence-lifecycle.md)                                                                                                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-23](CM-23-console-commerce-offers-purchases-sales.md), [CM-26](CM-26-portal-account-purchases-across.md), [CM-28](CM-28-consumables-quantity-grants-from-store.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                             |
| Gates       | none beyond the green gate                                                                                                                                                                                     |
| Human input | none                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                      |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CM-22** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Until SP-66 is approved CM-22 ships no developer webhook; `purchase.refunded` is an event only (→ SP-67).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: without `revokePurchase` (D9 moved to LX-11).
- [`plans/CM-29.md`](../plans/CM-29.md) §10: the catch-up. Commerce's first tick after an off-to-on change (its last-tick marker is older than two intervals) polls Play's voided purchases at once (30-day lookback); beyond it, it re-verifies active Play purchases. For the App Store it reads Apple's notification history first (six months) and re-verifies active purchases only beyond it (Q6).

## Goal

Purchases ledger and one revocation path, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CM-22** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **CM-22**.
- [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md), for file and line evidence.

## Scope

**In:**

- A read model over dist_purchases (later dist_orders); one revokePurchase for every source replacing two refund paths; admin GET .../commerce/purchases[/<id>]; a re-verify action; developer webhook purchase.refunded; Steam age-based re-check, daily under 14 days (recheck.ts:34).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CM-22**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 5 mockup item(s):** `commerce.add-to-offer`, `commerce.purchase`, `commerce.purchases-no-results`, `commerce.purchases`, `commerce.sales`.

## Acceptance criteria

- [ ] A refund in any store revokes through one function (grep test)
- [ ] Steam refunds caught within a day
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/commerce/*` (with `features/ship-builds/commerce` and `channels/storefronts` moved in); `help/restore-purchase`, `help/refunds`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set CM-22 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-22 done`.
