# LX-03 Claim and migrate carry `license_store_grants` and store bindings to the target licence (old binding kept as an alias); seat-checked `moveDevices`

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes) |
| Size        | 0.3–0.4 engineer-weeks                                                                  |
| Depends on  | none                                                                                    |
| Unblocks    | none                                                                                    |
| Role        | `pkey-implementer`                                                                      |
| Plan mode   | no                                                                                      |
| Gates       | THREAT-MODEL                                                                            |
| Human input | none                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                               |

## Goal

Claim and migrate move `license_store_grants` and store bindings to the target licence (the old binding kept as an alias), and `moveDevices` checks seats instead of clearing `seat_no`.

## Why

Migrate disables the enrolled licence without moving purchases, and `moveDevices` ignores seats (G6, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps) G6, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-03.
- Commerce and identity claim code (`commerce/index.ts`, `oidc.ts`).

## Scope

**In:**

- Carry grants and bindings in the claim batch; alias rows; seat-checked `moveDevices`.

**Out** (and where it belongs instead):

- Holder bindings (→ LX-11).

## Design notes

- Existing per-licence bindings must keep resolving.

**Corrections from the code (2026-10-04, implementation).**

- Only the **migrate** arm of `activateFromIdentity` retires a licence. The **claim** arm keeps
  the same licence row, so its grants, purchases and binding already stay put; nothing is carried
  there.
- `dist_purchase_bindings` is keyed (product, license_id), so the old binding cannot be re-pointed
  at a target that already has one. The alias is a new Distribution table,
  `dist_purchase_binding_aliases` (migration 0073; numbered 0072 on the branch, renumbered at integration after ST-01a took 0072), read before `dist_purchase_bindings` by
  `licenseOfBinding`. `dist_purchases.license_id` ("first licence wins") also has to move, or a
  restore of an already-recorded purchase is refused as `bound_elsewhere`.
- The rows belong to License (`license_store_grants`) and Distribution (`dist_purchases`, the
  bindings), which Identity may not import (rule 6). The carry is therefore a Core-declared
  descriptor step, `ServiceDescriptor.licenseMerge` (statements only, run whatever the service's
  enablement, like `manifestIngestAlways`), collected by `core/licenseMerge.ts` and handed to
  Identity on `ServiceContext.licenseMerge`. `mergeLicenseInto` runs the seat-checked device move
  (`planDeviceMove`), those statements, the retirement and its audit row in one batch.

## Steps

1. Tests.
2. Batch change.

## Acceptance criteria

- [x] After migrate, a restore on the old binding reaches the target licence (test).
- [x] `moveDevices` refuses beyond the target's seats (test).
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-11 replaces aliases with holder bindings.

The role agent sets `--set LX-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-03 done`.
