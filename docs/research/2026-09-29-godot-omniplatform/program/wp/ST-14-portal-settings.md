# ST-14 Customer portal settings: three keys

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 3: coverage)                             |
| Size        | 0.7–1 engineer-weeks                                                                           |
| Depends on  | [ST-08](ST-08-product-settings-hub.md), [I-29](I-29-retire-product-account-toggles-one-app.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-25](ST-25-legacy-retirement.md)                    |
| Role        | `pkey-implementer`                                                                             |
| Plan mode   | no                                                                                             |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; portal e2e                |
| Human input | none                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                      |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Register only portal.enabled, keyReissue and identity.keyEntry.claimByKey. Never register oidc_enabled, magic_enabled, license_key_claim_enabled or auto_link_enabled: I-29 retires them first.

- Title: was "Portal settings consolidation: Customer portal hub area visible with Identity off, branding editor and schema, one branding store, `portal_product_settings` into rows, one `claimByKey`".
- Depends on: added I-29.

## Goal

Portal settings live in the hub's Customer portal area, visible with Identity off, with a branding editor and schema, one branding store, `portal_product_settings` folded into rows and one `claimByKey`.

## Why

Portal settings are split across tables and hidden behind Identity ([S-18 §4.10](../../notes/S-18-settings-architecture.md#410-customer-portal)); D8 accepted the consolidation.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.10](../../notes/S-18-settings-architecture.md#410-customer-portal), [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-14, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D8.

## Scope

**In:**

- Area; branding editor and schema; `portal.*` rows copied once; `claim_by_key` → `identity.keyEntry.claimByKey`; old table dropped one release later.

**Out** (and where it belongs instead):

- `products.branding_json` drop (→ ST-25).

## PENDING entries to remove

ST-06 left a shrinking allow-list in `packages/worker/scripts/settings-coverage.ts`. Its "PENDING owners" decision ([ST-06](ST-06-settings-docs-coverage.md#design-notes)) assigns this package the 1 entry below. Register each one in the settings registry (the note names the intended key, where there is one), then delete it from `PENDING` and lower `PENDING_CEILING` by the same count. `checkCoverage` refuses an entry that is both pending and registered, so the two edits land together.

- `table:portal_product_settings`

## Design notes

- Take the non-NULL portal branding value.

## Steps

1. Migration.
2. Area and editor.
3. Portal tests.

## Acceptance criteria

- [ ] Every `PENDING` entry listed under "PENDING entries to remove" is registered and gone from `settings-coverage.ts`, `PENDING_CEILING` is 1 lower, and `settings-coverage.test.ts` passes.
- [ ] Branding reads from one store (test).
- [ ] The area is visible with Identity off (e2e).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-25 retires the leftovers.

The role agent sets `--set ST-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-14 done`.
