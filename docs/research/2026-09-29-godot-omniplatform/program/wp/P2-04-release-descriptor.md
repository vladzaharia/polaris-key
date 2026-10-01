# P2-04 Release descriptor ingest and the declared artifact map in `.pkey/release`

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth and publishing                                                                                                                                  |
| Size        | 1–1.5 engineer-weeks                                                                                                                                              |
| Depends on  | [P2-03](P2-03-release-data-model.md)                                                                                                                              |
| Unblocks    | [P2-02](P2-02-trusted-publisher.md), [P2-06](P2-06-publish-cli-action.md), [P2b-02](P2b-02-distribution-manifest.md)                                              |
| Role        | `pkey-implementer`                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                |
| Gates       | rule 9 (validator rules, mutation table, `release.schema.json`, a new `release-descriptor.schema.json`); generated `reference/validation-codes.mdx`; worker tests |
| Human input | none                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                         |

## Goal

A product declares its app deliverable and an **artifact map** in `.pkey/release`, and every file
of a release is classified by that map instead of by its filename. A **release descriptor**
(the unsigned body of the future release record: builds, artifacts, sizes, SHA-256s, build
numbers, locations) can be ingested once per release, either attached to a GitHub release as
`pkey-release.json` or handed over by P2-02's `submit` route, and it writes P2-03's tables
idempotently. A descriptor that disagrees with the map, the blob store or GitHub is refused with a
reason, and `dryRun` shows what would be written.

## Why

