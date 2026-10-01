# P0-02 Fix release resolution: tag filter, version ordering, pagination, upsert conflict, R6-10

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene and unblockers                                                                                 |
| Size        | 1–1.25 engineer-weeks                                                                                      |
| Depends on  | none                                                                                                       |
| Unblocks    | [P0-03](P0-03-release-webhook.md), [P2-03](P2-03-release-data-model.md), [D-02](D-02-diceroll-after-p1.md) |
| Role        | `pkey-implementer`                                                                                         |
| Plan mode   | no                                                                                                         |
| Gates       | D1 migrations; generated `data-model`; rule 9 for the two new `.pkey/release` fields (below)               |
| Human input | none                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                  |

## Goal

`stable`/`latest` (and every moving channel) resolve to the highest-precedence release among the
tags that are real app releases, across more than 100 releases. Non-release tags such as
`channels` or `packs` can never become `latest`. Two tags that strip to the same version no
longer fail a resync. Deleting the newest release no longer silently promotes an older one: the
R6-10 proof-of-concept test is flipped to a regression test.

## Why

Report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issues #4, #8 and
#9, and the resolution rules in [§3.4](../../README.md#34-release-the-record-of-everything-that-exists):

- `newest()` walks the GitHub list in API order (`packages/worker/src/services/release/channels.ts:112-122`),
  so "newest" is creation order, and any non-draft, non-prerelease tag qualifies as `stable`
  (`channels.ts:136-138`). Diceroll's rolling `channels` and `packs` releases become `latest`.
- Only one page of 100 releases is read (`github.ts:137-151`, called with `100` at
  `gateway.ts:346-352` and `sync.ts:82-88`); a busy repo pushes the last stable release off page 1.
- `idx_release_metadata_version` is `UNIQUE (product, version)` (`migrations/0007_backend_contracts.sql:64-65`)
  but the upsert's conflict target is `(product, release_id)` (`store.ts:212`). `v1.2.0` and
  `1.2.0`, or a tag deleted and re-created with a different prefix, raise `UNIQUE constraint failed`
  and roll back the whole resync batch (`resync.ts:402-426`) after its un-batched writes landed.
- R6-10 (`test/attack/R6-release.test.ts:1332-1385`, finding `docs/security/findings/R6-release.md:474-500`):
  nothing records a floor, so deleting v2.0.0 makes v1.0.0 `latest` with a public cache header.

## Read first

