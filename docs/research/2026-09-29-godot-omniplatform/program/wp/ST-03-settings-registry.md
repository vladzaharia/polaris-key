# ST-03 Settings registry types and slices: `SettingDef` with `policyBound`, `allowUnset` and `wire`, the platform slice with aliases, service slices through descriptors, deny-list and product-scope rules test

| Field       | Value                                                                                                                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 1: foundation)                                                                                                                                                                                                                                                                                       |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                                                                                                                                                                                      |
| Depends on  | none                                                                                                                                                                                                                                                                                                                                         |
| Unblocks    | [I-09](I-09-key-entry-attach.md), [U-05](U-05-cloud-sync-do.md), [PX-W9](PX-W9-key-entry-counting.md), [ST-04](ST-04-settings-resolver.md), [ST-06](ST-06-settings-docs-coverage.md), [ST-20](ST-20-manifest-authoritative.md), [ST-19](ST-19-manifest-cleanup.md), [LX-06](LX-06-licensing-settings.md), [HA-10](HA-10-hosting-settings.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                           |
| Gates       | rule 6 (service boundaries); THREAT-MODEL                                                                                                                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                    |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** the seed corrections and the §3.2 licensing keys.
- **[`plans/I-09.md`](../plans/I-09.md):** I-09 registers four identity keys.
- **[`plans/PX-W9.md`](../plans/PX-W9.md):** PX-W9 registers `identity.keyEntry.limit` (product, claimable, 1–100, default 10, `policyBound: max`) and the platform switch `identity.keyEntryRefusals` (default off).
- **[`plans/PX-W13.md`](../plans/PX-W13.md) (as amended):** three settings: the operator-only `identity.displayNameApproved`, the platform list `identity.reservedDisplayTerms`, and the platform switch `identity.reservedDisplayNames` (`warn` | `error`, default `warn`).

## Goal

One settings registry describes every platform, product and service setting (`SettingDef` with scope, type, `claimable`, `merge`, `policyBound`, `allowUnset`, `wire`), with A-13's platform keys migrated behind aliases and service slices contributed through Core descriptors.

## Why

Settings live under six precedence patterns and five vocabularies ([S-18 §2.3](../../notes/S-18-settings-architecture.md#23-six-precedence-patterns-five-vocabularies)); a registry is what search, docs, history, export and the coverage test all read ([S-18 §4.2](../../notes/S-18-settings-architecture.md#42-the-registry)). The account is not a settings scope: S-19's model OC was adopted ([S-18 owner decisions](../../notes/S-18-settings-architecture.md) item 5).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.1](../../notes/S-18-settings-architecture.md#41-scopes-and-vocabulary), [S-18 §4.2](../../notes/S-18-settings-architecture.md#42-the-registry), [S-18 §5.3](../../notes/S-18-settings-architecture.md#53-s-16-identity-s-19-licensing-model-and-licence-shaped-settings), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-03, [S-18 §A](../../notes/S-18-settings-architecture.md#appendix-a-registry-seed-list) (seed list).
- `notes/S-13-platform-settings.md` and A-13's registry code.

## Scope

**In:**

- `SettingDef` types incl. the `policyBound` direction rule, `allowUnset`, `wire`, and the reserved (unbuilt) `accountMerge` field.
- The platform slice with aliases for A-13's four keys; service slices via descriptors (rule 6).
- Deny-list and product-scope rules test; `identity.keyEntryRefusals` and `identity.keyEntry.limit` registered for I-09 and I-10a.

**Out** (and where it belongs instead):

- The resolver (→ ST-04); the generic API (→ ST-05); docs generation (→ ST-06).

## Design notes

- `accountMerge` stays reserved and is not built (owner, D20 resolved by S-19).
- S-19's per-product licensing settings are seeded as claimable entries (LX-06 implements them).
- Amend THREAT-MODEL AT-2 for the registry.

## Steps

1. Types and rules test.
2. Platform slice with aliases.
3. Descriptor-based service slices.

## Acceptance criteria

- [ ] The boundaries test passes (rule 6).
- [ ] A product-scope entry declared on a platform-only key fails the rules test.
- [ ] A-13's keys resolve through their aliases (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- ST-04, ST-06, ST-19, I-09, U-05 and LX-06 register or read entries here.

The role agent sets `--set ST-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-03 done`.
