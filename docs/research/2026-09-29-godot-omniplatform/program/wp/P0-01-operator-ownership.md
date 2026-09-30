# P0-01 Make operator-owned release settings survive a manifest resync

| Field       | Value                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene and unblockers                                                                   |
| Size        | 0.5–0.75 engineer-weeks                                                                      |
| Depends on  | none                                                                                         |
| Unblocks    | [P2-03](P2-03-release-data-model.md)                                                         |
| Role        | `pkey-implementer`                                                                           |
| Plan mode   | no                                                                                           |
| Gates       | D1 migrations; rule 9 (`artifactPolicy.architectures` schema parity); generated `data-model` |
| Human input | none                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                    |

## Goal

An operator who sets a product's access modes (including `entitled`), its compatibility window,
or the operator-only artifact policy (`requireSparkleSignature`, `minimumSystemVersion`) keeps
those values across every later `.pkey/` push, until they explicitly hand ownership back to the
manifest. A test proves "operator sets `entitled`, then resync" leaves `entitled` in place.

## Why

`resyncRepo` rewrites the compat window on every push (`packages/worker/src/services/release/resync.ts:180-191`)
and rewrites `artifact_policy_json`, `metadata_access` and `artifacts_access` in one `UPDATE`
(`resync.ts:277-292`). `entitled` cannot be written by a manifest (`RELEASE_ACCESS_VALUES`,
`packages/shared-manifest/src/index.ts:388`), so any push silently downgrades an `entitled`
product to the manifest's mode, which defaults to `public`. That is a policy downgrade by repo
write, the same class as R6-03 (report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot)
issue #1, [notes/A3 §2.3](../../notes/A3-admin-dx.md#23-operator-ownership-traps-they-affect-the-admin-experience-directly)).
The same write drops the operator fields that `config.ts:89-96` and `feed.ts:118-125` call
"operator-owned". The report's operator-ownership model ([§6.2](../../README.md#62-administrator-operator))
must hold before any more operator controls (channel policy, rollouts, halts) are added.

## Read first

