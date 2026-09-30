> Research note for [Godot on Polaris Key](../README.md), 2026-09-29.

# A6: Patching and content updates from a pure-GDScript client on Godot 4.7.2, empirical results

Run 2026-09-29, interrupted by a container restart, then resumed and **every experiment re-run**
on 2026-09-30. All numbers below come from the re-run. Engine: **Godot 4.7.2-stable (official,
`ed1daf0bf`)**, headless editor binary and the official `linux_release` export template. Host: a
4-vCPU Intel Xeon @ 2.10 GHz container, 16 GB RAM, Linux, warm page cache. No GDExtension anywhere;
every client-side step is GDScript calling stock engine APIs. The repo was not modified apart from
this note. The code now lives in [`prototype/patching/`](../prototype/patching/README.md); script
names below (`t0_fingerprint.gd` …) refer to it. Generated artefacts are not kept.

Evidence markers: **[M]** measured here, **[S]** read in the 4.7.2 engine source, **[I]** inference.

Question being answered: E8 (§2.3–2.4, §3.3, §5) proposes chunk-sync from CI-computed FastCDC
indexes with a thin client that only does SHA-256 + zstd + HTTP Range. README §3.7 proposes
`zstd --patch-from` deltas and warns against Godot's in-PCK delta patches. Which patching and
content-update methods can a **pure-GDScript client actually execute** on 4.7.2, for which pack
types, at what size and CPU cost?

## TL;DR

| Question                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can GDScript apply `zstd --patch-from` deltas?           | **Yes, at native speed**, although `PackedByteArray.decompress` cannot (no prefix/dictionary parameter; it returns 0 bytes on a patch-from frame) [M]. Prefix the frame with the 5-byte `GDDL\x01` header, list it as a `PACK_FILE_DELTA` entry in a tiny PCK written from GDScript, mount it, and the engine's own delta decoder does the work [M]. Works per file and whole-file (36 MB in ~50 ms decode; 160 MB also worked). |
| Godot-native delta patch PCKs (`--export-patch` + delta) | Work from `user://`: 1.31 MB raw / **602 KB** zstd for our 36 MiB pack (full zstd: 9.8 MB) [M]. Cost on every open of a patched file: 2.8 MB texture **0.38 → 3.25 ms** (depth 1), ~5.4 ms (depth 2) [M]. Must be mounted **with `replace_files=true`**, or the exporter's non-delta entries are silently dropped [M].                                                                                                           |
| Are re-exports deterministic?                            | Same imported project: **byte-identical** (packs, patches, zips) [M]. Clean re-import of the same sources: **one file differs**, `.godot/uid_cache.bin` (24 bytes: fresh UIDs for the three CSV-generated `.translation` files) [M]. A base that differs inside bytes a delta copies from fails loudly with a zstd checksum error at first load, not at mount [M].                                                               |
| Client-side PCK rebuild in GDScript                      | Works and verifies. A 60-line GDScript PCK writer is **byte-identical to the exporter** (whole-pack SHA-256 matches CI): 42 ms build + 167 ms SHA-256 for 36 MB [M]. `PCKPacker` output is data-identical but its directory order differs, so only per-file hashes can verify it [M].                                                                                                                                            |
| Chunk-sync (E8)                                          | Works exactly as E8 describes: 424 chunks, 7.5 MB fetched raw (**1.82 MB** as zstd-per-chunk), reassembled and verified at **~80–100 MB/s** on the release template [M]. File-aware FastCDC (chunks never straddle PCK entries) halves the bytes: **985 KB** at 64 KiB average [M]. Fixed blocks and whole-pack-compressed inputs gain nothing [M].                                                                              |
| Best bytes for one N−1→N pair                            | ~600 KB for all of: native delta PCK, whole-pack `--patch-from`, per-file `--patch-from` [M]. File-aware CDC 64 KiB is 985 KB but serves any older version [M].                                                                                                                                                                                                                                                                  |
| Pure-GDScript delta formats                              | Copy/add ("VCDIFF-lite") applies at ~790 MB/s because it is `seek` + `get_buffer` + `store_buffer` [M]. Anything byte-wise (bsdiff) is **~32 MB/s** and client-side rolling hashes **~20 MB/s**: not viable [M].                                                                                                                                                                                                                 |
| ZIP packs                                                | Mount and load correctly (deflated or stored) [M], but **`replace_files=false` is ignored** (the last-mounted zip always wins), there are no removals or deltas, no offset mounting, and reads are ~1.8× slower than PCK [M/S]. Deflated zips chunk poorly [M].                                                                                                                                                                  |
| Loose files in `user://`                                 | JSON, PO, `.translation`, OGG, WAV, TTF and any **pre-imported** artefact (`.ctex`, `.oggvorbisstr`, `.sample`, `.fontdata`, exported `.res`/`.scn`) load straight from `user://` in 0.1–4 ms [M]. **Runtime texture compression is absent from official templates** (`Image.compress` → error), so loose PNGs become uncompressed textures [M].                                                                                 |
| Mount semantics that bite                                | No unload; a newer pack at a **new path** works immediately but cached resources stay stale and removed files stay visible [M]. **Overwriting a mounted pack file corrupts reads**, and re-mounting it can return **wrong bytes** for stale entries [M]. Offset mounting works (containers, appended trailers) but the offset is a 32-bit `int`: >2 GiB fails [M/S].                                                             |
| UIDs                                                     | A pack's UIDs register from its own `.godot/uid_cache.bin` on mount, including `PCKPacker`-built packs that carry that file [M]. Mounted with `replace_files=false`, the pack's cache is shadowed and **none of its UIDs register** [M].                                                                                                                                                                                         |
| Web                                                      | Source-level only: `user://` is an Emscripten IDBFS mirror, so **every byte in `user://` is held in memory for the whole session** and written back to IndexedDB as whole files [S]. Not run in a browser.                                                                                                                                                                                                                       |

**Recommended client ladder** (§4): `noop → platform → engine-delta bake (per-file --patch-from under a
private namespace) → file-aware chunk-sync → per-file download + rebuild → full`. Everything
reconstructs a full pack, verifies its SHA-256 against the signed record, and only then mounts it
at a new content-addressed path at next boot.

---

## 1. Setup

### 1.1 Test content

A synthetic but realistic Godot 4.7 project (generator in `prototype/patching/tools/gen_project.py`), exported for
Linux with S3TC/BPTC textures:

