# ST-01c Settings backfill, revert-all (owner D19): every manifest-declared field returns to its manifest value, console-only rows kept as `console`, the dry-run report kept for the record, platform batch and runbook for `djdl` and `polaris-key`

| Field       | Value                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 0: stop the bleeding)                                                                 |
| Size        | 0.4–0.55 engineer-weeks                                                                                                       |
| Depends on  | [ST-01b](ST-01b-resync-claims.md)                                                                                             |
| Unblocks    | [ST-17](ST-17-resync-dry-run.md)                                                                                              |
| Role        | `pkey-implementer`                                                                                                            |
| Plan mode   | no                                                                                                                            |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); THREAT-MODEL                                                             |
| Human input | an operator runs the backfill on production (dry run recorded, then apply), one product at a time starting with `polaris-key` |
| Repo        | `vladzaharia/polaris-key`                                                                                                     |

## Goal

Every linked product is migrated onto ST-01b's claim model by the owner's "Revert all console values" rule: every manifest-declared field and row takes its manifest value, console-only rows stay as `source = 'console'`, and a dry-run report of every value that changed is kept for the record.

## Why

The note proposed an operator-reviewed preserve step with a 30-day default. The owner decided differently ([S-18 owner decisions](../../notes/S-18-settings-architecture.md) item 3: "Revert all console values" (no preserve review, no 30-day window)): the manifest wins every declared field once, and only what the manifest does not declare is kept. That removes the review machinery and roughly halves the package.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.14](../../notes/S-18-settings-architecture.md#414-migration), [S-18 §4.14.1](../../notes/S-18-settings-architecture.md#4141-the-backfill-rule-one-per-field-class) (field classes; ignore the "preserve" column), [S-18 §4.14.2](../../notes/S-18-settings-architecture.md#4142-the-backfill-procedure-st-01c) steps 1–5 (classification, kept as the report), [S-18 §4.14.3](../../notes/S-18-settings-architecture.md#4143-the-two-real-products) (`djdl` and `polaris-key`), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-01c.

## Scope

**In:**

- Admin action `POST /products/<slug>/settings/backfill?dryRun=1|0` and a platform batch over all linked products.
- Dry run: fetch the default-branch manifest at one pinned commit, write the snapshot (`origin = 'backfill'`), classify each field and row (equal, differs, not declared) with the §4.14.2 audit evidence; returned and stored as the report.
- Apply: declared fields and rows → manifest value; undeclared console rows → `source = 'console'` row; one audit row per product (`origin = 'backfill'`) listing every changed value with before and after.
- Unlinked products: no rows, no report entries beyond "unlinked". Fetch failure: no rows, "cannot read `.pkey/`".
- System product: the bootstrap `services_source = 'admin'` marker reset to `manifest` (values equal).
- Runbook entry for `djdl` and `polaris-key`.

**Out** (and where it belongs instead):

- Removed by the owner's D19: per-product review and acknowledgement, "preserve" ticks, the pending banner and the 30-day default.
- The shared dry-run plan UI for resync and link (→ ST-17).

## Design notes

- Do not fetch at `product_sync_state.commit_sha`: it can be an unapplied feature-branch push. It may be fetched only as corroboration for the report.
- Operators who want to keep a console value commit it to `.pkey/` before the run; the report shows what the run would revert.
- Idempotent: a second apply changes nothing and records an empty report.

### Corrections from the code (builder, 2026-10-06)

- **The dry run writes no snapshot.** The brief has the dry run write the snapshot (origin
  `backfill`). ST-01a's invariant is that a snapshot never describes a manifest that did not land,
  and two readers depend on it: the resync's claim-or-conflict test for console rows
  (`snapshotRowIds`) and ST-20's break-glass rule ("ends when the manifest changes the field from
  the last applied one"). A dry-run snapshot of an unapplied commit would make the next resync
  read that commit as already applied. So the dry run stores only its report, and the apply
  writes the snapshot (origin `backfill`) in its own batch, only when the stored one does not
  already describe the same documents. To apply exactly what the dry run showed, the apply takes
  `expectCommit=<the dry run's commit>` and refuses (409 `commit_moved`) when the manifest moved.
- **The system product's manifest is its deploy-hook snapshot**, not a GitHub read: ST-20 made
  the deploy hook its single writer and refuses every other resync of it, so the backfill
  classifies it against the root `.pkey/` at the deployed commit and never writes its snapshot.
  Bootstrapped but never deploy-linked (`release_source` not `github`) it is `unlinked`; linked
  with no snapshot it is `unreadable`.
- **The system product's services are not equal.** S-18 §4.14.3 says the bootstrap's services
  equal the root `.pkey/` (release and distribution on). The bootstrap starts from the default
  set (`parseServices(null)`: License and Config on) and adds Release and Distribution, while
  the root `.pkey/` turns License and Config off. The marker is therefore reset only when the
  stored services equal the manifest's (the brief's "values equal"); otherwise it is kept and
  reported, and the runbook tells the operator to switch them in the console first. Customer
  products' `*_source` markers are kept and listed (S-18 §4.14.1).
