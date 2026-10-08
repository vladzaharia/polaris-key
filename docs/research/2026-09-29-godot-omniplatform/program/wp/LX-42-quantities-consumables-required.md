# LX-42 Quantities and consumables (required licensing-train member)

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation K: Corpus lane (wire trains, serial)) |
| Size        | 1–1.4 engineer-weeks                                                                                               |
| Depends on  | [LX-35](LX-35-add-on-definitions-grantaddon.md), [LX-18](LX-18-licensing-wire.md)                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-28](CM-28-consumables-quantity-grants-from-store.md)                   |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                              |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/LX-42.md` first; no code before a human approves it                         |
| Gates       | `plan-mode`, `threat-model`, `rule-10`                                                                             |
| Human input | plan approval (`plans/LX-42.md`)                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-42** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial).

## Goal

Quantities and consumables (required licensing-train member), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-42** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.2, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.2, §6, for **LX-42**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), for file and line evidence.

## Scope

**In:**

- grants.quantity; a grant_consumptions ledger; consume, reverse and acknowledge semantics idempotent per request id; device routes (their contract rows are a required member of LX-18's plan; the SDK verbs ship in the LX-19 wave) and developer-backend routes; console and portal delivery status; errors.json codes; parity rows; THREAT-MODEL (replay, refund after consume). Decided under the brief (owner brief 'multiples of the same entitlement ... redemption status'). Consumable store products are refused until this lands.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track K (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-42**; DX consolidation K: Corpus lane (wire trains, serial).
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/LX-42.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A replayed consume is rejected
- [ ] A refund after consume reduces the balance, never below zero
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-42 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-42 done`.
