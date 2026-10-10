> Research note for [Godot on Polaris Key](../README.md), 2026-09-30.
> A working paper kept for its evidence and sources; the README synthesis is the cross-checked position.

# A7: Content operations across languages: shared vectors, reference appliers and portability, empirical results

Run 2026-09-30. `notes/A6` showed that a pure-GDScript client on Godot 4.7.2 can do chunk sync, per-entry and
whole-file `zstd --patch-from` deltas and per-file rebuilds, and produce a pack that one SHA-256 verifies. This
note asks the contract-first follow-up. Can the **same** operations be implemented **identically** in every SDK
language, and what shared test-vector set keeps them identical?

To answer it I built three things, now kept in [`prototype/content/`](../prototype/content/README.md):

- a small shared vector set;
- a reference applier and planner in six runtimes (five languages);
- a runner harness that checks every implementation against the same expected verdicts.

The repo was not modified apart from this note.

Evidence markers:

- **[M]** measured here;
- **[S]** read in source code;
- **[D]** read in vendor documentation (URLs in §15);
- **[I]** inference.

Section numbers such as "CONTENT §8.1" refer to the current [`CONTENT.md`](../CONTENT.md).

## TL;DR

| Question                                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can the content operations be implemented identically in every language? | **Yes [M].** One 4.1 MB vector set (75 cases: chunk-index parsing, full/chunk/delta/file apply with negatives, the planner, path rules) gives **75/75 identical verdicts** in every runtime tested, on the shipped set and on a 37 MB companion set: Python 3.9/3.11/3.14, Node 22 and 24, Chromium 141 (Web Worker), Java 21 (the Kotlin/Android API), .NET 10 and 11, and GDScript on Godot 4.7.2 (editor and official release template). Outputs are byte-identical, because each runner must reproduce the pinned payload SHA-256 or tree digest.                                                                            |
| Which primitives does that need?                                         | SHA-256, little-endian integer reads, JSON, HTTP Range and one zstd operation, **raw-content prefix decode** (`ZSTD_DCtx_refPrefix`). Everything else (index parsing, run grouping, container rebuild, planner, path rules) is under 700 lines of plain code per language [M].                                                                                                                                                                                                                                                                                                                                                   |
| Where is zstd prefix decode native?                                      | Python 3.14 `compression.zstd`, Node ≥ 22.19 / ≥ 24.6 `node:zlib` (experimental), .NET 11 `ZstandardDecoder.SetPrefix`, and Godot (engine delta decoder, via the A6 `GDDL` trick) [M]. **Not** Apple's Compression framework, Android, Python < 3.14, .NET ≤ 10 or any browser JS API [M/D].                                                                                                                                                                                                                                                                                                                                     |
| What does each SDK need to add?                                          | One small dependency at most (§11.2): `zstandard` (BSD-3) for Python < 3.14; libzstd via the official SwiftPM package (BSD-3) for Swift; zstd-jni (BSD-2) for Kotlin; ZstdSharp.Port (MIT) for .NET ≤ 10, Unity and Blazor; and for the browser a **69 KB (24 KB gzipped) decoder-only libzstd WASM** built here, or `@bokuweb/zstd-wasm` (MIT, 252 KB).                                                                                                                                                                                                                                                                         |
| Traps the vectors caught                                                 | (1) Node 22.15–22.18 and 24.0–24.5 **silently ignore** the zstd `dictionary` option (5/75 fail). (2) APIs that auto-detect the dictionary type **misparse a base that starts with the zstd dictionary magic** `37 A4 30 EC`. That covers node:zlib, zstd-napi, zstd-jni, @bokuweb, ZstdSharp `LoadDictionary`, .NET `ZstandardDictionary.Create`, and Python's digested and undigested modes even with `is_raw=True`. (3) Streaming decoders cap the window at 128 MiB by default (Node, Python 3.14, zstd-jni streams). (4) Godot's JSON parser turns U+0000 into U+FFFD. (5) Godot's `decompress` needs the exact output size. |
| Browser                                                                  | Chromium 141 `DecompressionStream` supports only gzip, deflate and deflate-raw. zstd is native only as an HTTP content encoding. **Compression Dictionary Transport (`dcz`) applied the vector's own `--patch-from` artifact natively and byte-identically** (5 MB and 37 MB payloads), with dictionaries capped at **100 MiB**. OPFS sync access handles work in a worker. `Cache.put` rejects 206 responses. Streaming SHA-256 runs at ~200 MB/s with hash-wasm, the same as one-shot WebCrypto.                                                                                                                               |
| Throughput (37.7 MB payload, 4-vCPU Xeon, no SHA-NI)                     | Chunk reassembly incl. all SHA-256: 206–285 MB/s native, 161 MB/s GDScript on the release template, 136 MB/s in Chromium. zstd whole-file decode 230–620 MB/s native, 568 MB/s Godot, 302 MB/s WASM. Delta decode 340–2,400 MB/s. SHA-256 330–400 MB/s native, 242 MB/s Godot, 180–200 MB/s browser (§8).                                                                                                                                                                                                                                                                                                                        |
| Swift, Kotlin, C#                                                        | From documentation (§10). Apple's Compression framework has **no zstd**, even at OS 27, which adds LZMESH and LZRAVEN; vendor libzstd. zstd-jni ships an Android `.aar` for four ABIs. **.NET 11 adds `System.IO.Compression.Zstandard*` with `SetPrefix`**, but not for browser/WASI.                                                                                                                                                                                                                                                                                                                                           |

---

## 1. Setup

Host: a 4-vCPU Intel Xeon @ 2.80 GHz (AVX2, AVX-512, **no SHA-NI**), 16 GB RAM, Linux 6.18, warm page cache. A6 ran
on a 2.10 GHz host, so its absolute numbers are not directly comparable with these.

| Runtime / tool                | Versions exercised                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python                        | 3.14.7 (stdlib `compression.zstd`, libzstd 1.5.7); 3.11.15 and 3.9.25 with `zstandard` 0.25.0 (libzstd 1.5.7)                                                                                      |
| Node                          | 22.22.2 (libzstd 1.5.7, OpenSSL 3.5.5). For the zstd matrix also 22.14.0, 22.15.0, 22.18.0, 22.19.0, 22.20.0, 24.0.0, 24.5.0, 24.6.0                                                               |
| npm packages                  | `zstd-napi` 0.0.13, `@bokuweb/zstd-wasm` 0.0.27, `zstd-codec` 0.1.5, `fzstd` 0.1.1, `zstddec` 0.3.1, `@mongodb-js/zstd` 7.0.0, `@noble/hashes` 2.4.0, `hash-wasm` 4.12.0, `playwright-core` 1.63.0 |
| Browser                       | Chromium 141.0.7390.37, headless, driven by Playwright, the runner in a module Web Worker, served by a local Node server with single-range `Range` support                                         |
| JVM (Kotlin/Android stand-in) | OpenJDK 21.0.10, zstd-jni 1.5.7-20, Gson 2.14.0. The Java calls are the ones a Kotlin SDK makes; no Kotlin compiler or Android device was available                                                |
| .NET                          | 10.0.12 (SDK 10.0.401) and 11.0.0-rc.1.26425.128 (SDK 11.0.100-rc.1), `ZstdSharp.Port` 0.8.8                                                                                                       |
| Godot                         | 4.7.2-stable official (`ed1daf0bf`): the headless editor binary and the official `linux_release` export template (runner exported as a `.pck`, as in A6 §1.2)                                      |
| CI stand-in                   | zstd CLI 1.5.5 (`--patch-from`, `-19`), A6's FastCDC port (Node), Python 3.14 for everything else                                                                                                  |
| WASM build                    | clang 18.1.3 `--target=wasm32`, zstd 1.5.7 sources, no emscripten, no libc                                                                                                                         |

Swift has no toolchain here, so it is covered from documentation only (§10).

---

## 2. The shared vector set

### 2.1 Content

The set is derived from A6's real exported packs, so it contains real `.ctex`/`.sample`/`.oggvorbisstr`/JSON
entries rather than random bytes:

- A deterministic subset of A6's `v1.pck`/`v2.pck` entries is re-packed as two exporter-like PCK v4 files. They
  use the same header, 16-byte alignment and a sorted directory.
- The subset keeps all of A6's changes except three large textures (two changed, one added):
  - `v1` is 5,257,944 B (147 files);
  - `v2` is 5,255,248 B (151 files);
  - 120 files are reused, 22 changed in place, 9 added and 5 removed.
- Chunking is file-aware FastCDC at 16 KiB average (4 KiB min, 64 KiB max), so the small set still has hundreds of
  records.
- Per-chunk frames are zstd level 19, stored raw when not smaller.
- Chunk bundles target 256 KiB, so runs cross bundle boundaries.

| Object                                                                                                                     | Count | Bytes      |
| -------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| `payload/v1.full.zst` (the seed, and the `full` case)                                                                      | 1     | 1,183,998  |
| `bundles/<sha256>` (every unique v2 chunk, fresh per release)                                                              | 6     | 1,370,152  |
| `chunks/v1.pkc`, `chunks/v2.pkc` (`pkey-chunks/1`; v2 has 468 records, 343 unique, 145 raw-stored)                         | 2     | 45,584     |
| `deltas/v1-v2.pf.zst` (whole-payload `zstd -19 --patch-from`)                                                              | 1     | 311,529    |
| `deltas/files/*.pf.zst` (per-file `--patch-from` for the 22 changed files)                                                 | 22    | 179,336    |
| `files/v1.files.json`, `files/v2.files.json`, `files/v2.gaps.zst`, `files/<sha256>` (31 blobs for changed and added files) | 34    | 691,612    |
| `cases.json`                                                                                                               | 1     | 283 KB     |
| **Total on disk**                                                                                                          |       | **4.1 MB** |

