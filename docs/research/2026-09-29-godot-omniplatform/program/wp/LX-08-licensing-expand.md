# LX-08 Licensing expand, backfill and dual-write: grants and holder tables, `tiers.rank` and `policyOfflineGraceDays`, licence `kind`, `ended_reason`, `superseded_by` and `source`, provisioned keys into `oidc` grants atomically

| Field       | Value                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                           |
| Size        | 0.7–1 engineer-weeks                                                                                                                                                                   |
| Depends on  | [LX-01](LX-01-licensing-plan.md), [LX-02](LX-02-oidc-signin-fix.md), [LX-06](LX-06-licensing-settings.md)                                                                              |
| Unblocks    | [LX-09](LX-09-entitlement-resolver.md), [LX-11](LX-11-commerce-rework.md), [LX-12](LX-12-licence-lifecycle.md), [LX-13](LX-13-entitlements-backend.md), [LX-25](LX-25-redeem-codes.md) |
| Role        | `pkey-implementer`                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                     |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; generated docs pages (`docs gen:check`; regenerate, never hand-edit)                                              |
| Human input | none                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                              |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** the exact DDL of §6.1; the Core table `entitlement_events` with a pull cursor (Q4); the triggers; no `dist_commerce_settings` table (Q5); the A3 record; the `addon` column, with nothing writing `addon` until LX-25 (Q8).

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Add `tiers.device_access` (`seats` | `account`, default `seats`), backfilled to `account` for tiers that hold only keyless account-bound licences; a licence on an `account` tier never receives a key (`plans/I-04.md` §F.6, SIGN-IN.md D-53). The console tier editor says "Devices: up to N" or "Account-wide · unlimited devices".

## Goal

The licensing model's storage exists and is kept in sync: new tables and columns are added, existing store grants are backfilled into `grants`, commerce, admin and refund paths dual-write, and provisioned entitlement keys become `oidc` grants in the same deploy as the new sign-in writer.

## Why

[S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract) steps 1–4: expand, backfill, dual-write, and the atomic provisioned-keys move. Reads stay on the old objects until LX-09.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.2](../../notes/S-19-licensing-model.md#72-data-model), [S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract) steps 1–4, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-08.
- `program/plans/LX-01.md` (exact DDL).

## Scope

**In:**

- Tables `grants`, `grant_entitlements`, `device_store_identities`, `holder_versions`, `dist_store_product_entitlements`, `dist_holder_bindings`, `dist_binding_aliases`, `dist_commerce_settings`; columns `licenses.kind/ended_reason/superseded_by/source/external_ref_hash`, `tiers.rank/policy_offline_grace_days`, `dist_purchases.grant_id`.
- Backfill; dual-write; provisioned keys → `oidc` grants atomically; highest-rank group choice; `syncTierOnSignIn`.

**Out** (and where it belongs instead):

- The read switch (→ LX-09).
- Contract (→ LX-16).

## Design notes

- One bare `ALTER TABLE … ADD COLUMN` per migration file (R11-04).
- Licensing settings are `product_settings` rows (LX-06), so no `products.licensing_json` column.

## Steps

1. Migrations with replay test.
2. Backfill.
3. Dual-write with reconciliation test.
4. Provisioned-keys move with the writer.

## Acceptance criteria

- [ ] Migrations replay cleanly (test).
- [ ] The reconciliation test shows zero drift between old and new objects.
- [ ] `legacy` documents are byte-identical before and after (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## S-21 amendment (2026-10-05): grant source `polaris-key`

The owner decided on 2026-10-05 that "`direct` really becomes `Polaris Key`"
([S-21](../../notes/S-21-polaris-storefront.md) D9, §6.8). In the grant-source vocabulary of [`plans/LX-01.md`](../plans/LX-01.md)
(`trg_grants_source_{ins,upd}`), write `polaris-key` where the plan says `direct`: the
source of a sale made through Polaris Key itself. No code writes `direct` yet, so this costs
nothing. The portal badge reads "Polaris Key". The outlet id `direct` is unrelated and does not
change.

## Hand-off

- LX-09 switches reads; LX-12 and LX-13 write grants.

The role agent sets `--set LX-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-08 done`.
