# LX-16 Licensing contract step: stop dual-writing, final reconciliation, drop or retire the old objects

| Field       | Value                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)      |
| Size        | 0.2–0.3 engineer-weeks                                                                            |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [LX-11](LX-11-commerce-rework.md)                         |
| Unblocks    | none                                                                                              |
| Role        | `pkey-implementer`                                                                                |
| Plan mode   | no                                                                                                |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`                               |
| Human input | a production release with LX-09's read switch live everywhere for one release before this deploys |
| Repo        | `vladzaharia/polaris-key`                                                                         |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W13.md`](../plans/PX-W13.md):** Q6: rename `account_product_grants` in the contract-phase migration.

## Goal

The old licensing objects are retired: dual-writing stops, a final reconciliation shows zero drift, and old columns are dropped where D1 allows without a rebuild (else left dead); `license_store_grants` is dropped last.

## Why

[S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract) step 6, one release after the read switch.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract) step 6, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-16.

## Scope

**In:**

- Stop dual-write; reconciliation report; drops; rollback script.

**Out** (and where it belongs instead):

- Anything still read.

## Design notes

- Check D1 `DROP COLUMN` support per column [U].

## Steps

1. Reconcile.
2. Stop writes.
3. Drop.

## Acceptance criteria

- [ ] Reconciliation shows zero drift.
- [ ] Migration replay test passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set LX-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-16 done`.
