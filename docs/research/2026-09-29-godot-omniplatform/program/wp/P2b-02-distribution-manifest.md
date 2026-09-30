# P2b-02 `.pkey/distribution`: outlets, identities, listings and transports

| Field       | Value                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2b: Distribution core                                                                                                                                                                                                |
| Size        | 1 engineer-weeks                                                                                                                                                                                                      |
| Depends on  | [P2b-01](P2b-01-distribution-service.md), [P2-04](P2-04-release-descriptor.md)                                                                                                                                        |
| Unblocks    | [P2b-03](P2b-03-availability-keys.md), [P2b-04](P2b-04-rollouts-delivery.md)                                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                                                    |
| Plan mode   | no                                                                                                                                                                                                                    |
| Gates       | rule 9 (a fourth manifest document: validator, mutation table, new `distribution.schema.json`); D1 migration + `TABLE_OWNERS` (two tables; not in the graph's gates); `docs gen:check`; threat model for capabilities |
| Human input | none                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                             |

## Goal

A product can carry `.pkey/distribution.{json,yaml,yml}` declaring its **outlets** (with store
identities), per-deliverable **transports** per outlet, and its **listing**. The file is parsed,
validated (rule 9), and applied on link and resync into `dist_outlets` and `dist_transports`
through distribution's own `manifestIngest` hook. **Outlet capabilities** come from a default
table per outlet kind and can be narrowed only by an operator, never by the manifest. The
`outletCapabilities` hook answers from that.

## Why

The research keeps `.pkey/release` about what exists and puts how it reaches devices in a second
document ([§3.8](../../README.md#38-distribution-distribution-service) "Manifest",
[§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative)). Storefront feeds,
the download page, availability and connectors all need outlet identities (bundle id, package
name, Steam app id) and listings. Security-relevant capabilities (`codeUpdates`,
`downloadedScripts`, `commerce`) must be operator-owned, following the `requireSparkleSignature`
precedent (R6-03; README §3.1). Store ids and URLs belong here, not in the config catalog
([notes/A3 §6](../../notes/A3-admin-dx.md#6-docs-and-skills-to-add-or-change)).

## Read first

- `AGENTS.md` (rules 5 and 9), `CLAUDE.md`, the `authoring-pkey-manifests` skill.
- [README §3.1](../../README.md#31-vocabulary) (outlet ids, capabilities, transports),
  [§3.8](../../README.md#38-distribution-distribution-service) (`dist_outlets`, `dist_transports`),
  [§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative) (the
  `distribution.yaml` sketch and "capabilities are deliberately absent").
- [notes/A3 §3.2](../../notes/A3-admin-dx.md#32-what-an-omni-platform-download-page-needs) and
  [§5.4](../../notes/A3-admin-dx.md#54-terminology-new-nouns-that-dont-collide);
  [notes/E1 §B1](../../notes/E1-apple.md#b1-source-json-schema-current) (listing fields AltStore
  needs); [notes/E2 §B3](../../notes/E2-android.md#b3-obtainium).
- [P2b-01](P2b-01-distribution-service.md) hand-off (`core/hooks.ts`), [P2-04](P2-04-release-descriptor.md)
  (artifact-map ids, declared channels).
- Code: `packages/shared-manifest/src/index.ts` (`ManifestDocuments` `:70-74`,
  `ValidationMessage.file` `:64`, `ParsedManifest` `:223-245`, `parseManifest` `:1460`),
  `schemas/v1/`, `test/schema-parity.test.ts` (`Docs`, `schemaAccepts`, the base fixture);
  `packages/worker/src/services/release/manifestFiles.ts:14,28-32`, `resync.ts:120-128`,
  `linkRepo.ts:196-207` (both loop over `["schema", "product", "release"]`); `src/core/registry.ts:113-120` (`manifestIngest`, which nothing calls
  today); `packages/cli/src/manifest.ts:97-127` (`loadManifest`); `.vscode/settings.json`.

## Scope

**In:**

- **Manifest package:** `ManifestDocuments.distribution`, `"distribution"` in the
  `ValidationMessage.file` union, `ParsedManifest.distribution` (normalised), validator rules and
  `schemas/v1/distribution.schema.json`. Proposed codes: `invalid_outlet_id`,
  `unknown_outlet_kind`, `invalid_outlet_identity`, `unknown_artifact_ref` (cross-document,
  `schema: "accepts"`), `unknown_channel_ref` (`schema: "accepts"`), `unknown_deliverable_ref`
  (`schema: "accepts"`), `invalid_transport`, `transport_not_allowed`, `invalid_listing`,
  `capabilities_not_manifest_writable`. One mutation entry each; the parity test's `Docs`,
  `schemaAccepts` and base fixture gain the document.
- **Absent document** with distribution enabled means one implicit outlet `direct` with transport
  `pkey-cdn`, so djdl needs no file.
- **Worker:** `ManifestFileName` and `MANIFEST_FILES` gain `distribution`; link and resync read it.
  Implement `manifestIngest` for distribution, and a Core helper that runs every **enabled**
  service's `manifestIngest` in the ingest batch, with the registry handed down from the
  composition root (the webhook, `admin/handlers/products.ts` and the admin API already hold
  `SERVICES`). Release's resync may not import distribution (rule 6).
- **Tables** (migration, `TABLE_OWNERS` under a new `distribution` key):
  `dist_outlets(product, outlet_id, kind, identity_json, capabilities_json, listing_json, capabilities_source, removed_at, created_at, modified_at)`
  and `dist_transports(product, deliverable_id, outlet_id, transport, config_json)`.
- **Capabilities:** a default table per outlet kind in `services/distribution/capabilities.ts`;
  the `outletCapabilities` hook returns the default narrowed by any operator override; admin
  routes (narrative-only) `GET …/distribution/outlets` and
  `PUT …/distribution/outlets/{outletId}/capabilities` (narrow-only, sets
  `capabilities_source = 'admin'`, audited), plus revert.
- **Editors and CLI:** `.vscode/settings.json` globs; `pkey validate` loads and reports the file.
- Docs: a `build/manifest/distribution.md` page (or a section of `authoring.md`), the skill's
  step 3 ("four files"), `services/distribution/index.md`, regenerated `reference/*.mdx`.

**Out** (and where it belongs instead):

- Availability, submissions, keys (→ [P2b-03](P2b-03-availability-keys.md)); rollouts, access and
  byte serving (→ [P2b-04](P2b-04-rollouts-delivery.md)); feeds (→ [P2b-05](P2b-05-storefront-feeds.md)).
- Credentials for store connectors: never in a manifest (→ [P5-01](P5-01-outlet-credentials.md)).
- Pack-specific transport behaviour and readiness (→ P4-05, P4-14). `pkey init` scaffolding of the
  file (→ P0-07 or a follow-up).

## Design notes

- **Shape** (README §3.12): `outlets: {<outletId>: {kind?, …identity}}`,
  `transports: {default, packs: {<outletId>: <transport>}, deliverables: {<deliverableId>: {<outletId>: <transport>}}}`
  (`deliverables` is a proposed per-deliverable override), `listing: {name, subtitle, description, iconUrl, headerUrl, tintColor, category, screenshots[], website, developerName}`
  and an optional per-outlet `listing` override merged over it.
- **Outlet ids and kinds.** Ids match `^[a-z][a-z0-9-]{0,63}$`. `kind` defaults to the id when the
  id is a known kind (`direct`, `app-store`, `testflight`, `altstore`, `altstore-pal`, `play`,
  `play-testing`, `obtainium`, `fdroid-repo`, `ms-store`, `app-installer`, `steam`, `itch`,
  `flathub`, `snap`, `winget`, `web`), so `altstore-beta` needs `kind: altstore`.
- **Identity fields per kind** (proposed): `app-store`/`testflight` `appleId`, `bundleId`;
  `altstore`/`altstore-pal` `artifact`, `bundleId`, `marketplaceId` (PAL only); `play`/`play-testing`
  `packageName`, `tracks {<channel>: <track>}`; `obtainium`/`fdroid-repo` `artifact`,
  `packageName`; `ms-store` `productId`; `steam` `appId`, `branches {<channel>: <branch>}`;
  `itch` `target`; `flathub` `appId`; `snap` `name`; `winget` `packageIdentifier`; `direct`
  `platforms[]`; `web` none. `artifact` names an artifact-map `id` (P2-04); channel keys must be
  declared channels.
- **Transports** `embedded`, `pkey-cdn`, `apple-ba`, `play-pad`, `steam-depot`, `msix-optional`,
  `flatpak-ext`, `web`. `pkey-cdn` and `embedded` fit any outlet; `apple-ba` only `app-store`/
  `testflight`; `play-pad` only `play`/`play-testing`; `steam-depot` only `steam`;
  `msix-optional` only `ms-store`/`app-installer`; `flatpak-ext` only `flathub`; `web` only `web`.
- **Capabilities are never manifest-writable.** A `capabilities` key anywhere in the file is an
  error, not ignored, so an author learns it at validate time. Operators may only **narrow** the
  default (`codeUpdates` true → false, `binaryUpdates` `self` → `none`), matching P3-01's rule that
  the server narrows and never widens past the compiled defaults.
- **Default capabilities** (proposed; P3-01's `outlet-matrix.json` becomes the source of truth
  once approved, and this table must then match it):

  | Kinds                                                                                                        | binaryUpdates | codeUpdates | dataUpdates | channelSwitch | commerce    | downloadedScripts |
  | ------------------------------------------------------------------------------------------------------------ | ------------- | ----------- | ----------- | ------------- | ----------- | ----------------- |
  | `direct`, `web`                                                                                              | `self`        | true        | true        | true          | `own`       | true              |
  | `app-store`, `testflight`, `play`, `play-testing`, `ms-store`                                                | `store`       | false       | true        | false         | `store-iap` | false             |
  | `steam`                                                                                                      | `store`       | false       | true        | false         | `steam`     | false             |
  | `altstore`, `altstore-pal`, `obtainium`, `fdroid-repo`, `app-installer`, `itch`, `flathub`, `snap`, `winget` | `store`       | false       | true        | false         | `own`       | false             |

- **Resync** upserts declared outlets and transports, sets `removed_at` on outlets no longer
  declared (never deletes: P2b-03's availability history refers to them), and never writes
  `capabilities_json`. `listing_json` is the merged listing.
- **One ingest mechanism.** Wiring `manifestIngest` through Core is the pattern the registry
  comment promises; keep release's own ingest as it is, and add the helper beside it.

## Steps

1. Manifest types, normaliser, validator rules, schema, mutation entries, parity-test plumbing.
2. Migration, `TABLE_OWNERS`, `docs gen`.
3. Worker: manifest file list, the Core ingest helper, distribution's `manifestIngest`, tests for
   link and resync (add, change, remove an outlet; operator capabilities survive).
4. Capability defaults, the hook, admin routes with narrow-only validation and audit.
5. CLI and editor wiring; docs and skill.

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/manifest test` passes with a Diceroll-shaped `distribution`
      document in the base fixture and one mutation per new code.
- [ ] Resync of a fixture repo writes the expected `dist_outlets` and `dist_transports` rows; a
      second resync is a no-op; removing an outlet sets `removed_at`.
- [ ] A manifest with `capabilities` fails validation; an operator widening a capability is
      refused; an operator narrowing survives a resync; revert restores the default.
- [ ] With distribution disabled, its `manifestIngest` does not run (spy) and the hook returns `null`.
- [ ] `pkey validate` reports errors in `distribution.yaml` with the file name.
- [ ] `docs gen:check` is clean; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- distribution linkRepo releaseStore
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- `dist_outlets`, `dist_transports`, the outlet id and kind vocabulary, the identity fields and
  `capabilities.ts` are what P2b-03 to P2b-06, P3-01 (outlet matrix), P4-05 and P5-02 to P5-04 read.
- The Core `manifestIngest` helper is available to any later service.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2b-02 done`.
