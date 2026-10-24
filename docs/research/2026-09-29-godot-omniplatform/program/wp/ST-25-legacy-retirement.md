# ST-25 Legacy settings retirement (widened)

| Field       | Value                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 5: governance and environments)                                                                                                                                                                                                           |
| Size        | 0.4–0.55 engineer-weeks                                                                                                                                                                                                                                                                         |
| Depends on  | [ST-11](ST-11-sql-only-settings.md), [ST-14](ST-14-portal-settings.md), [ST-17](ST-17-resync-dry-run.md), [ST-19b](ST-19b-manifest-settings.md), [ST-32](ST-32-sso-rules-admingroup-conversion.md), [LX-16](LX-16-licensing-contract.md), [LX-40](LX-40-retire-licensing-model-settings-7-1.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-25b](ST-25b-drop-products-admin-group.md), [ST-25c](ST-25c-retire-source-markers.md)                                                                                                                                                                |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                                                                                                              |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; rule 10 (OpenAPI + `routeCoverage`)                                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                       |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Widened, driven by P0-24's migration ledger: also products.admin_group, core.adminGroup and manifest product.adminGroup (after ST-32's conversion), legacyDefault (after LX-16), the \*\_source markers, the retired licensing keys (LX-40), products.branding_json and the portal tintColor read, PENDING emptied; each removal goes in the release that replaces it (owner, 2026-10-07).

- Title: was "Legacy settings retirement: `artifacts_access`, `products.branding_json`, bespoke route aliases, access-mode copy; coverage allow-list empty".
- Owner 2026-10-07: no compatibility window. What this package replaces (a route, mode, shape, Action input or CLI form) is removed in the same release; the one exception is a path that native app binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes), removed once DJDL has shipped a build on 0.9 (`tracks.md` rule 6).
- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: it removes every `admin_group` read and named reference once every offer has an outcome, with no day count. It does not drop the column (ST-25b does); ST-32 has already refused the manifest field.

## Corrections (2026-10-23)

ST-25.1's reader audit, against the code at staging `7ce6ef45b` (plan: `P0-25b-ST-25-slices.md`; the code is the fact, and this section wins over the text below). Lead decisions D3, D5, D7, D8 and D10 are applied.

- **S1. The bespoke route aliases are already gone.** `console/handlers/productSettings.ts` says so; only stale comments named them (`core/repo.ts`, `core/ingest/core.ts`, `services/release/config.ts`, `core/rowSettings.ts`, `core/settings/write.ts`). ST-25.1 reworded them.
- **S2. `PENDING` holds six entries, all owned by ST-12, which is done.** ST-12's consolidation moved them (D5): `platform_store_settings` and `PLATFORM_APPLE_TEAM_ID` to A-22; `platform_credentials` and `outlet_credentials` to P0-28; `dist_store_products` and `dist_store_products.source` to CM-23. ST-25.1 re-pointed the owners (the ceiling stays 6). "`PENDING` is empty" moves to P0-51, which depends on all three; ST-25 no longer owns it.
- **S3. `release_config.artifacts_access` is read by nothing** that decides access (`distribution/access.ts` makes `dist_access` the one answer). It is still written by `release/ingest.ts` and snapshotted into the truth store (`release_metadata.artifacts_access`, `release_artifacts.access`; CHECK-bound, so those stay). ST-25.2 stops the writes and sources the snapshot from `dist_access` (D6). The column is dropped by ST-25b.
- **S4. `products.branding_json`** is NULL in production and written by no release. Readers: `core/repo.ts` (a type), `seed.mjs`, and `portal/selfService.ts:183` (a `ProductFacts.branding` read the audit found; it needs removing in ST-25.3 before the drop). The portal tint read is `admin/src/portal/model/library.ts` (`productBranding.tintColor`); the tint now comes from `presentation` (ST-25.5). The live `portal_product_settings.branding_json` is not retired.
- **S5. Already-unread stores:** `lazy_delta_settings`, `email_product_caps` (ST-11), the `portal_product_settings` switch columns (ST-14), and the five older columns (`oidc_enabled`, `magic_enabled`, `license_key_claim_enabled`, `releases_enabled`, `auto_link_enabled`; comments only). `portal_enabled`, `key_reissue_enabled` and `claim_by_key` are still the field names of the registry-backed `getPortalProductSettings` overlay: live, so they are `PERMANENT` in the scan; ST-25.3 names the columns instead of `SELECT *`.
- **S6. `admin_group`** has worker, admin, CLI and manifest sites (the scan lists them). ST-32 stops the writes and refuses the field; ST-25.6 removes the reads once every offer has an outcome (ST-28 §10, D8). The column is dropped by ST-25b.
- **S7. The `*_source` markers** (about 85 references in 21 files) drive the resync's `WHERE … = 'manifest'` guards. Retiring them is a semantic switch that takes two releases through P0-49 (rule 5), so it is split out as **ST-25c** (D7), with deps ST-25 and P0-49.
- **S8. `legacyDefault`** (23 references on `SettingDef`, `resolve.ts`, `rowSettings.ts`) is a value backfill: it goes in ST-25.7 after LX-16 has materialised the explicit values and P0-49's report shows zero diffs.
- **S9. Access-mode copy (D16):** `admin/src/lib/labels.ts` is the label table; `sections/feeds/model/model.ts` keeps a second copy. The wire enum `ReleaseAccess` does not change.
- **S10. The two-release contract (tracks.md rule 5).** ST-25 drops only what has been unread for a shipped release (S5, `products.branding_json`). What ST-25 itself stops reading (`admin_group`, `release_config.artifacts_access`) is dropped by ST-25b, one release later (D3).