- `AGENTS.md` and the `authoring-pkey-manifests` skill (step 8, "resync and ownership").
- [notes/A1 §5](../../notes/A1-release-update.md#5-github-sync) (resync's sharp edges) and
  [notes/A3 §2.3](../../notes/A3-admin-dx.md#23-operator-ownership-traps-they-affect-the-admin-experience-directly).
- The existing ownership pattern: `setServices` / `revertServicesToManifest`
  (`packages/worker/src/repo.ts:1333-1377`), `core/servicesAdmin.ts`, migrations `0011` and `0020`.
- `packages/worker/src/services/update/admin.ts` (the `update/settings` endpoint),
  `services/release/config.ts` (`artifactPolicy`, `setReleaseAccess`), `core/products.ts:176-193`
  (`setCompatWindow`), `services/update/feed.ts:118-139`, `services/release/health.ts:65-95`.
- `packages/admin/src/views/UpdateSettings.tsx` and `packages/worker/test/serviceAdmin.test.ts:139-160`.

## Scope

**In:**

- Two ownership markers, same semantics as `services_source` (`NULL` or `manifest` = resync may
  write; `admin` = resync skips): `products.compat_source` and `release_config.access_source`
  (one marker for both access modes, because the console saves them together).
- A separate column for the operator-only artifact policy, `release_config.operator_policy_json`
  (`requireSparkleSignature`, `minimumSystemVersion`), which no manifest path ever writes.
  `artifact_policy_json` stays manifest-owned and keeps only the manifest fields
  (`channels`, `architectures`, `requireDmg`, `requireCli`, `allowAmbiguousAssets`).
- Resync and link honour the markers; `setReleaseAccess` and `setCompatWindow` claim ownership.
- `update/settings`: GET reports `accessSource` and `compatSource`; PATCH accepts
  `minimumSystemVersion` (string matching `^\d+(?:\.\d+){0,2}$`, or `null`) and
  `requireSparkleSignature` (boolean); a new `POST …/update/settings/revert` with
  `{ "fields": ["access" | "compat"] }` hands ownership back, changing nothing else.
- Console: source badges, "Revert to manifest", and the two operator policy fields on the Update
  settings view. Turning `requireSparkleSignature` off needs a confirm dialog and is audited.
- Rule 9: align `release.schema.json` `artifactPolicy.architectures` item pattern (`{0,31}`) with
  the validator's `CHANNEL_RE` (`{0,63}`, `index.ts:341`, used at `index.ts:975-983`). The
  validator is authoritative. This was listed as docs drift (issue #20); it lives here because
  this package owns `artifactPolicy`.

**Out** (and where it belongs instead):

- Channel pointers, pins, floors, rollouts and yanks as operator-owned policy (→ P2-03).
- The R6-10 high-water mark per channel (→ [P0-02](P0-02-release-resolution.md)).
- Moving other resync-written product fields (`name`, `default_*`, `admin_group`) under ownership
  markers: not requested by the research; leave them manifest-owned.
- Docs drift outside the pages this package touches (→ [P0-11](P0-11-docs-drift.md)).

## Design notes

- **Guard in the `WHERE` clause, not read-then-write.** Follow `setServices`: split resync's
  `products` UPDATE so `compat_min`/`compat_max` are written by a separate statement ending in
  `AND COALESCE(compat_source, 'manifest') = 'manifest'`; do the same for the access columns on
  `release_config`. The un-guarded fields stay in the original statements.
- **Operator policy migration.** Existing rows may hold hand-set operator keys inside
  `artifact_policy_json`. Backfill with an idempotent statement in its own file:
  `UPDATE release_config SET operator_policy_json = json_remove(artifact_policy_json, '$.channels', '$.architectures', '$.requireDmg', '$.requireCli', '$.allowAmbiguousAssets') WHERE operator_policy_json IS NULL AND (json_extract(artifact_policy_json, '$.requireSparkleSignature') IS NOT NULL OR json_extract(artifact_policy_json, '$.minimumSystemVersion') IS NOT NULL)`.
  `json_remove` keeps JSON booleans as booleans; `json_extract` would turn `false` into `0`.
- **Migration file rules.** One `ALTER TABLE … ADD COLUMN` per file with nothing after it
  (see `0013`, `0020`); the backfill goes in its own file after the `ALTER`s. Number the files
  when rebasing (the next free number is `0022` today); P0-02 also adds migrations.
- **Readers.** `artifactPolicy(cfg)` (`config.ts:97-122`) reads `requireSparkleSignature` from
  `operator_policy_json`; `minimumSystemVersion` in `feed.ts` does the same; `health.ts`'s local
  `artifactPolicy` reads `requireDmg`/`requireCli` from `artifact_policy_json` and
  `requireSparkleSignature` from `operator_policy_json`. Keep the fail-safe defaults: unreadable
  JSON means "signature required, no minimum".
- **`requireSparkleSignature` stays out of the manifest** (R6-03; `ManifestReleaseArtifactPolicy`,
  `index.ts:161-171`). Do not add it or `entitled` to any manifest shape.
- **Names used downstream:** `compat_source`, `access_source`, `operator_policy_json`,
  `POST /manage/api/products/<slug>/update/settings/revert`. P2-03's `release_channel_policy`
  follows the same `source` convention.
- The admin API is narrative-only in `routeCoverage.test.ts:28-44`, so rule 10 does not apply;
  document the endpoint in `packages/docs/src/content/docs/admin/` or the Update settings page.

## Steps

1. Write the migrations (three `ALTER`s, one backfill) and regenerate the data-model page
   (`pnpm --filter @polaris-key/docs gen`).
2. Add `compat_source`, `access_source` and `operator_policy_json` to the row types
   (`repo.ts` `ProductRow`, `release/config.ts` `ReleaseConfigRow`) and to link's inserts.
3. Make `setReleaseAccess` and `setCompatWindow` set their marker to `admin`; add a revert writer
   for each, and the operator-policy writer.
4. Split resync's two statements as described; add tests.
5. Extend `update/settings` (GET, PATCH, `revert`) with audit events
   `update.settings.revert` and `release.policy.update`.
6. Update the console view and its tests.
7. Fix the `architectures` schema pattern; add a valid fixture with a 40-character architecture
   to `schema-parity.test.ts` so the drift cannot return.
8. Update docs: the `authoring-pkey-manifests` skill step 8 (now five operator-claimable blocks),
   `services/update/eligibility.md` or the settings page, and the code comments in
   `config.ts:89-96` and `feed.ts:118-125` so "operator-owned" is true.

## Acceptance criteria

- [ ] Worker test: PATCH `artifactsAccess: "entitled"`, then `resyncRepo` with a manifest saying
      `access.artifacts: public` → `release_config.artifacts_access` is still `entitled`.
- [ ] Worker test: PATCH `compatMin: "2.0.0"`, then resync with `compatMin: 1.0.0` → the stored
      window is still `2.0.0`; after `revert` and another resync it is `1.0.0`.
- [ ] Worker test: operator `minimumSystemVersion: "13.0"` survives a resync and appears as
      `sparkle:minimumSystemVersion` in the appcast; `requireSparkleSignature: false` survives too.
- [ ] Worker test: a product never touched by an operator still follows every manifest change.
- [ ] Migration test (or `scheduled`/`repo` test) shows the backfill copies hand-set keys and is
      a no-op on replay.
- [ ] `schema-parity.test.ts` has a fixture with a 32–63 character architecture that both the
      validator and `release.schema.json` accept.
- [ ] `reference/data-model.mdx` is regenerated and `pnpm --filter @polaris-key/docs gen:check` passes.
- [ ] The green gate passes (`AGENTS.md`), including the admin build.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- serviceAdmin releaseStore linkRepo updateFeed release
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

P2-03 relies on the `*_source` convention and on `operator_policy_json` being the only home of
operator artifact policy; its channel policy table uses the same `source` column semantics and
the same revert endpoint shape. P2b-04 (rollouts, halts) and P5 connectors inherit the rule that
an operator value is never written by resync. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-01 done`.
