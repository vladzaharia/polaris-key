# ST-14 Portal settings consolidation: Customer portal hub area visible with Identity off, branding editor and schema, one branding store, `portal_product_settings` into rows, one `claimByKey`

| Field       | Value                                                                           |
| ----------- | ------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 3: coverage)                            |
| Size        | 0.7–1 engineer-weeks                                                            |
| Depends on  | [ST-08](ST-08-product-settings-hub.md)                                          |
| Unblocks    | [ST-25](ST-25-legacy-retirement.md)                                             |
| Role        | `pkey-implementer`                                                              |
| Plan mode   | no                                                                              |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; portal e2e |
| Human input | none                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                       |

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

## Design notes

- Take the non-NULL portal branding value.

## Steps

1. Migration.
2. Area and editor.
3. Portal tests.

## Acceptance criteria

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
