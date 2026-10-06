# LX-28 Bulk floating keys: `license_batches` and `licenses.batch_id`, `POST …/license/batches` (up to 500, labelled, keys returned once with `no-store`), batch reads with used counts, and **Disable unused keys**

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (S-24: licence holders)       |
| Size        | 0.5–0.8 engineer-weeks                                                                   |
| Depends on  | [LX-26](LX-26-licence-holders-worker.md)                                                 |
| Unblocks    | [LX-29](LX-29-new-license-wizard.md), [LX-30](LX-30-console-holder-surfaces.md)          |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no                                                                                       |
| Gates       | D1 migration; `TABLE_OWNERS`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; workerd |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Goal

An operator creates up to 500 floating licences in one labelled batch, receives their keys once,
can find the batch again with how many keys were used, and can disable every unused key of a batch
that leaked.

## Why

The owner asked for bulk floating keys with a count and a CSV export
([S-24](../../notes/S-24-licence-holders.md) R1, §8.5). Today there is no bulk creation (H12).
Resellers, bundles and store key pools all need it, and a leaked CSV needs one action to contain it
(§5.6, §7.1).

## Read first

- AGENTS.md and CLAUDE.md.
- [S-24](../../notes/S-24-licence-holders.md) §6.1, §6.3, §7.1, §7.3, §8.5 (D10).
- `packages/worker/src/services/license/admin/licenses.ts` (create path, `mintLicenseKey`,
  `hashKey`), `packages/worker/src/crypto.ts`, `migrations/0011`, `0015` (origin trigger).

## Scope

**In:**

- Migrations (one `ALTER` per file, R11-04): `license_batches(product, id, label, count, tier_id,
created_by, created_at)`, `licenses.batch_id TEXT NULL`, `idx_licenses_batch(product, batch_id)
  WHERE batch_id IS NOT NULL`. `TABLE_OWNERS` and the generated reference follow.
- `POST …/license/batches` `{label (1–80), count (1–500), tier, deviceLimit?, expiresAt?,
maxOfflineDays?, channels?, minVersion?, maxVersion?}` → `{batchId, licenses: [{licenseId,
key}]}` with `Cache-Control: no-store`. Every licence is floating (`name` and `email` null),
  `origin = 'admin'`, `batch_id` set; all rows and the batch commit in one D1 batch or none.
- `GET …/license/batches` and `GET …/license/batches/<id>`: label, count, created, by whom, and
  `used` (licences with at least one device ever bound).
- `POST …/license/batches/<id>/disable-unused` → `{disabled: n}`: disables every licence of the
  batch with no device ever bound.
- Audit `license.batch.create` (label, count, tier) and `license.batch.disable_unused` (count).
- OpenAPI and `routeCoverage`; THREAT-MODEL T-H1.

**Out:**

- The console flow and the CSV file (→ LX-29: the browser builds it from the response).
- Assigned batches from a CSV of names and emails (later; D10).

## Design notes

- The Worker never stores or re-serves plaintext keys; a batch's keys cannot be downloaded again.
- Measure the D1 batch at 500 licences (two statements each plus audit) on the emulator; if it fails,
  lower the cap and record the measured limit in the brief and the note.
- Labels are not unique.

## Corrections from the code (recorded by the builder, 2026-10-06)

- **Measured: 500 holds.** The create is one D1 batch of **four** statements whatever the count
  (the batch row; the licences and the keys each as one `INSERT … SELECT … FROM json_each(?)`;
  the audit row), not two statements per licence, which would pass 1,000 statements at 500 and
  meet D1's per-invocation query limit. Measured at 500 on the emulator
  (`test-workerd/licenseBatches.test.ts`: commit, rollback on an injected failure, activation,
  disable-unused); the cap stays 500.
- **`batchId` on licence reads and `?batch=` on the list** are built here. S-24 §6.3 lists them
  under LX-26, which predates the column; LX-29's **Open batch** and LX-30's Batch filter need
  them.
- **"Used"** is computed, with no new column: a `devices` row names the licence (any status), or
  one of its keys has `keys_index.last_used_at` (stamped by an activation or a browser key
  session, kept when the device later moves to another licence). A key added to an account in
  the portal without an activation counts as unused.
- **Answer and read shapes, additive:** the create answer also carries `batch` (the batch read)
  and `expiresAt` (every licence's computed expiry, for the CSV); batch reads carry `unused`
  (what Disable unused keys would disable) and `disabled` beside `used`. `name`, `email` and
  `profiles` are refused (`422`) rather than dropped; profiles on a batch are a follow-up if
  LX-29 needs them.
- **Migrations** are `0095_a_license_batches.sql`, `0095_b_licenses_batch_id.sql` and
  `0095_c_licenses_batch_index.sql` (the lead's numbers); `LATEST_MIGRATION` names the `c` file.

## Steps

1. Migrations and repo functions.
2. Create, reads, disable-unused; tests including the all-or-nothing failure path.
3. OpenAPI, `routeCoverage`, THREAT-MODEL.

## Acceptance criteria

- [x] A 500-key batch commits atomically and every key activates once (test); 501 is refused.
- [x] The response is `no-store`, and no plaintext key is persisted (test reads the tables).
- [x] `used` counts licences that ever bound a device; disable-unused touches only the others
      (tests).
- [ ] The green gate passes (AGENTS.md), including the migration, OpenAPI and `routeCoverage`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- license batch routeCoverage
```

## Hand-off

LX-29 builds the batch path and the CSV; LX-30 adds the batch filter, page and Disable unused.

The role agent sets `--set LX-28 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-28
done`.
