# P2-03 Release data model v2: deliverables, builds, artifact roles, channel policy, yanks

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth and publishing                                                                                                                  |
| Size        | 1–1.5 engineer-weeks                                                                                                                              |
| Depends on  | [P0-01](P0-01-operator-ownership.md), [P0-02](P0-02-release-resolution.md)                                                                        |
| Unblocks    | [P2-04](P2-04-release-descriptor.md), [P2-05](P2-05-release-routes.md), [P2b-01](P2b-01-distribution-service.md), [P3-01](P3-01-wire-v4-plan.md)  |
| Role        | `pkey-implementer`                                                                                                                                |
| Plan mode   | no                                                                                                                                                |
| Gates       | D1 migrations (replay conventions of `0012`/`0018`); `TABLE_OWNERS` and the generated `reference/data-model.mdx` (`docs gen:check`); worker tests |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Goal

The release truth store can record what the research's model needs, for the app and for any
future pack: deliverables, per-deliverable `seq`, builds with platform, arch, format, build number
and minimum OS, artifacts with a role, a build, a SHA-256 and hash-pinned locations, an
operator-owned channel policy per deliverable, and yanks. Existing rows are backfilled so every
product keeps resolving exactly as before. A read/write module exposes the model to P2-04, P2-05
and, through the `releaseCatalog` hook, to P2b-01. No route or resolution behaviour changes here.

## Why

