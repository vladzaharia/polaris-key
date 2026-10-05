# ST-05 Generic settings admin API with compatibility aliases for the bespoke routes

| Field       | Value                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 1: foundation)                                                                                          |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                         |
| Depends on  | [ST-04](ST-04-settings-resolver.md)                                                                                                             |
| Unblocks    | [ST-07](ST-07-settings-row-v2.md), [ST-11](ST-11-sql-only-settings.md), [ST-27](ST-27-alert-destinations.md), [ST-21](ST-21-capability-gate.md) |
| Role        | `pkey-implementer`                                                                                                                              |
| Plan mode   | no                                                                                                                                              |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL                                                                                               |
| Human input | none                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                       |

## Goal

A generic settings admin API reads, writes, reverts and lists settings at any scope through the registry, and the bespoke settings routes become compatibility aliases over it.

## Why

Every settings surface has its own route today ([S-18 §4.7](../../notes/S-18-settings-architecture.md#47-apis-admin-narrative-only-rule-10)); one API is what the console hub, the CLI and export use.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.7](../../notes/S-18-settings-architecture.md#47-apis-admin-narrative-only-rule-10), [S-18 §4.8](../../notes/S-18-settings-architecture.md#48-authorization), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-05.

## Scope

**In:**

- Routes per §4.7 with OpenAPI entries and `routeCoverage`.
- Aliases for the bespoke routes, same responses.
- Authz tests per scope.

**Out** (and where it belongs instead):

- The capability gate (→ ST-21); console views (→ ST-07, ST-08).

## Design notes

- Narrative-only API (rule 10): document every route; aliases are retired in ST-25.

## Steps

1. Routes.
2. Aliases.
3. OpenAPI and coverage.

## Acceptance criteria

- [ ] Every new route is in OpenAPI and `routeCoverage`.
- [ ] Each bespoke route answers identically through its alias (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- ST-07, ST-11, ST-21 and ST-27 call these routes.

The role agent sets `--set ST-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-05 done`.