- **Kept, not reverted:** a live break-glass claim (ST-20's rule: an apply that does not change
  the manifest's value for the field leaves it, and the backfill changes no manifest) and the
  system product's name (F-03). An expired break-glass row is not a claim.
- **Concurrency.** A console edit landing during the apply's GitHub reads must not be reverted
  unseen. The apply's first statement is its report row, inserted only while the product's state
  token (product row, claims, tiers, profiles, catalog versions, snapshot) still matches the one
  read before classifying; otherwise the NOT NULL `report_json` aborts the whole batch and the
  route answers 409 `backfill_conflict`.
- **The audit row** is `setting.backfill` (target the product, the operator as actor): `audit`
  has no `origin` column until ST-04's structured audit lands, so the action names the origin and
  the summary lists every change with before and after (bounded); the stored report holds the
  full record.
- **Evidence bound.** With neither a snapshot nor `product_sync_state.last_synced_at`, the
  evidence is bounded by `products.created_at` (marked weak), not `modified_at` as S-18 §4.14.2
  step 4 says: every console product edit bumps `modified_at`, so that bound would hide the very
  edits the evidence exists to show.
- **Row-backed settings (LX-06).** Besides the five column-backed claim keys, the admin group,
  the catalog, tiers and profiles, the backfill reverts every row-backed claimable setting the
  manifest declares (`licensing.*`, the sign-in tier sync: the registry's live scalar claimable
  product entries with a manifest path, so Core names no service). An undeclared console row
  stays; an undeclared manifest row is the next resync's to clear (omit-clears).
- **Routes** (narrative-only admin routes under rule 10, like resync and claims):
  `POST|GET /manage/api/products/<slug>/settings/backfill[/<reportId>]` and
  `POST|GET /manage/api/platform/settings/backfill`; `dryRun=1|0` is required, so a bare POST
  never applies. The product route sits ahead of LX-06's generic `settings/<key>` routes.
  Migration `00XX_settings_backfill_reports.sql` (the lead numbers it); rehearsed on a scratch
  SQLite file with all 122 migrations, and replayed as a no-op on a populated database (test).

## Steps

1. Classification over fixtures; the dry-run route; report storage.
2. Apply path in one batch per product; audit row.
3. Platform batch; runbook; operator runs it on production.

## Acceptance criteria

- [x] Fixtures for equal, differs, not declared, unlinked, no `commit_sha` and fetch failure classify as §4.14.1 says (tests).
- [x] After apply every declared field equals the manifest and every undeclared console row has `source = 'console'` (test).
- [x] The dry-run report is stored and readable after apply (test).
- [x] A second apply is a no-op (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- From this run on, every linked product's resync honours claims. ST-17 builds the reusable dry-run UI on the same classifier (`planBackfill` in `core/settingsBackfill.ts`: its items carry `class` and `owner` independently of the backfill's `action`).
- Owner step: the operator runs docs/RUNBOOK.md "Settings backfill" on production, `polaris-key` first, then `djdl` (dry run read and kept, then the apply with `expectCommit`).
- ST-04: its "one write path" scan (`test/settings-writes.test.ts`) must list `core/settingsBackfill.ts` among the manifest writers (the backfill writes manifest values and drops claims, audited as `setting.backfill`); with ST-04's structured audit columns the backfill's row can carry `origin = 'backfill'`.

The role agent sets `--set ST-01c in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-01c done`.