The truth store indexes every asset with a free-text kind and platform, but it has no build
numbers, no per-platform availability, no yank and no rollout, and its `sha256`, `storage_key` and
`metadata_json` columns are always NULL ([notes/A1 §1.1](../../notes/A1-release-update.md#11-tables),
[§3](../../notes/A1-release-update.md#3-hard-coded-assumptions-that-block-non-macos--godot)).
`release_channels.policy_json` is never read and is rewritten to NULL by every sync
([notes/A1 §6.1](../../notes/A1-release-update.md#61-where-things-slot-in)). The schema sketch in
[README §3.4](../../README.md#34-release-the-record-of-everything-that-exists) replaces this, and
every later release, distribution and wire v4 package names its tables.

## Read first

- `AGENTS.md` (the green gate; rule 5, products are data) and `CLAUDE.md`.
- [README §3.4](../../README.md#34-release-the-record-of-everything-that-exists) "Schema" and
  "Resolution rules", [§3.1](../../README.md#31-vocabulary) (build, artifact, promote/pin/yank,
  deliverable), [§3.9](../../README.md#39-rollouts-halts-and-telemetry) (what stays in release and
  what is distribution's).
- [notes/A1 §1, §6.3](../../notes/A1-release-update.md#63-new-tables-vs-new-columns) (new tables
  vs new columns; the `0007` non-idempotent tail; the `0018` index assertion).
- The landed [P0-01](P0-01-operator-ownership.md) (`access_source`, `compat_source`,
  `operator_policy_json`, the revert endpoint shape) and [P0-02](P0-02-release-resolution.md)
  (`stable_tag_pattern`, `ignore_tags_json`, the shared comparator, the non-unique
  `idx_release_metadata_version`, `release_channel_floors`). Use their names.
- Code: `packages/worker/migrations/0007_backend_contracts.sql:46-141` (truth-store tables),
  `0016_drop_dead_pii.sql` (the table-rebuild precedent), `0012_replay_guard.sql`,
  `0018_index_assertion.sql`; `packages/worker/src/services/release/store.ts:330-462`
  (`releaseStoreStatements`, `artifactRow`); `src/services/release/admin.ts:42-79`;
  `packages/docs/scripts/gen-reference.mjs:248-280` (`TABLE_OWNERS`); `test/helpers.ts:8-20`
  (tests apply every migration in order); `test/releaseStore.test.ts`.

## Scope

**In:**

- **New tables** (README §3.4, names verbatim):
  - `release_deliverables(product, deliverable_id, kind, pack_type, def_json, def_source)`, PK
    `(product, deliverable_id)`, `kind` CHECK `app|pack`;
  - `release_builds(product, release_id, build_id, platform, arch, format, build_number, variant_json, requires_json, min_os)`,
    PK `(product, release_id, build_id)`, FK to `release_metadata`;
  - `release_channel_policy(product, deliverable_id, channel, pointer_release_id, pinned, includes_json, min_supported, critical, source)`
    plus `modified_at`, `modified_by`; PK `(product, deliverable_id, channel)`;
  - `release_yanks(product, release_id, reason, at, by)`, PK `(product, release_id)`.
- **New columns** (one `ALTER TABLE … ADD COLUMN` per migration file, nothing after it):
  `release_metadata.deliverable_id`, `release_metadata.seq`, `release_metadata.channel`
  (see Design notes); `release_artifacts.build_id`, `release_artifacts.role`,
  `release_artifacts.locations_json`.
- **Indexes:** P0-02 made `idx_release_metadata_version` non-unique (two tags may strip to one
  version); widen it to `(product, deliverable_id, version)`, still non-unique. Add a unique
  `(product, deliverable_id, seq)` and lookup indexes for builds by `(product, platform, arch)` and
  artifacts by `(product, sha256)`.
- **Backfill** in the migrations: one `app` deliverable per product with a `release_config` row;
  `deliverable_id = 'app'` on every release; `seq` numbered per product in
  `(published_at, release_id)` order with a `ROW_NUMBER()` window; `role` from the legacy `kind`
  (`signature`, `checksum`, else `payload`).
- **Resync must not clobber the new columns.** `releaseStoreStatements` upserts only the
  GitHub-derived columns; `sha256`, `storage_key`, `metadata_json`, `build_id`, `role` (once set by
  a descriptor) and `locations_json` survive a resync. New releases found by sync get
  `seq = max + 1` for their deliverable.
- **Module** `packages/worker/src/services/release/model.ts` (name proposed): row types and
  functions `listDeliverables`, `upsertDeliverable`, `listBuilds`, `upsertBuild`,
  `listArtifactsForBuild`, `getChannelPolicy`, `setChannelPolicy` (source-guarded),
  `yankRelease`, `unyankRelease`, `isYanked`, `nextSeq`. Pure `DbStatement` builders for batching.
- **Vocabulary constants** exported from `@polaris-key/manifest` for P2-04's validator:
  `RELEASE_PLATFORMS` (`macos`, `ios`, `android`, `windows`, `linux`, `web`), `RELEASE_ARCHES`
  (`arm64`, `x86_64`, `universal`, `armv7`, `wasm32`, `any`), `ARTIFACT_ROLES` (`payload`,
  `files-index`, `chunk-index`, `chunk-bundle`, `delta`, `signature`, `checksum`),
  `DELIVERABLE_KINDS` (`app`, `pack`).
- `TABLE_OWNERS` entries under `release`; regenerate `reference/data-model.mdx`. Update
  `services/release/truth-store.md` and add the terms deliverable, build, artifact role, promote,
  pin and yank to `start/concepts.md` (README §3.1: "the first implementing PR").
- **Wave-1 sync:** **Fold P0-02's floors.** `release_channel_floors` rows move into `release_channel_policy.min_supported` and the two candidate-filter columns (`stable_tag_pattern`, `ignore_tags_json`) are inherited. Floor rows that cannot be cleared today become clearable: a floor on a manual channel later removed from the manifest returns 404 at the floor endpoint, and a `beta` floor recorded before a `channel_workflow` was configured returns 422.
  _Implementer's correction:_ this bullet contradicts the "Two different floors" design note
  below, which explains why folding the high-water mark into `min_supported` would block older
  installs once P3 enforces floors. The floors were **not** folded: `release_channel_floors` stays
  release's own table, `release_channel_policy.min_supported` is the device floor, and the
  candidate-filter columns stay on `release_config`. The clearable part is done: a stranded floor
  can be cleared (never lowered) at the floor endpoint.
- **Wave-1 sync:** **Bare-tag/`v`-tag ambiguity.** When both `v1.2.0` and `1.2.0` exist, `latest` picks the later-published one, but the appcast enclosure (`/release/dl/1.2.0/…`) looks up `tags/v1.2.0` first, so the DMG can come from a different release than the item's Sparkle signature. Resolve the enclosure by release id, not by re-deriving the tag, or refuse the ambiguity.
- **Wave-1 sync:** **Store status for big repos.** `releaseStoreStatements` treats a floor release it did not see as gone; for a repo above 1,000 releases the store row can say `blocked` while the live route still serves the floor via its tag lookup. Make the store row agree.
- **Wave-1 sync:** **ignoreTags length.** `release.schema.json` `ignoreTags` `maxLength: 255` counts code points while the validator's `value.length` counts UTF-16 units; align them when the schema is next touched (rule 9). _Done here without touching the schema:_ `isIgnoreTag`
  now counts code points.

**Out** (and where it belongs instead):

- Descriptor ingest, the artifact map, and builds for legacy releases (→ [P2-04](P2-04-release-descriptor.md)).
- Resolution over the new model, channel operations, admin and public routes (→ [P2-05](P2-05-release-routes.md)).
- `release_sets`, `release_holds`, pack floors per `contentApi`, pins (→ P4-02, P4-12).
- Rollout and halt, which are outlet-scoped (→ [P2b-04](P2b-04-rollouts-delivery.md)).
- `release_sources` for several repositories per product (README §3.4; no work package owns it
  yet, and nothing needs it before packs publish from a second repository).
- Changing the `access` CHECK on `release_metadata`/`release_artifacts` (delivery access moves to
  distribution in P2b-04, so do not rebuild these tables for it).

## Design notes

- **Identifiers.** The app deliverable is `app` (README §3.12 `deliverables.app`). Deliverable
  ids match `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, at most 64 characters (`diceroll.core3d`).
  `release_id` stays the GitHub tag for tag-sourced releases; a release with no tag uses
  `<deliverableId>@<version>` (P2-04 writes it). `build_id` is the artifact-map entry's `id`
  (`macos`, `apk`), unique within a release.
- **`seq`** is monotonic publication order per deliverable, not version order, so a backport can
  have a higher `seq` than a newer version. It is what the CI-signed record will carry (README
  §3.3) and what breaks ties in pack-set resolution.
- **`release_metadata.channel`** is an addition to the README sketch: the channel a release was
  published to (`pkey release publish --channel events`, README §6.1). NULL means "derive from
  GitHub", i.e. `stable` unless `prerelease`, plus manual-channel regexes, as today.
- **Channel policy semantics**, which P2-05 implements and P3 signs:
  - `includes_json` (`["stable"]` for beta) is manifest-declared (`deliverables.app.channels`);
  - `pointer_release_id` NULL means "follow the newest eligible release"; `promote` sets the
    pointer and makes that release a member of the channel; `pinned = 1` freezes the channel at
    the pointer; an unpinned channel resolves to the newest of its members and its pointer;
  - `min_supported` is the floor (a version in the deliverable's scheme) and `critical` flags the
    current pointer release;
  - `source` is `manifest` or `admin`, the `services_source` precedent: any operator or CI change
    sets `admin`, after which resync leaves the row alone; "revert to manifest" hands it back.
- **Yanks** never delete (`release_download_tokens` holds FKs, `store.ts:23-31`). A yanked release
  resolves only through an explicit pin, per README §3.4.
- **No CHECK on platform, arch, format or role.** The vocabularies will grow (P4 adds roles), and a
  CHECK change needs a table rebuild (`0016`). Validate in code against the exported constants.
- **Migrations** are numbered when rebasing onto the default branch. Idempotent statements
  (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, backfill `UPDATE`s guarded to be
  re-runnable) go in their own file ahead of the ALTER-only files. An index that encodes a
  correctness invariant (the `(product, deliverable_id, seq)` uniqueness) joins the required-index
  list in `0018`'s successor and `src/scheduled.ts`.
- `release_channels` stays as the derived "what GitHub says" view; stop treating `policy_json` as
  a seam and leave a comment pointing at `release_channel_policy`.
- **Two different floors.** P0-02's `release_channel_floors` is an anti-rollback **high-water
  mark** for live GitHub resolution (R6-10). `release_channel_policy.min_supported` is the
  **device floor** the signed feed will carry (`blocked(app-floor)`, README §3.6). P0-02's hand-off
  says to fold the first into the second; do not: every channel's floor would jump to its newest
  version and, once P3 enforces floors, block every older install. Keep `release_channel_floors`
  as release's own table (or a separate `high_water_version` column) and record the decision in
  the PR. The yank table replaces nothing of it: a deleted GitHub release is not a yank.

## Steps

1. Read the landed P0-01 and P0-02 changes; list their column and index names in the PR body.
2. Write the migrations and a test that applies them to a database seeded with today's shapes
   (tags `v1.0.0`, `v1.1.0`, a prerelease, `.sig` and `.sha256` sidecars) and asserts the backfill.
3. Make `releaseStoreStatements` preserve the new columns; extend `test/releaseStore.test.ts`.
4. Write `model.ts` and its tests; export the vocabulary constants from `@polaris-key/manifest`.
5. `TABLE_OWNERS`, `pnpm --filter @polaris-key/docs gen`; docs pages and glossary terms.

## Acceptance criteria

- [ ] Every migration applies on a fresh database and on one seeded with pre-migration rows; the
      tests assert `deliverable_id = 'app'`, a gap-free `seq` in publish order, and roles
      `payload`/`signature`/`checksum` from the old kinds.
- [ ] A resync after a descriptor-style write keeps `sha256`, `build_id`, `role`,
      `locations_json` and `storage_key` (test in `releaseStore.test.ts`).
- [ ] `setChannelPolicy` from an operator sets `source = 'admin'`, and a subsequent resync does not
      change that row; revert returns it to `manifest`.
- [ ] Two releases of one deliverable cannot share a `seq`; two deliverables can; two tags that
      strip to one version still sync (P0-02's regression test stays green).
- [ ] Existing release, update and portal suites pass unchanged (no behaviour change).
- [ ] `docs gen:check` is clean and `reference/data-model.mdx` lists the new tables under Release.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- releaseStore backendContracts scheduled release
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- P2-04 writes deliverables, builds and artifacts through `model.ts`; P2-05 reads them and owns
  resolution and the policy operations; P2b-01 exposes them through the `releaseCatalog` hook;
  P3-01 takes `seq`, `deliverable_id`, `build_id`, the role vocabulary and the policy semantics as
  the names the release record and feed use; P4-02 adds pack rows to the same tables.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-03 done`.
