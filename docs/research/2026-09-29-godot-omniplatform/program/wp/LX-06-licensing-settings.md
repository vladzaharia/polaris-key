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

- LX-07 onward read these settings through ST-04's resolver once it exists.

The role agent sets `--set LX-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-06 done`.
