# LX-11 Store purchases on offers: placement, restore and one revocation path (executes CM-20)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                                                                                                                                                                                                                                                                                                  |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-10](LX-10-anchor-choice.md), [CM-20](CM-20-commerce-consolidation-plan-lx-11-plan.md), [LX-35](LX-35-add-on-definitions-grantaddon.md), [CM-29](CM-29-commerce-service.md), [LX-12](LX-12-licence-lifecycle.md), [P0-21](P0-21-notification-substrate-core-notify.md)                                                                                                                                                                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-14](LX-14-console-licensing.md), [LX-16](LX-16-licensing-contract.md), [LX-20](LX-20-commerce-clients.md), [LX-22](LX-22-licensing-closeout.md), [LX-23](LX-23-subscriptions.md), [LX-25](LX-25-redeem-codes.md), [CM-22](CM-22-purchases-ledger-one-revocation-path.md), [CM-23](CM-23-console-commerce-offers-purchases-sales.md), [CM-24](CM-24-one-steam-ownership-engine-absorbs-ps-07.md), [CM-25](CM-25-app-purchase-as-licence-source.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Plan mode   | yes: executes CM-20's plan, [`plans/CM-20.md`](../plans/CM-20.md) (`planRef`), which needs human approval before code                                                                                                                                                                                                                                                                                                                                                                         |
| Gates       | plan mode; D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; THREAT-MODEL; drift gate (`--check`)                                                                                                                                                                                                                                                                                                                                                                          |
| Human input | plan approval (`plans/CM-20.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q5: `restorePolicy` and `transferCooldownDays` live per store in the existing commerce connector settings (`dist_connector_settings`, `commerce/settings.ts`), not a separate table; store mappings stay operator-only.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Its plan is CM-20 (planRef). Store products become SKUs of offers targeting tier: or addon:; purchases land on the account's licence (licence-held only, C-07); Steam ownership goes to CM-24; restore policy is one Advanced value per store; title drops dist_commerce_settings. Retires LX-08's licensingCatchUp (deploy hook and nightly) and the store-grant dual-write in the release where offers become the writer.

- Title: was "Commerce rework: holder bindings, restore policy, Steam store identity, many-to-many and base/seats mappings, `dist_commerce_settings`; Godot commerce follow-up".
- Depends on: added CM-20 and LX-35.
- Plan: executes CM-20's plan (`planRef: CM-20`, [`plans/CM-20.md`](../plans/CM-20.md), not written yet); `plans/LX-11.md` is no longer written.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: server only; its Godot step moves to LX-20, and its code goes in `services/commerce/`. `restore` lives in `commerce.stores`, and `DEFAULT_RESTORE` is `transfer` for every store (Q1, owner, 2026-10-08). Its acceptance follows the plan's §9.

## Goal

Store purchases follow the holder, not the first licence: holder bindings, per-store restore policy, Steam store identity, many-to-many and base/seats store-product mappings, `dist_commerce_settings`; the Godot commerce client follows.

## Why

"First licence wins" strands purchases across devices (G3, G4, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)). Decisions 8 and 11 ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 8, decision 11). Plan mode: it reworks shipped P6-01 code with live store semantics and touches the commerce wire.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.7](../../notes/S-19-licensing-model.md#77-store-purchases-under-oc), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-11.
- `packages/worker/src/services/distribution/commerce/` (P6-01).

## Scope

**In:**

- The plan; holder bindings; restore policy (`share-by-store-identity` for Steam, `transfer` for Apple and Play, `block`); transfer cooldown; Steam identity; mappings; Godot follow-up.

**Out** (and where it belongs instead):

- Other SDK clients (→ LX-20); subscriptions (→ LX-23).

## Design notes

- Existing per-licence bindings stay valid; dual-write.
- Must land before I-14 ships Steam DLC grants.
- ST-12 builds its mapping editor on this shape.

## Steps

1. Plan and approval.
2. Server rework.
3. Godot client; transcripts.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `commerce.offer-new`, `commerce.offer`, `commerce.offers`.

## Acceptance criteria

- [ ] A second device of the same Steam user gets the purchase when it runs on the same licence. On another licence of the same account, it gets the purchase once the first licence is unusable. On another holder's licence, it gets it by a transfer under `transfer`, which moves the purchase rather than sharing it, and never under `block` (test).
- [ ] A restore under `transfer` moves the grant and notifies (test).
- [ ] Transcripts regenerated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

- LX-14, LX-16, LX-20, LX-22, LX-23, LX-25.

The role agent sets `--set LX-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-11 done`.
