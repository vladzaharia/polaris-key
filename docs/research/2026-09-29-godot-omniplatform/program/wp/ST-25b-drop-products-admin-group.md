# ST-25b Drop `products.admin_group` (the release after ST-25)

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 5: governance and environments) |
| Size        | 0.1–0.2 engineer-weeks                                                                |
| Depends on  | [ST-25](ST-25-legacy-retirement.md)                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                |
| Role        | `pkey-implementer`                                                                    |
| Plan mode   | no; executes [`plans/ST-28.md`](../plans/ST-28.md) §5.1 step 3 (approved 2026-10-08)  |
| Gates       | `migration`, `table-owners`                                                           |
| Human input | none                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                             |

## Goal

`products.admin_group` is dropped, one release after ST-25 stopped every read of it. Done when every acceptance criterion holds and the green gate passes.

## Why

ST-28's Q4 drops the column rather than leaving it dormant, as the two-release DB contract (`tracks.md` rules 5 and 6) that LX-16b, I-28b and P0-28b already follow. ST-32 stops the writes, ST-25 removes every read, and this package drops the column once neither the serving Worker nor its rollback target names it.

## Read first

- `AGENTS.md` (always).
- [`plans/ST-28.md`](../plans/ST-28.md) §5.1 ("`products.admin_group` retires in three steps") and the migrations table.

## Scope

**In:**

- `00XX_drop_products_admin_group.sql`: `ALTER TABLE products DROP COLUMN admin_group;` (no index or view names it; only `0001_init.sql:21` creates it), with a down script in `scripts/rollback/` (`ADD COLUMN admin_group TEXT`).
- `TABLE_OWNERS` and the data-model docs, regenerated.
- The P0-24 ledger row: the production fact that the rollback target is ST-25 or later, recorded before the drop.

**Out** (and where it belongs instead):

- The reads and named references (→ ST-25); the stopped writes and the offers (→ ST-32).

## Design notes

- Name the file `00XX_<name>.sql`; the lead assigns the number at merge.
- No day count: the drop waits for the production fact, not a calendar window (owner, 2026-10-07).

## Steps

1. Verify ST-25's source scan still finds no `admin_group` outside `migrations/`.
2. Record the rollback-target fact in the P0-24 ledger.
3. Add the migration and its down script; run the green gate; hand off.

## Acceptance criteria

- [ ] The production rollback target is ST-25 or later, recorded in the P0-24 ledger before the drop.
- [ ] The migration replays cleanly, and the down script restores the empty column.
- [ ] No `admin_group` outside `migrations/` and `scripts/rollback/`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- migrations boundaries
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set ST-25b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-25b done`.
