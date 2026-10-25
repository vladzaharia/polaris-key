# U-27 Keep the licence config layer; delete the override-migration machinery

| Field       | Value                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (DX consolidation G: Managed config and Cloud Sync)                                                                                                                                  |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                    |
| Depends on  | [P0-49](P0-49-data-migration-runner-dry-run-report.md)                                                                                                                                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-32b](I-32b-retire-legacy-identity-engine.md), [U-27b](U-27b-drop-override-migration-tables-release-n.md), [U-28](U-28-one-config-chain-default-profile-one.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                        |
| Plan mode   | no                                                                                                                                                                                                        |
| Gates       | `migration`, `table-owners`, `rule-10`                                                                                                                                                                    |
| Human input | owner decision 1 (answered 2026-10-07, open to veto)                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CFG-01** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync).

## Goal

Keep the licence config layer; delete the override-migration machinery, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CFG-01** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, §6, for **CFG-01**.
- [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md), for file and line evidence.

## Scope

**In:**

- Release N of the U-03 retirement: payload.ts always reads licence config and secrets; remove the freeze on PUT .../licenses/<id>/overrides; delete overrideMigration.ts (1,387 lines) state, run, report and sweep, its 7 platform routes (OpenAPI, routeCoverage), the console page and nav entry, OverrideMigrationNotice, the LicenseConfig phase banners and data/overrideMigration.ts, and every read of override_migration (payload.ts:125's licenseConfigOverridesRetired) so the tables are unread; provisioning writes the account layer with a one-off P0-49 backfill; RUNBOOK, THREAT-MODEL U-03 rows and glossary. U-27b drops the two tables a release later. Precondition: the week-0 read-only check that override_migration.notice_started_at is NULL.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track G (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CFG-01**; DX consolidation G: Managed config and Cloud Sync.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- Gated on owner decision 1 ([README §8](../../../2026-10-07-dx-consolidation/README.md#8-owner-decisions)), answered on 2026-10-07 under delegated authority with the recommendation and open to the owner's veto; a veto takes that row's "If the answer is no" column.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- The transition guide's 'Override migration and policy history' study is not adopted: the migration run is cancelled (owner decision 1, P0-47) and U-27 deletes the machinery and the page, so no redesign is drawn. Policy history is ST-07's per-row History and ST-09's Recently changed. The route ledger row for platform-override-migration reads 'deleted (U-27)' (ST-49). (admin-4-16)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 1 mockup item(s):** `config.effective`.

## Corrections (2026-10-22)

Found against `integ/next-stage` @ 1099323cc (plan `U-27-P2-12-slices.md` §A0). The code is the fact.

1. **Paths have moved.** The module is `core/ops/overrideMigration.ts`, the handlers are `console/handlers/overrideMigration.ts`, and the page is `packages/admin/src/console/sections/platform/pages/platformOverrideMigration.tsx`. The older `core/overrideMigration.ts` and `admin/handlers/...` paths predate P0-17.
2. **More readers than `payload.ts:125`.** `core/licensing/payload.ts`, `core/licensing/issue.ts` and `issueAccount.ts` (`licenseConfigOverridesFrozen`), `services/license/admin/licenses.ts` (the freeze, `LICENSE_CONFIG_WRITABLE_SQL`, `configOverridesView`), `services/config/admin/catalog.ts`, `console/handlers/accountOverrides.ts` (`licenseLayerRetired`), `services/config/accountOverrideStore.ts`, `services/config/index.ts`, `productDeletion.ts`, `scheduled.ts` (the nightly step), `core/migrate/coreJobs.ts` (`core.licence-override-migration`), `console/handlers/platform.ts`, `console/routes.ts`, `console/stepUp.ts`, `scripts/override-migration-dry-run.ts` and the `override-migration:dry-run` package script.
3. **The legacy runner P0-49 left out** is the override migration's own state machine, lease and run, with its CLI script. U-27.4 deletes both. `settingsBackfill.ts` stays with P0-24.
4. **The "frozen" provisioning path drops unowned licences' provisioned secrets** (`provisionedColumn(..., frozen=true)` writes none). U-27.2 therefore targets per licence, not globally.
5. **Table owners.** Both tables are owned by `config`; the module crosses into them through `WRITE_SEAMS` / `LICENSE_WRITE_SEAMS` rows naming P0-49, which go with the module.
6. **Doc pages that do not exist yet.** `features/managed-config/visibility` and `minted-tokens` are created by U-30 and U-31. U-27's part covers `catalog.md`, `profiles.md`, `index.mdx`, `management-states.md` and `reference/config-entry.mdx`.
7. **The route ledger is already set.** `routeLedger.ts` already says `fate: "deleted", by: "U-27"`.

## Owner decision 1

Cancel the U-03 run. Answered 2026-10-07 under delegated authority, open to the owner's veto. Production had no `override_migration` row at 2026-10-07 19:05 PDT, so the retired and frozen branches never ran and removing them changes no document. The lead re-checks (`SELECT * FROM override_migration`) before release N deploys. U-27.1 (branch `wp/U-27.1-licence-layer-always`) makes the licence layer always read and writable.

## Acceptance criteria

- [x] Licence overrides apply to floating and in-account licences (test): `packages/worker/test/surfaces/licenseConfigLayer.test.ts` cases (a) floating and (b) owned licence (U-27.1 0da5533da)
- [x] No code reads override_migration (grep) and the old Worker keeps serving during the deploy: under `packages/worker/src` only `db/owners.ts` and the `accountOverrideStore` subject-store claim name the tables; the tables stay until U-27b (U-27.4 56621383c)
- [x] Owner decision 1 recorded (§ Owner decision 1 above)
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/managed-config/{catalog, visibility, minted-tokens, profiles}`; `reference/config-entry`. U-27.7 851c352c1 and 08e4f88cd: `catalog`, `profiles`, `management-states`, `upgrade-to-0-9`; `visibility` and `minted-tokens` belong to U-30 and U-31 (Corrections item 6); `reference/config-entry` needed no change.
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches: shipped in v0.9.17 (c87a8e7ba, CI attempt 2 green, 90 checks).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set U-27 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-27 done`.
