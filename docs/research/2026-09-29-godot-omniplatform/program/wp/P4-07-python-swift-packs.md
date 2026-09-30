# P4-07 Python and Swift pack facets: appliers, handlers, install state

| Field       | Value                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v1)                                                                                                                              |
| Size        | 1–1.5 engineer-weeks                                                                                                                        |
| Depends on  | [P4-04](P4-04-content-corpus-v1.md), [P3-06](P3-06-v4-python.md), [P3-07](P3-07-v4-swift.md), [P1b-09](P1b-09-fingerprint-storage-fixes.md) |
| Unblocks    | [P4-11](P4-11-chunk-sync-sdks.md), [P4-16](P4-16-more-pack-types.md), [P4-20](P4-20-save-compat.md)                                         |
| Role        | `pkey-sdk-porter`                                                                                                                           |
| Plan mode   | no                                                                                                                                          |
| Gates       | corpus: the content corpus and `plan-matrix.json` pass in pytest (lowest and highest supported CPython) and `swift test`                    |
| Human input | none (Swift runs on the existing macOS CI runner)                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                   |

## Goal

The Python and Swift SDKs each carry their own port of the pack core (planner, full/file/delta
appliers, files-index parsing, path rules, error registry, `packSetId`, install state) and pass
every content case and `plan-matrix.json` row through their production code. Each exposes the
update pack facet (`client.update.packs` in Python, the Swift equivalent) with `ensure`, `state`,
`register_handler`/`registerHandler` and progress, a `files.tree` handler, embedded baselines, and
`packSetId` in the device report.

## Why