| Content                                    | Count | Source size | In the PCK                                          |
| ------------------------------------------ | ----- | ----------- | --------------------------------------------------- |
| Icons, 128 px, lossless import             | 110   | 1.9 MB      | `.ctex`                                             |
| Textures 512/1024/2048, VRAM S3TC, mipmaps | 57    | 10.1 MB     | `.s3tc.ctex` (textures are 82% of the pack's bytes) |
| OGG music / WAV sfx                        | 10/40 | 3.3 MB      | `.oggvorbisstr` / `.sample`                         |
| JSON level data                            | 120   | 3.9 MB      | raw `.json`                                         |
| `.tres` materials and data tables          | 18    | 1.3 MB      | exported binary `.res`                              |
| `.tscn` scenes, `.gd` scripts, TTF fonts   | 7/4/2 | 0.3 MB      | `.scn`, `.gdc`, `.fontdata`                         |
| CSV translations (3 locales) + PO          | 2     | 35 KB       | `.translation` ×3 + `.po`                           |

`v1.pck` = 37,001,008 B (620 entries); `v2.pck` = **37,697,544 B (36.0 MiB, 625 entries)**, zstd -19
**9,796,975 B**. v1→v2 changes 21 source files (local edits in 4 textures, a global tint of one 2048²
texture and 3 icons, 5 JSON tweaks, one re-rendered OGG, 2 WAVs, a material, a data table, the CSV, a
scene, a script), adds 6 and removes 3. In the PCK that is **24 changed entries, 10 added, 5 removed**.

### 1.2 Harness

- Exports: `godot --headless --verbose --path proj --export-pack Linux out.pck`, `--export-patch
Linux|LinuxDelta out.pck --patches v1.pck`, and the same with `.zip` outputs. Preset `LinuxDelta`
  sets `patch_delta_encoding=true` (level 19, min reduction 10%).
- Offline tools (Python/Node, CI stand-ins): a PCK v2–v4 reader/writer, a FastCDC port (normalised
  chunking, level 1; plain and file-aware modes), a "VCDIFF-lite" copy/add delta generator, and the
  `zstd` 1.5.5 CLI.
- Client side: GDScript `SceneTree` scripts (`t0_fingerprint` … `t9_private_bake`) plus a shared
  `lib.gd` (PCK directory parser, streaming PCK writer, resource fingerprinting). Official 4.6+
  templates reject `--path`/`--script`/`--main-pack` (see A5 §1), so for template runs the runner
  project is exported as a `.pck` placed next to a copy of `linux_release.x86_64`, with
  `application/run/main_loop_type` set to the test's `class_name`.
- **Correctness oracle**: each run mounts packs from `user://`, then (a) loads all 371 source paths
  through `ResourceLoader` and reduces each resource to a content fingerprint (texture pixels, audio
  data, translation messages, scene tree, material values), and (b) SHA-256s every raw file against
  the v2 manifest. "371/371 + 625/625" means indistinguishable from mounting the CI-built `v2.pck`.
- Timings are release-template numbers unless marked "editor". They are warm-cache desktop numbers:
  scale them for mobile, where nothing was measured.

---

## 2. Results

### 2.1 Godot-native patch PCKs (4.6+)

**Sizes** [M] (baseline: full `v2.pck` as zstd -19 = 9,796,975 B):

| Artefact                                                    | Raw bytes  | On the wire (zstd -19)     | vs full |
| ----------------------------------------------------------- | ---------- | -------------------------- | ------- |
| Full `v2.pck`                                               | 37,697,544 | 9,796,975                  | —       |
| `--export-patch` (changed + added files, 5 removal entries) | 6,010,160  | 987,243                    | −89.9%  |
| `--export-patch` with delta encoding (21 `GDDL` entries)    | 1,305,616  | **602,410**                | −93.9%  |
| `zstd -19 --patch-from=v1.pck v2.pck` (CLI, 8.6 s in CI)    | —          | **604,835** (−22: 601,408) | −93.8%  |
| `--export-patch` as `.zip` (deflate, no removals possible)  | 1,174,820  | —                          | −88.0%  |

The exporter delta-encoded 21 of the 24 changed entries. It skipped two globally tinted icons
(0.9% and 2.2% reduction, below the 10% threshold) and `main.gdc` (0%). Examples: a JSON edit →
41 B, a 700 KB texture with a local edit → 1.6 KB, the globally tinted 2.8 MB texture → 187 KB
(−93%), a re-rendered OGG → 130 KB (−21%), `uid_cache.bin` → 131 B.

**Determinism** [M]:

- Exporting the same imported project again (twice today, once in the interrupted run) gave
  byte-identical `v1.pck`, `v2.pck`, patch, delta patch and zip outputs (same SHA-256 each time).
- A **clean import** of a copy of the same v1 sources gave a pack that differs in exactly one file,
  `.godot/uid_cache.bin`: 24 bytes, the UIDs of the three `.translation` files the CSV importer
  generates. Those UIDs are not stored in any `.import` file, so each fresh import mints new ones.
  Texture and audio UIDs live in `.import` files and were stable. A delta patch exported against the
  clean base differs by 32 bytes (1,305,584 B).
- The v1→v2 delta still applied cleanly to the clean-imported base (371/371, 625/625), but only
  because v2 had itself re-minted those translation UIDs, so the delta stored them as literals. That
  is luck, not a property to rely on.
- **Wrong base** (16 bytes flipped inside two patched files of v1): the mount succeeds. At first
  read, the engine logs `Failed to decode delta … "Restored data doesn't match checksum"`, the file
  reads as 0 bytes, and the resource fails to load (369/371). Unpatched files are never checked:
  mounted alone, the same tampered v1 returns the altered bytes with **zero engine errors**
  (618/620 raw files match), because Godot does not verify directory MD5s on read [M/S]. The client
  must hash packs itself.

**Mount matrix** (all from `user://`, editor binary; resources /371, raw files /625) [M]:

| Mount sequence                                         | Resources   | Raw     | Note                                                                                                               |
| ------------------------------------------------------ | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `v2.pck`                                               | 371         | 625     | reference; mount 2.4 ms                                                                                            |
| `v1` + `v2_patch` (both `replace=true`)                | 371         | 625     | removal entries hide the 3 deleted files                                                                           |
| `v1` + `v2_delta` (`replace=true`)                     | 371         | 625     |                                                                                                                    |
| `v1` + `v2_delta` (**`replace=false`**)                | 369         | 622     | the exporter's full (non-delta) entries for existing paths are ignored: 2 icons and `main.gdc` stay v1             |
| `v2_delta` **then** `v1`                               | 349         | 601     | mounting a non-delta entry with `replace=true` clears queued deltas for that path [S]: mount order is load-bearing |
| clean-imported `v1` + `v2_delta`                       | 371         | 625     | see determinism                                                                                                    |
| tampered `v1` + `v2_delta`                             | 369         | 623     | fails closed per file, at load time                                                                                |
| chunk-reconstructed `v2` + a CLI-built v2→v1 delta PCK | v1: 368/368 | 620/620 | answers E8 §6 Q4: a byte-identical reconstruction is a valid base                                                  |
| `v1` + `v2_delta` + v2→v1 delta (stack depth 2)        | v1: 368/368 | 620/620 | stacked deltas apply in load order [S/M]                                                                           |

**Per-open cost of delta-patched files** (mean of 50 opens; `FileAccessPatched` re-reads the base,
decodes, and keeps the result in RAM with no cache between opens [S]) [M]:

| File                                   | Size   | Full `v2.pck` | `v1`+delta, release | Depth 2 (editor) |
| -------------------------------------- | ------ | ------------- | ------------------- | ---------------- |
| `t2048_01` `.s3tc.ctex` (187 KB delta) | 2.8 MB | 0.38 ms       | **3.25 ms**         | 5.39 ms          |
| `t1024_03` `.s3tc.ctex` (1.6 KB delta) | 0.7 MB | 0.05 ms       | 0.25 ms             | 0.42 ms          |
| `t2048_00` (not patched)               | 2.8 MB | 0.29 ms       | 0.27 ms             | 0.30 ms          |
| `level_005.json` (41 B delta)          | 54 KB  | 0.02 ms       | 0.07 ms             | 0.13 ms          |

`ResourceLoader.load()` of the same paths costs the same plus ~0.1 ms. The overhead is per open and
scales with **base size × stack depth**. On a 36 MB pack it is noise. On a pack of hundreds of
patched textures loaded at every level change on a phone, it is not. Peak RAM per open ≈ base +
result.

### 2.2 Client-side PCK rebuild in pure GDScript

Inputs: `v1.pck` on disk, the v2 manifest (path → size, MD5, SHA-256, offset), and the 34
changed/added files downloaded as blobs (6.0 MB raw, 993 KB if each is zstd-compressed). Unchanged
entries (30.2 MB) are located in v1 by the PCK directory's MD5 and confirmed by SHA-256 [M]:

| Method (`t2_rebuild`, `t2b_bake`, `t9_private_bake`)                               | Build         | Verify          | Whole-pack SHA-256 = CI's? | Resources / raw |
| ---------------------------------------------------------------------------------- | ------------- | --------------- | -------------------------- | --------------- |
| `PCKPacker`, unchanged bytes read from v1 by offset                                | 119 ms        | per file 168 ms | no                         | 371 / 625       |
| `PCKPacker`, unchanged bytes read through `res://` after mounting v1               | 113 ms        | per file 180 ms | no                         | 371 / 625       |
| **GDScript PCK writer**, streamed 1 MiB copies by offset                           | **42 ms**     | whole 167 ms    | **yes**                    | 371 / 625       |
| Bake: mount v1 + `v2_delta`, stream every v2 file through `res://` into the writer | 113 ms        | whole 165 ms    | **yes**                    | —               |
| **Private-namespace bake** (§4 rung 3): per-file `--patch-from` deltas             | 2 + 5 + 55 ms | whole 163 ms    | **yes**                    | —               |

What is and is not preserved [M/S]:

- `PCKPacker` writes the **same data region** as the exporter (offsets identical with alignment 16)
  but writes the directory in insertion order, while the exporter sorts it by path. So 50,303
  directory bytes differ and only per-file hashes can verify its output. It cannot write
  `PACK_FILE_DELTA` entries (it has `add_file_removal`, not a delta API), and it stamps the
  **client's** engine version into the header. Its default alignment is 32; the exporter used 16
  here.
- The GDScript writer reproduces the exporter layout exactly (header 104 B padded to 16, entries
  16-aligned in data order, sorted directory, MD5s copied from the manifest). The client can
  therefore check **one** SHA-256 against the signed record, the invariant README §3.3 and E8 §5.8
  want.
- Rebuilt packs carry `.godot/uid_cache.bin`, so UIDs keep working (§2.7). Removed files are simply
  absent; nothing needs removal entries.
- Memory: the writer streams (O(1 MiB)). `PCKPacker.add_file*` holds one whole file at a time.

### 2.3 Chunk-based reassembly (E8's thin client)

**Offline chunk analysis** (v1 as the seed, v2 as the target; recipe index costed at 40 B/chunk; the
per-chunk zstd column is what a client downloads) [M]:

| Input                         | Chunker                        | v2 chunks      | Missing  | Missing raw          | **Missing, zstd per chunk** | Index      |
| ----------------------------- | ------------------------------ | -------------- | -------- | -------------------- | --------------------------- | ---------- |
| PCK (36.0 MiB)                | FastCDC 16 KiB avg             | 1,618          | 208      | 5.50 MB (14.6%)      | 1,251,697                   | 65 KB      |
| PCK                           | FastCDC 64 KiB                 | 424            | 80       | 7.85 MB (20.8%)      | 1,909,204                   | 17 KB      |
| PCK                           | FastCDC 256 KiB                | 103            | 36       | 14.6 MB (38.6%)      | 4,555,599                   | 4 KB       |
| PCK                           | FastCDC 1 MiB                  | 25             | 16       | 26.5 MB (70.3%)      | 7,102,547                   | 1 KB       |
| PCK                           | **file-aware** 16 KiB          | 2,689          | 202      | 4.84 MB (12.9%)      | **934,696**                 | 108 KB     |
| PCK                           | **file-aware** 64 KiB          | 1,531          | 81       | 5.41 MB (14.4%)      | **984,678**                 | 61 KB      |
| PCK                           | **file-aware** 256 KiB         | 1,249          | 47       | 6.06 MB (16.1%)      | 1,037,135                   | 50 KB      |
| PCK                           | fixed 64 KiB / 256 KiB / 1 MiB | 576 / 144 / 36 | —        | 91.7% / 94.4% / 100% | ~10.0 MB (no gain)          | —          |
| PCK wrapped in one zstd frame | any                            | —              | —        | 99.9–100%            | 9.8 MB (no gain)            | —          |
| ZIP, deflate (Godot export)   | FastCDC 64 KiB                 | 145            | 46       | 4.24 MB (37.1%)      | 4,130,123                   | 6 KB       |
| ZIP, **stored** entries       | FastCDC 64 KiB / 16 KiB        | 424 / 1,619    | 82 / 210 | 21.6% / 14.9%        | 1,974,148 / 1,292,982       | 17 / 65 KB |

"File-aware" runs FastCDC separately over each PCK entry (and the header, padding and directory),
using the offsets in the PCK directory, so no chunk straddles two files. Unchanged files then always
produce identical chunks, and a changed file costs only its own changed chunks. It halves the
download at 64 KiB for a 3.6× larger index. A full download from the chunk store with per-chunk
zstd costs 10.49 MB versus 9.80 MB for one whole-file zstd frame (+7%): E8's "first install = full
blob, then record the index as the seed" is right.

**GDScript reassembly** (`t3_chunks`: raw chunks; `t3b_zchunks`: zstd-19 frame per chunk). For each
v2 chunk: seek + read from v1 if its SHA-256 is in the seed index, else load the downloaded chunk,
`decompress(size, ZSTD)`, SHA-256 it, stream it out, and hash the whole output [M]:

| Measurement (release template)                                           | Result                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| 424 chunks, 28.5 MB local + 7.49 MB remote (1.82 MB on the wire)         | whole-pack SHA-256 OK, 0 bad chunks                       |
| Assemble + decompress + per-chunk and whole SHA-256, 36 MB               | **358–453 ms (79–100 MB/s)**, of which decompress 9–10 ms |
| `HashingContext` SHA-256, 64 KiB / 1 MiB blocks                          | ~220–227 MB/s (one outlier run 128 MB/s)                  |
| `PackedByteArray.decompress(n, ZSTD)` on zstd -19 frames, 64 KiB / 1 MiB | **0.8–1.26 GB/s** / ~0.96 GB/s                            |
| Recipe parse (424-entry JSON)                                            | 2 ms                                                      |
| Pure-GDScript gear hash (client-side CDC)                                | **20–22 MB/s** (editor 17 MB/s)                           |

This answers E8 §6 Q3 on desktop: `decompress` accepts zstd -19 frames, and the one-shot API has no
`windowLogMax` limit [S: `ZSTD_decompressDCtx`]. It needs the exact decompressed size, which the
recipe provides. `decompress_dynamic` rejects zstd ("only gzip, DEFLATE, and Brotli") [M]. Costs
are dominated by SHA-256, which runs twice per byte. Skip the per-chunk hash for **local** chunks when
the whole-pack hash is checked anyway, and hash local chunks lazily only for repair. The client-side
rolling hash is 5× slower than the whole reassembly, which confirms E8 §5.1 principle 3: keep it in
CI.

### 2.4 Binary deltas applied from GDScript

**Direct `zstd --patch-from` decode is impossible from script** [M/S]. `decompress(size, ZSTD)` on a
patch-from frame returns an empty array; `decompress_dynamic` does not support zstd; no API takes a
dictionary or prefix.

**The engine's delta decoder is reachable** [M/S]. `DeltaEncoding::decode_delta` expects
`"GDDL"` + version byte `1` + one zstd frame whose prefix is the whole old file (`refPrefix`,
content size and checksum flags on), which is exactly what `zstd --patch-from` produces. It runs
whenever a path has `PACK_FILE_DELTA` entries registered. A GDScript client can write such a PCK
itself:

| Variant (`t4_delta_trick`, `t9_private_bake`)                                                                                                                                                    | Result (release template)                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Per file**: 24 CLI `--patch-from` frames (368,736 B + 231,856 B zstd for 10 new files) → 24-entry delta PCK                                                                                    | written in 2.7 ms; **24/24 files byte-identical** to v2; read + decode of all 24: 30.5 ms                        |
| **Whole file, copy host**: old pack wrapped as one virtual file `__pkey_base/whole.bin` in a new PCK (streamed copy) + 1-entry delta PCK holding the 604,835 B whole-pack delta                  | host 24 ms, decode **48 ms**, write + SHA-256 218 ms; output = CI `v2.pck`                                       |
| **Whole file, appended trailer**: 1-entry PCK directory appended to the old pack, whose `file_base` wraps around (`-start`) to cover bytes `[0, n)`; mounted at offset `n`; truncated afterwards | host 0 ms, decode 53 ms, write + SHA-256 199 ms; old pack restored byte-for-byte (SHA-256 re-checked)            |
| Whole file, **160 MB** synthetic base, frame window 153 MiB (editor)                                                                                                                             | decode 1,056 ms, write + SHA-256 1,339 ms, +153 MB resident after decode: works [M]                              |
| **Private-namespace per-file bake**: trailer re-exposes every old entry as `__pkey/base/<path>`; deltas target those paths; output streamed into the writer                                      | trailer 2 ms + mounts 5 ms + bake **55 ms** + SHA-256 163 ms; `res://assets/...` untouched; output = CI `v2.pck` |

- The 160 MB frame fails in the `zstd` **CLI** ("Window size larger than maximum … use --long=28")
  because the CLI decodes in streaming mode. The engine's one-shot `ZSTD_decompressDCtx` does not
  enforce `windowLogMax`, so the only practical limit is RAM: whole-file decode holds old + new in
  memory (≈2× file) [M/S]. The per-file variant bounds RAM by the largest changed file.
- The format is engine-internal (`GDDL` v1, PCK v4 flag bit 2), not a documented API. Exported
  patch PCKs persist it, so it is unlikely to change silently, but pin it per engine `major.minor`
  and cover it in conformance [I].
- CI does not need the Godot editor to produce these deltas: plain `zstd --patch-from` against the
  **stored** base bytes plus a 60-line PCK writer suffices [M]. That also removes README §3.7's
  determinism worry, because nothing is re-exported.

**Pure-GDScript formats** [M]:

| Method                                                                                                     | Size (v1→v2)        | Apply speed (release)                                          | Verdict                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| "VCDIFF-lite" (COPY src,len / ADD len + literals, one zstd frame; PCK-aware generator, 64 B / 16 B blocks) | 654,942 / 638,009 B | decompress 7 ms + apply **45 ms (~790 MB/s)** + SHA-256 184 ms | works: all native `seek`/`get_buffer`/`store_buffer` |
| bsdiff-style byte-wise add loop                                                                            | —                   | **31.7 MB/s** (editor 25 MB/s)                                 | too slow above a few MB, and there is no bzip2       |
| XOR over a `PackedInt64Array` view                                                                         | —                   | 213 MB/s                                                       | still a script loop; no vectorised byte ops exist    |

VCDIFF-lite is a fallback only if the engine-internal `GDDL` route ever breaks. It is 8% larger than
`--patch-from`, and it is a format we would own, spec and test across SDKs.

### 2.5 Non-PCK pack types

**ZIP via `load_resource_pack`** [M/S]:

- Godot-exported (deflate, 11.4 MB) and stored (37.7 MB) zips both mount (4–11 ms) and give 371/371
  - 625/625. Exported patch zips work as overlays, but a zip **cannot express removals**, so deleted
    files stay visible (`level_119.json` etc.). The exporter always writes deflate at the default level
    [S].
- **`replace_files=false` is ignored for zip-over-zip**: `v2.zip` then `v1.zip` with `replace=false`
  shows **v1** content (349/371). The cause is that `ZipArchive` keeps its own `files` map keyed by
  path, overwritten by every later zip, while `PackedData` keeps the old entry pointing at the same
  source [S]. PCK honours the flag (`v2.pck` then `v1.pck`, `replace=false` → 371/371).
- No offset mounting ("non-zero offset isn't supported with ZIP archives"), no delta entries, path
  names truncated at 255 bytes (`filename_inzip[256]`), and every file open re-opens the archive
  [S]. Reading all 625 files through `res://`: **378 ms from a zip vs 205 ms from a PCK**; loading
  all resources 567 vs 336 ms [M].
- `ZIPReader`: open 2 ms; read everything 54 MB/s (deflate) / 63 MB/s (stored); extract to
  `user://` 38–39 MB/s. `ZIPPacker`: level 0 **404 MB/s**, level 1 59 MB/s (13.4 MB), default 16 MB/s
  (11.4 MB), level 9 5 MB/s (11.2 MB). All four outputs mount [M].

**Loose files in `user://`**, loaded without the import pipeline (release template; editor in
brackets where it differs) [M]:

| Content                                                   | API                                                                        | Result                                                                                                    | Time               |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------ |
| JSON (54 KB)                                              | `FileAccess.get_file_as_string` + `JSON.parse_string`                      | ok                                                                                                        | 1.2 ms             |
| PO catalogue (200 msgs)                                   | `ResourceLoader.load("user://….po")` → `TranslationServer.add_translation` | `tr()` returns the new string                                                                             | 1.15 ms            |
| CSV (400 rows × 3 locales)                                | `get_csv_line` loop → `Translation.add_message`                            | ok                                                                                                        | 3.8 ms             |
| Exported `.translation`                                   | `ResourceLoader.load`                                                      | `OptimizedTranslation`                                                                                    | 0.16 ms            |
| OGG / WAV                                                 | `AudioStreamOggVorbis.load_from_file` / `AudioStreamWAV.load_from_file`    | 22 s / 0.8 s streams                                                                                      | 0.6 / 0.4 ms       |
| TTF                                                       | `FontFile.load_dynamic_font`                                               | ok                                                                                                        | 0.3 ms             |
| PNG 1024²                                                 | `Image.load_from_file` + `ImageTexture.create_from_image`                  | RGBA8, uncompressed                                                                                       | 15 ms              |
| PNG → `Image.compress(S3TC/BPTC/ETC2)`                    | —                                                                          | **error 2 on the template** ("`_image_compress_bc_func` is null"); works in the editor (28 / 664 / 28 ms) | —                  |
| Pre-imported `.s3tc.ctex` / lossless `.ctex`              | `ResourceLoader.load("user://….ctex")`                                     | `CompressedTexture2D`, VRAM format kept                                                                   | 0.3 / 0.2 ms       |
| `.oggvorbisstr` / `.sample` / `.fontdata`                 | `ResourceLoader.load`                                                      | ok                                                                                                        | 1.3 / 0.1 / 0.4 ms |
| Exported binary `.res`; `.scn` whose deps are in `res://` | `ResourceLoader.load`                                                      | ok; scene instantiates with textures                                                                      | 0.1 / 3.9 ms       |

The CVTT and Betsy compressors build only for the editor unless templates are built with
`*_export_templates=yes`, and even the always-built etcpak is not wired up in the official template
[S/M]. **Texture packs must ship pre-imported `.ctex` per texture family** (README §5.7's
`OS.has_feature("s3tc"/"etc2"/"astc")` selection), or accept 4–8× the VRAM.

### 2.6 Web (source-level; not run)

From `platform/web` at 4.7.2 [S]:

- `user://` is `/userfs`, an Emscripten **IDBFS** mount. At start-up `initFS` calls
  `FS.syncfs(true)`, which copies **the whole IndexedDB store into MEMFS**. Every installed pack is
  then held in browser memory for the entire session, and boot time grows with installed content.
- Every file closed after a write sets `idb_needs_sync`. The next main-loop iteration runs
  `FS.syncfs(false)`, which writes changed files back to IndexedDB as whole files.
- `load_resource_pack("user://…")` therefore works on web, but reads are copies out of MEMFS.
- Rebuilding a 100 MB pack in `user://` transiently needs old pack + new pack in MEMFS, plus the IDB
  write of the new one [I]. Chunk-sync and deltas save bandwidth on web but **not memory**.
- The main pack is `fetch`ed into MEMFS by `preloadFile` and passed as `--main-pack`. JS can add
  files with `Engine.preloadFile` (before start) or `copyToFS` (after init), again into memory.
- **Implication** [I]: on web, keep `user://` for small state (install DB, small packs). Treat the
  browser HTTP cache of **immutable, content-addressed** pack URLs as the large-pack store,
  downloading into a non-persistent MEMFS path when needed. Prefer many small packs over one large
  one. The persistence caveats in E3 (incognito, third-party iframes) apply on top.

### 2.7 Mount semantics

All [M] unless marked (probes `t7_semantics`, `t7b`, `t7c_uid`, `t7d_uid_rep`, `t8_removed`):

| Probe                                                                               | Result                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCK A then B, overlapping path, `replace=true` / `false`                            | B wins / A wins; B's new paths always added                                                                                                                                   |
| ZIP A then B, `replace=false`                                                       | **B wins** (flag ignored, §2.5)                                                                                                                                               |
| Removal entry in a pack mounted with `replace=false`                                | **still removes** (removals and deltas bypass the flag [S])                                                                                                                   |
| Mount a `user://` directory                                                         | `false`: the directory pack source accepts only `res://` [S]                                                                                                                  |
| **Overwrite** a mounted pack file with v2, no remount                               | reads are garbage: 118/625 files match v2 and 114/620 match v1; fresh loads fail                                                                                              |
| …then re-mount the same path                                                        | new entries correct (625/625) but **stale entries point into the new bytes**: removed `level_119.json` returns the start of `level_120.json`. Never write over a mounted pack |
| Mount v2 at a **new path** in the same session                                      | 1.4 ms; all v2 bytes correct at once                                                                                                                                          |
| …`load()` (`CACHE_MODE_REUSE`) of an already-loaded texture                         | the **stale v1 object**                                                                                                                                                       |
| …`CACHE_MODE_IGNORE`                                                                | a new object with v2 pixels                                                                                                                                                   |
| …`CACHE_MODE_REPLACE` / `REPLACE_DEEP`                                              | material updated in place (held references see new values); **`CompressedTexture2D` is not** (held reference keeps v1 pixels)                                                 |
| …files removed in v2                                                                | still visible and loadable (full packs carry no removal entries)                                                                                                              |
| Two packs inside one container file (v1 at offset 1,000, delta at 37,002,011)       | both mount; 625/625                                                                                                                                                           |
| Offset 2,100,000,000 / 2,200,000,000                                                | ok / **fails**: `load_resource_pack(…, offset: int)` is a 32-bit `int` in C++ [S]                                                                                             |
| Offset on a ZIP                                                                     | fails                                                                                                                                                                         |
| UID of a file new in v2, after `v1` + `v2_delta` / `v2_patch` / `PCKPacker` rebuild | registered and `load("uid://…")` works (from the pack's `uid_cache.bin`, loaded on every mount [S])                                                                           |
| Same, with the pack mounted **`replace=false`**                                     | **not registered**: the main pack's `uid_cache.bin` shadows the pack's, even for a full `v2.pck`                                                                              |
| Same, over a clean-imported base                                                    | registered                                                                                                                                                                    |

---

## 3. Method × pack type matrix

Bytes are for the 36 MiB v1→v2 pair above (full = 9.80 MB zstd). CPU is the release template on this
x86 host for 36 MB, including the final whole-pack SHA-256 (~165 ms) where the method produces a
full pack.

### 3.1 Methods

| #   | Method                                                                | Pure GDScript?                                 | Wire bytes (saved)             | Client CPU, 36 MB                                                           | Complexity | Caveats                                                                                                                       |
| --- | --------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Full download                                                         | yes                                            | 9.80 MB (0%)                   | ~0.2 s verify                                                               | trivial    | first install; universal fallback                                                                                             |
| 2   | Native patch PCK overlay (`--export-patch`, whole changed files)      | yes (mount)                                    | 0.99 MB (−90%)                 | mount <1 ms; no per-load cost                                               | low        | overlays accumulate (no unload); needs `replace=true`; pairwise; exporter must see the exact base                             |
| 3   | Native **delta** patch PCK overlay                                    | yes (mount)                                    | 0.60 MB (−94%)                 | mount <1 ms; **+2.9 ms per open** of a 2.8 MB patched file, per stack level | low        | per-boot cost forever; base must be byte-exact; needs `replace=true` or its full entries vanish; RAM ≈ base + result per open |
| 4   | Polaris-built delta PCK (CLI `--patch-from` per file + GDDL header)   | yes (mount; the client can even write the PCK) | 0.60 MB (−94%)                 | as 3                                                                        | low–medium | as 3, but built against stored bytes, so no re-export determinism problem; engine-internal format                             |
| 5   | **Bake** 3 or 4 into a full pack (private namespace, streamed writer) | yes                                            | 0.60 MB (−94%)                 | **~0.23 s** (0.06 s bake + SHA-256)                                         | medium     | pairwise; appends a temporary trailer to the old pack (or copies it); RAM bounded by the largest changed file                 |
| 6   | Whole-file `--patch-from` via GDDL (any single file)                  | yes                                            | 0.60 MB (−94%)                 | ~0.25–0.29 s (0.05 s decode)                                                | medium     | pairwise; RAM ≈ 2× file; 160 MB tested                                                                                        |
| 7   | Per-file download + client rebuild (GDScript writer)                  | yes                                            | 0.99 MB (−90%)                 | ~0.21 s                                                                     | low        | any old version whose manifest is known; per-file granularity only                                                            |
| 8   | Chunk-sync, FastCDC 64 KiB (E8)                                       | yes                                            | 1.93 MB incl. index (−80%)     | ~0.36–0.45 s (80–100 MB/s)                                                  | medium     | any-version; needs the seed index; per-chunk compression adds ~7% to full installs                                            |
| 8b  | Chunk-sync, **file-aware** FastCDC 64 KiB                             | yes                                            | **1.05 MB incl. index (−89%)** | same                                                                        | medium     | index 3.6× larger (61 KB); chunker version must be pinned                                                                     |
| 9   | VCDIFF-lite copy/add (own format)                                     | yes                                            | 0.64–0.65 MB (−93%)            | ~0.24 s                                                                     | medium     | our own format to spec; pairwise; only if 4–6 break                                                                           |
| 10  | bsdiff / byte-wise patch in GDScript                                  | technically                                    | —                              | **~1.1 s per 36 MB** loop alone                                             | high       | not viable                                                                                                                    |
| 11  | Client-side CDC (rolling hash in GDScript)                            | technically                                    | —                              | ~1.7 s per 36 MB (20–22 MB/s)                                               | high       | not needed: the seed index makes it unnecessary                                                                               |
| 12  | Overwrite a mounted pack in place                                     | yes                                            | —                              | —                                                                           | —          | **unsafe**: corrupt and even wrong reads (§2.7)                                                                               |
| 13  | ZIP overlay (`--export-patch` to `.zip`)                              | yes (mount)                                    | 1.17 MB (−88%)                 | mount <1 ms; reads ~1.8× slower                                             | low        | cannot remove files; ignores `replace=false`; no offsets                                                                      |
| 14  | Loose-file replacement in `user://` (tree packs)                      | yes                                            | changed files only             | ~ms per file                                                                | low        | activate by pointer swap; images must be pre-imported per texture family                                                      |

### 3.2 Pack types

✓ = works and is recommended, ~ = works with caveats, ✗ = not applicable or not viable.

| Pack type                                                          | Full | Native patch/delta overlay (2–4) | Engine-delta bake (5–6)                | Per-file rebuild (7) | Chunk-sync (8)    | Notes                                                                                    |
| ------------------------------------------------------------------ | ---- | -------------------------------- | -------------------------------------- | -------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `godot.pck` (uncompressed container)                               | ✓    | ~ (per-load cost; mount rules)   | ✓ (best bytes)                         | ✓                    | ✓ file-aware      | E8's primary type; everything verified here                                              |
| PCK compressed as a whole (`.pck.zst` at rest)                     | ✓    | ✗                                | ~ (decompress first)                   | ✗                    | ✗                 | compress for transport only, never at rest                                               |
| `godot` ZIP pack, deflate                                          | ✓    | ~ (no removals, no deltas)       | ~ (whole-file only)                    | ~ (`ZIPPacker`)      | ~ (37% at 64 KiB) | prefer converting to PCK or a tree in CI                                                 |
| ZIP pack, stored                                                   | ✓    | ~                                | ~                                      | ~                    | ✓ (like PCK)      | still has the zip mount bugs                                                             |
| `files.tree`: JSON / l10n / audio / fonts / pre-imported artefacts | ✓    | ✗                                | ~ (per large file)                     | ✓ (file level)       | ~ (large files)   | hot activation: `TranslationServer`, `load_from_file`, `ResourceLoader.load("user://…")` |
| Images as source PNG/JPG                                           | ✓    | ✗                                | ~                                      | ✓                    | ~                 | uncompressed in VRAM on templates (no `Image.compress`)                                  |
| Large single blob (audio bank, video, model)                       | ✓    | ✗                                | ✓ up to the RAM budget (160 MB tested) | ✗                    | ✓                 | CDC for any-version; GDDL delta for hot pairs                                            |

---

## 4. Recommended client patch-strategy ladder (Godot)

This refines E8 §5.5's `noop → platform → chunk → delta → full` for what a pure-GDScript client can
execute. The server publishes the menu; the client picks the cheapest route it can run within
`memBudgetBytes` and free disk.

0. **noop**: active payload SHA-256 == target.
1. **platform**: the pack is bound to a platform transport on this outlet (E8 §4). Out of scope
   here.
2. **Engine-delta bake** (hot N−1→N pairs; bytes ≈ `--patch-from`, −94% here). CI publishes per-file
   `zstd --patch-from` frames against the **stored** N−1 entries, plus zstd blobs for added files.
   The client:
   - appends a trailer that re-exposes the old pack's entries as `__pkey/base/<path>`, mounted at
     the trailer offset with `replace=false`;
   - writes and mounts a GDDL delta PCK for those private paths;
   - streams the new pack (unchanged entries copied by offset, changed ones read through `res://`,
     added ones from blobs);
   - truncates the old pack back and verifies the whole-pack SHA-256.

   ~0.23 s per 36 MB; RAM bounded by the largest changed file; the live `res://` namespace is
   untouched (§2.4, `t9`). If the old pack is read-only (platform-delivered), copy it instead of
   appending, or fall back to rung 3. Verify the delta's own SHA-256 from the signed menu before
   feeding it to the decoder [I].

3. **Chunk-sync, file-aware FastCDC 64 KiB** (any older version; −89% here). Seed index = the
   installed release's chunk index. Local chunks come from seeds by offset. Missing chunks arrive by
   Range, are `decompress`ed and SHA-256-verified, and the output is streamed. ~80–100 MB/s on
   desktop. Also the repair path.
4. **Per-file download + rebuild** (−90%). The simplest incremental route. It needs only the files
   index and works from any version whose manifest the client holds.
5. **Full** (compressed transport). First install, then record its chunk index as the seed.

Rules that apply to every rung:

- **Always reconstruct a full, exporter-identical PCK** and verify one SHA-256 against the signed
  record. Never leave native patch or delta overlays mounted across boots: they cost load time on
  every open and make the active set a stack instead of a hash. Use them only as a decode step
  (rungs 2 and 6).
- Write the new pack to a **new content-addressed path** (`user://pkey/store/<sha>.pck`) and mount
  it at next boot. Never overwrite a mounted pack (§2.7). If a same-session switch is unavoidable,
  mount the new path and load with `CACHE_MODE_IGNORE`. Expect stale cached textures and
  still-visible removed files.
- Prefer **PCK** for engine resources, **trees** for loose data. Use ZIP only when a third party
  forces it, and then only stored and never layered with `replace=false`.
- Never ship chunkable packs whole-file-compressed at rest; compress on the wire or per chunk.
- Mount order is load-bearing: base first, then patches. A later full mount with `replace=true`
  discards queued deltas.
- Web: bandwidth routes still apply, but memory is the constraint (§2.6).

---

## 5. Key GDScript snippets

Condensed from the tested scripts in `prototype/patching/runner/` (`lib.gd`, `t3b`, `t4`, `t9`). Error handling
trimmed.

**PCK directory parser (v2–v4, unencrypted).** Offsets are made absolute; `base` lets you read a pack
embedded at an offset:

```gdscript
const MAGIC := 0x43504447  # "GDPC"

static func read_pck_dir(path: String, base := 0) -> Dictionary:
	var f := FileAccess.open(path, FileAccess.READ)
	f.seek(base)
	if f.get_32() != MAGIC:
		return {}
	var version := f.get_32()
	var engine := [f.get_32(), f.get_32(), f.get_32()]
	var flags := f.get_32()                       # bit 1 = REL_FILEBASE (always set by 4.x)
	var file_base := f.get_64() + base
	var dir_off := f.get_64() + base
	f.seek(dir_off)
	var entries := []
	for i in f.get_32():
		var p := f.get_buffer(f.get_32()).get_string_from_utf8()  # NUL-padded to 4
		var ofs := f.get_64()
		var size := f.get_64()
		var md5 := f.get_buffer(16)
		var fl := f.get_32()                      # 1 ENCRYPTED, 2 REMOVAL, 4 DELTA
		entries.append({"path": p, "ofs": file_base + ofs, "size": size, "md5": md5, "flags": fl})
	return {"version": version, "engine": engine, "flags": flags, "entries": entries}
```

**Exporter-identical streaming PCK writer** (header 104 B, 16-byte alignment, sorted directory):

```gdscript
class PckWriter:
	var f: FileAccess
	var file_base := 0
	var recs := []

	func begin(path: String) -> void:
		f = FileAccess.open(path, FileAccess.WRITE)
		for v in [MAGIC, 4, 4, 7, 2, 2]:          # magic, format v4, engine 4.7.2, REL_FILEBASE
			f.store_32(v)
		f.store_64(0); f.store_64(0)              # file_base, dir_offset (patched in finish)
		for i in 16:
			f.store_32(0)
		_pad()
		file_base = f.get_position()

	func _pad() -> void:
		var r := f.get_position() % 16
		if r:
			var z := PackedByteArray(); z.resize(16 - r); f.store_buffer(z)

	func add(path: String, data: PackedByteArray, flags := 0) -> void:
		var o := f.get_position()
		f.store_buffer(data)
		_pad()
		var md5 := PackedByteArray(); md5.resize(16)
		if (flags & 2) == 0:
			var h := HashingContext.new(); h.start(HashingContext.HASH_MD5); h.update(data); md5 = h.finish()
		recs.append([path, o - file_base, data.size(), md5, flags])

	## Copy [ofs, ofs+size) of another file in 1 MiB steps (constant memory).
	func add_copy(path: String, src: FileAccess, ofs: int, size: int, md5_hex: String) -> void:
		var o := f.get_position()
		src.seek(ofs)
		var left := size
		while left > 0:
			var n := mini(1 << 20, left)
			f.store_buffer(src.get_buffer(n))
			left -= n
		_pad()
		var md5 := md5_hex.hex_decode()
		md5.resize(16)                            # zero-filled when no hash is given
		recs.append([path, o - file_base, size, md5, 0])

	func finish() -> void:
		_pad()
		var dir_off := f.get_position()
		recs.sort_custom(func(a, b): return a[0] < b[0])
		f.store_32(recs.size())
		for r in recs:
			var pb: PackedByteArray = r[0].to_utf8_buffer()
			var pad := (4 - pb.size() % 4) % 4
			pb.resize(pb.size() + pad)
			f.store_32(pb.size()); f.store_buffer(pb)
			f.store_64(r[1]); f.store_64(r[2]); f.store_buffer(r[3]); f.store_32(r[4])
		f.seek(24); f.store_64(file_base); f.store_64(dir_off)
		f.close()
```

**Engine as a zstd `--patch-from` decoder (whole file, copy host).** Output is streamed and hashed.
The virtual path is private, so no game path is touched:

```gdscript
const F_DELTA := 4
const VPATH := "__pkey_base/whole.bin"

static func gddl(zst: PackedByteArray) -> PackedByteArray:
	var b := "GDDL".to_ascii_buffer()
	b.append(1)                                   # DeltaEncoding version
	b.append_array(zst)                           # frame from `zstd --patch-from=old new`
	return b

func apply_whole_delta(old_path: String, delta_path: String, out_path: String) -> String:
	var n := FileAccess.open(old_path, FileAccess.READ).get_length()
	var host := PckWriter.new(); host.begin("user://pkey/staging/host.pck")
	host.add_copy(VPATH, FileAccess.open(old_path, FileAccess.READ), 0, n, "")
	host.finish()
	ProjectSettings.load_resource_pack("user://pkey/staging/host.pck", false)
	var dp := PckWriter.new(); dp.begin("user://pkey/staging/delta.pck")
	dp.add(VPATH, gddl(FileAccess.get_file_as_bytes(delta_path)), F_DELTA)
	dp.finish()
	ProjectSettings.load_resource_pack("user://pkey/staging/delta.pck", false)  # deltas bypass replace_files
	var src := FileAccess.open("res://" + VPATH, FileAccess.READ)  # first access decodes (RAM ≈ old + new)
	var out := FileAccess.open(out_path, FileAccess.WRITE)
	var h := HashingContext.new(); h.start(HashingContext.HASH_SHA256)
	var left := src.get_length()
	while left > 0:
		var c := src.get_buffer(mini(1 << 20, left))
		h.update(c); out.store_buffer(c); left -= c.size()
	out.close()
	return h.finish().hex_encode()                # compare with the signed record before use
```

**Private-namespace trailer** (rung 2): re-expose every entry of an installed pack under
`__pkey/base/` without copying it. Truncate back to `n` afterwards; the manifest knows `n`, so a
crash in between is repairable:

```gdscript
func expose_private(old: String, entries: Array) -> int:
	var f := FileAccess.open(old, FileAccess.READ_WRITE)
	f.seek_end()
	var start := f.get_position()
	for v in [MAGIC, 4, 4, 7, 2, 2]:
		f.store_32(v)
	f.store_64(-start)                            # file_base wraps to 0: entry offsets are absolute
	f.store_64(104)                               # directory follows the 104-byte header
	for i in 16:
		f.store_32(0)
	f.store_32(entries.size())
	for e in entries:                             # from read_pck_dir(old)
		var pb: PackedByteArray = ("__pkey/base/" + e.path).to_utf8_buffer()
		pb.resize(pb.size() + (4 - pb.size() % 4) % 4)
		f.store_32(pb.size()); f.store_buffer(pb)
		f.store_64(e.ofs); f.store_64(e.size)
		var z := PackedByteArray(); z.resize(16); f.store_buffer(z); f.store_32(0)
	f.close()
	ProjectSettings.load_resource_pack(old, false, start)  # start must be < 2^31
	return start
```

**Chunk-sync inner loop** (§4 rung 3; `recipe` = target chunk list, `seed_index` = SHA-256 → local
offset):

```gdscript
func reassemble(seed_path: String, seed_index: Dictionary, recipe: Array, fetched_dir: String, out_path: String) -> String:
	var src := FileAccess.open(seed_path, FileAccess.READ)
	var out := FileAccess.open(out_path, FileAccess.WRITE)
	var whole := HashingContext.new(); whole.start(HashingContext.HASH_SHA256)
	for c in recipe:                              # {sha256, size}
		var buf: PackedByteArray
		var local = seed_index.get(c.sha256)
		if local != null:
			src.seek(int(local.ofs)); buf = src.get_buffer(int(c.size))   # verified by the whole-pack hash
		else:
			var z := FileAccess.get_file_as_bytes(fetched_dir.path_join(c.sha256))
			buf = z.decompress(int(c.size), FileAccess.COMPRESSION_ZSTD)  # one frame per chunk
			var h := HashingContext.new(); h.start(HashingContext.HASH_SHA256); h.update(buf)
			if h.finish().hex_encode() != c.sha256:
				return ""                         # refetch this chunk
		whole.update(buf); out.store_buffer(buf)
	out.close()
	return whole.finish().hex_encode()
```

**Hot-activated loose content** (tree packs):

```gdscript
var tr: Translation = ResourceLoader.load("user://pkey/trees/%s/l10n/fr.po" % sha)
TranslationServer.add_translation(tr)                        # hot; remove_translation() to swap
var music := AudioStreamOggVorbis.load_from_file("user://pkey/trees/%s/music/t3.ogg" % sha)
var tex: Texture2D = ResourceLoader.load("user://pkey/trees/%s/tex/t.s3tc.ctex" % sha)  # pre-imported
var data = JSON.parse_string(FileAccess.get_file_as_string("user://pkey/trees/%s/levels/5.json" % sha))
```

---

## 6. Consequences for the README and E8

| Where                                                                                               | Current text                                                                                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E8 §2.3 table, §3.3 "Scripts cannot call the delta decoder"; README §3.7 "zstd delta (native SDKs)" | `--patch-from` "not exposed to GDScript"                                                    | GDScript **can** apply `--patch-from` via GDDL-wrapped delta entries, at native speed, per file or whole file (§2.4). The GDScript SDK can take the same zstd delta route as native SDKs; the `godot-delta-pck` overlay becomes a decode step, not a mounted layer.                                                                                                                                                                |
| E8 §5.3 `godot.pck` routes                                                                          | "chunk-sync (≥16 MiB) → zstd delta (native SDKs) → godot-delta-pck layer (GDScript) → full" | For GDScript: engine-delta **bake** → file-aware chunk-sync → per-file rebuild → full. Mount only full, verified packs.                                                                                                                                                                                                                                                                                                            |
| E8 §2.2 chunk parameters                                                                            | FastCDC 16/64/256 KiB over the whole file                                                   | For PCKs, chunk **per entry** using the directory offsets ("file-aware"): −49% bytes at 64 KiB here for a 3.6× larger index. Record `fileAware: true` next to the chunker version.                                                                                                                                                                                                                                                 |
| E8 §3.3 zstd window worry; §6 Q3                                                                    | `windowLogMax` / `--long` concerns                                                          | One-shot decode (`decompress`, and the delta decoder) ignores `windowLogMax`: a 153 MiB window decoded fine; RAM is the limit. `decompress` handles zstd -19 chunk frames at ~1 GB/s; SHA-256 ~220 MB/s (x86 desktop; mobile not measured).                                                                                                                                                                                        |
| E8 §6 Q4                                                                                            | delta PCK over a chunk-reconstructed base untested                                          | Works (byte-identical base); depth 2 works; per-open cost ~+3 ms per level for a 2.8 MB file on desktop.                                                                                                                                                                                                                                                                                                                           |
| README §3.7 / §5.7 "mount with `replace_files=false`"                                               | data-only enforcement at mount                                                              | With `replace=false`, (a) patch and delta overlays silently lose their full-file entries, (b) the pack's UIDs never register, (c) ZIP ignores the flag entirely. Enforce data-only by **checking the directory before mounting** (the prefix allowlist and script/cache denylist already specified), mount full packs from new paths, and choose the flag deliberately: `false` is fine for full, disjoint-prefix, uid-free packs. |
| README §5.7 "UIDs are not registered for PCKPacker packs"                                           | —                                                                                           | More precisely: UIDs register from whichever `.godot/uid_cache.bin` is visible when the pack mounts. A `PCKPacker` pack that carries the file registers them, but only if it is mounted with `replace=true`. Forbidding `uid://` into packs remains the simple rule.                                                                                                                                                               |
| README §3.7 "depend on byte-identical re-exports"                                                   | —                                                                                           | Confirmed and scoped: same-project re-exports are deterministic; a clean re-import changes `uid_cache.bin` (CSV translation UIDs). Building deltas against **stored** artefacts (zstd CLI + a small PCK writer, no editor) sidesteps it.                                                                                                                                                                                           |
| README §5.7 web multi-pack "unverified"                                                             | —                                                                                           | Still not run. Source shows all of `user://` resident in RAM on web (§2.6).                                                                                                                                                                                                                                                                                                                                                        |

---

## 7. What could not be (re-)run, and limits

- **Web**: source reading only; no browser build was run (no web templates in the scratch
  experiment).
- **Mobile**: no Android or iOS device. All timings are x86-64 desktop; the Android
  `load_resource_pack` stall (godot#105009) and low-end SHA-256 throughput remain open (E8 §6 Q3).
- **Windows file locking**: not tested. Godot opens pack files per read rather than holding them
  open [S], so deleting or replacing an unmounted old pack should work [I].
- **Multi-version history**: only one v1→v2 pair was built. "Any old version" advantages of
  chunk-sync over pairwise deltas are argued from E8, not measured here.
- **Interrupted-run artefact**: an earlier `big.pfw27.zst` (719,584 B) could not be reproduced; its
  generation flags were lost with the killed run. All regenerated 160 MB variants (`--patch-from`
  with default, `--long=27` and `--zstd=wlog=27`) produce the same 822,301 B frame, and that frame
  decodes in the engine. No conclusion depends on the lost file.
- The trailer trick mutates the installed pack for well under a second. That it does not disturb
  the same file's existing mount is inferred from append-only semantics [I], not tested while the
  base was the live content pack.
- Numbers are single runs on a warm cache, except t3b (three runs, range reported).

## 8. Reproduction

The experiment's sources now live in [`prototype/patching/`](../prototype/patching/README.md). Its
README has the prerequisites, the environment variables and step-by-step commands; the paths below
are relative to it. The engine sources are not vendored; the README lists them at `4.7.2-stable`.

- `build.sh <proj>` (headless import with retries) and `tplrun.sh <release|debug> <Class> args…`
  (export the runner and run it on the official template).
- Offline tools in `tools/`: `gen_project.py`/`make_v2.py` (content), `manifest.py` (per-file
  SHA-256 manifest), `pckdiff.py`, `fastcdc.cjs` (`FASTCDC_SEGMENTS` for file-aware),
  `chunk_rerun.py` (the chunk tables), `vcd_lite.py`.
- Runner scripts in `runner/`:
  - `t0_fingerprint` (mount matrix)
  - `t1_delta_cost`
  - `t2_rebuild` (`packer`, `packer_res`, `writer`), `t2b_bake`
  - `t3_chunks`, `t3b_zchunks`
  - `t4_delta_trick` (`files`, `whole copy|append`), `t4b_vcdl`, `t4c_bytewise`, `t4d_plain`
  - `t5b_loose` (via `loose_tests`), `t5c_zip`
  - `t7_semantics`, `t7b`, `t7c_uid`, `t7d_uid_rep`, `t8_removed`
  - `t9_private_bake`
- Engine source consulted:
  - `core/io/{file_access_pack,file_access_patched,delta_encoding,compression,pck_packer,file_access_zip}.cpp`
  - `core/config/project_settings.cpp`
  - `editor/export/editor_export_platform.cpp`
  - `platform/web/{os_web.cpp,js/libs/library_godot_os.js,js/engine/engine.js}`
  - `modules/{betsy,cvtt,etcpak}/config.py`