Classification today is filename sniffing: `.ipa`, `.apk`, `.exe`, `.msix`, `.AppImage`, `.pck`
and `universal` all fall through to `other`/`null`, and one release can hold only one artifact per
(arch, extension) ([notes/A1 §1.2 and §3](../../notes/A1-release-update.md#12-artifact-classification-truth-store-only)).
The research decides "declared, not sniffed": an `artifacts` map assigns every file
`{deliverable, id, platform, arch, format, role, match}`, CI uploads a descriptor ingested once per
release, and sniffing survives only as a fallback for legacy app releases
([README §3.4](../../README.md#34-release-the-record-of-everything-that-exists) "Deliverables",
[§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative)). Ingest requires a
GitHub **immutable release** where GitHub is the source and cross-checks every digest (§3.4
"Publishing", [notes/E5 §2.3](../../notes/E5-frontier-tech.md#23-should-a-release-server-verify-attestations-at-ingest-i)).

## Read first

- `AGENTS.md` (rules 5 and 9), `CLAUDE.md`, and the `authoring-pkey-manifests` skill.
- [README §3.4](../../README.md#34-release-the-record-of-everything-that-exists),
  [§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative),
  [§3.3](../../README.md#33-trust-model-two-signers-two-documents) (the release-record fields the
  descriptor must line up with).
- [notes/A1 §1.5, §5, §6.4](../../notes/A1-release-update.md#5-github-sync);
  [notes/E7 §0](../../notes/E7-server-ci-tools.md) items 10, 13 and 14.
- [P2-03](P2-03-release-data-model.md) hand-off (`model.ts`, the vocabulary constants,
  identifiers, `seq`), and the landed [P0-02](P0-02-release-resolution.md) (`stableTagPattern`,
  `ignoreTags` and the shared comparator).
- Code: `packages/shared-manifest/src/index.ts` (release validation `:1094-1330` on main at
  `caeb3ed`, `normalizeRelease` `:1886`, `releaseRoot` `:2377`), `schemas/v1/release.schema.json`,
  `test/schema-parity.test.ts` (the `Docs` type `:44-48`, the sweep `:740-760`);
  `packages/worker/src/services/release/store.ts` (`artifactKind`/`artifactPlatform`, the
  sniffers), `sync.ts`,
  `github.ts:30-47` (`Release`/`ReleaseAsset` lack `immutable` and `digest`) and
  `github.ts:343,395` (`fetchTextAsset`, 4 KiB default cap).

## Scope

**In:**

- **Manifest (rule 9).** `.pkey/release` gains `deliverables.app` with `kind: app`,
  `versioning {scheme, stableTagPattern, ignoreTags, buildNumber}`,
  `channels {<name>: {includes: [...]}}` and `artifacts[] {id, platform, arch, format, role, match}`.
  Proposed codes: `invalid_deliverable_id`, `invalid_deliverable_kind`, `invalid_version_scheme`,
  `invalid_tag_pattern`, `invalid_channel_includes` (unknown channel or cycle, validator-only),
  `invalid_artifact_entry`, `duplicate_artifact_id`, `invalid_artifact_platform`,
  `invalid_artifact_arch`, `invalid_artifact_role`, `invalid_artifact_match`. A `kind: pack`
  entry raises the warning `pack_deliverables_not_supported` and is ignored until P4-02. Each code
  has a mutation-table entry and a schema rule or an explicit `schema: "accepts"`.
- **Compatibility.** A release document without `deliverables` means an implicit `app`
  deliverable with legacy sniffing, so `products/djdl` stays valid. P0-02 adds top-level
  `stableTagPattern` and `ignoreTags` (persisted as `release_config.stable_tag_pattern` and
  `ignore_tags_json`); accept them as the legacy spelling of `deliverables.app.versioning` (the
  flattened-root precedent), keep writing the same columns for the `app` deliverable, and refuse
  both spellings at once with `conflicting_versioning`.
- **Descriptor contract** in `packages/shared-manifest/src/descriptor.ts`:
  `ReleaseDescriptor` (v1) and `validateReleaseDescriptor(descriptor, parsedManifest)`, with
  `schemas/v1/release-descriptor.schema.json`. Extend the parity sweep to this file.
- **Worker ingest** in `packages/worker/src/services/release/descriptor.ts`:
  `ingestReleaseDescriptor(db, env, product, descriptor, {source, now, dryRun, promoted})` writing
  `release_metadata`, `release_builds`, `release_artifacts` and `release_deliverables` through
  `model.ts`, and a P2-01 `blob_refs` row (`ref_kind` `artifact`) for every `r2` location, in one
  batch.
- **GitHub path.** During truth-store sync, a release carrying a `pkey-release.json` asset
  (at most 64 KiB) is ingested with `source: "github"`. Add `immutable` to `Release` and `digest`
  to `ReleaseAsset`. Refuse a mutable release and any asset whose `digest` differs from the
  descriptor; record the refusal in `release_health` (`degraded`, with the reason).
- **Map classification** for GitHub releases with no descriptor: assets matching an `artifacts`
  entry become that build's payload; `<payload>.sig` and `<payload>.sha256` become its `signature`
  and `checksum`; `sha256` comes from GitHub's `digest` when present. Sniffing runs only when the
  product declares no map.
- Resync writes `release_deliverables` rows (`def_source = 'manifest'`).
- Docs: `build/manifest/authoring.md`, `services/release/artifacts.md` (the asset model beyond
  `-arm64`/`.dmg`), the skill's step 3, regenerated `reference/validation-codes.mdx`.

**Out** (and where it belongs instead):

- The authenticated `submit` route, tickets and blob promotion (→ [P2-02](P2-02-trusted-publisher.md)).
- Resolution over builds, and routes serving them (→ [P2-05](P2-05-release-routes.md)).
- Producing descriptors in CI (→ [P2-06](P2-06-publish-cli-action.md)).
- `releaseKeys`, signing and CI-signed records (→ P3-03, per [P3-01](P3-01-wire-v4-plan.md) item
  16); `publishing.trustedPublisher` (→ P2-02); pack deliverables, `content`, `patch`
  (→ [P4-02](P4-02-pack-deliverables.md), P4-03).
- `pkey init` scaffolding of the new block (→ P0-07 fixes `init`; add it there or in a follow-up).

## Design notes

- **Descriptor fields** (names line up with README §3.3 so P3-01 can make it the signed payload
  by moving it, not reshaping it): `descriptorVersion: 1`, `product`, `deliverable`, `kind`,
  `version`, optional `seq`, optional `tag`, optional `channel`, `title`, `notes`, `publishedAt`,
  `provenance {commit, workflowRun}`, and `builds[] {id, platform, arch, format, buildNumber, minOS, requires, artifacts[]}`
  with `artifacts[] {name, role, sha256, size, contentType?, locations[]}` and
  `locations[] {provider: r2|github|store|external, key? | asset? | url?}`.
- **Why not `@polaris-key/protocol`.** The descriptor is a CI → Worker body, not a device-facing
  document, and any `shared-protocol` edit is plan mode (`CLAUDE.md`). The CLI already depends on
  `@polaris-key/manifest`, and validation needs the parsed manifest's artifact map. P3-01 decides
  whether the signed record moves into `shared-protocol`.
- **Cross-checks.** Every build `id` is declared for that deliverable; `platform`, `arch` and
  `format` equal the declaration; each payload `name` matches the entry's `match`; roles come from
  `ARTIFACT_ROLES`; names are unique within a release; an `r2` location's key is exactly the
  content address of that artifact's `sha256` (P2-01 layout); a `github` location names an asset
  of the tagged release with the same `digest`; a `store` location carries no bytes (a store-only
  build still records its version and build number, README §3.2); an `external` URL is `https://`.
- **`match`** is a glob: `*` matches any run of characters, `?` one character, anchored,
  case-sensitive, at most 128 characters; compile it with every other character escaped.
- **`role: portable`.** README §3.12 gives `win-zip` the role `portable`, which is not in §3.4's
  role list. Treat installer versus portable as the `format` (`zip` versus `exe`/`msi`); keep
  `role` to `ARTIFACT_ROLES`. Record this in the PR.
- **Idempotence.** The same descriptor twice is a no-op. A different descriptor for an existing
  `(deliverable, version)` is refused (`reason: release_exists`), except that a descriptor may
  enrich a row the GitHub sync created for the same tag when its file names match.
- **`seq`.** If absent, the Worker assigns `max + 1` for a new release and keeps the stored value
  for an existing one. If present, it must exceed the current maximum for a new release and equal
  the stored value for an existing one. Note for P3-01: a GitHub webhook sync (P0-03) can create
  the row before CI submits, so a CI-assigned `seq` needs this rule.
- **Release ids.** The tag when `tag` is present; otherwise `<deliverable>@<version>` (P2-03).
- **Bounded GitHub cost.** Fetch `pkey-release.json` only for releases whose row has no ingested
  descriptor (store its SHA-256 in `metadata_json`), and at most a fixed number per sync.
- **Errors** reuse `ErrorCode` with a `reason`; no new `PolarisErrorCode` (plan mode).
- **Products are data.** No product-, platform- or format-specific branch outside the vocabulary
  constants and the manifest.

- **Implementation corrections (P2-04).**
  - The nested spelling `deliverables.app.versioning.{stableTagPattern, ignoreTags}` reports
    the existing `invalid_stable_tag_pattern` / `invalid_ignore_tags`, not a new
    `invalid_tag_pattern`: one rule and one code for both spellings.
  - `@polaris-key/manifest` exports `CANONICAL_CHANNEL_PATTERN` and `CHANNEL_ALIAS_NAMES`,
    derived from P0-04's `CHANNEL_NAME_PATTERN` and `CHANNEL_ALIASES` in
    `@polaris-key/protocol`; a non-canonical or alias channel key in `deliverables.app.channels`
    is the existing `invalid_channel` (an error, since these names are stored as written).
  - `match` is matched by a linear wildcard matcher (`matchesArtifactGlob`), not a compiled
    RegExp: `*`-heavy globs compile to polynomially backtracking patterns, and both sides are
    repo-controlled.
  - The `release_exists` and `seq` rules need the GitHub path to put a described release's row
    in that release's own publication-order slot among the store's upserts (so `seq` stays
    publication order) and its builds and files LAST; `ingestGithubDescriptors` returns the
    rows by release id (`rows`, emitted by `releaseStoreStatements`) plus a `tail`. It plans
    descriptors in publication order and checks an explicit `seq` on a new release against the
    value the batch will have reached at that slot (stored maximum plus one per new release
    published before it), refusing `seq_not_increasing` otherwise, so an explicit seq can never
    collide with a computed one in the same batch.
  - Channel `includes` entries must be canonical names too (`invalid_channel_includes`, and the
    schema's `includes` items carry the canonical pattern): they are stored as written in
    `release_channel_policy.includes_json`, so a manual channel P0-04 tolerates with a warning
    (`Nightly.2`) or an alias (`staging`) cannot be included.
  - Enrichment checks only that every file the descriptor places on GitHub is one the row holds.
    A held file the descriptor does not name leaves whatever build the map gave it (`build_id`
    NULL, `role` back to `roleOfKind(kind)`) in the same batch that deletes the builds the
    descriptor does not list, so no file points at a deleted build. In the other order (CI
    submits first, the GitHub sync runs after), a described release is not classified by the map
    at all: a GitHub file the descriptor does not name is inserted with `build_id` NULL and its
    kind's role, the same state the ingest leaves it in.
  - "Bounded GitHub cost": a refused `pkey-release.json` is remembered in its marker with the
    asset id and `basis`, the SHA-256 of the persisted app declaration and the manual channels it
    was judged against. It is fetched again when either changes. Refusals that hang on other rows
    (`release_exists`, `r2_object_missing`, `r2_ref_not_owned`) are fetched again on every sync,
    within the per-sync cap.
  - Both writers plan from a read and apply a batch later, so every statement re-checks at write
    time what another writer can change in between (`services/release/guard.ts`). The sync's
    `sniffed`/`mapped` artifact upserts and the map's build upserts do nothing to a release that
    has an ingested descriptor by then. The ingest's head writes a new release only while no other
    release of its version exists and an explicit `seq` is still above the maximum. It updates an
    existing row only while it has no ingested descriptor, or has this one, and while the row's
    stored `seq` (if any) is the one the plan checked: a row the sync created and numbered after
    the plan read the store is not overwritten by a descriptor whose explicit `seq` differs.
    Every tail statement runs only while the release carries this descriptor's marker. Racing
    writers (two submissions, or a submission and a sync) therefore resolve as
    first-commit-wins. The CI path reads the marker back and reports a loss as the refusal that a
    fresh plan gives (`release_exists`, `seq_not_increasing` or `seq_mismatch`).

## Steps

1. Manifest rules, mutation entries, schema changes and fixtures (the parity base fixture gains a
   `deliverables` block; the djdl fixture still passes). Then the descriptor module and schema.
2. `github.ts` types; ingest in `descriptor.ts` with tests for each cross-check and for dry run.
3. Wire the GitHub path into truth-store sync; map classification with sniffing as the fallback.
4. Resync writes `release_deliverables`; docs, skill, `docs gen`.

## Acceptance criteria

- [ ] Every new validator code has a mutation-table entry; `pnpm --filter @polaris-key/manifest test`
      passes, including the djdl fixture and the base fixture with `deliverables`.
- [ ] Worker tests: a Diceroll-shaped release (macOS universal DMG, Windows zip, Linux tar.gz, APK,
      sideload IPA, web zip) is classified by the map into six builds with the right platform and
      arch; the same release without a map falls back to sniffing exactly as today.
- [ ] Ingest refuses: an undeclared build id, a name not matching `match`, a platform mismatch, a
      mutable GitHub release, a digest mismatch, a non-content-addressed `r2` key, a lower `seq`,
      and a conflicting re-submission. Each refusal writes nothing.
- [ ] Re-ingesting the same descriptor changes no row (compare table dumps).
- [ ] `dryRun` returns the planned rows and writes nothing.
- [ ] `docs gen:check` is clean; the skill and authoring page describe the new block.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- descriptor releaseStore release
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- `ReleaseDescriptor`, `validateReleaseDescriptor` and the schema are the contract P2-06 produces
  and P2-02's `submit` hands to `ingestReleaseDescriptor`.
- P2-05 resolves over the builds written here. P3-03 extends ingest to CI-signed records; P4-02
  lifts the `kind: pack` warning and adds pack rules.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-04 done`.