The **v2 full blob is not shipped**: only its size (1,246,961 B) is needed, by the planner. v1's own bundles are
not shipped either, because a seed needs only chunk ids and lengths. **Regenerating the whole set reproduced every
blob and every expected verdict byte for byte** [M], so a `gen corpus --check` style drift gate works for it.

A **large companion set** is built from the full A6 packs by the same generator. It has a 37.7 MB payload, 1,531
records, 64 KiB chunks and 4 MiB bundles, 32 MB in total. It is used only for throughput and was **not** meant to
ship.

### 2.2 Cases

There are 75 cases in four groups:

- **`chunkIndexCases` (15):** two valid indexes plus 13 negative mutations, one per rule of §3.1.
- **`applyCases` (20):**

| id                                 | Strategy | What it pins                                   | Expected                                                                |
| ---------------------------------- | -------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `full-v1`                          | full     | first install                                  | ok                                                                      |
| `full-v1-tampered`                 | full     | one flipped byte in the blob                   | `full.corrupt`                                                          |
| `chunk-v1-to-v2`                   | chunk    | v1 as the only seed                            | ok: 71 chunks fetched (535,496 B) in 21 runs, 397 seeded                |
| `chunk-no-seed`                    | chunk    | nothing installed                              | ok: 343 fetched in 6 runs; 125 duplicate records copied from own output |
| `chunk-tampered-zstd`              | chunk    | flipped byte in a fetched zstd frame           | `chunk.corrupt` at record 390                                           |
| `chunk-tampered-raw`               | chunk    | flipped byte in a raw-stored chunk             | `chunk.corrupt` at record 54                                            |
| `chunk-bundle-truncated`           | chunk    | bundle ends mid-chunk                          | `bundle.truncated` at record 457                                        |
| `chunk-seed-tampered`              | chunk    | flipped byte in a reused seed chunk, no repair | `payload.hash_mismatch`                                                 |
| `chunk-seed-tampered-repair`       | chunk    | same, with the repair pass                     | ok, `repairedChunks: [427]`                                             |
| `chunk-index-for-other-payload`    | chunk    | index bound to another payload                 | `chunks.payload_mismatch`                                               |
| `delta-whole-v1-to-v2`             | delta    | whole-payload `--patch-from`                   | ok                                                                      |
| `delta-whole-wrong-base`           | delta    | base has one flipped byte                      | `delta.base_mismatch`                                                   |
| `delta-whole-wrong-base-unchecked` | delta    | same, base check skipped (test-only switch)    | `delta.apply_failed`                                                    |
| `delta-whole-artifact-tampered`    | delta    | artifact ≠ pinned hash                         | `delta.artifact_mismatch`                                               |
| `file-v1-to-v2`                    | file     | reuse by hash + 31 blobs + gaps                | ok: 120 reused, 31 blobs, 634,340 B                                     |
| `file-delta-v1-to-v2`              | file     | 22 per-file deltas + 9 blobs                   | ok: 314,288 B                                                           |
| `file-delta-tree`                  | file     | same, written as a tree                        | ok, `treeDigest`                                                        |
| `file-delta-wrong-base`            | file     | installed copy of a changed file corrupted     | `delta.base_mismatch` with its path                                     |
| `file-source-missing`              | file     | an added file has no source                    | `file.source_missing` with its path                                     |
| `file-gaps-short`                  | file     | gaps blob one byte short                       | `files.layout_mismatch`                                                 |

- **`planCases` (23):** 19 synthetic rows and 4 rows built from the set's own menu (§4.4).
- **`pathCases` (17):** the path rules of §3.3.

---

## 3. Format definitions (proposed; these are what the vectors implement)

### 3.1 `pkey-chunks/1` (binary, little-endian)

```text
offset size  field           rule
0      8     magic           ASCII "PKEYCHNK" (50 4B 45 59 43 48 4E 4B)
8      2     version         u16 = 1
10     2     recordSize      u16 = 48
12     4     flags           u32; bit 0 = fileAware (informative: chunks never straddle a files-index entry);
                             bits 1..31 must be 0
16     4     chunkCount      u32
20     4     bundleCount     u32
24     8     payloadSize     u64 = sum of every chunk record's len
32     32    payloadSha256   SHA-256 of the whole payload (binds the index to its payload)
64     48×chunkCount   chunk records, in payload order:
             id[32] | len u32 | clen u32 | bundle u32 | offset u32
64+48×chunkCount  48×bundleCount  bundle records:
             sha256[32] | size u64 | reserved u64 (= 0)
file length = 64 + 48 × (chunkCount + bundleCount), exactly
```

This extends the CONTENT §9 sketch in three ways:

- The **bundle table** is appended as 48-byte records, so every record in the file has one size and the index is
  self-describing and hash-pinned.
- The header carries **`payloadSha256`**, so a seed index can be matched to its payload without the release record.
- Chunker parameters (`fastcdc`, min/avg/max, level) are **not** in the binary index. Clients never chunk
  (CONTENT principle 3), so those parameters belong in the pack release record's `chunks.params`.

A record's position in the payload is implied: it is the prefix sum of `len`.

Record semantics:

- `id` is the SHA-256 of the **uncompressed** chunk.
- `clen == len` means stored raw. `clen < len` means exactly one zstd frame with the content-size field present.
  CI must store raw when the frame is not smaller, so `clen > len` is invalid.
- `bundle`/`offset` locate `clen` bytes in bundle `bundle`.
- Duplicate ids are allowed. CI stores each unique chunk once, and every duplicate record points to the same
  location.

**Validation order.** The error code is the verdict, and the first failure wins:

1. length < 64 → `chunks.bad_length`
2. magic ≠ `PKEYCHNK` → `chunks.bad_magic`
3. version ≠ 1 → `chunks.unsupported_version`
4. recordSize ≠ 48 → `chunks.bad_record_size`
5. `flags & ~1` ≠ 0 → `chunks.bad_flags`
6. length ≠ 64 + 48 × (chunkCount + bundleCount) → `chunks.bad_length` (compute in 64 bits)
7. bundle records in order: reserved ≠ 0 → `chunks.reserved_nonzero {bundle}`
8. chunk records in order:
   - `len == 0` → `chunks.zero_length {chunk}`;
   - `clen == 0 || clen > len` → `chunks.bad_clen {chunk}`;
   - `bundle ≥ bundleCount` → `chunks.bad_bundle_ref {chunk}`;
   - `offset + clen > bundles[bundle].size` → `chunks.bad_bundle_range {chunk}`.
9. Σ len ≠ payloadSize → `chunks.size_mismatch`

At apply time, `payloadSha256`/`payloadSize` ≠ the release's payload gives `chunks.payload_mismatch`.

Chunk bundles are the concatenated frames (or raw chunks) of unique chunks in first-use order. They are untrusted
containers fetched by `Range`: a whole bundle is never hashed; each chunk is.

### 3.2 Delta artifacts (`pkey-patch/1` fields the vectors use)

The descriptor fields are:

- `method: "zstd-patch-from"`;
- `from`, the SHA-256 of the base payload or file;
- `to`, the SHA-256 of the output;
- `size`, the output bytes;
- `artifact` and `artifactSha256`;
- `memBytes`, for the planner.

The artifact is **one bare zstd frame** exactly as `zstd --patch-from=<base> <target>` writes it:

- the whole base is a raw-content prefix;
- the content-size and checksum flags are on;
- the window is at least the larger file (36 MiB for the 37 MB pair; 153 MiB for A6's 160 MB pair).

Publish rules forced by §7:

- **Decoders must use raw-content prefix mode** (`ZSTD_DCtx_refPrefix`, `ZSTD_dct_rawContent`,
  `DICT_TYPE_RAWCONTENT`, `as_prefix`, `SetPrefix`), never dictionary-type auto-detection.
- **CI must not publish a `zstd-patch-from` delta whose base begins with `37 A4 30 EC`.** Several SDK decoders can
  only auto-detect and would misparse it. Such a base is in practice a zstd dictionary; the planner falls back to
  chunk, file or full.
- **Decoders must raise `windowLogMax` explicitly**, to at least ⌈log2(window)⌉ and within `memBytes`. One-shot
  APIs have no cap; streaming APIs default to 27 (128 MiB) and reject larger windows.
- **The stored artifact is the bare frame.** The `dcz` framing for browsers is added at the edge (§9.3). The
  40-byte header is derivable from `from` alone.

### 3.3 `pkey-files/1` (JSON)

```json
{
  "format": "pkey-files/1",
  "layout": "container",
  "payload": { "size": 5255248, "sha256": "58cc…" },
  "files": [
    {
      "path": ".godot/imported/t512_05.png-….s3tc.ctex",
      "offset": 1234,
      "size": 174828,
      "sha256": "…"
    }
  ]
}
```

- **`layout: "container"`** (a single-file payload such as a PCK):
  - `files` is in ascending `offset` order, non-overlapping;
  - the bytes not covered by any file (header, alignment padding, directory) are published as one **gaps blob**:
    their concatenation in offset order, zstd-compressed.
- **A container rebuild is then type-neutral:** write gap₀, file₀, gap₁, file₁ … gap_tail, where each gap's length
  is implied by the offsets. No SDK needs a PCK writer to run the `file` strategy; Godot may use either route. For
  the small v2 the gaps blob is 4,626 B.
- **`layout: "tree"`:** the same list, without offsets or gaps. The result is verified per file, and reported as
  **`treeDigest`**: the SHA-256 of the UTF-8 text formed by one line `<sha256hex> <size> <path>\n` per file, sorted
  by path bytes.

**Path rules** (portable to every file system and to GDScript, which has no Unicode normalisation):

1. Length is 1–1,024 UTF-8 bytes.
2. Every character is in U+0020–U+007E, excluding `\ : * ? " < > |`. This excludes control characters, non-ASCII,
   backslashes and drive letters.
3. Segments are split on `/`. Rejected:
   - empty segments (so no leading, trailing or doubled `/`);
   - `.` and `..`;
   - segments ending in space or `.`;
   - segments whose part before the first `.` is, case-insensitively, `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` or
     `LPT1`–`LPT9`.
4. Paths are checked in index order:
   - an exact duplicate gives `files.duplicate_path`;
   - an ASCII-case-insensitive duplicate gives `files.case_collision`;
   - a path that is a directory prefix of another, or has one as its prefix (case-insensitively), gives
     `files.path_conflict`;
   - every other violation of rules 1–3 gives `files.unsafe_path`.

   The later path is reported.

### 3.4 Apply algorithms and verdict precedence

The first failure is the verdict. Counters are part of the verdict, so every runner must count the same way.

**`full(blob, sha, size)`:** decode the zstd blob to exactly `size` bytes. A decoder error, wrong length or wrong
hash gives `full.corrupt`.

**`delta(base, d, artifact, skipBaseCheck = false)`**:

1. SHA-256(artifact) ≠ `d.artifactSha256` → `delta.artifact_mismatch`;
2. unless skipped (test-only), SHA-256(base) ≠ `d.from` → `delta.base_mismatch`;
3. raw-prefix decode:
   - any decoder error → `delta.apply_failed`;
   - length ≠ `d.size` or SHA-256 ≠ `d.to` → `delta.apply_failed`.

**`chunk(targetIndex, seeds[], fetch, sha, size, repair)`**:

1. Parse the target index (§3.1). Its payload binding must hold (`chunks.payload_mismatch`).
2. Build `S`: id → (seed, offset), taking the first occurrence over seeds in order and records in order. Local
   seeds were verified at install, so their chunks are **not** re-hashed on the fast path.
3. For each target record `i` in order:
   - if `id ∈ S`, copy from the seed;
   - else if `id` was already written, copy from the output;
   - else fetch.

   A fetched record joins the current **request run** if it is in the same bundle as the previous fetched record
   and its `offset == prev.offset + prev.clen`. Otherwise it starts a new run. One `Range` request fetches one run.
   A fetched record with fewer than `clen` bytes available gives `bundle.truncated {chunk: i}`. Otherwise it is
   decoded (raw if `clen == len`); a decoder error, wrong length or wrong SHA-256 gives `chunk.corrupt {chunk: i}`.

4. If SHA-256(output) ≠ `sha`:
   - without repair, the verdict is `payload.hash_mismatch`;
   - with repair, re-hash every seed-sourced record in order and refetch those that differ (same errors as step
     3), then re-check. Failing again gives `payload.hash_mismatch`.
5. Verdict: `{ok, sha256, size, fetchedChunks, fetchedBytes (Σ clen), requests (runs), seedChunks, selfChunks,
repairedChunks[]}`.

**`file(installedPayload, installedIndex, targetIndex, gaps, layout, fileDeltas, fileBlobs, sha, size)`**:

1. Apply the path rules to the target, giving `files.*` with the path.
2. For a container, check the layout (offsets non-decreasing, `payload.size` = expected, gaps length = Σ implied
   gaps). A failure gives `files.layout_mismatch`.
3. For each target file in order, take the first source that applies:
   - **Reuse:** an installed file with the same SHA-256 (the first match); the bytes are copied without hashing.
   - **Per-file delta:** a delta for this path whose `to` is this file's hash. If the installed index has no file
     with the delta's `from`, the verdict is `delta.base_mismatch {path}`. Otherwise the file is decoded by the
     `delta` algorithm above, with `{path}` attached to its errors.
   - **Blob:** a blob keyed by this file's SHA-256, decoded per its codec. A decoder error, wrong length or wrong
     hash gives `file.corrupt {path}`.
   - Otherwise the verdict is `file.source_missing {path}`.
4. Finish the output:
   - a container interleaves gaps and files, and a wrong payload hash gives `payload.hash_mismatch`;
   - a tree verifies every file, including reused ones (`file.corrupt {path}`), and reports `treeDigest`.
5. Counters: `reusedFiles`, `deltaFiles`, `blobFiles` and `downloadedBytes` (artifacts plus blobs; the index and
   gaps are excluded).

### 3.5 Error-code registry

| Stage       | Codes                                                                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chunk index | `chunks.bad_length`, `chunks.bad_magic`, `chunks.unsupported_version`, `chunks.bad_record_size`, `chunks.bad_flags`, `chunks.reserved_nonzero`, `chunks.zero_length`, `chunks.bad_clen`, `chunks.bad_bundle_ref`, `chunks.bad_bundle_range`, `chunks.size_mismatch`, `chunks.payload_mismatch` |
| chunk apply | `bundle.truncated`, `chunk.corrupt`, `payload.hash_mismatch`                                                                                                                                                                                                                                   |
| delta       | `delta.artifact_mismatch`, `delta.base_mismatch`, `delta.apply_failed`                                                                                                                                                                                                                         |
| files       | `files.unsafe_path`, `files.duplicate_path`, `files.case_collision`, `files.path_conflict`, `files.layout_mismatch`, `file.corrupt`, `file.source_missing`                                                                                                                                     |
| full        | `full.corrupt`                                                                                                                                                                                                                                                                                 |
| planner     | `plan.transport_unsupported`, `plan.insufficient_disk`, `plan.no_strategy`                                                                                                                                                                                                                     |

The codes are deliberately coarse per stage. For example, "the zstd decoder threw" and "the output hash differs"
are both `delta.apply_failed`, because decoders disagree on which one they report: libzstd reports a checksum error,
while a decoder that skips checksums returns wrong bytes. Coarse codes are what made 75/75 possible across ten
decoder configurations.

---

## 4. Install planner (language-neutral specification)

This concretises CONTENT §8.1. It is a **pure, integer-only function**; every value is a byte count below 2^53.

### 4.1 Input

```text
target:
  release        string
  payload        { sha256, size }
  full           { bytes } | null                  size of the full-download object
  platform       { transport } | null              non-null iff bound to a platform transport on this outlet
  chunks         { indexBytes, index: <blob ref> } | { indexBytes, records: [[id, len, clen, bundle, offset]…] } | null
  files          { indexBytes, gapsBytes, files: [{ sha256, blobBytes }…] } | null
  deltas         [{ id, method, from, memBytes, artifacts: [{ sha256, bytes }…] }…]
installed:       [{ release, payloadSha256, chunks: { index: <ref> } | { ids: […] } | null, files: [sha256…] | null }…]
caps:            { strategies: [...], patchMethods: [...], transports: [...], memBudget, freeDisk, requestWeight? }
```

### 4.2 Algorithm

```text
REQUEST_WEIGHT = 16384                     (default; caps.requestWeight overrides)
RANK = noop 0, platform 1, delta 2, chunk 3, file 4, full 5

1. if any installed.payloadSha256 == target.payload.sha256
       → {strategy: noop, bytes: 0, requests: 0, cost: 0, peakDisk: 0, fallbacks: []}
2. if target.platform != null:
       if target.platform.transport ∈ caps.transports → {strategy: platform, transport, fallbacks: []}
       else → {error: plan.transport_unsupported}          (never fall back to the CDN silently)
3. candidates:
   delta  if "delta" ∈ caps.strategies: for each d in target.deltas, in menu order (ord = index):
            feasible iff d.method ∈ caps.patchMethods and some installed.payloadSha256 == d.from
                     and d.memBytes ≤ caps.memBudget
            bytes = Σ d.artifacts[].bytes ; requests = |d.artifacts|
   chunk  if "chunk" ∈ caps.strategies and target.chunks != null and some installed has chunks:
            S = ∪ ids of every installed chunk index
            bytes = target.chunks.indexBytes ; runs = 0 ; prev = none ; seen = {}
            for r in target records, in order:
              if r.id ∈ S or r.id ∈ seen: continue            (does NOT reset prev)
              seen += r.id ; bytes += r.clen
              if prev == none or r.bundle ≠ prev.bundle or r.offset ≠ prev.offset + prev.clen: runs += 1
              prev = r
            requests = 1 + runs                                (1 = the index)
   file   if "file" ∈ caps.strategies and target.files != null and some installed has files:
            H = ∪ installed files ; M = unique target file hashes ∉ H, in order
            bytes = indexBytes + gapsBytes + Σ blobBytes(M)
            requests = 1 + (gapsBytes > 0 ? 1 : 0) + |M|
   full   if target.full != null (always allowed, whatever caps.strategies says):
            bytes = target.full.bytes ; requests = 1
   no candidates → {error: plan.no_strategy}
4. cost = bytes + w × requests      (w = caps.requestWeight ?? REQUEST_WEIGHT)
   peakDisk = target.payload.size + bytes            (staged downloads + output; conservative)
5. feasible = candidates with peakDisk ≤ caps.freeDisk ; none → {error: plan.insufficient_disk}
6. sort feasible by (cost, RANK, ord) ascending — a total order
7. chosen = first ; fallbacks = the rest in order, with every "full" moved to the end
   → {strategy, delta?, bytes, requests, cost, peakDisk, fallbacks: [{strategy, delta?, bytes, requests, cost}]}
```

### 4.3 Decisions in this spec, and why

- **The cost is bytes plus a request weight.** CONTENT §8.1's β·peakDisk and γ·cpu terms became constraints (disk,
  memory) instead of prices.
  - Measured CPU differences are small next to transfer: every strategy applies at 100+ MB/s, even in GDScript.
  - Pricing disk or CPU would need per-device constants that make the function non-portable.
