# P4-11 Chunk sync from seeds in every SDK

| Field       | Value                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v2)                                                                                                                                                                                             |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                       |
| Depends on  | [P4-10](P4-10-chunk-indexes.md), [P4-06](P4-06-client-core-packs.md), [P4-07](P4-07-python-swift-packs.md), [P4-08](P4-08-godot-packs.md), [S-02](S-02-r2-range.md), [P4-05](P4-05-pack-transports-cdn.md) |
| Unblocks    | [P4-18](P4-18-web-dcz.md), [X-01](X-01-dotnet-sdk.md)                                                                                                                                                      |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                          |
| Plan mode   | no: the format and vectors were approved in P4-10's plan                                                                                                                                                   |
| Gates       | corpus (content corpus v2 chunk sections in every runner); all SDKs                                                                                                                                        |
| Human input | none                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                  |

## Goal

Every SDK (`client-core` for Node and React, Python, Swift, Godot) implements the `chunk` strategy.
It parses `pkey-chunks/1`, builds a seed map from every installed payload whose chunk index is
known (installed packs and embedded baselines, across packs), copies reusable chunks, fetches
each missing run with one `Range` request carrying `If-Range`, decodes and verifies every fetched
chunk, runs the repair pass, verifies the payload hash, and commits through the install-state
machine. All 15 `chunkIndexCases` and 8 chunk `applyCases` pass in every runner with identical
verdicts and counters, and each SDK advertises `chunk` in `caps.strategies`, so the planner's
chunk candidate becomes live.

## Why