Every SDK implements the same ~450–700 lines against the same vectors
([CONTENT §13](../../CONTENT.md#13-per-sdk-integration)); a feature is done only when every SDK
passes or declares an allowed typed N/A ([PARITY §2](../../PARITY.md#2-what-parity-means)).
Python serves tools and ML pipelines, Swift serves macOS and iOS apps and is the base for the Apple
Background Assets transport later ([A7 §10.1](../../notes/A7-xlang-content.md#101-swift--apple)).

## Read first

- `AGENTS.md`; the approved `program/plans/P4-01.md`.
- [notes/A7 §3.4–§3.5](../../notes/A7-xlang-content.md#34-apply-algorithms-and-verdict-precedence),
  [§4](../../notes/A7-xlang-content.md#4-install-planner-language-neutral-specification),
  [§6](../../notes/A7-xlang-content.md#6-results-by-language) (Python),
  [§7](../../notes/A7-xlang-content.md#7-decoder-behaviour-matrices) (decoder traps),
  [§10.1](../../notes/A7-xlang-content.md#101-swift--apple) (Swift, libzstd, CryptoKit,
  background `URLSession`), [§11.2](../../notes/A7-xlang-content.md#112-one-small-dependency-per-sdk-none-for-godot).
- [CONTENT §4.1](../../CONTENT.md#41-handler-contract-every-sdk), [§10](../../CONTENT.md#10-client-pipeline-every-sdk);
  [PARITY §5.6](../../PARITY.md#56-packs), [§6.2](../../PARITY.md#62-zstd-one-codec-at-most-one-dependency-per-sdk).
- The reference implementations: `packages/client-core/src/packs/` once P4-06 lands, and in
  `docs/research/2026-09-29-godot-omniplatform/prototype/content/`:
  `runners/python/pkey_content.py` and `runcases.py` (A7's Python library and runner, 456 + 129
  lines, stdlib and `zstandard` modes) and `probe/magic/` (the dictionary-magic probes).
- Code: `sdks/python/pyproject.toml` (`requires-python = ">=3.9"`, dependencies),
  `sdks/python/src/polaris_key/update/`, `core/telemetry.py`, `tests/test_conformance.py`
  (corpus path at line 44); `sdks/swift/Package.swift` (targets; `PolarisKeyUpdate` is macOS-only
  because of Sparkle), `Sources/PolarisKeyCore/`, `Tests/PolarisKeyTests/`;
  `.github/workflows/ci.yml` (Python 3.12 only at line 96; Swift on `macos-15`).

## Scope

**In:**

- **Python** (`polaris_key/update/packs/`): the core port; zstd via stdlib `compression.zstd` on
  3.14 (`ZstdDict(base, is_raw=True).as_prefix`, explicit `window_log_max`) and `zstandard`
  (`DICT_TYPE_RAWCONTENT`, explicit `max_window_size`) on 3.9–3.13, added as a conditional
  dependency (`zstandard; python_version < "3.14"`, BSD-3); SHA-256 via `hashlib`; `httpx` Range
  requests; `files.tree` handler; embedded baselines; the facet; `packSetId` in the report.
- **Swift**: a new cross-platform target (proposed `PolarisKeyPacks`, macOS and iOS, depending on
  `PolarisKeyCore`) with the core port; libzstd from the official `facebook/zstd` SwiftPM package
  pinned to 1.5.7 (or a decoder-only local target, if the plan prefers it), called through
  `ZSTD_DCtx_refPrefix`, `ZSTD_d_windowLogMax` and `ZSTD_decompressDCtx`; CryptoKit `SHA256`
  streaming; `URLSession` Range requests; `files.tree` handler; embedded baselines from the app
  bundle; the facet on the umbrella client; `packSetId` in the report.
- **Runners**: `sdks/python/tests/test_content_conformance.py` and `test_plan_matrix.py` over the
  corpus paths P4-04 landed (proposed `conformance/corpus/v2/content/` and
  `conformance/corpus/v2/plan-matrix.json`); Swift `ContentConformanceTests` and `PlanMatrixTests`
  over the same files in the `Resources/v2/` mirror; each reports its runtime and zstd library
  versions.
- **CI**: pytest on the lowest and highest supported CPython (3.9 and 3.14), unless P1b-05 already
  added that matrix.

**Out** (and where it belongs instead):

- Chunk sync (→ [P4-11](P4-11-chunk-sync-sdks.md)).
- `ml.model`, `data.json`, `l10n.table` and `custom.*` handlers (→ [P4-16](P4-16-more-pack-types.md)).
- Apple Background Assets and background `URLSession` transfers (→ P5-05, P5-08).
- Feed pack sets, floors and revocations (→ P4-12, P4-13); `isAvailable` (→ P4-20).

## Design notes

- **Python's prefix trap.** On 3.14 the only stdlib mode that handles every base is
  `ZstdDict(base, is_raw=True).as_prefix`, which is **undocumented**; the documented
  `as_digested_dict`/`as_undigested_dict` ignore `is_raw` and fail on a base starting with the
  zstd dictionary magic. 3.14 also rejects windows over 128 MiB unless `window_log_max` is set.
  Add a unit test for each (A7 §6, §7).
- **No Python N/A for full or file.** zstd is needed for every strategy, and PARITY allows no N/A
  for `packs.apply.full`, so `zstandard` is a hard dependency below 3.14, not an extra.
- **Swift has no system zstd.** Apple's Compression framework lists no zstd even at OS 27; vendor
  libzstd (A7 §10.1). Keep Sparkle's conditioning intact: packs must build for iOS, so they cannot
  live in `PolarisKeyUpdate`.
- **Swift resources.** The mirror is copied into the test bundle (`.copy("Resources/v2")`, or
  whatever P4-04 added); read blobs from `Bundle.module`, never by walking up the monorepo.
- **Install state** follows P4-06's machine exactly (same fields, same transitions); store it
  under the platform data directory with backup exclusion (P1b-09), with atomic replace
  (`os.replace`; `FileManager.replaceItemAt`).
- **Identical verdicts, not identical code.** Port the algorithm and the counters; each verdict is
  compared by canonical JSON, integral floats normalised.

## Steps

1. Python core port against the corpus (stdlib on 3.14, `zstandard` on 3.9–3.13).
2. Python facet, `files.tree` handler, install state, report; tests.
3. Swift target and libzstd dependency; core port against the mirror.
4. Swift facet, handler, install state, report; tests.
5. CI matrix, registry manifests, SDK docs pages.

## Acceptance criteria

- [ ] Every content case and `plan-matrix.json` row passes in pytest on CPython 3.9 (`zstandard`)
      and 3.14 (stdlib), and in `swift test` on the macOS runner.
- [ ] Unit tests prove Python decodes a delta whose base starts `37 A4 30 EC` via `as_prefix`
      and `DICT_TYPE_RAWCONTENT`, and decodes a frame with a window over 128 MiB (a synthetic
      frame generated in the test).
- [ ] The Swift package builds for iOS without linking Sparkle (`swift build` plus an iOS
      `xcodebuild` build of the new target, or the existing platform check).
- [ ] Each SDK's `update.packs.ensure([id])` installs a `files.tree` pack from a fake byte server,
      survives a simulated crash mid-download by resuming, and reports `packSetId`.
- [ ] The green gate passes.
- [ ] `parity.json` manifests for Python and Swift mark the v1 pack features implemented (once
      P1b-01 has landed).

## Verify

```sh
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_content_conformance.py tests/test_plan_matrix.py )
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test --filter "ContentConformanceTests|PlanMatrixTests" )
( cd sdks/swift && swift test )
```

## Hand-off

P4-11 adds the chunk applier and chunk-index parser to both ports; P4-16 adds `ml.model`,
`data.json` and `l10n.table` handlers through the facet's handler registry; P5-05/P5-08 put the
Background Assets transport behind the `platform` strategy on top of the Swift target. Then
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-07 done`.