- **The request weight is a capability input.** At 64 KiB, the real v1→v2 menu chose a 1.25 MB full download over
  a 0.56 MB chunk sync, because the chunk sync takes 22 requests (row `plan-real-no-delta-64k`).
  - 16 KiB is the default.
  - An SDK on a high-latency link, or in an iOS background session where many small requests are throttled [I],
    can raise it.
  - The conformance rows pin both behaviours.
- **The run rule is shared by the planner and the applier**, and the applier's `requests` counter is checked
  against it. A seeded record between two missing chunks does not break their run. This matters as soon as bundles
  are shared across releases: a new bundle holds only new chunks.
- **A pack bound to a platform transport the SDK lacks is an error, not a CDN fallback.** CONTENT §7 says one
  transport per outlet.
- **Tie-breaks are total:** cost, then strategy rank, then menu order. `plan-tie-rank` pins delta winning an exact
  tie with chunk.
- **Out of scope, belonging to UX policy rather than the pure function:**
  - metered/cellular consent;
  - the "replace in place, loses rollback" offer;
  - gap coalescing (fetching junk bytes to merge runs). That could become a v2 capability with its own rows.

### 4.4 The plan rows (`plan-matrix`)

Unless stated, the synthetic rows use this setup:

- a 10 MB target;
- a 4 MB full blob;
- ten 1 MB chunks at 400 KB each in one bundle, with the installed seed holding seven;
- five files, three of them installed;
- one 300 KB delta from the installed release.

| Row                             | What it pins                                                                               | Expected                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `plan-noop`                     | installed == target                                                                        | noop                                                                                                                                   |
| `plan-platform`                 | bound, SDK supports the transport                                                          | platform                                                                                                                               |
| `plan-platform-unsupported`     | bound to `play-pad`, SDK lacks it                                                          | `plan.transport_unsupported`                                                                                                           |
| `plan-delta-wins`               | baseline                                                                                   | delta 300,000 B (cost 316,384); then chunk, file, full                                                                                 |
| `plan-delta-other-base`         | delta starts from an uninstalled release                                                   | chunk 1,200,592 B, 2 requests; then file, full                                                                                         |
| `plan-delta-over-memory`        | `memBytes` > budget                                                                        | chunk                                                                                                                                  |
| `plan-delta-method-unsupported` | no `zstd-patch-from` in caps                                                               | chunk                                                                                                                                  |
| `plan-no-seed-index`            | no installed chunk index, no delta                                                         | file 1,203,000 B, 4 requests; then full                                                                                                |
| `plan-first-install`            | nothing installed                                                                          | full                                                                                                                                   |
| `plan-request-heavy`            | 50 scattered missing chunks                                                                | full; chunk (51 requests) is a fallback                                                                                                |
| `plan-tie-rank`                 | delta cost == chunk cost                                                                   | delta                                                                                                                                  |
| `plan-two-deltas`               | three deltas, two equal                                                                    | the first cheapest in menu order                                                                                                       |
| `plan-disk-limited`             | disk admits only delta and chunk                                                           | delta; fallbacks exclude file and full                                                                                                 |
| `plan-insufficient-disk`        | nothing fits                                                                               | `plan.insufficient_disk`                                                                                                               |
| `plan-two-seeds`                | two installed releases seed disjoint chunks                                                | chunk 400,592 B (only `c9`)                                                                                                            |
| `plan-run-rules`                | duplicate ids, a gap, a bundle change, a seeded record between two contiguous missing ones | chunk: 5 unique chunks, **3 runs**, 4 requests                                                                                         |
| `plan-full-always-last`         | full cheaper than file                                                                     | full still listed last                                                                                                                 |
| `plan-caps-full-only`           | `strategies: []`                                                                           | full                                                                                                                                   |
| `plan-request-weight`           | `requestWeight` 4 MiB                                                                      | full beats a 2-request chunk sync                                                                                                      |
| `plan-real-v1-v2`               | the set's own menu                                                                         | whole delta 311,529 B; then per-file delta set 345,603 B (33 objects), chunk 558,312 B (22 requests), file 665,655 B, full 1,246,961 B |
| `plan-real-no-delta`            | same, no delta support                                                                     | chunk                                                                                                                                  |
| `plan-real-low-memory`          | budget excludes the whole-payload delta                                                    | per-file delta set                                                                                                                     |
| `plan-real-no-delta-64k`        | `requestWeight` 65,536                                                                     | full                                                                                                                                   |

The per-file delta set costs 33 objects here because the vectors keep each artifact separate for simplicity. CI
should pack per-file frames and added-file blobs into one object (like a chunk bundle), making it one or two
requests [I].

---

## 5. Corpus encoding and runner expectations

**File shape** (`cases.json` plus a `blobs/` directory):

```text
{
  "contentCorpusVersion": 1,
  "description", "set", "params" (informative CI parameters),
  "payloads": { "v1": {sha256, size}, "v2": {sha256, size, fullZstdBytes} },
  "blobs": { "<relative path>": { "size", "sha256" } },        every file under blobs/
  "chunkIndexCases": [{ id, description, index: <ref>, expected }],
  "applyCases":      [{ id, description, strategy, …inputs…, expected }],
  "planCases":       [{ id, description, input, expected }],
  "pathCases":       [{ id, paths, expected }]
}
<ref>   = { "blob": "<path>", "codec"?: "zstd" | "none", "size"?: <decoded bytes>, "mutate"?: [<op>…] }
<op>    = {op: "truncate", length} | {op: "xor", offset, value}
        | {op: "putU16" | "putU32" | "putU64", offset, value}          (little-endian)
```

References are read in one of two ways:

- **Installed state** (seed payloads, delta bases, the installed payload, the gaps blob) is **materialised**: read
  the blob, decode it if `codec` is `zstd`, then apply the mutations.
- **The object under test** (a full blob, an artifact, a bundle, an index) is **raw**: the mutations apply to the
  stored bytes.

Negative cases are therefore mostly _mutations of shared blobs_. The 26 negative index and apply cases add no blobs:
24 are mutations and two reuse existing blobs differently.

**A runner must:**

1. Verify every blob against the `blobs` table first. A mismatch is a harness error, not a case failure.
2. Run each case through the SDK's real code path. The runner may inject local fetch functions, but it must not
   special-case ids.
3. Compare the verdict object with `expected` by **canonical JSON equality**: object keys unordered, arrays ordered,
   integers compared by value.
4. Report its runtime and library versions. A runner that lacks a capability must fail loudly, never skip, unless
   the case carries a `requires` field. No case needs one today; type-specific `godot.pck` vectors later would.

**Portability rules the runners forced:**

- **No U+0000 in JSON strings.** Godot's `JSON.parse_string` replaces it with U+FFFD, and a NUL-path case "passed"
  in Godot only because both sides went through the same lossy parser [M]. It is now a U+001F case.
- **Every zstd reference carries its decoded `size`.** Godot's `decompress(size, …)` and some one-shot APIs need
  it; chunk records already carry `len`.
- **Integers stay below 2^53.** JavaScript reads `u64` fields through `BigInt`, and Godot parses every JSON number
  as a float. The canonical comparison normalises integral floats.
- **Keep bytes in blobs, not base64 in JSON.** `cases.json` stays reviewable (283 KB), and every language already
  has file reads.
- GDScript runners must normalise `StringName` and `String` keys before canonicalising [M].

---

## 6. Results by language

