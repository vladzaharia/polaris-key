# P4-10 Chunk indexes and chunk bundles in CI; content corpus v2

| Field       | Value                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v2)                                                                                                                                                                                                          |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                    |
| Depends on  | [P4-03](P4-03-ci-patch-artifacts.md), [P4-04](P4-04-content-corpus-v1.md), [S-03](S-03-chunk-size-real-history.md), [S-02](S-02-r2-range.md)                                                                            |
| Unblocks    | [P4-11](P4-11-chunk-sync-sdks.md), [P4-17](P4-17-lazy-deltas.md)                                                                                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                   |
| Plan mode   | yes: `program/plans/P4-10.md` is written and approved before any code                                                                                                                                                   |
| Gates       | plan mode; corpus (content-corpus drift gate, `pnpm gen:corpus -- --check`, Swift and Godot mirrors, generated `corpus.mdx`); all SDKs (every runner loads the new sections); rule 9 if chunking is manifest-configured |
| Human input | approval of the plan (merging the plan PR); nothing else                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                               |

## Goal

`pkey release publish --deliverable <packId>` produces, for every single-file pack payload, a
`pkey-chunks/1` chunk index and immutable chunk bundles (file-aware FastCDC, one zstd frame or a
raw copy per chunk), uploads only objects that do not exist yet, and records them as `chunk-index`
and `chunk-bundle` artifacts and in each variant's `chunks {format, sha256, params}` (the field
P4-01 reserved in the pack record). The content corpus P4-04 created gains `chunkIndexCases`, the
chunk `applyCases` and index-blob plan rows, regenerated under the same drift gate and mirrored for
Swift and Godot. The Node runner parses every chunk-index case through a shared TypeScript parser;
every other runner loads the new sections and declares them `planned` until P4-11.

## Why

