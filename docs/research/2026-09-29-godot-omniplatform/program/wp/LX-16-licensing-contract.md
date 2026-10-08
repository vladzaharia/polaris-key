# LX-16 Licensing contract step (widened)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                                                                                                                                                             |
| Size        | 0.2–0.3 engineer-weeks                                                                                                                                                                                                                                                                                                                                   |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [LX-11](LX-11-commerce-rework.md), [U-28](U-28-one-config-chain-default-profile-one.md), [LX-36](LX-36-access-policy-license-access-absorbs-ps.md), [LX-38](LX-38-account-keyed-automatic-licences.md), [LX-40](LX-40-retire-licensing-model-settings-7-1.md), [PS-12](PS-12-discover-visibility-one-setting.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-16b](LX-16b-licensing-contract-drops-release-n-1.md)                                                                                                                                                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                       |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`                                                                                                                                                                                                                                                                                      |
| Human input | a production release with LX-09's read switch live everywhere for one release before this deploys                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W13.md`](../plans/PX-W13.md):** Q6: rename `account_product_grants` in the contract-phase migration.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Release N of the licensing contract (two-release rule, tracks.md flags): stop every read and write of license_profiles (after U-28's report), the auto_issue_json/group_role_map_json tier reads, the licensing.\* rows, the legacy resolver path and resolveEffective's fused payload, grant_entitlements, license_store_grants and the dead mapping columns (flag, grants_kind, base_tier_id, dist_store_product_entitlements); split payload.ts's config walk from the entitlement walk. No table drop here: LX-16b drops the standalone tables a release later. Dormant columns in licenses and grants (the grants holder CHECK, licenses.kind) stay unread rather than rebuilding those tables (migrations/0017's warning). licenses.sub is not touched: it carries idx_licenses_sub and retires in I-32's post-sunset contract. Any change to a guarded index ships a new 00XX_index_assertion.sql.

- Title: was "Licensing contract step: stop dual-writing, final reconciliation, drop or retire the old objects".
- Depends on: added U-28, LX-36, LX-38, LX-40 and PS-12.

## Goal

The old licensing objects are retired: dual-writing stops, a final reconciliation shows zero drift, and old columns are dropped where D1 allows without a rebuild (else left dead); `license_store_grants` is dropped last.

## Why

[S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract) step 6, one release after the read switch.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract) step 6, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-16.

## Scope

**In:**

- Stop dual-write; reconciliation report; drops; rollback script.

**Out** (and where it belongs instead):

- Anything still read.

## Design notes

- Check D1 `DROP COLUMN` support per column [U].

## Steps

1. Reconcile.
2. Stop writes.
3. Drop.

## Acceptance criteria

- [ ] Reconciliation shows zero drift.
- [ ] Migration replay test passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set LX-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-16 done`.
