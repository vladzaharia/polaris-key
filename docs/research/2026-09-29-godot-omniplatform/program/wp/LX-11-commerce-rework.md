# LX-11 Commerce rework: holder bindings, restore policy, Steam store identity, many-to-many and base/seats mappings, `dist_commerce_settings`; Godot commerce follow-up

| Field       | Value                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                         |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                 |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-10](LX-10-anchor-choice.md)                                                                                                                                                  |
| Unblocks    | [LX-14](LX-14-console-licensing.md), [LX-16](LX-16-licensing-contract.md), [LX-20](LX-20-commerce-clients.md), [LX-22](LX-22-licensing-closeout.md), [LX-23](LX-23-subscriptions.md), [LX-25](LX-25-redeem-codes.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                |
| Plan mode   | yes: the plan [`plans/LX-11.md`](../plans/LX-11.md) needs human approval before code                                                                                                                                 |
| Gates       | plan mode; D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; THREAT-MODEL; drift gate (`--check`)                                                                                                 |
| Human input | plan approval (`plans/LX-11.md`)                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                            |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q5: `restorePolicy` and `transferCooldownDays` live per store in the existing commerce connector settings (`dist_connector_settings`, `commerce/settings.ts`), not a separate table; store mappings stay operator-only.

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

## Acceptance criteria

- [ ] A second device of the same Steam user gets the purchase (test).
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
