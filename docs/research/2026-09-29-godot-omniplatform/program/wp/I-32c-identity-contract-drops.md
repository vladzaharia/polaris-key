# I-32c Identity contract drops: `oidc_config` and the `licenses.sub` indexes (release N+1)

| Field       | Value                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)  |
| Size        | 0.1–0.15 engineer-weeks                                                                            |
| Depends on  | [I-32b](I-32b-retire-legacy-identity-engine.md)                                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                             |
| Role        | `pkey-implementer`                                                                                 |
| Plan mode   | no; executes the I-32c rows of [`plans/I-27.md`](../plans/I-27.md) §3 and §6 (approved 2026-10-08) |
| Gates       | `migration`, `table-owners`, `docs-generated`                                                      |
| Human input | none                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                          |

## Goal

The tables and indexes I-32b left unread are dropped, one release later. Done when every acceptance criterion holds and the green gate passes.

## Why

The two-release DB contract (`tracks.md` rules 5 and 6): I-32b stops every read in release N, and this package drops the storage in N+1, once the production rollback target is I-32b or later.

## Read first

- `AGENTS.md` (always).
- [`plans/I-27.md`](../plans/I-27.md) §6 (the migrations table and "What stays"), §3 (`provisioning_config`) and §9 (rollback).

## Scope

**In:**

- `00XX_drop_licenses_sub_indexes.sql`: `DROP INDEX IF EXISTS` for `idx_licenses_sub` and `idx_licenses_sub_global`; the down script recreates both.
- `00XX_drop_oidc_config.sql`: `DROP TABLE IF EXISTS oidc_config`; the down script restores the empty table.
- `00XX_drop_provisioning_config.sql`, only if I-32b's list shows no reader or writer left.
- `oidc_config` (and `provisioning_config`, if dropped) out of `TABLE_OWNERS` and the docs pages, regenerated.

**Out** (and where it belongs instead):

- `licenses.sub` and the `oidc_*` columns of `edge_mint_approvals` stay dormant: migration 0017 warns against rebuilding `licenses`.

## Design notes

- Name each file `00XX_<name>.sql`; the lead assigns numbers at merge. Replay-safe, with down scripts in `scripts/rollback/`.
- The P0-24 ledger records the production check before the drop.

## Steps

1. Confirm in production that the rollback target is I-32b or later, and record it in P0-24.
2. Add the migrations and down scripts; regenerate the docs; run the green gate; hand off.

## Acceptance criteria

- [ ] The production check is recorded in P0-24 before the drop.
- [ ] Each down script restores what its migration dropped.
- [ ] `docs gen:check` passes with `oidc_config` gone from `TABLE_OWNERS`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- migrations scheduled
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set I-32c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-32c done`.
