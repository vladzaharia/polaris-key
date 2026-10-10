# CM-20 Commerce consolidation plan (= LX-11's plan)

| Field       | Value                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred) (DX consolidation K: Corpus lane (wire trains, serial))                                                                                                                      |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                                                                   |
| Depends on  | [LX-08](LX-08-licensing-expand.md)                                                                                                                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-11](LX-11-commerce-rework.md), [LX-18](LX-18-licensing-wire.md), [CM-21](CM-21-storefront-connection-notifications.md), [CM-25](CM-25-app-purchase-as-licence-source.md), [CM-29](CM-29-commerce-service.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                                                                                                                      |
| Plan mode   | yes: [`plans/CM-20.md`](../plans/CM-20.md), approved 2026-10-08; LX-11 executes it (`planRef`), and LX-23, LX-18, LX-20 and CM-21 to CM-28 build inside it                                                                                               |
| Gates       | `plan-mode`                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CM-20** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial).

- Owner 2026-10-07/08: Commerce is a service (CM-29, `plans/CM-29.md`). Its code lives in `services/commerce/`, device routes move to `/<p>/commerce/*` in CM-29's release with the SDK path strings (no aliases), and the store hook URLs stay as Commerce's canonical routes. Reconcile this package with CM-29's approved plan before building.

## Goal

Commerce consolidation plan (= LX-11's plan), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CM-20** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §4.1, §4.3, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §4.1, §4.3, §6, for **CM-20**.
- [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md), for file and line evidence.

## Scope

**In:**

- plans/CM-20.md: Offer (target tier: or addon:, billing, quantity), SKU per storefront including app, the Purchase ledger read model, the revokePurchase contract (full refund or chargeback revokes at once, partial never), Core subscriptions taken from LX-41, the settings collapse (26 planned commerce.\* keys to 4; three test-purchase switches to commerce.acceptTestPurchases; restore policy x3 plus transferCooldownDays to one Advanced value; renewalBufferHours a constant), the storefront state machine, console IA, the offers backfill (one add-on per distinct key set, one offer per add-on, each store row a SKU) and the additive wire for LX-18 (offers[], app claim kind, transferred) with transcripts and SDK order; THREAT-MODEL deltas.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track K (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CM-20**; DX consolidation K: Corpus lane (wire trains, serial).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Write `plans/CM-20.md` and stop for human approval; name the corpus regeneration and every SDK that follows where the wire is touched.
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Plan approved; names the corpus regeneration and LX-19/LX-20
- [ ] Commerce is the `commerce` service, which requires License (CM-29). This plan's routes, settings and tables are CM-29's
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm gen corpus --check
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set CM-20 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-20 done`.
