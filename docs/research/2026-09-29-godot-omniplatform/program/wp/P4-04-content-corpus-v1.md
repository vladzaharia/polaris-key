# P4-04 Content corpus v1: index parsing, full/file/delta apply, path rules, `plan-matrix.json`

| Field       | Value                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v1)                                                                                                                                                            |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                      |
| Depends on  | [P4-01](P4-01-packs-plan.md)                                                                                                                                              |
| Unblocks    | [P4-06](P4-06-client-core-packs.md), [P4-07](P4-07-python-swift-packs.md), [P4-08](P4-08-godot-packs.md), [P4-10](P4-10-chunk-indexes.md)                                 |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                     |
| Plan mode   | yes: `pkey-wire-planner` writes a short execution plan, `program/plans/P4-04.md`, against the approved P4-01 plan; a human approves it before code                        |
| Gates       | corpus (`pnpm gen:corpus -- --check`, Swift and Godot mirrors); all SDKs (pack-kind record cases); `corpus.mdx` (`docs gen:check`); one corpus-touching package in flight |
| Human input | approval of `program/plans/P4-04.md`                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                 |

## Goal

The content corpus exists in the repo and is drift-gated like the JWS corpus. A TypeScript port of
notes/A7's generator writes it; `pnpm gen:corpus -- --check` regenerates it in memory and fails on
any difference, mirrors included; the source set stays under 5 MB. It pins files-index parsing and
path rules, full, file and delta apply with negatives, `packSetId`, and the install planner as
`plan-matrix.json`. The JWS corpus gains pack-kind `releaseRecordCases` and `markerCases` that pin
the content set's hashes, and every SDK's release-record runner passes them. SDK appliers and
content runners come next, in P4-06, P4-07 and P4-08.

## Why

