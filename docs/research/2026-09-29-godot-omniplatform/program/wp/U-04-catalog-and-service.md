# U-04 Catalog, manifest and the `sync` service: catalog `user` block and `cloudSync` block with validator rules 1–11, typed setting keys in the mirrors, generated docs, the Cloud Sync service descriptor (`requires: [config, identity]`), console catalog form and Cloud Sync page

| Field       | Value                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                             |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                    |
| Depends on  | [U-01](U-01-cloud-sync-plan.md)                                                                                                                                                                                           |
| Unblocks    | [U-05](U-05-cloud-sync-do.md)                                                                                                                                                                                             |
| Role        | `pkey-implementer`                                                                                                                                                                                                        |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                                                                                                                  |
| Gates       | rule 9 (validator rule, mutation table, JSON schema); new service slug (services checklist, boundaries test); generated docs pages (`gen-docs` drift); `gen-mirrors` drift; console CSP parity; `gen:services -- --check` |
| Human input | none                                                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                 |

## Goal

Products declare user settings and Cloud Sync data in `.pkey/schema` and turn on a new **Cloud Sync** service: the catalog `user` block and the `cloudSync` block validate under rules 1–11, mirrors expose typed setting keys, docs regenerate, and `tools/services.json` gains the `sync` descriptor with `requires: [config, identity]`, its toggle, discovery fragment and console section.

## Why

Owner decision 2: Cloud Sync is its own service with its own toggle ([S-17 owner decisions](../../notes/S-17-user-data-sync.md)). Everything is declared as data (rule 5) ([S-17 §5.3](../../notes/S-17-user-data-sync.md#53-catalog-and-manifest-extension)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; skills `adding-a-catalog-entry` and `authoring-pkey-manifests`; `plans/U-01.md`.
- [S-17 §5.3](../../notes/S-17-user-data-sync.md#53-catalog-and-manifest-extension), [S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-04.
- `tools/services.json`, `packages/shared-catalog/`, `packages/shared-manifest/schemas/v1/schema.schema.json`, the services checklist and `boundaries` test.

## Scope

**In:**

- `user` block (`sync`, `conflict`, `listed`, with `merge` members) on `config` entries; `cloudSync` block (collections, saves, limits, `unlicensed`, `writes`, `migrations`).
- Validator rules 1–11 with mutation-table entries and JSON schema (rule 9); `gen-mirrors` typed setting keys; `gen-docs`.
- The `sync` service: descriptor, `requires: [config, identity]`, toggle, discovery fragment, console section and accent. Cloud Sync needs sign-in, so it requires the product's Identity service (owner, 2026-10-04, final answers); the console Services toggle enforces the dependency both ways.
- Console catalog form fields and the Cloud Sync page shell.

**Out** (and where it belongs instead):

- Routes and storage (→ U-05).

## Design notes

- No new `ConfigKind`; `enums.json` and generated constants do not change.
- Limits, including `unlicensed`, must not exceed the platform ceilings; `unlicensed` must not exceed licensed.
- One new slug per PR (program README §5).
- The Cloud Sync page states that devices get a principal only by signing in through the product; key-activated devices keep settings locally.

## Steps

1. Catalog and manifest schema with rules and mutations.
2. Mirrors and docs.
3. Service descriptor and console.

## Acceptance criteria

- [ ] Every rule 1–11 has a validator rule, a mutation-table entry and schema coverage.
- [ ] `gen:services -- --check`, `gen:mirrors` drift and generated docs are clean.
- [ ] The `sync` toggle cannot be enabled without Config and Identity, and Identity cannot be turned off while Cloud Sync is on (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:services -- --check
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- U-05 reads the catalog through `shared-catalog`; the SDK packages use the typed keys.

The role agent sets `--set U-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-04 done`.