| Runtime                                           | zstd                                                                                    | SHA-256                      | Shipped set | 37 MB set |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- | ----------- | --------- |
| Python 3.14.7                                     | stdlib `compression.zstd`, `ZstdDict(base, is_raw=True).as_prefix`, `window_log_max` 31 | `hashlib`                    | 75/75       | 75/75     |
| Python 3.11.15 / 3.9.25                           | `zstandard` 0.25.0, `DICT_TYPE_RAWCONTENT`                                              | `hashlib`                    | 75/75       | 75/75     |
| Node 22.22.2 / 22.19.0 / 24.6.0                   | `node:zlib` `zstdDecompressSync({dictionary, params: windowLogMax})`                    | `node:crypto`                | 75/75       | 75/75     |
| Node 22.22.2                                      | `zstd-napi` 0.0.13                                                                      | `node:crypto`                | 75/75       | 75/75     |
| Node 22.22.2                                      | the custom decoder-only WASM (§9.5)                                                     | `node:crypto`                | 75/75       | 75/75     |
| **Node 22.18.0**                                  | `node:zlib` (dictionary silently ignored)                                               | `node:crypto`                | **70/75**   | —         |
| Chromium 141 (worker, HTTP `Range`)               | `@bokuweb/zstd-wasm`                                                                    | WebCrypto / `@noble/hashes`  | 75/75       | —         |
| Chromium 141 (worker, HTTP `Range` and in-memory) | the custom WASM                                                                         | `hash-wasm` / WebCrypto      | 75/75       | 75/75     |
| OpenJDK 21.0.10                                   | zstd-jni 1.5.7-20 `ZstdDecompressCtx.loadDict` + one-shot                               | `MessageDigest`              | 75/75       | 75/75     |
| .NET 11.0 RC1                                     | built-in `ZstandardDecoder.SetPrefix`, `MaxWindowLog2` 31                               | `SHA256` / `IncrementalHash` | 75/75       | 75/75     |
| .NET 11.0 RC1 / .NET 10.0.12                      | `ZstdSharp.Port` 0.8.8 (unsafe `ZSTD_DCtx_refPrefix`)                                   | same                         | 75/75       | 75/75     |
| Godot 4.7.2 editor and release template           | `decompress(size, ZSTD)` + engine delta decoder via `GDDL` delta PCKs                   | `HashingContext`             | 75/75       | 75/75     |

Implementation sizes, including runner plumbing:

| Language   | Lines                                                                        |
| ---------- | ---------------------------------------------------------------------------- |
| Python     | 456 (library) + 129 (runner)                                                 |
| JavaScript | 314 (core, shared by Node and the browser unchanged) + 95 (case interpreter) |
| Java       | 504                                                                          |
| C#         | 517                                                                          |
| GDScript   | 690 (includes a 40-line PCK writer and the bench mode)                       |

The JavaScript core takes `{sha256, zstd}` as injected primitives. Its Node and browser runs differ only in those
two functions and in `fetch`, which is the shape `client-core` needs.

**Python.**

- The only 3.14 stdlib path that handles every base is **`ZstdDict(base, is_raw=True).as_prefix`**, and
  `as_prefix` is **not in the documentation** [D].
- The documented `as_digested_dict` and `as_undigested_dict` modes ignore `is_raw` on decompression. They fail on a
  base that begins with the dictionary magic [M]. That looks like a CPython bug worth reporting.
- 3.14 rejects windows over 128 MiB unless `window_log_max` is set [M].
- The SDK supports 3.9+, so `zstandard` (`DICT_TYPE_RAWCONTENT`) is needed until the floor reaches 3.14.

**Node.**

- `node:zlib` has zstd from **22.15.0** at Stability 1 (experimental) [D].
- The `dictionary` option is **silently ignored until 22.19.0 (and 24.6.0)**. 22.15–22.18 and 24.0–24.5 decode a
  `--patch-from` frame as if there were no dictionary and fail with "Data corruption detected" [M].
- The repo pins `engines: node >=22`, so the SDK must either require 22.19 or probe at startup: decode a tiny
  built-in prefix vector, and advertise `zstd-patch-from` in `caps.patchMethods` only if the probe passes.
- The decoder is always streaming, so `ZSTD_d_windowLogMax` must be passed for large windows.
- Throughput depends on `chunkSize`. At the default, whole-file decode runs at 320–400 MB/s; at 64 MiB it reaches
  578 MB/s, and delta decode 1,022 MB/s [M].

**Browser.** See §9.

**JVM (Kotlin/Android API).**

- zstd-jni's `ZstdDecompressCtx.loadDict(byte[])` maps to `ZSTD_DCtx_loadDictionary`, which auto-detects the type.
  The public API has no `refPrefix` [M].
- It passes every vector. It cannot decode a base that starts with the magic, hence the publish rule in §3.2.
- One-shot `decompress(byte[], size)` has no window cap. `ZstdInputStream` needs `setLongMax(31)` [M].

**.NET.**

- .NET 11's built-in decoder is the cleanest API tested: `SetPrefix`, `MaxWindowLog2`, `TryGetMaxDecompressedLength`
  [M/D]. `ZstandardDictionary.Create` auto-detects the dictionary type [M].
- .NET 10 has no zstd [M]. `ZstdSharp.Port` works, but its public `LoadDictionary` also auto-detects. Raw prefix
  needs its unsafe port of `ZSTD_DCtx_refPrefix`, reached here through a private handle field [M].
  - An SDK should wrap that in a tiny supported helper or ask upstream for a public `SetPrefix`.

**Godot.**

- A6's mechanism works unchanged as a general `patch_from(base, frame)` primitive: a host PCK exposes the base under
  a private path, and a delta PCK carries the `GDDL`-wrapped frame.
  - A run of the shipped set makes 66 such calls and 132 mounts.
  - The engine decoder is `ZSTD_DCtx_refPrefix` plus one-shot `ZSTD_decompressDCtx` [S: `core/io/delta_encoding.cpp`].
    It is immune to the magic trap and has no window cap [M].
- Output assembly must use `append_array`. A byte loop would run at A6's ~30 MB/s.
- Pack mounts cannot be undone, so each staging operation needs a unique private namespace.

---

## 7. Decoder behaviour matrices

**7.1 Raw-content prefix, and a base that begins with `37 A4 30 EC`** (a 440 KB synthetic base; `--patch-from`
frame from the zstd CLI) [M]:

| API                                                                  | Normal base | Magic base                                   |
| -------------------------------------------------------------------- | ----------- | -------------------------------------------- |
| zstd CLI `-d --patch-from`                                           | ok          | ok                                           |
| Godot engine delta decoder (refPrefix)                               | ok          | **ok**                                       |
| Python 3.14 `ZstdDict(is_raw=True).as_prefix`                        | ok          | **ok**                                       |
| Python 3.14 `…as_digested_dict` / `…as_undigested_dict` (documented) | ok          | **error**                                    |
| `zstandard` `DICT_TYPE_RAWCONTENT`                                   | ok          | **ok** (`DICT_TYPE_AUTO`: error)             |
| `node:zlib` `dictionary` (≥ 22.19)                                   | ok          | **error** (`ERR_ZLIB_INITIALIZATION_FAILED`) |
| `zstd-napi` `loadDictionary`                                         | ok          | **error**                                    |
| `@bokuweb/zstd-wasm` `decompressUsingDict`                           | ok          | **error**                                    |
| custom WASM (`ZSTD_DCtx_refPrefix`)                                  | ok          | **ok**                                       |
| zstd-jni `loadDict(byte[])` / `ZstdDictDecompress`                   | ok          | **error**                                    |
| .NET 11 `ZstandardDecoder.SetPrefix`                                 | ok          | **ok** (`ZstandardDictionary.Create`: error) |
| ZstdSharp unsafe `ZSTD_DCtx_refPrefix`                               | ok          | **ok** (`LoadDictionary`: error)             |

