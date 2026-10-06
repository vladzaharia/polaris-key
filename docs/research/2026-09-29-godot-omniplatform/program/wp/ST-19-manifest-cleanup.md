# ST-19 Manifest cleanup: duplicate spellings deprecated with warnings, registry ↔ manifest parity test

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 4: manifest round trip)                                                       |
| Size        | 0.5–0.7 engineer-weeks                                                                                                |
| Depends on  | [ST-03](ST-03-settings-registry.md)                                                                                   |
| Unblocks    | [ST-18](ST-18-promote-export.md), [ST-19b](ST-19b-manifest-settings.md)                                               |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                 |
| Plan mode   | yes: executes the approved [`plans/ST-19.md`](../plans/ST-19.md) (2026-10-06); nothing beyond it                      |
| Gates       | plan mode; rule 9 (validator rule, mutation table, JSON schema); CLI bundle; `gen:settings --check`; docs `gen:check` |
| Human input | none (plan approved 2026-10-06)                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Goal

Duplicate manifest spellings are deprecated with warnings, and a parity test keeps the registry and the manifest schema in step.

## Why

`djdl`'s legacy `.pkey/product.json` spelling is one of several duplicates ([S-18 §4.14.3](../../notes/S-18-settings-architecture.md#4143-the-two-real-products)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); the `authoring-pkey-manifests` skill.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.14.3](../../notes/S-18-settings-architecture.md#4143-the-two-real-products), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-19.

## Scope

**In** (exactly [`plans/ST-19.md`](../plans/ST-19.md) §3–§6 as amended by its owner decisions):

- The `DEPRECATED_SPELLINGS` table (`packages/shared-manifest/src/spellings.ts`) and the two
  warnings `deprecated_spelling` and `conflicting_spelling` for the 18 rows of plan §3.1, legacy
  `modules:` names included (Q4); today's precedence kept (Q3).
- Rule 9: one mutation entry per row, a table-driven test, `"deprecated": true` in the schemas.
- Canonical layout (Q2): `product:` + `licensing:` + `release:`; tier `profileId` (Q2b). Registry
  `manifest.path`s moved to the canonical spellings; the parity and coverage test changes of plan
  §3.5; 11 `PENDING` entries removed, 10 renamed, and the 21 that remain change owner to ST-19b.
- `pkey init` writes `profileId:` and `entries:`; `loadManifest` warns when two files exist for one
  document (Q5, CLI only); the monorepo `.pkey/schema.yaml` uses `entries: []`; docs and the
  `authoring-pkey-manifests` skill updated.

**Out** (and where it belongs instead):

- Turning warnings into errors (a later decision; plan §7 step 3).
- Registering the manifest-declared settings that are not spellings (→ ST-19b).
- Showing warnings at link and resync (→ ST-17, Q6).

## Design notes

- Plan mode because it changes the manifest contract: the plan names every validator rule and mutation entry.
- No wire, corpus, transcript or SDK change; no manifest that validates today stops validating.

## Steps

1. Plan (approved 2026-10-06).
2. Spelling table, warnings, schemas and mutation entries.
3. Registry paths, parity and coverage changes, `PENDING` moves.
4. CLI scaffold and two-files warning, monorepo `.pkey/schema.yaml`, docs and skill.

## Acceptance criteria

- [ ] `pkey validate` warns on `djdl` and prints no warning on the monorepo `.pkey/`.
- [ ] No registry `manifest.path` names a deprecated spelling; no `PENDING` entry is owned by ST-19.
- [ ] Rule 9 entries exist for each warning.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/worker test settings
mise exec node@22 -- pnpm gen:settings -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- ST-19b registers the 21 remaining manifest-declared settings.
- After merge, outside this repo: move `vladzaharia/djdl` and `storyrime` `.pkey/` to the canonical spellings.

The role agent sets `--set ST-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-19 done`.
