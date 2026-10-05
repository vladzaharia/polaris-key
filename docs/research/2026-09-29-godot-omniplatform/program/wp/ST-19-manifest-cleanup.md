# ST-19 Manifest cleanup: duplicate spellings deprecated with warnings, registry ↔ manifest parity test

| Field       | Value                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Phase       | ST: Settings architecture (S-18) (phase 4: manifest round trip)                      |
| Size        | 0.5–0.7 engineer-weeks                                                               |
| Depends on  | [ST-03](ST-03-settings-registry.md)                                                  |
| Unblocks    | none                                                                                 |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                |
| Plan mode   | yes: the plan [`plans/ST-19.md`](../plans/ST-19.md) needs human approval before code |
| Gates       | plan mode; rule 9 (validator rule, mutation table, JSON schema); CLI bundle          |
| Human input | plan approval (`plans/ST-19.md`)                                                     |
| Repo        | `vladzaharia/polaris-key`                                                            |

## Goal

Duplicate manifest spellings are deprecated with warnings, and a parity test keeps the registry and the manifest schema in step.

## Why

`djdl`'s legacy `.pkey/product.json` spelling is one of several duplicates ([S-18 §4.14.3](../../notes/S-18-settings-architecture.md#4143-the-two-real-products)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); the `authoring-pkey-manifests` skill.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.14.3](../../notes/S-18-settings-architecture.md#4143-the-two-real-products), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-19.

## Scope

**In:**

- Warnings for each duplicate spelling; rule 9 mutation entries; registry ↔ manifest parity test.

**Out** (and where it belongs instead):

- Turning warnings into errors (a later decision).

## Design notes

- Plan mode because it changes the manifest contract: the plan names every validator rule and mutation entry.

## Steps

1. Plan.
2. Warnings.
3. Parity test.

## Acceptance criteria

- [ ] `pkey validate` warns on `djdl` and passes on the monorepo `.pkey/`.
- [ ] Rule 9 entries exist for each warning.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

## Hand-off

- None.

The role agent sets `--set ST-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-19 done`.
