# ST-18 Promote to repo (patch), settings export and import, `pkey settings diff` and `export`, `pkey validate --against`, CI scope `settings:read`

| Field       | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 4: manifest round trip) |
| Size        | 1–1.4 engineer-weeks                                            |
| Depends on  | [ST-17](ST-17-resync-dry-run.md)                                |
| Unblocks    | [ST-23](ST-23-env-promote.md)                                   |
| Role        | `pkey-implementer`                                              |
| Plan mode   | no                                                              |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; CLI bundle   |
| Human input | none                                                            |
| Repo        | `vladzaharia/polaris-key`                                       |

## Goal

Operators turn console claims into a `.pkey/` patch, export and import settings, and run `pkey settings diff|export` and `pkey validate --against`; CI scope `settings:read` exists in both CI scope lists.

## Why

The manifest round trip closes model C ([S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe) item 6; D13 patch only).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-18, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D13.

## Scope

**In:**

- Patch generation; export/import (dry run, L2); CLI commands; `settings:read` in `W/core/ciVocabulary.ts` `CI_SCOPES` and `A/api.ts`, with a parity test.

**Out** (and where it belongs instead):

- A GitHub-App PR variant (later; needs `contents: write`).

## Design notes

- THREAT-MODEL CI-scope row.

## Steps

1. Patch and export.
2. CLI.
3. Scope and parity test.

## Acceptance criteria

- [ ] The two `CI_SCOPES` lists match (test).
- [ ] Export then import round-trips (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

## Hand-off

- ST-23 builds environment promote on export.

The role agent sets `--set ST-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-18 done`.