The planner and the appliers are pure functions, so they are conformance-tested across SDKs
([CONTENT §8.1](../../CONTENT.md#81-the-strategy-ladder-and-planner)). notes/A7 built 75 cases that
gave identical verdicts and byte-identical outputs in ten decoder configurations and five
languages, and found traps (Node's silently ignored `dictionary`, the dictionary-magic base,
128 MiB window caps, Godot's U+0000 handling) that only a shared corpus catches
([A7 §11.5](../../notes/A7-xlang-content.md#115-corpus-plan-a-plan-mode-all-languages-event-per-claudemd),
[PARITY §6.3](../../PARITY.md#63-spec-rules-found-by-running-six-runtimes)). Contract → corpus →
SDKs is the repo's order (`AGENTS.md` rule 2), so this lands before any SDK applier.

## Read first

- `AGENTS.md` (rules 1–3), `CLAUDE.md` (plan mode), [`plans/README.md`](../plans/README.md).
- The approved `program/plans/P4-01.md`: corpus location, files, sections, generator design,
  budget, mirrors, feature ids and any format change to A7's (blob refs in the files index,
  per-file delta descriptors, tree `full` objects).
- [notes/A7 §2](../../notes/A7-xlang-content.md#2-the-shared-vector-set) (content and cases),
  [§3](../../notes/A7-xlang-content.md#3-format-definitions-proposed-these-are-what-the-vectors-implement)
  (formats, apply algorithms, verdicts, error registry),
  [§4.4](../../notes/A7-xlang-content.md#44-the-plan-rows-plan-matrix) (the 23 rows),
  [§5](../../notes/A7-xlang-content.md#5-corpus-encoding-and-runner-expectations) (encoding,
  `<ref>`, `mutate` ops, runner rules), §14 (the scratch generator's structure).
- Reference code to port, in `docs/research/2026-09-29-godot-omniplatform/prototype/content/`:
  `gen/gen.py` (the generator; Python 3.14 plus the zstd CLI 1.5.5), `gen/planref.py` (the 23 plan
  rows), `gen/refapply.py` (expected verdicts come from the reference runner),
  `runners/python/pkey_content.py` and `runcases.py` (the reference implementation and runner),
  and its `README.md` (prerequisites, drift check by regeneration).
- Code: `tools/sign-corpus.ts` (`reconcile` at line 2313, `main` at 2334, `SWIFT_V2_RESOURCES`),
  `conformance/runners/node/corpusV2.test.ts`, `sdks/python/tests/test_conformance.py`,
  `sdks/swift/Package.swift` (`.copy("Resources/v2")`),
  `sdks/swift/Tests/PolarisKeyTests/ConformanceTests.swift`, the Godot runner from P1-01,
  `packages/docs/scripts/gen-reference.mjs` (`corpusInventory`, line 366),
  `packages/docs/src/content/docs/build/wire/corpus.md`, `.prettierignore`.

## Scope

**In:**

- Executing `program/plans/P4-04.md` (one page, written by `pkey-wire-planner` before dispatch):
  the blob list with sizes, case ids, generator module layout, mirror paths, and any detail P4-01
  left to this package.
- **Generator.** Port A7's generator to TypeScript under `tools/` (proposed
  `tools/gen-content-corpus.ts`), called from `tools/sign-corpus.ts` `main` so `pnpm gen:corpus`
  and `--check` cover both corpora. Committed blobs are inputs verified by SHA-256; `--check`
  rebuilds `cases.json` and `plan-matrix.json` from them; an explicit blob-rebuild mode requires
  the pinned zstd CLI version.
- **Content set.** A7's v1/v2 PCK pair (v1 5,257,944 B, 147 files; v2 5,255,248 B, 151 files: 120
  reused, 22 changed, 9 added, 5 removed), minus chunk objects: `payload/v1.full.zst`, the
  whole-payload delta, the per-file deltas, files indexes, gaps blob and file blobs, reshaped to
  P4-01's formats. A7's `gen/gen.py` starts from the patching experiment's 37 MB Godot exports,
  which the repo does not hold; the port starts from the small v1/v2 payloads instead, which the
  committed set reproduces (v1 from its full blob, v2 by the `file` strategy).
- **`cases.json`** (`contentCorpusVersion: 1`): `applyCases` `full-v1`, `full-v1-tampered`,
  `delta-whole-v1-to-v2`, `delta-whole-wrong-base`, `delta-whole-wrong-base-unchecked`,
  `delta-whole-artifact-tampered`, `file-v1-to-v2`, `file-delta-v1-to-v2`, `file-delta-tree`,
  `file-delta-wrong-base`, `file-source-missing`, `file-gaps-short`; the 17 `pathCases`;
  `packSetIdCases`; plus any tree `full` case P4-01's tree decision needs.
- **`plan-matrix.json`** (`planMatrixVersion: 1`): all 23 rows of A7 §4.4, chunk inputs inline.
- **JWS corpus** (`tools/sign-corpus.ts`): pack-kind `releaseRecordCases` and `markerCases`
  signed by a committed test release key, pinning the content set's hashes. Unless P4-01 folded
  them into P3-02, update every SDK's release-record verifier so these pass: `client-core` (Node,
  React), Python, Swift, Godot.
- **Placement and mirrors.** Where P4-01 put them; its recommendation follows P3-01's corpus
  placement: `plan-matrix.json` beside `update-matrix.json` in `conformance/corpus/v2/`, and the
  content set in `conformance/corpus/v2/content/` (`cases.json`, `blobs/`). The generator mirrors
  both into `sdks/swift/Tests/PolarisKeyTests/Resources/v2/` (already bundled by
  `.copy("Resources/v2")`) and into the Godot mirror P1-01 created: extend `CORPUS_TARGETS`'
  reconciliation to the `content/` subdirectory and its blobs (the stray-file guard leaves
  subdirectories to their owner), and add the blob extensions to the `Conformance (Linux)`
  preset's `include_filter` so the exported pack carries them. Add `.prettierignore` for the blob
  directory and `.gitattributes` `binary`.
- **Stage-matrix version 2.** Emit the pack rows P4-01 planned (`canPlayOffline: true` paths,
  `play-offline` accepted in `offline`, fetch consent and progress) as `stageMatrixVersion: 2`, and
  update the stage machine and its runner in every port that exists by then (Node `client-core`,
  Python, Swift, Godot `PKeyStages`), per [P1-09's plan §4.5](../plans/P1-09.md).
- **Docs and registry.** `corpusInventory` lists the content corpus and the plan matrix
  (regenerate `reference/corpus.mdx`); update `build/wire/corpus.md`. Once P1b-01 and P1b-02 have
  landed: feature ids in `conformance/parity/features.json` (every SDK `planned` for P4 v1) and the
  error codes and corpus versions in `gen-sdk-constants`.

**Out** (and where it belongs instead):

- `chunkIndexCases`, chunk apply cases, chunk bundles, index blobs that reference them
  (→ [P4-10](P4-10-chunk-indexes.md)).
- Appliers, planners and content runners in the SDKs (→ [P4-06](P4-06-client-core-packs.md),
  [P4-07](P4-07-python-swift-packs.md), [P4-08](P4-08-godot-packs.md)).
- A7's 37 MB companion set: CI performance jobs only, never the corpus.
- Type-specific `godot.pck` vectors (engine header, directory check): P4-08 unit tests, or a
  later corpus section with a `requires` field (A7 §5).

## Design notes

- **Verdicts are objects, compared by canonical JSON** (keys unordered, arrays ordered, integers by
  value). Counters are part of the verdict (`reusedFiles`, `deltaFiles`, `blobFiles`,
  `downloadedBytes`), so the generator states them exactly. The first failure wins, with A7
  §3.4's precedence and §3.5's coarse codes.
- **Expected verdicts come from a reference implementation inside the generator** (a port of
  A7's reference applier and `planref.py`), cross-checked against what the generator built, never
  from hand-written numbers. The generator never imports an SDK, so a shared bug cannot make both
  sides agree. [P4-10](P4-10-chunk-indexes.md) extends the same reference with chunks.
- **Portability rules from A7 §5:** no U+0000 in JSON strings (use U+001F), integers below 2^53,
  every zstd `<ref>` carries its decoded `size`, bytes live in blobs (never base64 in JSON),
  mutations (`truncate`, `xor`, `putU16/32/64`) apply to raw bytes for the object under test and
  to decoded bytes for installed state.
- **Runners fail loudly** when they lack a capability; no case carries `requires` yet.
- **Format changes move A7's numbers.** Blob refs in the index or packed per-file descriptors
  change rows such as `plan-real-v1-v2` (A7: per-file set 345,603 B, file 665,655 B). That is
  expected; the PR lists each changed expectation against A7's value.
- **The oracle.** Before merging, run the `prototype/content/` Python reference runner (updated
  for P4-01's format changes) over the new corpus and paste its summary in the PR. It is a
  one-off check, not part of the gate.
- **Budget.** A7's set without chunk objects is about 2.5 MB; mirrors multiply repo growth,
  so report source and mirror sizes separately in the PR.
- Only one corpus-touching package may be in flight (program README §5): coordinate with P3-02,
  P4-10 and P4-13.

## Steps

1. Confirm `plans/P4-04.md` is approved (merged) and P4-01 is `done`; otherwise stop.
2. Port the generator and reference planner; reproduce A7's v1 set first, then apply P4-01's
   format changes.
3. Wire it into `pnpm gen:corpus` with `--check` and the mirrors; add the ignore and attribute
   rules.
4. Add the pack-kind record and marker cases; update each SDK's record verifier and runner.
5. Docs generator, registry entries, constants; run the oracle; format.

## Acceptance criteria

- [ ] `pnpm gen:corpus -- --check` passes, and fails after a one-byte edit to any committed
      content file or mirror.
- [ ] Every blob matches the `blobs` table's size and SHA-256; the source set is under 5 MB.
- [ ] `cases.json` holds the 12 apply cases and 17 path cases named above plus `packSetIdCases`;
      `plan-matrix.json` holds the 23 A7 rows by id.
- [ ] Pack-kind `releaseRecordCases` and `markerCases` pass in Node, React (`client-core`),
      Python, Swift and Godot.
- [ ] The prototype reference runner passes every content case and plan row (output in the PR).
- [ ] `pnpm format` leaves the blob directory untouched.
- [ ] `pnpm --filter @polaris-key/docs gen:check` passes with the new corpus inventory.
- [ ] The green gate passes.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_conformance.py )
( cd sdks/swift && swift test --filter ConformanceTests )
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm format
```

Plus the Godot runner from P1-01 on the editor and a release template.

## Hand-off

P4-06, P4-07 and P4-08 load the content set and `plan-matrix.json` from the approved paths and
mirrors through their real code paths; the case ids, verdict shapes and version constants above
are their contract. P4-10 extends the same generator with `chunkIndexCases`, chunk apply cases
and index-blob plan rows, bumping `contentCorpusVersion` if its plan says so. Then
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-04 done`.
