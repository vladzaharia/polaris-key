# ST-01b Resync claim fix on the final shape: `product_settings`, column-backed claims for name, licence defaults and web origins, `admin_group` manifest-only, per-row `source` on tiers and profiles, catalog claim, all checks before the first write, per-field resync audit

| Field       | Value                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 0: stop the bleeding)                                                                                                                                                                                                     |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                                                            |
| Depends on  | [ST-01a](ST-01a-manifest-snapshot.md)                                                                                                                                                                                                                             |
| Unblocks    | [I-09](I-09-key-entry-attach.md), [U-05](U-05-cloud-sync-do.md), [PX-W9](PX-W9-key-entry-counting.md), [ST-01c](ST-01c-settings-backfill.md), [ST-04](ST-04-settings-resolver.md), [ST-20](ST-20-manifest-authoritative.md), [LX-06](LX-06-licensing-settings.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                                                |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; THREAT-MODEL; console CSP parity                                                                                                                                                             |
| Human input | none                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                         |

## Goal

A resync writes only manifest-declared fields whose current source is `manifest`; a console edit to a claimable setting claims it and survives every later resync; console-only tiers and profiles are never deleted; and a refused resync writes nothing. Storage is created in its final shape (`product_settings`), so no later package re-migrates it.

## Why

Today every resync overwrites the product name, the licence defaults, web origins, tiers, profiles and the catalog with the manifest's values, silently discarding console edits, and its tier and profile refusals run after the product-row writes, so a refused resync is half-applied ([S-18 §2.1](../../notes/S-18-settings-architecture.md#21-the-resync-overwrite-a-correctness-bug)). The owner accepted model C for customer products ([S-18 owner decisions](../../notes/S-18-settings-architecture.md) item 1: model C; the system product is manifest-authoritative with 7-day break-glass claims).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §2.1](../../notes/S-18-settings-architecture.md#21-the-resync-overwrite-a-correctness-bug), [S-18 §4.3](../../notes/S-18-settings-architecture.md#43-storage) (`product_settings` DDL, column-backed keys, per-row `source`), [S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe) (model C made safe), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-01b.
- `packages/worker/src/services/release/resync.ts`, `packages/worker/src/services/license/admin/tiers.ts`, `packages/worker/src/services/config/admin/profiles.ts`, `packages/worker/src/services/config/admin/catalog.ts`, `packages/worker/src/admin/handlers/products.ts`.

## Scope

**In:**

- Migration: `product_settings` in the final §4.3 shape; per-row `source TEXT NOT NULL DEFAULT 'manifest' CHECK (source IN ('manifest','console'))` on `tiers` and `profiles`; `TABLE_OWNERS`.
- Column-backed claims for `core.name`, `license.defaults.maxOfflineDays`, `license.defaults.deviceLimit`, `core.web.origins`, and the catalog as one claimable unit (`config.catalog`).
- `core.adminGroup` becomes manifest-only (no claim).
- Resync: every check runs before the first write, then one `db.batch`; manifest rows upserted, console rows left alone, a manifest row deleted only when dropped and unreferenced; a console row with a new manifest row's id reported as a conflict.
- Per-field resync audit rows; console writes on these fields set `source = 'console'`; Revert deletes the claim and re-applies from the ST-01a snapshot.
- Console claims refused on `system = 1` products until ST-20; dialog copy for claim and Revert.

**Out** (and where it belongs instead):

- Backfill of existing products (→ ST-01c); until it runs, products behave as today (no claims exist).
- The registry and resolver (→ ST-03, ST-04); the dry-run UI (→ ST-17).
- Break-glass claims on the system product (→ ST-20).

## Design notes

- Column-backed is permanent: the hot path keeps reading `products.*`; the row holds only `source`, `version`, author, reason, expiry.
- Absence of a row means `manifest` for claimable keys. Revert deletes the row.
- Existing `*_source` columns are kept and mapped by adapters (`NULL|manifest|default|import → manifest`, `admin → console`); no table rebuild.
- `web.origins` keeps `omitClears: true` (`resync.ts` today).
- I-09 and U-05 depend on this package: they write their settings as `product_settings` rows and create no bespoke tables.

## Steps

1. Migration and rehearsal.
2. Move all resync refusals ahead of the first write; one batch.
3. Claim on console write; Revert from snapshot; per-field audit.
4. Tests; THREAT-MODEL row "resync as a write path"; admin build.

## Acceptance criteria

- [ ] A console edit to each claimable field survives a following resync (test per field).
- [ ] A console-only tier or profile survives a resync whose manifest omits it (test).
- [ ] A resync refused by a referenced-tier guard leaves every row unchanged (test).
- [ ] Revert restores the snapshot value at once, or says "applies at the next resync" when no snapshot exists (test).
- [ ] A console claim on a `system = 1` product is refused (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- `product_settings` is the single per-product settings table: ST-04's resolver, I-09, U-05 and LX-06 write rows into it.

The role agent sets `--set ST-01b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-01b done`.
