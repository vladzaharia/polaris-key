# ST-05 Generic settings admin API with compatibility aliases for the bespoke routes

| Field       | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 1: foundation)                                                                                                                       |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                      |
| Depends on  | [ST-04](ST-04-settings-resolver.md)                                                                                                                                          |
| Unblocks    | [ST-07](ST-07-settings-row-v2.md), [ST-11](ST-11-sql-only-settings.md), [ST-27](ST-27-alert-destinations.md), [ST-21](ST-21-capability-gate.md), [CM-03](CM-03-merchants.md) |
| Role        | `pkey-implementer`                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                           |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL                                                                                                                            |
| Human input | none                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                    |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W17.md`](../plans/PX-W17.md):** call `applyServiceTransitions`, and show the dry-run count in the confirm.

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`.

- **Write `storefront.polarisKey.enabled`** ([PS-03](PS-03-obtain-path-engine.md)). PS-03 made
  `core/storefrontSwitch.ts` the setting's first reader. It is a `platform_settings` row keyed by the
  registry key itself (`storage: { kind: "scalar" }`, no `storedAs` alias) holding the JSON string
  `"on"` or `"off"`. No row or a tombstone reads as the default `on`; any other value, or an
  unreadable store, reads as off. It is not an A-13 store key (`core/platformSettings.ts`), so the
  A-13 route cannot write it and this generic API is its only writer. Accept only `"on"` and
  `"off"` (a `switch`, L2 confirmation both ways, per its registry entry in
  `core/settings/platform.ts`), write the row under that key, reset by deleting it or writing the
  tombstone, and read it back in a test through `polarisKeyStorefrontEnabled`.

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
