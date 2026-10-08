# CM-21 Storefront connection: notifications automation and one test-purchase switch

| Field       | Value                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred) (DX consolidation H: Distribution channels, storefronts and commerce)                        |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                   |
| Depends on  | [CM-20](CM-20-commerce-consolidation-plan-lx-11-plan.md), [A-28](A-28-one-store-app-binding-derived-identity.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-23](CM-23-console-commerce-offers-purchases-sales.md)                                                                        |
| Role        | `pkey-implementer`                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                       |
| Gates       | `threat-model`                                                                                                                                                           |
| Human input | none                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CM-21** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Goal

Storefront connection: notifications automation and one test-purchase switch, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CM-21** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §4.3, for **CM-21**.
- [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md), for file and line evidence.

## Scope

**In:**

- The storefront state machine in the channels read model (assignment makes ready); App Store Server Notifications set, verify and test round trip and the Play RTDN verifier as wizard rows; commerce.acceptTestPurchases, migrated by a P0-49 job; the Play push audience defaults to the hook URL (commerce/play.ts:325-345). The identity half lives in A-28.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CM-21**; DX consolidation H: Distribution channels, storefronts and commerce.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Notifications set up from the wizard with no console of the store
- [ ] One test-purchase switch
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set CM-21 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-21 done`.