Chunk sync is the default patch mechanism for packs of 16 MiB and more, and the only incremental
path that works from **any** older release ([README decision 14](../../README.md#11-decisions-needed);
[CONTENT §8.1](../../CONTENT.md#81-the-strategy-ladder-and-planner)). On the synthetic 36 MiB
Godot pack it downloads 1.05 MB instead of 9.80 MB ([CONTENT §8.3](../../CONTENT.md#83-godot-measured-pure-gdscript-472)).
Chunk boundaries are computed only in CI (CONTENT principle 3), so CI must emit the index and the
bundles before any SDK can sync. The corpus pins the format before four SDKs implement it
([notes/A7 §11.5](../../notes/A7-xlang-content.md#115-corpus-plan-a-plan-mode-all-languages-event-per-claudemd)).

## Read first

- `AGENTS.md` (rules 1–3, the green gate), `CLAUDE.md` (plan mode), `program/plans/README.md`.
- [CONTENT §8](../../CONTENT.md#8-patching), [§9](../../CONTENT.md#9-formats) (chunk index, codec,
  patch descriptor), [§11](../../CONTENT.md#11-server-side-by-service) (CI tooling, R2 keys) and
  [§12](../../CONTENT.md#12-security) (gated bundles).
- [notes/A7](../../notes/A7-xlang-content.md): §2 (the vector set), §3.1 (format and validation
  order), §3.4 (chunk apply), §3.5 (error codes), §5 (corpus encoding), §11.5 (corpus plan).
- [notes/A6 §2.3](../../notes/A6-godot-patching.md#23-chunk-based-reassembly-e8s-thin-client) for
  the file-aware measurements (64 KiB average: 984,678 B; 16 KiB: 934,696 B with a 1.8× index).
- The reference code in `docs/research/2026-09-29-godot-omniplatform/prototype/content/`:
  `gen/gen.py` (`chunk`, `build_index`, bundle packing, the case list), `gen/fastcdc.js`,
  `runners/js/content.mjs` (parser and applier), `runners/python/pkey_content.py`.
- The approved `program/plans/P4-01.md` (decisions 2, 17, 19 and 22: variants, corpus layout,
  generator, feature ids) and `program/plans/P4-04.md`.
- What P4-03 and P4-04 landed: the pack path of `pkey release publish` in `packages/cli/src/`
  (files index, gaps blob, deltas, lint, the zstd CLI check), `tools/gen-content-corpus.ts`, the
  content set in `conformance/corpus/v2/content/` (`cases.json`, `blobs/`),
  `conformance/corpus/v2/plan-matrix.json`, and `conformance/runners/node/content.test.ts` (these
  are the proposed paths; use the ones that landed).
- `tools/sign-corpus.ts` (`reconcile` and `main`, ~L2311–2381; `SWIFT_V2_RESOURCES` ~L37) and
  `packages/docs/scripts/gen-reference.mjs` §7 (`corpusInventory`, ~L365).

## Scope

**In:**

- The plan, `program/plans/P4-10.md`, in the format of `program/plans/README.md`.
- A `pkey-chunks/1` parser and validator in `@polaris-key/client-core/packs` (for example
  `packages/client-core/src/packs/chunkIndex.ts`), used by the CLI's self-check and the Node runner.
  The P4-06 and P4-07 briefs give the parser to P4-11; land the TypeScript one here because the
  CLI lint and the Node runner need it, and P4-11 reuses it. Python, Swift and Godot parsers stay
  with P4-11.
- In the CLI publisher: file-aware FastCDC, per-chunk zstd frames, chunk-bundle packing, the
  binary index writer, the lints below, upload of new objects only, and the `chunks` field and
  artifact roles in the release descriptor.
- Content corpus v2 (the content set's second version): `chunkIndexCases` (15), the eight chunk
  `applyCases` (`chunk-v1-to-v2`, `chunk-no-seed`, `chunk-tampered-zstd`, `chunk-tampered-raw`,
  `chunk-bundle-truncated`, `chunk-seed-tampered`, `chunk-seed-tampered-repair`,
  `chunk-index-for-other-payload`), the blobs
  they need (`chunks/v1.pkc`, `chunks/v2.pkc`, `bundles/<sha256>`), and the index-blob plan rows
  P4-04 left for this package: `plan-matrix.json` rows whose chunk targets and seeds reference the
  `.pkc` blobs instead of inline `records`/`ids` (A7 §4.1 allows both; P4-01 put the inline form in
  v1). `contentCorpusVersion` goes to 2 if the plan says so.
- Pack-kind `releaseRecordCases` in `conformance/corpus/v2/cases.json` gain `chunks`, pinning the
  content vectors' chunk-index hash, so the two corpora join by SHA-256.
- Runner updates: Node parses all 15 index cases; Python, Swift and Godot load the new sections
  and report them as `planned` under the feature id `packs.index.chunks` (and
  `packs.apply.chunk`) in `parity.json` once P1b-01 exists. No silent skips.
- Regenerated docs: `corpus.mdx` and the content-corpus page under `contribute/`.

**Out** (and where it belongs instead):

- The chunk applier, seeds and sync in any SDK (→ [P4-11](P4-11-chunk-sync-sdks.md)).
- Planner logic: P4-06 implemented it; only rows change here.
- Lazy deltas (→ [P4-17](P4-17-lazy-deltas.md)); web `dcz` (→ [P4-18](P4-18-web-dcz.md)).
- Bundle liveness and server GC (→ [P4-14](P4-14-readiness-gc-rollouts.md)). Repacking bundles
  below ~50% live data (CONTENT §11) has no owner yet; the plan should say so.
- Chunk indexes for large files inside `layout: tree` payloads. CONTENT §4.2 wants them for big
  tree files; the record carries one `chunks` field. Not scheduled; the plan confirms.
- Serving bundles by `Range`/`If-Range`: that is the distribution blob route (P4-05, P2b-04), and
  S-02 measures R2's behaviour. Here, only add a Worker test that a bundle key is served with
  `Accept-Ranges` and honours `If-Range`, if P4-05 has no such test.

## Design notes

- **Format, exactly as A7 §3.1.** A 64-byte header (magic `PKEYCHNK`, `version` u16 = 1,
  `recordSize` u16 = 48, `flags` u32 with bit 0 `fileAware`, `chunkCount`, `bundleCount`,
  `payloadSize` u64, `payloadSha256`), then 48-byte chunk records
  `id[32] | len u32 | clen u32 | bundle u32 | offset u32` in payload order, then 48-byte bundle
  records `sha256[32] | size u64 | reserved u64`. File length is exactly
  `64 + 48 × (chunkCount + bundleCount)`. The parser returns the first failure in the fixed order
  with its code (`chunks.bad_length`, `chunks.bad_magic`, `chunks.unsupported_version`,
  `chunks.bad_record_size`, `chunks.bad_flags`, `chunks.reserved_nonzero`, `chunks.zero_length`,
  `chunks.bad_clen`, `chunks.bad_bundle_ref`, `chunks.bad_bundle_range`, `chunks.size_mismatch`);
  `chunks.payload_mismatch` is an apply-time check.
- **Codec** (README decision 21): `clen == len` means stored raw; `clen < len` means exactly one
  zstd frame with the content-size field; `clen > len` is invalid, so CI stores raw whenever the
  frame is not smaller. Chunk ids are SHA-256 of the **uncompressed** bytes. P4-03 compresses
  with the zstd CLI (`zstd -19`, version ≥ 1.5.5); one process per chunk is too slow for
  thousands of chunks, so batch chunks per invocation (the CLI writes the content size by
  default) or use a binding that sets the pledged source size. The lint below is the safety net.
- **Lints** (A7 §11.5): every frame is a single frame, has the content-size flag, decodes to `len`
  and hashes to `id`; the written index parses cleanly with the shared parser; the bundle table's
  sizes match the uploaded objects.
- **File-aware chunking.** For a container payload (`layout: container` files index from P4-03),
  run FastCDC separately over each segment (gap, file, gap, …) and set `fileAware`. **Padding
  rule (S-03):** a gap shorter than 64 bytes that directly follows a file is chunked together with
  that file. It is the exporter's 16-byte alignment padding. The header, the directory and longer
  gaps stay their own segments, and a chunk still never spans two files. On real Diceroll history
  this halves the index (655 → 350 KB for 6,733 entries) and cuts the mean N−1 download by 21%,
  with identical missing bytes and requests
  ([notes/S-03 §4.5](../../notes/S-03-chunk-size-real-history.md#45-reading-the-tables)). A
  single-file payload without a container index (an `ml.model`, say) is chunked whole with the
  bit clear.
- **Parameters** are not in the binary index; they go in the record's `chunks.params` and never
  change for a published release (CI never re-chunks history). Default: FastCDC, minimum
  average/4, maximum average×4, plus the padding rule above. **The average depends on the
  index-on-wire question below; settle that first, because `avgSize` is frozen for every published
  release.** Measured by S-03 on five real releases, at the 16 KiB request weight
  ([notes/S-03 §4.7](../../notes/S-03-chunk-size-real-history.md#47-index-size-on-the-wire), cost
  table):
  - **Index sent raw or as one zstd frame: 64 KiB.** The averages 16–128 KiB land within 5% of each
    other in every pair class. 32 KiB's 3.7–4.4% N−1 gain is roughly even at N−2 and is lost from
    N−3 on (2.2–2.5% dearer), because it needs more request runs.
  - **Index sent as a delta of the seed index: 64 KiB for a payload whose N−1 delta fits the
    device memory budget; 32 KiB only where chunk sync serves N−1.** The index term then drops to
    1.4–9 KB at any average. On the monolithic 85 MB PCK, 32 KiB is 9.7% cheaper at N−1 (741 KB
    against 821 KB) and 2.2% cheaper at N−2, and 1.4–1.5% dearer at N−3 and older. At a 64 KiB
    weight it is 8.7% cheaper at N−1 and 1.7–5.5% dearer from N−2 on. That N−1 gain counts only
    where chunk sync serves N−1: a payload above about `memBudget`/2 (the whole-file delta needs
    about 2 × its size, so the 85 MB PCK needs ~170 MB), or an SDK without delta support. Every
    Diceroll pack slice's N−1 delta fits a 64 MiB budget (at most about 42 MB), so under per-pack
    delivery N−1 is delta-served and chunk sync runs from N−2 on. There 32 and 64 KiB are within
    −1.2% to +5.3% per pack ([notes/S-03 §4.10](../../notes/S-03-chunk-size-real-history.md#410-per-pack-estimate-desktop-pck-sliced-by-the-proposed-packs-an-estimate),
    last table), so keep 64 KiB. `chunks.params` is per payload record, so the plan may set 32 KiB
    for oversized payloads only; if it wants one default, take 64 KiB.

  See [notes/S-03 §5](../../notes/S-03-chunk-size-real-history.md#5-recommendation). A7's generator records
  `{chunker: "fastcdc-2016-nc1", fileAware, avgSize, minSize, maxSize, bundleTarget, zstdLevel}`;
  notes/E8 §5.4 sketched `{alg, min, avg, max, id, codec}`. Use what P4-01 froze; otherwise the
  plan picks A7's names. The default average is CI config, not format, but it cannot change for a
  release once published.

- **Manifest.** README §3.12 sketches `patch.chunking: {alg: fastcdc, avg: 65536, fileAware: true}`
  in `.pkey/release`. If this package makes chunking configurable there, it is a rule-9 change:
  validator rule, mutation-table entry in `packages/shared-manifest/test/schema-parity.test.ts`,
  JSON schema, regenerated `validation-codes.mdx`.
- **Bundles** target 4–16 MiB (CONTENT §2) and hold unique chunks in first-use order; duplicate
  records point at one location. The plan must choose between:
  - fresh bundles per release (what the A7 vectors do; trivial GC), or
  - bundles shared across releases of **one** deliverable, where a new release's bundles hold only
    new chunks (what the run rule, A7 §4.3, and CONTENT §11's repacking assume; much less storage).

  Recommend the second, scoped to one deliverable and one gating class. S-03 measured both. With
  shared bundles an N−1 sync is 2 requests (index plus one run), against 42 with fresh bundles.
  The 4, 8 and 16 MiB targets gave identical bytes and requests in every pair class. Target
  **4 MiB** unless S-02's Range and cache results argue for more. The index format supports both.
  Never share a bundle between a gated and a free pack: a `Range` would leak content
  (CONTENT §12).

- **Index on the wire (plan question from S-03).** With the padding rule the raw index is 0.35 MB,
  31% of an N−1 chunk sync. As one zstd frame it is 0.28 MB. As a `zstd --patch-from` frame
  against the seed index the client already stores, it is **1.4–9 KB**
  ([notes/S-03 §4.7](../../notes/S-03-chunk-size-real-history.md#47-index-size-on-the-wire)).
  The plan decides whether v2 ships the index compressed, adds an index-delta artifact (a
  `pkey-patch/1` over the index blob, planner-visible), or defers both. Either is a record or
  artifact-role change, so name it in the wire section. Decide it before the default average
  (Parameters above): with an index delta, 32 KiB beats 64 KiB at N−1 by about 10% on a payload
  whose N−1 is served by chunk sync (the 85 MB PCK), and by at most 1.2% on a pack.

- **Storage.** R2 keys from P2-01's `bundleKey(sha256, {gated})` (`bundles/sha256/<h>`, or under
  `gated/` for gated deliverables); `release_artifacts` roles `chunk-index` and `chunk-bundle`
  (added by P2-03); `blob_objects.kind = bundle`. Upload new objects
  only (dedupe by hash). If an operator gates a deliverable later, its earlier bundles stay under
  the public prefix; document that in the pack authoring docs.
- **Corpus determinism.** zstd output depends on the library version. P4-04's rule applies: the
  committed blobs (now including `.pkc` indexes and bundles) are inputs checked by SHA-256,
  `--check` rebuilds `cases.json` and `plan-matrix.json` from them, and only the explicit
  blob-rebuild mode compresses, with the pinned zstd CLI. The blob directory stays in
  `.prettierignore` and `.gitattributes` `binary`. Keep the source set under 5 MB: A7's full set,
  bundles included, is 4.1 MB, and P4-04 reported its own size; report source and mirror sizes
  separately. Only one corpus-touching package may be in flight (program README §5).
- **Expected verdicts come from a reference implementation**, a port of A7's
  `refapply.py`/`content.mjs` inside the generator, never from hand-written numbers. `requests`
  counts are part of the verdict and must match the planner's run rule.
- **Wire.** P4-01 reserved `chunks` in each variant of the pack record, so filling it should be a
  corpus change only; the plan confirms that v4 verifiers accept a record that carries it. If the
  approved P4-01 plan did not reserve it, the plan treats this as a wire change:
  `PROTOCOL_VERSION`, the compatibility story for deployed clients, and every SDK.

## Steps

1. Write `program/plans/P4-10.md`: the `chunks` fields and parameter names; the bundle strategy;
   the new corpus sections, files and version constant; generator, mirror and drift-gate changes;
   the SDK follow-ups (P4-11 for `client-core`, Python, Swift and Godot; X-01 and P6-05 later);
   Worker impact (artifact roles, the blob-route `Range` test). Set the status to
   `awaiting-approval` and stop.
2. After approval, add the parser and its unit tests in `@polaris-key/client-core/packs`.
3. Add the chunker, bundle packer, index writer and lints to the CLI publisher, then the
   descriptor fields and upload.
4. Extend `tools/gen-content-corpus.ts` (its reference applier gains chunks) and the mirrors; add
   `chunks` to the pack-kind `releaseRecordCases`; run `pnpm gen:corpus`.
5. Update the runners, the parity manifests and the docs; run the green gate.

## Acceptance criteria

- [ ] `program/plans/P4-10.md` is merged (human approval) before any code lands.
- [ ] `pnpm --filter @polaris-key/cli test` covers: no chunk straddles a files-index entry when
      `fileAware` is set; raw storage when the frame is not smaller; every frame is one frame with
      a content size; the same input twice gives identical index and bundle hashes; a second
      publish of the same payload uploads nothing; a gated deliverable writes under the gated prefix.
- [ ] The `client-core` parser returns exactly the A7 §3.1 code for each of the 15
      `chunkIndexCases` in `conformance/runners/node`.
- [ ] The content corpus contains the 15 index cases, the 8 chunk apply cases and the index-blob
      plan rows; `pnpm gen:corpus -- --check` is clean, including the Swift and Godot mirrors, and
      fails after a one-byte edit to a new blob; the source set is under 5 MB.
- [ ] A pack-kind `releaseRecordCases` vector pins the chunk index's SHA-256.
- [ ] Python, Swift and Godot runners load the new sections and report them as `planned`; none is
      skipped silently.
- [ ] `pnpm --filter @polaris-key/docs gen:check` passes (corpus page regenerated).
- [ ] The green gate passes (`AGENTS.md`).
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm conformance
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift test )
```

## Hand-off

- **P4-11** relies on: the parser's API and module path; the corpus section names and verdict
  shape; each variant's `chunks {format, sha256, params}`; the bundle key layout (`bundleKey` from
  P2-01).
- **P4-17** relies on the stored chunk indexes to estimate a pair's chunk-sync bytes without
  reading payloads.
- **P4-14** relies on the `chunk-index` and `chunk-bundle` roles and on bundle references in
  `blob_refs` to compute liveness.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-10 done`.
