# ST-21 Capability gate `can()` on every settings write; `useCan` reads capabilities

| Field       | Value                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 5: governance and environments) |
| Size        | 0.5–0.7 engineer-weeks                                                  |
| Depends on  | [ST-05](ST-05-settings-admin-api.md)                                    |
| Unblocks    | [ST-22](ST-22-per-product-roles.md), [CM-03](CM-03-merchants.md)        |
| Role        | `pkey-implementer`                                                      |
| Plan mode   | no                                                                      |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL                       |
| Human input | none                                                                    |
| Repo        | `vladzaharia/polaris-key`                                               |

## Goal

Every settings write checks a capability with `can()`, and the console's `useCan` reads capabilities from the server.

## Why

D10: capability field and gate now, roles later ([S-18 §4.8](../../notes/S-18-settings-architecture.md#48-authorization)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.8](../../notes/S-18-settings-architecture.md#48-authorization), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-21, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D10.

## Scope

**In:**

- `can()` on every settings write; capability on each registry entry; `useCan`.

**Out** (and where it belongs instead):

- Per-product roles (→ ST-22).

## Design notes

- Today's admin group remains the only role.

## Steps

1. Gate.
2. Console hook.
3. Tests.

## Acceptance criteria

- [ ] Every settings route checks `can()` (route coverage test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-22 adds roles behind the same gate.

The role agent sets `--set ST-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-21 done`.