- `AGENTS.md`; the `authoring-pkey-manifests` skill (step 3, release fields).
- [notes/A1 §1.3](../../notes/A1-release-update.md#13-channel-model) and
  [§5](../../notes/A1-release-update.md#5-github-sync).
- `packages/worker/src/services/release/{channels,github,gateway,sync,store,health,surfaces}.ts`.
- `packages/worker/src/core/entitlements.ts:31-73` (`parseSemver`, `compareSemver`).
- `packages/shared-manifest/src/index.ts` (release validator around 875-1062, `compileManualChannelRegex`),
  `schemas/v1/release.schema.json`, `test/schema-parity.test.ts` (release entries).
- Tests: `test/release.test.ts` (channels L165-233), `test/releaseStore.test.ts`,
  `test/attack/R6-release.test.ts` (R6-10).

## Scope

**In:**

- **Candidate filter.** Two new `.pkey/release` fields, names fixed by the report:
  `stableTagPattern` (an anchored regex, compiled with the same safety rule as manual channels,
  `compileManualChannelRegex`, max 80 characters) and `ignoreTags` (a list of exact tag names).
  Default `stableTagPattern`, when undeclared:
  `^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`.
  (Correction, from the code: written out with `^…$` this is 81 characters, one over the cap.
  `compileManualChannelRegex` anchors every source as `^(?:…)$` itself, so the constant
  `DEFAULT_STABLE_TAG_PATTERN` is stored unanchored and matches the same tags.)
  Only matching, non-ignored, non-draft releases are candidates for `stable`/`latest` and for
  the `beta` prerelease fallback. Manual channels keep their own regex but skip `ignoreTags`.
  Persist as `release_config.stable_tag_pattern` and `release_config.ignore_tags_json`
  (manifest-owned; written by link and resync).
- **Version ordering.** Among candidates, "newest" is the highest semver precedence of
  `versionFromTag(tag)`; ties (`v1.2.0` and `1.2.0`) go to the later `published_at`. One shared
  function used by the live routes, the truth-store channel rows and `checkReleaseHealth`.
- **Pagination.** `listReleases` follows `Link: rel="next"` up to a page cap. The truth-store
  sync reads up to 10 pages (1,000 releases). Live resolution reads pages until it has seen a
  candidate, capped at 3 pages, and picks the highest candidate among the pages it read.
- **Pinned lookups** try `tags/v<version>` and, on 404, `tags/<version>` (`github.ts:123-127`),
  so unprefixed tags can be pinned and the stable appcast's pinned enclosure resolves.
- **Upsert conflict.** A migration replaces the unique index with a non-unique one
  (`DROP INDEX IF EXISTS idx_release_metadata_version;` then
  `CREATE INDEX IF NOT EXISTS idx_release_metadata_version ON release_metadata(product, version);`).
  Nothing in `src/` looks a release up by version, so uniqueness buys nothing.
- **R6-10 floor.** A new table `release_channel_floors(product, channel, version, release_id, raised_at, lowered_by, lowered_at)`
  holds the highest version each moving channel has resolved to during a truth-store sync. When
  live resolution of a moving selector picks a candidate below the floor, it looks the floor's
  release up by tag (one call): if it still exists (a higher release sat on an unread page), serve
  it; if it is gone, refuse with 404 `no release for selector`. `checkReleaseHealth` reports a `channel-regressed` check (`error`) naming the floor and
  what the list now offers. An operator lowers or clears a floor with
  `POST /manage/api/products/<slug>/release/channels/<channel>/floor` (`{ "version": "1.0.0" }` or
  `{ "clear": true }`), audited as `release.channel.floor`.

**Out** (and where it belongs instead):

- `release` webhook events that refresh the store between pushes (→ [P0-03](P0-03-release-webhook.md)).
- Version schemes other than semver (`semver+build`, `4part`), deliverables, `seq`, yanks, pins
  and operator channel policy (→ P2-03). _Superseded by P2-03:_ the floor table stays release's
  own anti-rollback high-water mark and is **not** folded into
  `release_channel_policy.min_supported` (the device floor); see P2-03's "Two different floors"
  note.
- Per-platform resolution and caching resolution to cut GitHub quota (→ P2-05).
- Accepting a `v1.2.3` _selector_ is not planned; correcting the OpenAPI text that promises it
  belongs to [P0-11](P0-11-docs-drift.md).
- Hiding non-candidate releases from the portal list (→ P2-03, P2b-06).

## Design notes

- `channels.ts` stays pure: pass the candidate predicate and comparator in; the gateway and sync
  build them from `release_config`. Keep `resolveChannel`'s signature usable by P2-05.
- `compareSemver` treats unparseable input as equal (`entitlements.ts:48`). Filter first, then
  compare, so the comparator only ever sees parseable versions; add a local strict comparator if
  sharing `core/entitlements.ts` is awkward.
- The floor is raised only by the sync (no hot-path writes). Live resolution does one extra D1
  read for moving selectors, and one extra GitHub call only in the below-floor case. Pinned
  selectors are never floored. `pr-N` channels are not floored.
- A floor stuck too high (a typo'd `v10.0.0` deleted later) is the operator's call: health says so,
  the admin endpoint fixes it. The console button can wait for P2-07; the endpoint and health
  check are required here.
- Rule 9: `stableTagPattern` and `ignoreTags` need validator rules (proposed codes
  `invalid_stable_tag_pattern`, `invalid_ignore_tags`), mutation-table entries (the regex safety
  rule is validator-only: `schema: "accepts"`), `release.schema.json` properties, and a regenerated
  `reference/validation-codes.mdx`. The graph lists only `migration` for this package; the
  rule 9 work is part of the tag filter the report asks for.
- New table ⇒ a `TABLE_OWNERS` entry (release) in `packages/docs/scripts/gen-reference.mjs:248`
  and a regenerated `reference/data-model.mdx`. Number migrations on rebase (P0-01 adds some too).
  (Correction: the lead pre-assigned 0023 to this package, so the three files are
  `0023_release_resolution.sql` plus one `0023_release_resolution_*.sql` per bare ALTER.)
- Quota: pagination adds API calls only where the first page has no candidate. Record the
  per-request call counts in the PR (issue #3 is P2-05's to solve).

## Steps

1. Add the manifest fields (validator, mutation entries, schema, normaliser, skill text).
2. Migrations: two `ALTER`s on `release_config` (one per file), the index swap, the floor table.
3. Implement candidate filtering, ordering and pagination; route every caller through them.
4. Pinned lookup fallback to the unprefixed tag.
5. Floors: raise in `releaseStoreStatements`, enforce in `resolveSelector` and in the truth-store
   channel rows, health check, admin endpoint.
6. Flip `R6-10` to a "FIXED" regression test; update `docs/security/findings/R6-release.md` and
   the R6-10 row in `docs/security/2026-08-26-security-audit.md:372`.
7. Regenerate docs pages; update `services/release/*` pages on channels and resolution.

## Acceptance criteria

- [ ] Test: releases `[channels (not prerelease, newest by API order), v1.4.0, v1.10.0]` →
      `latest` is `v1.10.0`; with `ignoreTags: [v1.10.0]` it is `v1.4.0`.
- [ ] Test: 150 releases across two pages with the only stable one on page 2 → `latest` resolves;
      the sync ingests all 150.
- [ ] Test: after a sync has floored `stable` at v2.0.0, a page 1 holding 100 newer prereleases
      and a v1.9.9 backport still serves v2.0.0 (through the floor lookup), not v1.9.9.
- [ ] Test: a repo tagging `1.2.3` (no `v`) serves `/release/dl/1.2.3/…` and a working appcast enclosure.
- [ ] Test: releases `v1.2.0` and `1.2.0` in one sync, and a stored `1.2.0` row followed by a new
      `v1.2.0` tag, both resync without error.
- [ ] `R6-10` test asserts the fix: once a sync has seen v2.0.0 and v2.0.0 then disappears,
      `latest` on `/version` is 404 and health reports `channel-regressed`; after the admin floor
      endpoint lowers the floor, v1.0.0 serves. (The test gains a sync step; the PoC had none.)
- [ ] `schema-parity.test.ts` covers both new codes; `validation-codes.mdx` and `data-model.mdx`
      are regenerated; `gen:check` passes.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release releaseStore updateFeed R6-release linkRepo
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

P0-03 relies on a sync that is safe to run on every `release` event (full pagination, no unique
conflict, floors raised). P2-03 inherits `stable_tag_pattern`, `ignore_tags_json` and the
`release_channel_floors` rows (kept as their own table, not migrated into `release_channel_policy`, per
P2-03's "Two different floors" decision), and the single
resolution function. P2-05 builds per-platform resolution and caching on the same function.
When done: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-02 done`.
