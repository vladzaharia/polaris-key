# LX-08 Licensing expand, backfill and dual-write: grants and holder tables, `tiers.rank` and `policyOfflineGraceDays`, licence `kind`, `ended_reason`, `superseded_by` and `source`, provisioned keys into `oidc` grants atomically

| Field       | Value                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                                |
| Size        | 0.7–1 engineer-weeks                                                                                                                                                                                                        |
| Depends on  | [LX-01](LX-01-licensing-plan.md), [LX-02](LX-02-oidc-signin-fix.md), [LX-06](LX-06-licensing-settings.md)                                                                                                                   |
| Unblocks    | [LX-09](LX-09-entitlement-resolver.md), [LX-11](LX-11-commerce-rework.md), [LX-12](LX-12-licence-lifecycle.md), [LX-13](LX-13-entitlements-backend.md), [LX-25](LX-25-redeem-codes.md), [CM-02](CM-02-provider-webhooks.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                          |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; generated docs pages (`docs gen:check`; regenerate, never hand-edit)                                                                                   |
| Human input | none                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                   |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** the exact DDL of §6.1; the Core table `entitlement_events` with a pull cursor (Q4); the triggers; no `dist_commerce_settings` table (Q5); the A3 record; the `addon` column, with nothing writing `addon` until LX-25 (Q8).

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- No `tiers.device_access` column. **Owner decision (2026-10-05): sign-in licenses stay device-limited**, so "issued by signing in" is a derived fact shown only as the origin "From signing in" (held by an account, no key; `plans/I-04.md` §F.6, SIGN-IN.md D-53), not a tier policy and never a licence type (owner decision 2026-10-05: no 'Account-wide' label). The console tier editor keeps "Devices: up to N" for every tier.

## Amendments from S-22 (2026-10-05)

The commerce plan [S-22](../../notes/S-22-polaris-key-commerce.md) (its packages are optional and deferred) changes this brief as follows. These amendments win over the text below where they differ.

- **Grant source vocabulary.** As the S-21 amendment below says: `polaris-key` replaces `direct` in the `trg_grants_source_{ins,upd}` vocabulary and in the `licenses.source` values (meaning: bought through Polaris Key checkout; [S-22](../../notes/S-22-polaris-key-commerce.md#101-owner-decisions-delegated-to-claude-2026-10-05) decision D9). There is no `direct` grant source: a sale a developer records through the admin API is a `comp` grant (portal "From <developer>"). Commerce also writes `external_ref_hash` (the provider's payment or subscription id, hashed) and `order_ref` on every grant and licence it creates. Nothing writes `polaris-key` until CM-05.

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

## Corrections from the code (LX-08, 2026-10-06)

The implementer checked the brief and `plans/LX-01.md` §6.1–6.2 against the code. Where they
disagreed, the code won, as follows:

- **The decision record is Amendment A4, not A3.** A3 is Cloud Sync's (U-01,
  `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md`).
- **The `oidc` layer sits right after the licence overrides, not before them.** It is merged
  without any key the overrides carry. With disjoint keys both positions give the same values,
  but not the same bytes. `mergeMap` appends a key it has not seen, so the layer that brings a
  key in decides where the key sits in the signed `entitlements` and in the ETag material.
  LX-02's writer re-appends the declared keys after every operator key, and only the "after"
  position reproduces that order (`core/grants.ts` header).
- **A move that would reorder keys is deferred.** This affects a licence whose column has an
  operator key after a provisioned key, or an entry stored in another member order. The
  background move leaves such a licence to its next sign-in, which rewrites the document anyway.
  The move never bumps `licenses.modified_at`, which is the `updatedAt` of the injected policy
  entries.
- **The backfill is an upsert, not `INSERT OR IGNORE`.** It has the same deterministic ids, and a
  replay still writes nothing. The catch-up after the deploy runs the same projection to absorb
  the deploy window. For an active grant only its active flag rows become keys, because a flag a
  refund revoked under an earlier mapping is not in the legacy layer either; a revoked grant keeps
  all its keys. `modified_at` is the latest grant or revocation:
  `MAX(MAX(granted_at), MAX(revoked_at))`, where the plan had
  `COALESCE(MAX(revoked_at), MAX(granted_at))`.
- **The DDL has one column per line.** The plan's compact DDL would break the D1 data-model
  generator, which reads one column per line.
- **The maxOfflineDays warning keeps its code.** The code stays `tier_ignored_field`, and its
  three messages gain "for offline grace use policyOfflineGraceDays". The plan's
  `tier_max_offline_days_alias` name does not exist in the validator, and renaming a code is a
  breaking change. LX-05b can split it when the warning becomes an error. The new rules are
  `invalid_tier_rank` and `invalid_tier_policy_offline_grace_days`, with mutation-table entries
  and the schema.
- **Subject stores.** `entitlement_events` is registered (`core/entitlementEvents.ts`). `grants`
  cannot be a subject store: it is keyed by `account_id`, which the registry guard forbids. Its
  merge re-key and deletion stay with LX-13 (plan §7, I-05 follow-ups), and nothing writes an
  account-held grant before then.
- **`holder_versions` is created empty.** LX-08 bumps no version. LX-09 adds the bumps on every
  licence, grant, override and device write together with the cache that reads them; partial
  bumps would be a false invariant.
- **Where the move runs.** The deploy-hook job `licensing.migrateProvisioned` is one bounded pass
  in `POST /webhooks/deploy` (`core/licensingCatchUp.ts`). The nightly maintenance step
  `licensingCatchUp` finishes it and re-projects the store grants.
- **U-03 interaction.** U-03 owns the column's `config` and `secrets` members and LX-08 owns the
  declared `entitlements` keys, so the two never write the same member. U-03's nightly sweep
  empties its members with `json_set` in SQL. LX-08's writes are compare-and-set on the whole
  column. Provisioned secrets keep following U-03 (column until the run, then account rows).
- **Admin tier API unchanged.** The console tier editor (LX-14) adds `rank` and
  `policyOfflineGraceDays`. The admin upsert leaves both columns as they are.
- **`dist_purchases.grant_id` is written in a second batch.** Distribution names the grant after
  License's store-grant write returns (`recordPurchase` and `revokeRecordedPurchase` in
  `commerce/state.ts`), because the two writes belong to two services. A failure between them
  leaves `grant_id` empty or stale; the catch-up's `licensingReconcile` repairs it, and
  `storeGrantDrift` reports it until then.
- **Review fixes (2026-10-07).**
  - The move touches only OIDC licences (`sub IS NOT NULL`): on any other licence a declared key
    is an operator's override.
  - The rollback script also deletes the copied keys from the `oidc` grants and the emptied
    grants, so a roll-forward cannot revive a key the old Worker revoked in between.
  - Declared keys bind as one JSON parameter (`json_each`), within D1's 100-parameter limit.
  - The deploy hook runs the catch-up after its answer (`waitUntil`) and records the outcome as a
    platform activity row (`licensing.catch_up`).
  - The `upgradeOnly` audit row rides the sign-in's guarded batch.

## Hand-off

- LX-09 switches reads; LX-12 and LX-13 write grants.
- **Follow-ups from LX-08's review:**
  - **N2.** The move pass restarts from the first licence each time, so a large number of deferred
    licences can starve the ones after them within a pass's budget. Resume from a stored cursor.
  - **N6.** LX-14 shows the `oidc` grant: provisioned keys no longer appear among a licence's
    console overrides or in the catalog's usage count.
  - **N7.** LX-11 and LX-13 add the deletes for `device_store_identities`, `dist_holder_bindings`
    and `dist_binding_aliases` (licence deletion, account merge and deletion) as they start
    writing them, with PRIVACY rows.
  - LX-09 adds the `holder_versions` bumps; LX-11 retires the catch-up's one-key-per-mapping rule;
    LX-13 moves and deletes account-held grants; LX-14 adds `rank` and `policyOfflineGraceDays`
    to the admin tier API.

The role agent sets `--set LX-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-08 done`.
