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

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** glossary noun **Cloud Sync principal** (Q7); the A3 record; enum additions (the parity `service` enums gain `sync`); tolerance tests; the discovery re-record; data shape in the catalog and limits and access policy as claimable settings in `.pkey/product` (Q5), with the registry slice; rule 8b.

## Corrections and decisions (implementation, 2026-10-05)

Recorded by the implementer; the code is the fact. Decisions the brief and plan left open were
taken with the recommended option, as the lead delegated.

- **Settings registry slice registered; persistence waits for ST-01b** (fix round 1, after
  ST-03 merged). `services/sync/settings.ts` (`SYNC_SETTINGS_SLICE`, namespace `cloudSync`,
  attached as `syncService.settings`) registers plans/U-01.md §3's product-scope claimable
  entries: `cloudSync.limits`, `cloudSync.limits.byTier`, `cloudSync.limits.byEntitlement`,
  `cloudSync.unlicensed` and `cloudSync.writes` (security-widening, so `critical`). Their
  defaults and the ceilings their value specs name are `CLOUD_SYNC_DEFAULTS` /
  `CLOUD_SYNC_CEILINGS` from `@polaris-key/catalog`, the same constants validator rule 10 uses.
  Every entry is `pending: U-05` (U-05 adds the readers), and storage is a scalar
  `product_settings` row that ST-01b creates: until then `.pkey/product`'s `cloudSync` block is
  validated (rules 8, 8b, 10) but not persisted. The operator-only per-product ceilings
  (`cloudSync.ceiling.*`) and the platform `cloudSync.writesPaused` lock stay with U-05, which
  enforces them. There is no `gen:settings` generator or settings reference page yet (ST-06).
- **`gen-mirrors` drift is the generator test.** `pnpm gen:mirrors` needs `--catalog`/`--out-dir`
  and the repo commits no mirror, so the drift gate is
  `mise exec node@22 -- pnpm --filter @polaris-key/tools exec vitest run gen-mirrors.test.ts` (byte-exact per
  language). Mirrors now always carry the user-settings block (`UserSettingKey = never` and an
  empty `USER_SETTINGS` when a catalog declares none), so a downstream repo that commits a mirror
  sees a one-time diff on upgrade; the release notes for the generator must say so.
- **One implementation of the user-block rules.** Rules shape and 1–5 live once, in
  `@polaris-key/catalog` (`userSettingIssues`, `mergeMembersOverLimit`), called by the manifest
  validator, the Worker's console catalog publish (`PUT …/config/catalog`) and the console's
  catalog editor, so a draft the console accepts publishes. `@polaris-key/manifest` exports
  `validateCatalogCloudSync` for the publish route.
- **Console publish keeps `cloudSync`.** The publish route used to store `entries` only, which
  would have dropped the catalog's `cloudSync` block on the first console publish. It now carries
  the active version's block forward when the body has none, stores one the body names, and
  checks either against the new entries (a removed flag or rename target refuses with 422).
- **Discovery fragment.** U-04 ships `services.sync` as `{"enabled":false}` off and, on,
  `{"enabled":true,"settings":false,"collections":false,"saves":false,"endpoints":{"pull":null,"push":null,"saves":null}}`:
  every capability false and no endpoint until U-05, U-09 and U-10 serve one; `limits` arrive
  with U-05. The discovery golden, the OpenAPI `SyncFragment` and three transcripts were
  re-recorded (the transcripts' expected capability maps gain `sync: false`).
- **Accent.** Cloud Sync's console accent is the **teal** family (dark `#14f8e1`, light
  `#086260`), `tune-accents`' optimum over the palette's remaining gaps; light chroma is 0.075
  so it clears the 17.5 ΔE00 floor against the Release cyan and the ΔEOK floor against the
  Distribution green.
- **Console page.** Cloud Sync → **Data** (`sync/data`), read-only over the active catalog: user
  settings, collections, saves, migrations, the platform ceilings and the sign-in-only callout.
  Editing collections, saves, limits and migrations from the console (S-17 §5.10) is not in this
  package: they are authored in `.pkey/`.
- **Tolerance tests.** Node, React, Python, Swift and Kotlin each gain a test that a catalog with
  `user` and `cloudSync` members still parses; Godot's fixture catalog carries both members, so
  its fetch test covers it.
- **Kotlin** tests could not run in this environment (no Java runtime); the Kotlin mirror sample
  and tests were changed and need a JDK run.

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

- [x] Every rule 1–11 has a validator rule, a mutation-table entry and schema coverage.
- [x] `gen:services -- --check`, `gen:mirrors` drift and generated docs are clean.
- [x] The `sync` toggle cannot be enabled without Config and Identity, and Identity cannot be turned off while Cloud Sync is on (tests).
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

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
