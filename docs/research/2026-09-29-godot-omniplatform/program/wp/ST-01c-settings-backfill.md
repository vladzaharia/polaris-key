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

## Steps

1. Classification over fixtures; the dry-run route; report storage.
2. Apply path in one batch per product; audit row.
3. Platform batch; runbook; operator runs it on production.

## Acceptance criteria

- [ ] Fixtures for equal, differs, not declared, unlinked, no `commit_sha` and fetch failure classify as §4.14.1 says (tests).
- [ ] After apply every declared field equals the manifest and every undeclared console row has `source = 'console'` (test).
- [ ] The dry-run report is stored and readable after apply (test).
- [ ] A second apply is a no-op (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- From this run on, every linked product's resync honours claims. ST-17 builds the reusable dry-run UI on the same classifier.

The role agent sets `--set ST-01c in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-01c done`.