**7.2 Window over 128 MiB** (A6's 160 MB pair: 822,301 B frame, 153 MiB window) [M]:

| Library and mode                          | Default                                      | With an explicit `windowLogMax` 31                                     |
| ----------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `node:zlib` (streaming only)              | **fails** (`windowTooLarge`)                 | ok: 1.37 s via `zstdDecompressSync`, 1.17 s via `createZstdDecompress` |
| Python 3.14 `compression.zstd`            | **fails** ("Frame requires too much memory") | ok, 0.71 s                                                             |
| `zstandard` one-shot `decompress()`       | ok, 0.20 s                                   | —                                                                      |
| zstd-jni one-shot `decompress(byte[], n)` | ok, 0.93 s                                   | —                                                                      |
| zstd-jni `ZstdInputStream`                | **fails**                                    | ok with `setLongMax(31)`                                               |
| .NET 11 `ZstandardDecoder`                | ok, 0.93 s                                   | —                                                                      |
| ZstdSharp                                 | —                                            | ok, 0.23 s                                                             |
| custom WASM                               | ok, 1.03 s                                   | —                                                                      |
| `@bokuweb/zstd-wasm`                      | ok, 2.60 s                                   | —                                                                      |
| `zstd-napi`                               | ok, 2.36 s                                   | 1.47 s                                                                 |
| Godot engine                              | ok (A6 §2.4)                                 | —                                                                      |
| Chromium `dcz`                            | not offered (dictionary > 100 MiB, §9.3)     | —                                                                      |

The rule is simple: **one-shot `ZSTD_decompressDCtx` has no cap; every streaming decoder defaults to 2^27**.

**7.3 A `dcz` body (40-byte RFC 9842 header + the frame) fed to a plain zstd decoder** [M]. The header is a zstd
_skippable frame_, so in theory any decoder skips it. In practice:

- **ok:** Python `compression.zstd`, zstd-jni one-shot, ZstdSharp one-shot, the custom WASM (one-shot);
- **0 bytes, silently:** `node:zlib`; .NET 11 built-in (reports `Done`);
- **errors:** `zstandard` one-shot; Godot (`Destination buffer is too small`, because a skippable frame reports
  content size 0).

So **store the bare frame, and let the edge add the header** (§9.3).

**7.4 npm zstd packages** (Node 22, the shipped set's 1.18 MB → 5.26 MB frame and its delta) [M]:

| Package                     | License    | Plain decode | Dictionary / prefix API    | Prefix decode of the delta   |
| --------------------------- | ---------- | ------------ | -------------------------- | ---------------------------- |
| `node:zlib` (22.22)         | MIT        | ok           | `dictionary` (auto-detect) | ok                           |
| `zstd-napi` 0.0.13 (native) | Apache-2.0 | ok           | `loadDictionary`           | ok                           |
| `@bokuweb/zstd-wasm` 0.0.27 | MIT        | ok           | `decompressUsingDict`      | ok                           |
| `zstd-codec` 0.1.5          | MIT        | ok           | `decompressUsingDict`      | **aborts: OOM** (fixed heap) |
| `fzstd` 0.1.1 (pure JS)     | MIT        | ok           | none                       | —                            |
| `zstddec` 0.3.1             | MIT/BSD-3  | ok           | none                       | —                            |
| `@mongodb-js/zstd` 7.0.0    | Apache-2.0 | ok           | none                       | —                            |

---

## 8. Throughput

The 37 MB set: v1 37,001,008 B → v2 37,697,544 B. Every figure is output bytes per second, best of 3 or 5, warm,
single-threaded.

- "Delta decode" is the whole-payload 604,835 B frame over the 37 MB base.
- "Delta verified" adds three SHA-256 passes (artifact, base, output).
- "Chunk" is 81 fetched chunks (984,645 B in 29 runs) plus 1,450 seeded ones, with every fetched chunk hashed and
  the whole payload hashed.
- "File rebuild" is 24 per-file deltas plus 10 blobs and a gaps fill, with the final hash.

| Runtime                            | SHA-256 stream                                                     | zstd full decode (9.8 → 37.7 MB)         | Delta decode                       | Delta verified | Chunk                                                | File rebuild |
| ---------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------- | -------------- | ---------------------------------------------------- | ------------ |
| Python 3.14 stdlib                 | 372                                                                | 388                                      | 419                                | 126            | 206                                                  | 171          |
| Python 3.11 `zstandard`            | 378                                                                | 560                                      | 717                                | 152            | 215                                                  | 176          |
| Node 22.22 `node:zlib`             | 386                                                                | 319 (default) – 578 (`chunkSize` 64 MiB) | 339 – 1,022                        | 121            | 221                                                  | 231          |
| Java 21 zstd-jni                   | 331                                                                | 617                                      | 800                                | 137            | 236                                                  | 189          |
| .NET 11 built-in                   | 397                                                                | 227                                      | 2,429                              | 185            | 285                                                  | 240          |
| .NET 10/11 ZstdSharp               | 385–387                                                            | 493–555                                  | 2,075–2,110                        | 177–180        | 273–278                                              | 202–208      |
| Godot 4.7.2 release template       | 242                                                                | 568                                      | 423 (engine, incl. host-PCK write) | 97             | **161**                                              | 129          |
| Chromium 141, custom WASM          | WebCrypto one-shot 179; `hash-wasm` stream 202; `@noble/hashes` 98 | 302                                      | 694                                | —              | 136 (memory); **106 over HTTP `Range`**, 29 requests | —            |
| Chromium 141, `@bokuweb/zstd-wasm` | as above                                                           | 146                                      | 480                                | —              | 136; 98 over `Range`                                 | —            |

Chunk-index parsing of 1,531 records takes 0.1–3.7 ms in every language. The planner's real-menu row takes 3.1 ms
in GDScript.

Readings:

- **SHA-256 bounds everything on this host**, which lacks SHA-NI. The chunk strategy hashes about 1.15× the payload
  (the decoded bytes of fetched chunks, then the whole output) and copies the rest. It lands at 55–72% of raw SHA
  speed in every language. Skipping per-chunk hashes of seeded chunks, as the spec does, is what keeps it there.
- GDScript's chunk sync at 161 MB/s (80–100 MB/s on A6's slower host) is within 1.3–1.8× of native.
- The browser is about 2× slower than native, mostly from WASM copies and SHA-256.
- The **.NET 11 RC1** built-in whole-file decode (227 MB/s) is slower than ZstdSharp on the same runtime. Its delta
  decode is the fastest measured. Re-measure at GA.

---

## 9. Browser specifics (Chromium 141, measured)

### 9.1 Decompression and hashing APIs

- **`DecompressionStream` and `CompressionStream`** accept only `gzip`, `deflate` and `deflate-raw`, in both the
  page and the worker. `br`, `brotli` and `zstd` throw [M]. The Chrome and MDN documentation list the same three
  formats [D].
- **HTTP content encodings.** Chromium sends `Accept-Encoding: gzip, deflate, br, zstd`, and adds `dcb, dcz` when a
  dictionary matches [M]. Native zstd exists only there: a _full_ blob served with `Content-Encoding: zstd` needs no
  WASM, but a `Range` slice of a chunk bundle does.
- **SHA-256.** WebCrypto `digest` is one-shot and async: 179–183 MB/s whole-buffer, 178–196 MB/s per 64 KiB chunk.
  For a streaming whole-payload hash without holding the payload in memory:
  - `hash-wasm` (MIT): 201–202 MB/s;
  - `@noble/hashes` (MIT, pure JS): 98–103 MB/s [M].

### 9.2 Storage and fetching

- **OPFS** (`navigator.storage.getDirectory()` + `createSyncAccessHandle()` in a dedicated worker) works [M]:
  - 128 MiB of sequential 1 MiB writes at 93–131 MB/s;
  - reads at 518–536 MB/s;
  - 128 scattered 64 KiB writes in 106–121 ms;
  - reported quota 921–944 MB in a fresh headless profile.

  This is the right place for `.part` files and seeds. Godot's web `user://` is IDBFS held in memory, so a web
  Godot build should keep payloads in OPFS through page JavaScript (A6 §2.6).

- **`Cache.put` of a 206 response** throws `TypeError: Partial response (status code 206) is unsupported` [M].
- **`fetch` with `Range`** returns 206. The applier issues one request per run: 29 for the 37 MB chunk case,
  357–387 ms end to end on localhost [M].

### 9.3 Compression Dictionary Transport applies the vector delta natively [M]

The local server:

1. served `v1` with `Use-As-Dictionary: match="/cdt/*"`;
2. on the next request (`/cdt/v2.pck`), received `Available-Dictionary: :<base64 SHA-256 of v1>:` from Chromium;
3. answered `Content-Encoding: dcz` with the RFC 9842 header followed by **the vector's own
   `deltas/v1-v2.pf.zst`**.

The browser decoded it natively to v2's exact SHA-256:

- 5.26 MB from 311,569 B;
- 37.7 MB from 604,875 B in 612 ms.

No JavaScript decoder was involved.

Limits:

- **Dictionary size is capped at 100 MiB.** A bisection in fresh contexts found 104,857,600 B offered and
  104,857,601 B not [M]. Chromium defines `kDictionarySizeLimit = 100 * 1024 * 1024` [S].
- **There is also a per-site budget.** After 8 and 64 MiB dictionaries in one context, a 99 MiB one was not
  offered [M]. Chromium runs per-site eviction off its dictionary cache size [S].
- **Protocol rules** (RFC 9842) [D]:
  - secure contexts only (localhost counts);
  - same-origin match patterns;
  - `dcz` clients must accept windows of at least max(8 MB, 1.25 × dictionary), up to 128 MB.
- **Browser coverage:** Chromium-based browsers only (Chrome/Edge 130+); Firefox and Safari do not implement it
  [D].
- **The dictionary lives in the evictable HTTP cache**, so the client must still verify SHA-256(output) = `to` in
  JavaScript, and fall back when it is not offered.

Serving recipe for the Worker [I]:

- Serve full payloads with `Use-As-Dictionary`.
- For a delta route, when `Available-Dictionary` equals base64(`from`) of a published `zstd-patch-from` descriptor,
  stream `5E 2A 4D 18 20 00 00 00 || hex_decode(from) || artifact` from R2 with `Content-Encoding: dcz` and
  `Vary: Accept-Encoding, Available-Dictionary`.

That header needs no base bytes, and the stored artifact stays the portable bare frame (§7.3). This moves README
P4 v3's "web Compression Dictionary Transport" from speculative to demonstrated. It is limited to payloads of
100 MiB or less, in Chromium.

### 9.4 Byte-level fallbacks in the browser

A WASM zstd decoder with prefix support is still needed for:

- chunk sync (per-chunk frames inside `Range` slices);
- Firefox and Safari;
- payloads over 100 MiB;
- cold or evicted dictionaries.

### 9.5 A vendored decoder-only libzstd WASM

zstd 1.5.7's decoder sources (`lib/common` + `lib/decompress`) were compiled with `clang --target=wasm32
-nostdlib -ffreestanding -mbulk-memory`:

- a 46-line C shim provides a bump allocator, `memcpy`/`memset` builtins and exports around `ZSTD_DCtx_refPrefix` +
  `ZSTD_decompressDCtx`;
- five stub libc headers complete the build;
- a 24-line JS loader completes it.

| Build | Size         | Gzipped  |
| ----- | ------------ | -------- |
| `-O3` | **68,949 B** | 24,110 B |
| `-Oz` | 56,506 B     | 19,225 B |

It passes all 75 cases in Node and Chromium and decodes the magic base and the 153 MiB window. It runs at 302 MB/s
(whole file) and 694 MB/s (delta) in Chromium, about **2× `@bokuweb/zstd-wasm`**, which is emscripten, 252 KB with
the compressor, and uses bundler-style extensionless imports that needed server-side resolution to load unbundled
[M]. Its license is BSD-3-Clause (zstd's dual license, taking BSD).

This is the recommended dependency for `sdk-react`. The same `.wasm` also serves `sdk-node` on Node < 22.19.

---

## 10. From documentation: Swift, Kotlin/Android, C#/.NET

### 10.1 Swift / Apple

- **The Compression framework has no zstd [D].** `compression_algorithm` lists LZ4, LZ4_RAW, ZLIB, LZMA, LZFSE,
  LZBITMAP and BROTLI, plus LZMESH and LZRAVEN, introduced at iOS/iPadOS/tvOS/visionOS/watchOS 27.0. CONTENT §13's
  "vendored libzstd" is confirmed.
- **Candidate packages:**
  - **The official `facebook/zstd` repository ships a `Package.swift`** [M: read in the 1.5.7 source]. It has
    product `libzstd`, a C target over `lib/{common,compress,decompress,dictBuilder}`, swift-tools 5.0, and
    platforms macOS 10.10 / iOS 9 / tvOS 9. Swift imports the C API directly, so `ZSTD_DCtx_refPrefix` (stable
    since 1.4.0 [D: zstd manual]), `ZSTD_d_windowLogMax` and `ZSTD_decompressDCtx` are available with no wrapper.
    **Recommended:** a small local package over the decoder-only sources (as in §9.5) to avoid shipping the
    compressor.
  - **`SwiftZSTD`** (omniprog, mirrored as aperedera) wraps compression and decompression with "dictionaries …
    supported, but not with streaming". It documents no dictionary type and no prefix API [D], so it is
    insufficient on its own.
- **Hashing:** CryptoKit `SHA256` streams via `init()`, `update(data:)` / `update(bufferPointer:)` and `finalize()`
  [D]. The Swift SDK already uses CryptoKit.
- **Background downloads with `URLSession`** [D]:
  - `URLSessionConfiguration.background(withIdentifier:)`, `sessionSendsLaunchEvents`, `isDiscretionary` for
    non-urgent transfers, and `earliestBeginDate`;
  - "downloads that use a background configuration will handle resumption automatically".
  - Manual resume (`cancel(byProducingResumeData:)` → `downloadTask(withResumeData:)`) requires all of:
    - the resource is unchanged;
    - `GET`;
    - an `ETag` or `Last-Modified` header;
    - **byte-range support**;
    - the temp file has not been purged.

  Implications [I]:

  - Content-addressed, immutable R2 objects with strong ETags satisfy these conditions.
  - A chunk run can be a background download task whose `URLRequest` carries a `Range` header. The applier then
    consumes completed files.
  - Background sessions are discretionary and coarse, so the iOS SDK should raise `requestWeight`, fetch whole
    bundles, or prefer a delta.

- **Background Assets** (managed, OS 26+; `AssetPackManager`) is covered in `notes/E1` §E. The platform downloads
  and patches, with no documented differential. Polaris Key then verifies the marker and files index (CONTENT §7).
  It is **bound to Swift and the Godot-iOS plugin**.

### 10.2 Kotlin / Android

- **Android's public API has no zstd** (`java.util.zip` is deflate) [D/I]. **zstd-jni** (BSD-2-Clause) publishes an
  Android `.aar` on Maven Central [M: `1.5.7-20`]:
  - native libraries for arm64-v8a (476 KB), armeabi-v7a (363 KB), x86 (552 KB) and x86_64 (547 KB), compressor
    included;
  - `minSdkVersion 21`;
  - the same Java API measured in §6: `loadDict` auto-detects, the one-shot decode is uncapped, streams need
    `setLongMax`.

  The `.so` files were not executed on a device.

- **Hashing:** `MessageDigest.getInstance("SHA-256")` streams via `update`/`digest` [D]. On ARMv8 the platform
  provider uses the SHA-2 instructions [I], so phones may hash faster than this x86 host.
- **Background transfer** [D]:
  - WorkManager long-running workers (`setForeground`, a foreground service) on all versions;
  - on **Android 14+, user-initiated data transfer jobs** (`JobInfo.Builder.setUserInitiated(true)`, the
    `RUN_USER_INITIATED_JOBS` permission, a mandatory notification, and `setEstimatedNetworkBytes`). Google notes
    "There is currently no Jetpack library that supports UIDT jobs", with WorkManager as the fallback below 14.

  Neither does `Range` or resume for you. The SDK issues `Range` requests itself inside the job, and the journal in
  CONTENT §10 makes that resumable.

- **Play Asset Delivery** (`AssetPackManager.getPackLocation()` → `assetsPath()`) is covered in `notes/E2`. It is
  **bound to Kotlin and the Godot-Android plugin**.

### 10.3 C# / .NET

- **.NET 11 adds `System.IO.Compression.ZstandardStream`, `ZstandardEncoder`, `ZstandardDecoder`,
  `ZstandardDictionary` and the option types** [M: reflected from the RC1 runtime; D: Microsoft Learn,
  `net-11.0` moniker].
  - `ZstandardDecoder` exposes `SetPrefix(ReadOnlyMemory<byte>)`, `ZstandardDecompressionOptions.MaxWindowLog2`
    and `TryGetMaxDecompressedLength`.
  - It is marked `[UnsupportedOSPlatform("browser")]` and `("wasi")`, so **Blazor WebAssembly still needs a managed
    port**.
  - .NET 11 is at RC1 (a "go-live" release) [M: release index]. General availability is expected in November 2026
    [I].
- **.NET ≤ 10 has no zstd** [M]. **`ZstdSharp.Port`** (MIT; pure managed; targets netstandard2.0/2.1, net462 and
  net5–9) runs everywhere, including Unity (.NET Standard profile), Blazor and mobile. Raw prefix goes through its
  `ZSTD_DCtx_refPrefix` port (§6). `ZstdNet` (a native wrapper) was not tested.
- **Hashing:** `IncrementalHash.CreateHash(HashAlgorithmName.SHA256)` for streaming, `SHA256.HashData` for one-shot
  [M].

---

## 11. Cross-cutting conclusions

### 11.1 Portable with each platform's own primitives

These work in every SDK language:

- SHA-256, including streaming (browsers need `hash-wasm` or `@noble/hashes` for streaming);
- `pkey-chunks/1` parsing (`DataView`, `struct`, `ByteBuffer`, `BinaryPrimitives`, `decode_u32`);
- JSON;
- HTTP `Range`;
- run grouping;
- **type-neutral container rebuild** from `pkey-files/1` offsets plus a gaps blob;
- the path rules (ASCII by construction);
- the planner, a pure integer function.

`zstd` plain decode is native in Python 3.14, Node ≥ 22.15, .NET 11 and Godot. **zstd raw-prefix decode**, the
delta, is native in Python 3.14 (`as_prefix`), Node ≥ 22.19/24.6, .NET 11 (`SetPrefix`) and Godot (engine
internals, A6). In the browser it is native only via `dcz`.

### 11.2 One small dependency per SDK (none for Godot)

| SDK              | zstd with raw prefix                                                                                                                               | License                             | Notes                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| Node / Electron  | none on ≥ 22.19; otherwise the shared WASM decoder (BSD-3) or `zstd-napi` (Apache-2.0, native prebuilds)                                           | —                                   | probe at startup; set `windowLogMax`                |
| React / browser  | vendored decoder-only libzstd WASM (BSD-3-Clause, 69 KB / 24 KB gz) or `@bokuweb/zstd-wasm` (MIT, 252 KB); `hash-wasm` (MIT) for streaming SHA-256 | BSD-3 / MIT                         | `dcz` where available; OPFS for staging             |
| Python           | none on ≥ 3.14 (`as_prefix`); `zstandard` for 3.9–3.13                                                                                             | BSD-3-Clause                        | set `window_log_max` / `max_window_size`            |
| Swift            | libzstd from the official `facebook/zstd` SwiftPM package, ideally a decoder-only target                                                           | BSD-3-Clause (dual GPLv2; take BSD) | CryptoKit for SHA-256                               |
| Kotlin / Android | zstd-jni `.aar`                                                                                                                                    | BSD-2-Clause                        | no raw-prefix API → CI publish rule (§3.2)          |
| C# / .NET, Unity | none on .NET 11 (not browser/WASI); `ZstdSharp.Port` for ≤ 10, Unity and Blazor                                                                    | MIT                                 | wrap the unsafe prefix call                         |
| Godot (GDScript) | none: engine `decompress` + `GDDL` delta decoder                                                                                                   | —                                   | pin the `GDDL` method per engine `major.minor` (A6) |

### 11.3 Platform-bound

These stay per-SDK adapters behind the `platform` strategy, and are verified afterwards by the same files index and
hashes:

- Apple Background Assets: Swift, plus the Godot-iOS plugin;
- Play Asset Delivery: Kotlin, plus the Godot-Android plugin;
- Steam depots: native Steamworks bindings (GodotSteam, Steamworks.NET);
- MSIX optional packages: the Windows packaging APIs;
- `dcz`: Chromium browsers;
- OPFS sync handles: browser workers.

### 11.4 What `client-core` should hold

- the chunk-index parser;
- the chunk, file, full and delta orchestration with injected `{sha256, zstd, fetch}`;
- the planner;
- the path rules;
- the error registry.

That is the shape that passed unchanged in Node and Chromium here. Python, Swift, Kotlin, C# and GDScript each
reimplement about 450–700 lines, a size measured here for five of them.

### 11.5 Corpus plan (a plan-mode, all-languages event per CLAUDE.md)

- **Where:** add a content corpus beside the JWS corpus, for example under `conformance/corpus/`, generated by the
  corpus tooling with the same `--check` drift gate. §2.1 showed regeneration is deterministic.
- **Mirror:** into the Swift test resources, as `cases.json` already is.
- **Budget:** keep the shipped set under 5 MB. The 37 MB set belongs in CI performance jobs, not the corpus.
- **Join with the JWS corpus:** pack release records (`pkey-release+jws`, `kind: pack`) belong to the JWS corpus
  and pin the content vectors' hashes (payload, files index, chunk index, artifacts). The two corpora join through
  blob SHA-256s, so no signing key enters the content vectors.
- **Runners:**
  - the TypeScript runner in `conformance/runners/node`, reusing `client-core`, plus a Chromium job over the same
    core with the WASM decoder;
  - pytest;
  - `swift test`;
  - a Godot headless job on both the editor and the release template, because `GDDL` is engine-internal;
  - Kotlin and .NET when those SDKs exist.

  Every runner reports its library versions. The Node runner also runs on the minimum supported Node, which is how
  the 22.18 silent-ignore failure would have been caught.

- **CI-side lint:** a check refusing the `37 A4 30 EC` base and enforcing "single frame with content size" for
  chunks. It belongs in the pack publisher, with its own vectors.

---

## 12. Consequences for CONTENT.md, E8 and the README

| Where                     | Current text                                                                            | Finding                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CONTENT §9 chunk index    | "a 64-byte header, then fixed 48-byte … records"                                        | Header defined (§3.1): magic, version, recordSize, flags, counts, payloadSize, **payloadSha256**, plus a trailing **bundle table** in 48-byte records, a validation order and error codes.                                      |
| CONTENT §9 files index    | `{path, size, sha256, mode, chunks[]}`                                                  | Add `offset` and `layout: container`, plus a **gaps blob**. The `file` strategy then rebuilds any container without a type-specific writer. Path rules made ASCII-portable (§3.3).                                              |
| CONTENT §8.1 planner      | `cost = bytes + α·requests + β·peakDisk + γ·cpu`                                        | α becomes `caps.requestWeight` (default 16 KiB); disk and memory become constraints; tie-breaks are total; the run rule is shared with the applier (§4). The 23 rows are a first `plan-matrix`.                                 |
| E8 §5.4 patch descriptor  | `params.windowLog: 27`                                                                  | The window is at least the larger file (153 MiB for 160 MB). Clients must set `windowLogMax` explicitly; decoders must use raw-prefix mode; CI must refuse the magic base.                                                      |
| CONTENT §13 per-SDK table | Node "delta (zstd/HDiffPatch)"; React "chunk (OPFS), full"; Python "chunk, delta, full" | Node: `node:zlib` ≥ 22.19, else the WASM decoder. React: add **delta via `dcz`** (≤ 100 MiB, Chromium) with the WASM fallback. Python: stdlib from 3.14. Swift "vendored libzstd" confirmed; the official SwiftPM package fits. |
| CONTENT §17 Q4            | browser throughput unknown                                                              | Desktop Chromium measured (§8): SHA-256 ~200 MB/s, WASM zstd 300 MB/s, chunk sync 106–136 MB/s. Mobile remains open.                                                                                                            |
| README P4 v3              | "web Compression Dictionary Transport"                                                  | Works today in Chromium with the unchanged `--patch-from` artifact plus a 40-byte header at the edge (§9.3).                                                                                                                    |
| A6 GDScript snippets      | `decompress(size, ZSTD)`                                                                | Every zstd object in manifests and vectors must carry its decoded size.                                                                                                                                                         |

---

## 13. Limits

- **No Swift toolchain or Apple hardware; no Kotlin compiler or Android device.** Kotlin is represented by the same
  zstd-jni Java API on the JVM, and the `.aar`'s native libraries were not executed.
- **One browser engine**, headless Chromium 141 on Linux. Firefox, Safari and mobile browsers were not run.
- **Localhost networking:** `Range` and `dcz` timings exclude real RTT and CDN behaviour, and the Worker and R2
  were not exercised. The `dcz` server was a local Node process.
- **One synthetic content pair** from A6 (textures dominate). Single host, warm cache, best-of-N timings.
- **.NET 11 is RC1.**
- **ZstdSharp's raw-prefix call used reflection** on a private field. That is a test harness, not a design.
- **The 160 MB window case was run once per decoder** on a 16 GB host.
- **The per-file delta set's request count** reflects separate objects; production packing is inferred.

---

## 14. Reproduction

The experiment's sources now live in [`prototype/content/`](../prototype/content/README.md). Its README
has the prerequisites, the environment variables and step-by-step commands; the paths below are relative
to it. The input packs come from [`prototype/patching/`](../prototype/patching/README.md) (`PACKS_DIR`).

- **Generator** (the CI stand-in): `gen/gen.py small|large <dir>` (Python 3.14 + zstd CLI + `fastcdc.cjs`);
  planner rows in `gen/planref.py`.
- **Reference implementation:** `runners/python/pkey_content.py`; runner `runcases.py <dir> stdlib|zstandard`.
- **JavaScript core:** `runners/js/content.mjs` and `cases.mjs`.
  - Node: `runners/node/run.mjs <dir> zlib|zstd-napi`, `run-wasm.mjs`.
  - Browser: `runners/browser/{server.mjs,index.html,worker.mjs,drive.mjs,cdtcap.mjs,zstddec-prefix.mjs}`.
- **JVM:** `jvm/Runner.java` (`<dir> [bench]`), built by `jvm/build.sh`.
- **.NET:** `dotnet/runner/Program.cs` (`-p:TF=net10.0|net11.0`; `ZSTD=builtin|sharp`; `probe` and `bench` modes).
- **Godot:** `runners/godot/content_runner.gd` (`--script` on the editor; exported `.pck` + `linux_release`
  template for the bench).
- **WASM decoder:** `wasm/zdec.c`, built by `wasm/build.sh`.
- **Probes:** `probe/` (magic base, 153 MiB window, `dcz` body) and `npm/probe.mjs` (npm packages).
- **Throughput:** `bench/` (Python and Node) and the runners' `bench` modes.
- **Everything at once:** `run-all.sh small|large`.

---

## 15. Sources

- zstd manual (`ZSTD_DCtx_refPrefix`, `ZSTD_d_windowLogMax`): https://facebook.github.io/zstd/zstd_manual.html ;
  zstd 1.5.7 sources incl. `Package.swift`: https://github.com/facebook/zstd/releases/tag/v1.5.7
- Godot `core/io/delta_encoding.cpp` (4.7.2-stable):
  https://github.com/godotengine/godot/blob/4.7.2-stable/core/io/delta_encoding.cpp
- Node `zlib` (zstd added v22.15.0, Stability 1): https://nodejs.org/docs/latest-v22.x/api/zlib.html
- Python `compression.zstd`: https://docs.python.org/3.14/library/compression.zstd.html ; python-zstandard:
  https://python-zstandard.readthedocs.io/en/latest/
- zstd-jni: https://github.com/luben/zstd-jni ; Maven Central artifacts:
  https://repo1.maven.org/maven2/com/github/luben/zstd-jni/
- .NET `ZstandardDecoder`:
  https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandarddecoder?view=net-11.0 ; .NET release
  index: https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json ; ZstdSharp:
  https://github.com/oleg-st/ZstdSharp
- npm packages: https://github.com/bokuweb/zstd-wasm , https://github.com/dritchie/zstd-napi ,
  https://github.com/101arrowz/fzstd , https://github.com/mongodb-js/zstd , https://github.com/Daninet/hash-wasm ,
  https://github.com/paulmillr/noble-hashes
- Apple: https://developer.apple.com/documentation/compression/compression_algorithm ,
  https://developer.apple.com/documentation/cryptokit/sha256 ,
  https://developer.apple.com/documentation/foundation/downloading-files-in-the-background ,
  https://developer.apple.com/documentation/foundation/pausing-and-resuming-downloads ,
  https://developer.apple.com/documentation/foundation/urlsessiondownloadtask/cancel(byproducingresumedata:) ,
  https://developer.apple.com/documentation/backgroundassets/assetpackmanager ; SwiftZSTD:
  https://github.com/omniprog/SwiftZSTD
- Android: https://developer.android.com/develop/background-work/background-tasks/uidt ,
  https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running ,
  https://developer.android.com/guide/playcore/asset-delivery/integrate-java ,
  https://developer.android.com/reference/java/security/MessageDigest
- Web: RFC 9842 Compression Dictionary Transport: https://www.rfc-editor.org/rfc/rfc9842.html ; Chromium
  `services/network/shared_dictionary/shared_dictionary_constants.cc`:
  https://chromium.googlesource.com/chromium/src/+/HEAD/services/network/shared_dictionary/ ; Chrome blog on
  compression dictionaries: https://developer.chrome.com/blog/search-compression-dictionaries ; Compression Streams:
  https://developer.chrome.com/blog/compression-streams-api ; OPFS sync access handle:
  https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle ; `Cache.put`:
  https://developer.mozilla.org/en-US/docs/Web/API/Cache/put
