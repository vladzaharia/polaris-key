# CM-28 Consumables and quantity grants from store purchases

| Field       | Value                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred) (DX consolidation H: Distribution channels, storefronts and commerce)                                                      |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                 |
| Depends on  | [CM-27](CM-27-spike-store-purchase-parity-microsoft.md), [CM-22](CM-22-purchases-ledger-one-revocation-path.md), [LX-42](LX-42-quantities-consumables-required.md), [CM-29](CM-29-commerce-service.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                 |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                  |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/CM-28.md` first; no code before a human approves it                                                                                                             |
| Gates       | `plan-mode`, `threat-model`                                                                                                                                                                            |
| Human input | plan approval (`plans/CM-28.md`)                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                              |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CM-28** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: quantity is the offer's quantity times the store's. Consumable offers are refused until LX-42 lands.
- [`plans/CM-29.md`](../plans/CM-29.md) §10: its code goes in `services/commerce/`, after CM-29.

## Goal

Consumables and quantity grants from store purchases, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CM-28** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §6, for **CM-28**.
- [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md), for file and line evidence.

## Scope

**In:**

- Verify consumable transactions (Apple, Play); grant quantities on Licensing's consumable entitlements with redemption state; idempotent per transaction; refunds reduce the quantity; SDK finish and consume after the claim on LX-19/LX-20's names.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CM-28**; DX consolidation H: Distribution channels, storefronts and commerce.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/CM-28.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A replayed transaction grants nothing
- [ ] Refund reduces the balance
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set CM-28 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-28 done`.
