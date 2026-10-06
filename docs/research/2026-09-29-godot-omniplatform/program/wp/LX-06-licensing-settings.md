# LX-06 Licensing settings home: `licensing.*` as claimable `product_settings` rows registered in S-18's registry, manifest `licensing.*` and `oidc.syncTierOnSignIn` (rule 9), License → Settings section, admin API

| Field       | Value                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes)                                                     |
| Size        | 0.4–0.55 engineer-weeks                                                                                                                     |
| Depends on  | [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md)                                                                      |
| Unblocks    | [LX-07](LX-07-grace-clamp.md), [LX-08](LX-08-licensing-expand.md), [LX-12](LX-12-licence-lifecycle.md), [LX-14](LX-14-console-licensing.md) |
| Role        | `pkey-implementer`                                                                                                                          |
| Plan mode   | no                                                                                                                                          |
| Gates       | rule 9 (validator rule, mutation table, JSON schema); rule 10 (OpenAPI + `routeCoverage`); console CSP parity                               |
| Human input | none                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                   |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** the §3.2 keys; a derived default for `entitlementModel` (`legacy` for products created before a constant committed here, else `combined`; Q2); no `oidc_config` column; `refundGraceHours` kept, capped at 168 hours, and S-18's A.4 row reworded to say it only delays the revocation (Q3).

## Corrections from the code (LX-06, 2026-10-06)

Where this brief and the plan met the code, the code won:

- **Admin API.** `plans/LX-01.md` §6 says the settings "use ST-05's generic API, so they add no
  route", but ST-05 is not built and this brief's header carries rule 10. LX-06 therefore builds
  the first slice of S-18 §4.7's generic API at its final paths, for row-backed claimable keys only:
  `GET /manage/api/products/{p}/settings/effective[?area=]`, `PATCH` and `DELETE
…/settings/{key}`. ST-05 widens the same routes to every key; nothing needs an alias.
- **Storage.** The row-backed store is a new Core module, `core/rowSettings.ts`, beside ST-01b's
  column-backed `settingsClaims.ts`. ST-04's resolver replaces `readRowSettings` and its
  `writeSetting()` replaces `writeRowSetting`/`revertRowSetting`.
- **Manifest side.** License and Identity apply their rows from `manifestIngestAlways`, with the
  claim guard in SQL. A setting the manifest stops declaring loses its manifest row (omit-clears),
  so `.pkey/` keeps describing what is in force; a claim is never touched.
- **Derived default.** Expressed as registry data (`SettingDef.legacyDefault`,
  `createdBefore` = 2026-10-06T00:00:00Z) so ST-04's resolver applies it without a License hook.
- **Key and area.** `identity.syncTierOnSignIn` (ST-03's seed) is renamed
  `identity.oidc.syncTierOnSignIn` per the plan; its name makes it security-widening under the
  registry's rule 2. The licensing keys keep ST-03's area `license.licensing` (not the plan's
  `license.policy`, which is the Enrollment/defaults area), because License → Settings renders
  exactly that area.
- **`reanchor: onRefresh` and `dunningGraceDays`.** `onRefresh` is left out of the shared
  vocabulary until LX-21 (the validator, schema and registry refuse it). `dunningGraceDays` is
  validated and stored from the manifest but stays `pending` (LX-23): the console hides it and the
  API refuses writes.
- **Console.** Sign-in's `syncTierOnSignIn` row is on Identity → Sign-in (S-19 §7.13's table);
  the licensing keys are on the new License → Settings page.

## Lead decisions (review, 2026-10-06)

- **D1.** `COMBINED_ENTITLEMENT_MODEL_SINCE` stays as committed (2026-10-06T00:00Z). LX-09 moves it
  to its own deploy time, so products registered before LX-09 read `legacy`; that direction is safe
  because only the displayed default changes until LX-09 reads the setting.
- **D2.** Accepted: a licensing setting (or `oidc.syncTierOnSignIn`) dropped from `.pkey/` returns
  to its default, the per-descriptor omit-clears exception of S-18 §4.5 item 1, which now names
  these keys beside `web.origins` so ST-04 and ST-05 implement the same rule.

## Goal

S-19's per-product licensing settings (`licensing.entitlementModel`, `entitlementHolder`, `clampGraceToExpiry`, `anchorPolicy`, `reanchor`, `refundGraceHours`, `dunningGraceDays`) are claimable `product_settings` rows in S-18's registry, declarable in the manifest as `licensing.*` (plus `oidc.syncTierOnSignIn`), editable in License → Settings, and served by an admin API.

## Why

S-19 §7.13 proposed `products.licensing_json`; S-18 is now accepted and is the settings home ([S-19 owner decisions](../../notes/S-19-licensing-model.md) item 5, S-18 §5.3). Decisions 4 and 5 fix the defaults (`device`; `combined` for new products, `legacy` for existing).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; the `authoring-pkey-manifests` skill.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.13](../../notes/S-19-licensing-model.md#713-licensing-settings-where-each-lives) (settings and defaults; storage replaced by `product_settings`), [S-19 §7.12](../../notes/S-19-licensing-model.md#712-manifest-impact-rule-9), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-06.
- S-18 §4.3, §4.5, §5.3 and ST-01b and ST-03's briefs.

## Scope

**In:**

- Registry entries (claimable); manifest keys with rule 9 rule, mutation entry and schema; License → Settings section; admin routes with OpenAPI and `routeCoverage`; resync-vs-admin test.

**Out** (and where it belongs instead):

- Behaviour behind each setting (→ LX-07, LX-09, LX-10, LX-12, LX-21).

## Design notes

- Model C: a console edit claims; Revert returns to the manifest (S-18 D2).
- `restorePolicy` and `transferCooldownDays` live in `dist_commerce_settings` (LX-11).

## Steps

1. Registry entries.
2. Manifest keys.
3. Console and API.

## Acceptance criteria

- [ ] A console edit survives resync and Revert restores the manifest value (test).
- [ ] Rule 9 and rule 10 gates pass.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
```

## Hand-off

- LX-07 onward read these settings through ST-04's resolver once it exists (until then through
  `readLicensingSettings` and `readSyncTierOnSignIn`).
- LX-09 moves `COMBINED_ENTITLEMENT_MODEL_SINCE` to its own deploy time, so products registered
  before LX-09 read `legacy` (D1; the same line is in LX-09's brief).
- ST-05: the resync dry run (`planRepoManifest`) must list row-setting applies and clears, not only
  the claims it leaves alone (the release service cannot see the License and Identity entries
  under rule 6, so this goes through the registry).
- Follow-ups from review (not blocking):
  - **N2 (ST-04):** Revert and reset delete the row, so its version returns to 0; keep a tombstone
    row as platform settings do, so a version never goes backwards.
  - **N4 (ST-07):** an L0 change saves without an Undo, and an L3 level maps to the danger intent
    without a typed confirmation; the `SettingsRow` v2 confirmation should cover both.
  - **N5 (ST-04):** the manifest-ingest audit rows use the "Manifest resync" actor and "set from the
    manifest" label on a first link too; ST-04's `origin` column should tell link from resync.

The role agent sets `--set LX-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-06 done`.
