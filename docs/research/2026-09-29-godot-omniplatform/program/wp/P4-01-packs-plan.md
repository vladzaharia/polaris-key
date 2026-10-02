# P4-01 Plan packs on the wire: `kind: pack` records, bindings, content corpus, `plan-matrix.json`

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v1)                                                                                                 |
| Size        | 0.5–0.75 engineer-weeks                                                                                        |
| Depends on  | [P3-01](P3-01-wire-v4-plan.md)                                                                                 |
| Unblocks    | [P4-02](P4-02-pack-deliverables.md), [P4-03](P4-03-ci-patch-artifacts.md), [P4-04](P4-04-content-corpus-v1.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                            |
| Plan mode   | yes: this package **is** the plan. It writes `program/plans/P4-01.md` and stops; no code                       |
| Gates       | plan mode; human approval (merging the plan PR)                                                                |
| Human input | approval of `program/plans/P4-01.md`. Nothing downstream starts until then                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                      |

## Goal

`program/plans/P4-01.md` exists, has the nine sections that
[`plans/README.md`](../plans/README.md) requires, and settles every packs v1 decision that touches
the wire, the conformance corpus or more than one language: the `kind: pack` release record and the
app record's `content` block inside wire v4's `pkey-release+jws`, the `.pkey/release` pack
deliverable fields, the marker, `packSetId`, the content corpus (location, files, generator,
budget, mirrors) and `plan-matrix.json`. The status is `awaiting-approval`. A reviewer can check
that each numbered decision below has an answer, a reason and an owning work package.

## Why

Packs add **no document type** ([README §3.3](../../README.md#33-trust-model-two-signers-two-documents),
[decision 1](../../README.md#11-decisions-needed)), but they add a record kind, fields in the app's
signed record, a content corpus and a new conformance matrix. Each of those is an all-languages
event (`CLAUDE.md` plan mode, `AGENTS.md` rules 1 and 2). notes/A7 ran the formats and algorithms
identically in six runtimes, but it also left gaps that the worker, the CLI, the corpus and five
SDK implementations would otherwise each fill differently (listed under Design notes). Settling
them once is cheaper than reconciling five PRs.

## Read first

- `AGENTS.md` (rules 1, 2, 3, 5, 9, 10), `CLAUDE.md` (plan mode),
  [`plans/README.md`](../plans/README.md) (the nine required sections).
- The approved `program/plans/P3-01.md` and the [P3-01 brief](P3-01-wire-v4-plan.md): the
  `pkey-release+jws` envelope, `kind`, `seq`, release keys, unknown-field rules, the feed.
- [CONTENT §3](../../CONTENT.md#3-where-packs-live-across-the-three-services),
  [§6.1](../../CONTENT.md#61-binding-modes), [§6.9](../../CONTENT.md#69-record-and-table-changes),
  [§7](../../CONTENT.md#7-transports) (marker), [§8.1](../../CONTENT.md#81-the-strategy-ladder-and-planner),
  [§9](../../CONTENT.md#9-formats), [§10](../../CONTENT.md#10-client-pipeline-every-sdk),
  [§16](../../CONTENT.md#16-phasing-and-effort).
- [notes/A7](../../notes/A7-xlang-content.md) §2 (the vector set), §3 (formats, apply algorithms,
  [error registry §3.5](../../notes/A7-xlang-content.md#35-error-code-registry)),
  [§4](../../notes/A7-xlang-content.md#4-install-planner-language-neutral-specification) (planner
  and its 23 rows), [§5](../../notes/A7-xlang-content.md#5-corpus-encoding-and-runner-expectations)
  (corpus encoding, runner rules),
  [§11.5](../../notes/A7-xlang-content.md#115-corpus-plan-a-plan-mode-all-languages-event-per-claudemd).
- [README §3.3, §3.4](../../README.md#34-release-the-record-of-everything-that-exists) (record
  fields, tables), [§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative)
  (illustrative `.pkey/release`); [PARITY §4.1](../../PARITY.md#41-corpora-behaviour-as-data) and
  [§5.6](../../PARITY.md#56-packs) (corpus files, feature ids);
  [notes/E8 §5.4](../../notes/E8-content-delivery.md#54-schemas-json-sketches) (older sketches;
  A7 wins where they differ).
- Reference code: `docs/research/2026-09-29-godot-omniplatform/prototype/content/` (A7's
  generator, reference applier and planner) and `prototype/patching/` (A6's Godot mechanics). Run
  them to see the exact shapes the vectors used.
- Code: `packages/shared-protocol/src/core.ts:9` (`PROTOCOL_VERSION = 3`),
  `docs/security/WIRE-CONTRACT-V3.md` §1 (the 65,536-byte decoded payload cap) and §9;
  `tools/sign-corpus.ts` (`reconcile`, `main`, `SWIFT_V2_RESOURCES`);
  `packages/shared-manifest/src/index.ts`, `schemas/v1/release.schema.json`,
  `test/schema-parity.test.ts`; `packages/worker/src/core/devices.ts:869` (`REPORT_KEYS`);
  `packages/docs/scripts/gen-reference.mjs` (`corpusInventory` at line 458, `TABLE_OWNERS` at line 312);
  `.prettierignore`; `sdks/swift/Package.swift` (the `.copy("Resources/v2")` test resource).

## Scope

**In:**

- `program/plans/P4-01.md`, answering decisions 1–24 below with a choice, a reason and the work
  package that implements it, plus a **names table** (tables, columns, artifact roles, files,
  constants, error codes, feature ids) that P4-02 to P4-09 quote verbatim.
- Annotated JSON examples: a `godot.pck` pack release with two texture variants, a `files.tree`
  pack release, an app release carrying `content`, a marker, and one `plan-matrix.json` row.
- **The pack rows of the stage machine** (from [P1-09's plan §8](../plans/P1-09.md)): the rows for a
  `true` `canPlayOffline`, the `accepts` change that lets `offline` accept `play-offline`, fetch
  consent and progress, and the bump to `stageMatrixVersion: 3` (P3-02 takes version 2). P4-04 emits them and updates the
  machine in every port that exists by then; P4-06, P4-07 and P4-08 implement only the host side.
- Status changes in `workpackages.json` (`planning`, then `awaiting-approval`).

**Out** (and where it belongs instead):

- Any code, corpus, schema or migration (→ [P4-02](P4-02-pack-deliverables.md),
  [P4-03](P4-03-ci-patch-artifacts.md), [P4-04](P4-04-content-corpus-v1.md)).
- Chunk indexes, chunk bundles, `chunkIndexCases` and chunk apply vectors (→ P4-10). The plan only
  reserves the `chunks` field.
- `compatible`/`standalone` resolution, `packSets` in the feed, holds, `packChannels`, pack floors
  (→ P4-12, P4-13); revocation records (→ P4-13); content keys (→ P4-19); `provides`/`removes`
  (→ P4-20). Reserve names only.

## Design notes: the decisions the plan must make

**What P3-01's approved plan reserves for P4** (`plans/P3-01.md` §8). P4 stays inside wire v4 by
filling these slots: in the record, `kind: pack`, `revocation` and `delegation`, and `content`;
in the feed, `packSets`, `packFloors`, `revocations` and `deltas`, and new `selector` keys. A
selector key a client did not ask for is never served to it. P4's stage-matrix bump is version 3
(P3-02 takes version 2). `packs` is a reserved name, not a v4 action: this plan adds it to
`UPDATE_ACTIONS`, the `updateAction` enum, `vocabulary.actions` and the `UpdateDecision` type
together, with the `update-matrix.json` rows that produce it (plan §2.8). Every integer claim it
adds follows plan §2.2's integer rule, with its minimum stated, and every new string compared for
uniqueness or order is ASCII by pattern.

**Contract** (wire v4, `pkey-release+jws`):

1. **Version and sequencing.** P3-01 reserves `kind: pack`, `kind: revocation` and
   `content: {contentApi, pins[], holds[], expects[], packChannels}`, and has v4 verifiers "verify,
   then refuse to act on" reserved kinds. Extend those slots; do not add new shapes. Say whether
   filling them moves `PROTOCOL_VERSION`. If P3-02 has not merged when this plan is approved, fold
   the pack shapes and their `releaseRecordCases` into P3-02 (one all-SDK event, not two). State
   how a v4 client that predates packs treats an app record that carries `content`. Use P3-01's
   record-hash definition (SHA-256 over the ASCII compact JWS) everywhere a pack is referenced.
2. **One record per release, variants inside.** README §3.3 puts builds or variants inside one
   record; CONTENT §9 lists a singular `variant`. Recommend `variants[]` in one record, so an app
   pin names one record and the device picks its variant. Per variant: `variant`
   (`texture`/`locale`/`quality`), `payload {size, sha256}`, `full {sha256, bytes, size, codec}`,
   `files {format: "pkey-files/1", layout, sha256, bytes, gaps?}`, `deltas[]`, `conflicts`, and
   `requires` (`engine`, `contentApi: {<appDeliverable>: range}`, `features`, `packs`). Release
   level: `deliverable`, `kind`, `version`, `seq`, `type`, `formatVersion`, `entitlement`,
   `provenance`. Reserve `chunks`, `provides`, `removes`.

   **Files-index encoding (S-03; decide here).** The `files` reference above has no codec, so the
   index is fetched as raw JSON. On the real 6,733-entry Diceroll desktop PCK, `pkey-files/1` is
   1.37 MB raw and 0.34 MB as one zstd frame. Raw, it is 64% of the bytes of an N−1 per-entry delta
   set and of the `file` strategy
   ([notes/S-03 §4.5](../../notes/S-03-chunk-size-real-history.md#45-reading-the-tables)). Item 5's
   per-entry `blob {sha256, bytes, codec}` would make the raw index larger still. Decide whether
   `files` becomes `{format, layout, sha256, bytes, codec, size, gaps?}`. That shape follows item
   4's rule, with `sha256`/`bytes` over the stored frame and `size` decoded. The decision changes
   what every SDK's `file` and per-entry-delta paths download and parse, and it needs
   `releaseRecordCases` and apply vectors. [P4-03](P4-03-ci-patch-artifacts.md) then stores the
   index as frozen here.

3. **Size.** Records obey the 65,536-byte decoded payload cap unless P3-01 changed it. Per-file
   detail therefore lives in hash-pinned side objects (the files index, per-file delta
   descriptors), never inline. State the worst case for the Diceroll-sized pack (625 entries).
4. **Every zstd reference carries its decoded `size`** (A7 §5; Godot's `decompress` needs it).
5. **File blobs.** The planner needs `blobBytes` per file (A7 §4.1), but `pkey-files/1` (A7 §3.3)
   has no blob fields; A7's generator keyed blobs by the **decoded** file hash (`files/<sha256>`)
   and kept the codec in the test case, which production cannot do. Recommend each files-index
   entry gains `blob {sha256, bytes, codec}` of its stored object, every stored object is addressed
   by the SHA-256 of its stored bytes (so `ETag` and `Repr-Digest` match, README §3.5), and CI
   publishes a blob for every file, deduplicated by hash, so `file` works from any older release.
6. **Tree payloads.** Recommend `payload.sha256` = `treeDigest` (A7 §3.3) and a `full` object that
   is one zstd frame of the files concatenated in index order, split by the index on apply (the
   container rule with empty gaps).
7. **Delta menu.** Whole-payload deltas use A7 §3.2's descriptor (`method`, `from`, `to`, `size`,
   `artifact`, `artifactSha256`, `memBytes`, window). The per-entry set that `godot.pck` uses
   (CONTENT §8.3; A7's "per-file delta set", 33 objects) needs a shape: recommend a hash-pinned
   `pkey-patch/1` object with `scope: "files"` (per changed path: `from`, `to`, `size`, artifact)
   referenced from the record with its total `bytes` and object count, and say whether CI packs
   the frames into one object now or later (A7 §4.4 note). v1 method: `zstd-patch-from` only;
   reserve `godot-delta-pck`, `hdiffpatch`, `bsdiff`.
8. **Publish and decode rules become contract** (A7 §3.2): raw-content prefix decode only; no
   `zstd-patch-from` delta against a base that starts `37 A4 30 EC`; decoders raise `windowLogMax`
   within `memBytes`; the stored artifact is the bare frame. Define `memBytes`.
9. **App record `content`** (CONTENT §6.9): v1 fields `contentApi`, `pins[{pack, release}]`,
   `expects[{pack, required}]`; reserve `holds` and `packChannels` for P4-12. Add per-build
   `embeds[]` (a lean web build and a full store build of one app release differ). Say where CI
   gets pins: recommend the markers of the packs embedded in the build plus explicit
   `--pin <packId>@<version>` flags, printed by the dry run.
10. **Marker** (`.pkey/pack.json`, CONTENT §7). Recommend
    `{format: "pkey-marker/1", packId, version, release: "<compact pkey-release+jws>"}`: no new
    `typ`, and verification reuses the release-record verifier. It sits **beside** a single-file
    payload (inside it, it would change the hash it pins) and is excluded from a tree's files
    index. A detached-JWS marker, which CONTENT §7 and the [P5-08](P5-08-platform-pack-transports.md)
    brief assume, would need a new `typ` and a `PROTOCOL_VERSION` event; if chosen, say so.
11. **`packSetId`.** Devices report it in v1 and release stores `release_sets.pack_set_id` in v2,
    so it is one function. Recommend SHA-256 hex of UTF-8 lines `<packId> <releaseSha256>\n`
    sorted by pack-id bytes (the `treeDigest` pattern), with corpus vectors.
12. **Error registry** (A7 §3.5) is contract. Say where it lives (`shared-protocol`, emitted per
    language by P1b-02's `gen-sdk-constants`) and that `plan.*` results are verdicts, not throws.
13. **Telemetry.** `packSetId` (and `appRelease`, if kept) in the report body: `DeviceFacts` in
    `packages/shared-protocol/src/core.ts` and `REPORT_KEYS` in `core/devices.ts:869`, which drops
    unknown keys silently.
14. **Feed.** Pinned packs need no feed entry (CONTENT §6.3). Recommend v1 adds no feed fields and
    say so, because CONTENT §16 lists "the pack part of the channel feed" under v1.

**Manifests** (rule 9):

15. **The v1 subset** of `.pkey/release` `deliverables.<packId>` with `kind: pack`: `type`,
    `binding`, `baseline`, `required`, `delivery`, `handler {mountOrder, prefixes, activation}`,
    `variants`, `requires.engine`, `entitlement`, `contentPolicy.dataOnly`,
    `patch {strategies, deltaBases}`; and `deliverables.app.content.contentApi`. A pack-id grammar
    (the examples use `<product>.<name>[.<name>]`). For each rule: its error code, its
    mutation-table entry (`schema: "rejects"` or `"accepts"`) and its JSON-schema change. The
    [P4-12](P4-12-compat-resolution.md) brief adds `binding: compatible | standalone`,
    `requires.contentApi`, `requires.packs`, `conflicts`, per-pack `channels` and `packChannels`;
    the [P4-16](P4-16-more-pack-types.md) brief widens `type`.
16. **v1 binding rules.** Recommend the narrow v1: `binding` accepts only `pinned` and `type` only
    `godot.pck` and `files.tree` (the types some SDK can install), so a product never declares
    behaviour that v1 silently does not deliver. Every `required` pack and every
    `baseline: embedded` pack must be pinned by each app release.

**Corpus:**

17. **Location and files.** Follow P3-01's placement (it recommends keeping
    `conformance/corpus/v2/` with additive, separately versioned files). Recommend
    `plan-matrix.json` (`planMatrixVersion: 1`, all 23 A7 rows) beside `update-matrix.json`, and
    the content set in a `content/` subdirectory of the same directory: `content/cases.json`
    (`contentCorpusVersion: 1`: A7's 12 full/delta/file `applyCases`, 17 `pathCases`, new
    `packSetIdCases`) and `content/blobs/`. The Swift `.copy("Resources/v2")` then bundles it with
    no `Package.swift` change. Encode chunk targets and seeds **inline** (`records`, `ids`; A7
    §4.1), so v1 SDKs implement the whole planner without a chunk-index parser and P4-11 never
    touches it.
18. **JWS-corpus additions:** pack-kind `releaseRecordCases` and `markerCases` that pin the content
    set's hashes (A7 §11.5: the corpora join by hash; no key enters the content corpus). List
    positives and negatives.
19. **Generator.** Port A7's generator to TypeScript under `tools/` (proposed
    `tools/gen-content-corpus.ts`), run by `pnpm gen:corpus` so `--check` covers it. zstd output
    is not stable across libzstd versions, so committed blobs are **inputs** checked by hash;
    `--check` rebuilds `cases.json` and `plan-matrix.json` from them; a separate explicit mode
    rebuilds blobs with a pinned zstd CLI version and refuses any other.
20. **Budget and mirrors.** Under 5 MB for the source set; A7's set without chunk objects is about
    2.5 MB (A7 §2.1). Mirrors: Swift under `sdks/swift/Tests/PolarisKeyTests/Resources/v2/` and
    Godot beside P1-01's mirror. Say whether mirrors count against the budget (each one doubles
    the repository growth).
21. **Hygiene.** `.prettierignore` must exclude the blob directory: `pnpm format` would rewrite
    hash-pinned JSON indexes. Add `.gitattributes` `binary` for blobs.
22. **Parity registry** (PARITY §3.3): v1 feature ids and allowed N/As. Recommend splitting
    `packs.index` into `packs.index.files` (v1) and `packs.index.chunks` (v2).

**SDKs, Worker, rollout:**

23. SDK order and owners ([P4-06](P4-06-client-core-packs.md), [P4-07](P4-07-python-swift-packs.md),
    [P4-08](P4-08-godot-packs.md)); zstd per SDK (A7 §11.2); v1 types: `files.tree` everywhere,
    `godot.pck` in Godot. Typed N/As: none for full and file; `packs.apply.delta` only
    `dependency`/`version`.
24. Worker: pack records stored beside app records in P3-03's record store (proposed
    `release_records`); P4-02's tables (proposed `release_pins`, `release_metadata.content_api`,
    `release_builds.embeds_json`, artifact role `files-gaps`), `TABLE_OWNERS`; P4-05's routes
    (rule 10); the descriptor hook as P2b-01 named it (README §3.2 says `releaseCatalog`, README
    §10 `buildCatalog`). Deploy order: P4-02 before any CI publishes a pack; SDK releases after
    P4-04.

## Steps

1. `check.mjs --show P4-01` confirms P3-01 is `done` (its plan merged); `--set P4-01 planning`;
   branch `wp/P4-01-plan`.
2. Read the sources above; run the `prototype/content/` generator and reference runner once.
3. Draft `plans/P4-01.md` in the nine sections. Put decisions in tables (decision, choice, reason,
   owner). Keep it reviewable in one sitting; push detail into the JSON examples.
4. Cross-check every name against P3-01's plan and the sibling briefs; list conflicts under
   "Risks and open questions" for the human.
5. Format, set `awaiting-approval`, open the PR, stop.

## Acceptance criteria

- [ ] `program/plans/P4-01.md` has the nine sections of `plans/README.md`.
- [ ] Decisions 1–24 each have a choice, a reason and an owning work package, or an explicit
      deferral to a named id.
- [ ] The JSON examples show a two-variant `godot.pck` record whose worst case (625 entries, three
      variants, one whole and one per-entry delta each) stays under the payload cap, with the
      arithmetic.
- [ ] The corpus section lists every file, section, case id and approximate size, and adds up the
      budget.
- [ ] Every new manifest rule has a named error code and a `rejects`/`accepts` classification.
- [ ] One names table covers every identifier downstream briefs will quote, and every name that
      P3-01 reserved (`kind: pack`, `content`, the record hash) is used as P3-01 defined it.
- [ ] The plan names the pack rows of `stage-matrix.json` (`canPlayOffline`, `play-offline` in
      `accepts`, fetch consent and progress) and the move to `stageMatrixVersion: 3`.
- [ ] `workpackages.json` shows `awaiting-approval`; `node check.mjs` and prettier pass.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-01 awaiting-approval
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm exec prettier --check docs/research/2026-09-29-godot-omniplatform/program/{plans/P4-01.md,workpackages.json,INDEX.md}
git diff --name-only origin/main...HEAD   # only the plan, workpackages.json and INDEX.md
```

## Hand-off

P4-02 takes the manifest fields, publish rules, tables and roles; P4-03 takes the record, files
index, delta and marker shapes and the pin source; P4-04 takes the corpus layout, generator
design, cases and mirrors (its own short plan, `plans/P4-04.md`, only fills in what this one
leaves open); P4-05 to P4-09 take the names table. If a later package needs to deviate, it amends
this plan in a small plan PR first. The planner sets `awaiting-approval`; the lead sets
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-01 done` once the
human merges the plan PR.