Chunk sync is the default for packs of 16 MiB and more ([README decision 14](../../README.md#11-decisions-needed)):
it serves any older version and makes moving assets between packs free
([CONTENT §8.1](../../CONTENT.md#81-the-strategy-ladder-and-planner)). notes/A7 ran the same
operations in six runtimes with identical verdicts, so this is porting against fixed vectors, not
design ([notes/A7 §3.4](../../notes/A7-xlang-content.md#34-apply-algorithms-and-verdict-precedence)).
P4-10 put the format and vectors in the corpus; the parity rule says the feature is done only when
every SDK passes ([PARITY §5.6](../../PARITY.md#56-packs)).

## Read first

- `AGENTS.md`, `CLAUDE.md`, and the brief and code of P4-06, P4-07 and P4-08: the packs modules
  (`@polaris-key/client-core/packs`, `polaris_key/update/packs/`, the Swift `PolarisKeyPacks`
  target, `addons/polaris_key/packs/` — proposed names; use what landed), the injected ports
  (incremental SHA-256, `zstd.decode(frame, size)`, `fetch` with `Range`/`If-Range`, byte sources
  and sinks `read(offset, length)` / `write(offset, bytes)`), install state `state.json` (`active`,
  `previous`, `inflight`, `observed`, `confirmedBootSeq`), the planner, the zstd dependency each
  SDK chose, and the content runners (`conformance/runners/node/content.test.ts`,
  `sdks/python/tests/test_content_conformance.py`, Swift `ContentConformanceTests`, the Godot
  runner).
- [CONTENT §8.1](../../CONTENT.md#81-the-strategy-ladder-and-planner),
  [§10](../../CONTENT.md#10-client-pipeline-every-sdk) (journal, `.part`, commit, resume, web) and
  [§13](../../CONTENT.md#13-per-sdk-integration).
- [notes/A7](../../notes/A7-xlang-content.md): §3.1, §3.4 (chunk algorithm and verdict), §4.2 (run
  rule), §6 (per-language traps), §8 (throughput), §9.2 (OPFS, `Cache.put`), §10 (Swift
  `URLSession`, Android background transfer), §11.2 (dependencies).
- Reference code: `docs/research/2026-09-29-godot-omniplatform/prototype/content/runners/js/content.mjs`,
  `runners/python/pkey_content.py`, `runners/godot/content_runner.gd`.
- `docs/research/2026-09-29-godot-omniplatform/prototype/README.md` (HTTP probe: gzip breaks
  `Range`; `HTTPRequest` forwards `Authorization` on cross-host redirects; `download_file`
  truncates).
- [notes/E8 §5.7](../../notes/E8-content-delivery.md#57-storage-layout-and-garbage-collection)
  (client storage layout: `pkey/index/<sha256>` for seed indexes).
- The P4-10 parser (`@polaris-key/client-core/packs`) and the corpus sections it added.

## Scope

**In:**

- `client-core`: the chunk applier over P4-06's injected ports (the shape that ran unchanged in
  Node and Chromium in A7), the seed registry, and feeding `installed[].chunks` to the planner.
  The planner itself is complete (P4-06 costs chunk candidates over inline records); it only
  learns to take a chunk index by reference (P4-10's index-blob rows), and the capability flips.
  Node and React wiring; React stages in OPFS through P4-06's storage adapter.
- Python and Swift: parser (the P4-06 and P4-07 briefs assign it here), applier, seed registry,
  `Range` fetching.
- Godot: parser (`PackedByteArray.decode_u32`/`decode_u64`), applier, `HTTPClient`-based `Range`
  fetching.
- Seed indexes in every SDK: after any install whose record has `chunks`, fetch the index by hash,
  verify it against the record and store it under the SDK's content directory
  (`…/pkey/index/<sha256>`). Embedded baselines become seeds through their release records.
- Journal and resume: a per-run completion bitmap in `staging/<planId>/journal.json`; on resume,
  completed ranges are re-hashed before reuse.
- `caps.strategies` gains `chunk`; `parity.json` marks `packs.index.chunks` (P4-01 split
  `packs.index`) and `packs.apply.chunk` implemented.
- An HTTP transcript for a chunk-bundle `Range` fetch with `If-Range`, if P1b-03's transcript
  machinery exists.

**Out** (and where it belongs instead):

- `dcz` deltas in Chromium (→ [P4-18](P4-18-web-dcz.md)).
- Gap coalescing (fetching unneeded bytes to merge runs): A7 §4.3 calls it a later capability with
  its own plan rows. Not scheduled.
- Platform transports (→ P5-08); iOS background sessions and Android jobs (→ P5-05, P5-06). Here
  those SDKs only raise `requestWeight`.
- C# (→ [X-01](X-01-dotnet-sdk.md)) and Kotlin (→ P6-05), which reimplement against the same vectors.
- Server-side `Range` behaviour (S-02; the blob route of P4-05).

## Design notes

- **Algorithm, exactly A7 §3.4.** Build `S`: id → (seed, offset), first occurrence over seeds in
  order, then records in order. For each target record: copy from a seed; else copy from the
  output if the id was already written; else fetch. Seeded chunks are not re-hashed on the fast
  path (they were verified at install). The verdict is
  `{ok, sha256, size, fetchedChunks, fetchedBytes, requests, seedChunks, selfChunks, repairedChunks[]}`;
  errors are `bundle.truncated {chunk}`, `chunk.corrupt {chunk}`, `payload.hash_mismatch`, and
  `chunks.payload_mismatch` when the index is bound to another payload. The repair pass re-hashes
  seed-sourced records in order and refetches those that differ.
- **The run rule is shared with the planner.** A fetched record joins the current run if it is in
  the same bundle and `offset == prev.offset + prev.clen`; a seeded or duplicate record between
  two contiguous missing ones does not break the run (`plan-run-rules`). The applier's `requests`
  counter must equal the planner's, and the corpus checks it.
- **HTTP.** One single-range request per run: `Range: bytes=<o>-<o+len-1>` and
  `If-Range: "<bundle sha256>"` (the strong ETag is the SHA-256, README §3.5). A `200` instead of
  `206` (the bundle changed or `Range` was ignored) aborts the strategy and falls back to the next
  plan entry; never read a whole bundle to recover. No multi-range requests until S-02 says R2
  supports them. A short body is `bundle.truncated`. Gated deliverables send the delivery
  authorisation P4-05 defined on every request and never cache the response.
- **zstd.** Plain decode only, to exactly `len` bytes (every chunk record carries it; Godot's
  `decompress(len, FileAccess.COMPRESSION_ZSTD)` needs it). Use the dependency each SDK already
  has: `node:zlib` (22.15+) or `@polaris-key/zstd-wasm` (P4-06); Python 3.14 `compression.zstd` or
  `zstandard`; libzstd via SwiftPM (P4-07); the Godot engine.
- **Output.** Pre-allocate a `.part` file on the same volume as `store/`, write at the target
  offset, rename to `store/<sha>` on commit, write state by temp + rename (CONTENT §10). Godot
  never overwrites a mounted pack: new content-addressed path, restart activation (P4-08).
- **Seeds** can come from any installed pack or the embedded baseline, not only the same
  deliverable. Embedded seeds are read-only and read at offsets. Keep the seed map keyed by the
  32-byte id; in GDScript, measure `PackedByteArray` keys against hex strings before choosing.
- **Planner input.** Pass seeds only for payloads whose index is stored locally; a missing seed
  index is fetched after an install, not counted as a planner request. First install stays
  `full`, then records the index as a seed (CONTENT §8.1).
- **Per SDK:**
  - Godot: `HTTPClient` with `Accept-Encoding: identity` (gzip breaks `Range`), no automatic
    redirects, and no `Authorization` on a cross-host redirect (prototype HTTP probe). Assemble
    output with `append_array` or `FileAccess.store_buffer`, never a byte loop (A7 §6).
  - Swift: `URLSession` with `Range` in the `URLRequest`; CryptoKit streaming SHA-256.
    Background sessions are discretionary, so raise `requestWeight` there (A7 §10.1).
  - React: OPFS sync access handle in a dedicated worker; streaming SHA-256 via `hash-wasm`
    (WebCrypto `digest` is one-shot); `Cache.put` rejects 206 responses.
  - Godot on the web keeps `user://` in memory, so it has no persistent seeds and the planner falls
    back to `full` by itself. No typed N/A is needed.
- **Throughput** (A7 §8, informative): 206–285 MB/s native, 161 MB/s GDScript on the release
  template, 106–136 MB/s in Chromium. Report large regressions; do not gate on them.

## Steps

1. `client-core` applier and seed registry, run against corpus v2 in `conformance/runners/node`.
2. Node and React wiring (OPFS worker for React), with the Chromium job if P1b-05 exists.
3. Python, then Swift, each against the corpus mirror.
4. Godot, on the editor and the release template.
5. Seed-index storage, journal and resume in each SDK's install state.
6. `caps`, `parity.json`, transcripts; the green gate.

## Acceptance criteria

- [ ] The 15 `chunkIndexCases`, the 8 chunk `applyCases` and P4-10's index-blob `plan-matrix.json`
      rows pass with identical verdicts, counters included, in: `conformance/runners/node`, the
      Chromium job (if P1b-05 has landed), pytest on CPython 3.9 and 3.14, `swift test`, and the
      Godot runner on the editor and a release template.
- [ ] Each SDK has an integration test with a fake server: v1 installed via `full` records its
      seed index; v2 installs via `chunk`; the number of `Range` requests equals the planner's
      `requests`; a `200` reply to a `Range` request makes the install fall back to the next
      strategy; an interrupted install resumes and reuses completed runs.
- [ ] A cross-pack test: a chunk moved from pack A to pack B is copied from A's installed payload.
- [ ] `caps.strategies` includes `chunk` in every SDK; `pnpm parity:check` passes with
      `packs.index.chunks` and `packs.apply.chunk` implemented (once P1b-01 has landed).
- [ ] The green gate passes (`AGENTS.md`), including Python and Swift.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm conformance
mise exec node@22 -- pnpm test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
# Godot: the headless runner P1-01 added, on the editor and on an exported release template
```

## Hand-off

- **P4-18** relies on the `client-core` applier, the OPFS staging worker, the seed store and the
  fallback order in the React SDK.
- **X-01** (and later Kotlin, P6-05) reimplements the parser and applier against the same corpus
  sections and verdict shape.
- The seed-index store path and the `caps` fields (`strategies`, `requestWeight`) are what later
  planners and telemetry read.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-11 done`.