**Slice map.** The scan is `packages/worker/test/legacySettingsScan.test.ts`: a new hit fails, and a `KNOWN` row whose file no longer names its token fails (stale), so each slice deletes its rows.

| Slice | Work                                                                                        | Depends on                 |
| ----- | ------------------------------------------------------------------------------------------- | -------------------------- |
| 25.1  | Reader audit, these corrections, the scan, PENDING owners, S1 comments (done)               | staging                    |
| 25.2  | `release_config.artifacts_access` stops; the snapshot from `dist_access`                    | 25.1                       |
| 25.3  | Migration: drop the two tables, the dead `portal_product_settings` columns, `branding_json` | 25.2, rollback-target fact |
| 25.4  | One access-mode vocabulary (copy only; BUILT UX review)                                     | P0-32.25                   |
| 25.5  | The portal's legacy tint read                                                               | P0-32.25                   |
| 25.6  | `admin_group` reads out (6a worker, 6b admin and CLI)                                       | ST-32, offers outcome      |
| 25.7  | `legacyDefault` out                                                                         | LX-16, zero-diff report    |
| 25.8  | Close: LX-40 left no retired key; ledger rows; tick the boxes                               | 25.3-25.7, LX-40           |

Package changes: ST-25 now also depends on ST-32, LX-16 and LX-40 (D8, D10); the `*_source` markers move to ST-25c (D7); ST-25b drops `release_config.artifacts_access` too (D3); "`PENDING` is empty" is P0-51's. Each migration is named `00XX_<name>.sql`; the lead assigns the number at merge.

## Goal

Legacy settings are retired: `release_config.artifacts_access` (writes; ST-25b drops the column), `products.branding_json`, the dead stores, `admin_group` reads, `legacyDefault` and the access-mode copy. The coverage `PENDING` list is emptied by P0-51 once A-22, P0-28 and CM-23 land.

## Why

D12 and D16 ([S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold)); [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else) lists the retirements.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-25, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D12, D16.

## Scope

**In:**

- Confirm no reader diverges, then stop writing and drop; copy-only access-mode unification.

**Out** (and where it belongs instead):

- Any wire enum change (none, D16).

## Design notes

- Drops follow the replayable-migration convention.

## Steps

1. Reader audit.
2. Drops.

## Acceptance criteria

- [ ] `PENDING` owners are A-22, P0-28 and CM-23, and the ceiling is unchanged (P0-51 empties it).
- [ ] `legacySettingsScan`'s `KNOWN` holds only ST-25b's two columns and the `PERMANENT` rows.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None: closes the ST phase.

The role agent sets `--set ST-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-25 done`.
