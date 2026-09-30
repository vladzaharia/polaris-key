# Patching and content updates on Godot 4.7.2 (A6)

This is research code for [Godot on Polaris Key](../../README.md) that backs
[A6: patching and content updates from a pure-GDScript client](../../notes/A6-godot-patching.md); it
is not part of the green gate and not a published SDK.

It generates a synthetic but realistic Godot 4.7 project (v1) and an edited copy (v2), exports them
as PCKs, ZIPs, native patch PCKs and delta patch PCKs, and measures which update methods a
pure-GDScript client can run on stock engine APIs: native overlays, a client-side PCK rebuild,
FastCDC chunk sync, `zstd --patch-from` through the engine's own delta decoder (`GDDL`), a
copy/add "VCDIFF-lite" format, ZIP packs and loose files. Its `out/v1.pck` and `out/v2.pck` are
also the input of the [cross-language content vectors](../content/README.md).

## What is here

| Path                      | What                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/gen_project.py`    | generates the v1 project: `gen_project.py <dir> [seed]` (seed 1234). Icons, VRAM-compressed textures, OGG, WAV, JSON, fonts, `.tres`, scenes, CSV/PO translations, scripts and both export presets             |
| `tools/make_v2.py`        | derives v2 in place from a copy of v1 (21 changed, 6 added, 3 removed source files) and writes `v2_changes.json` next to the project directory                                                                 |
| `tools/pck.py`            | minimal PCK v2–v4 reader/writer (identical to `../content/gen/pck.py`); `pck.py <pack> [offset] [n]` lists the largest entries                                                                                 |
| `tools/manifest.py`       | per-file manifest of a pack: path → SHA-256, size, MD5, offset, plus the whole-pack SHA-256                                                                                                                    |
| `tools/pckdiff.py`        | entry-level diff of two packs                                                                                                                                                                                  |
| `tools/fpcmp.py`          | compares a fingerprint dump from `t0_fingerprint` with a reference dump                                                                                                                                        |
| `tools/fastcdc.cjs`       | FastCDC (2016, normalised chunking level 1) and fixed-size chunking: `fastcdc.cjs <file> <avg\|fixed:SIZE>`; `FASTCDC_SEGMENTS=<json>` makes it file-aware. `.cjs` because the repo root `package.json` is ESM |
| `tools/chunk_rerun.py`    | the chunk study of §2.3 (plain and file-aware FastCDC, fixed blocks; PCK, `.pck.zst` and ZIP inputs); writes `out/r/`                                                                                          |
| `tools/chunk_analysis.py` | the first, pre-restart version of the same table over `out/cdc_*.json`                                                                                                                                         |
| `tools/vcd_lite.py`       | VCDIFF-lite generator: `vcd_lite.py old.pck new.pck out.vcdl [block]`                                                                                                                                          |
| `runner/`                 | the client side: one `SceneTree` script per test (below) plus `lib.gd` (PCK directory parser, streaming PCK writer, resource fingerprinting) and `loose_tests.gd`                                              |
| `build.sh`                | `build.sh <projdir>`: headless import with retries (headless import is occasionally flaky)                                                                                                                     |
| `tplrun.sh`               | `tplrun.sh <release\|debug> <Class> [args…]`: exports `runner/` as a pack and runs it on the official template. It rewrites `runner/project.godot` to set the class                                            |

### Runner scripts

Each script is a `SceneTree` that reads its arguments after `--`.

| Script                         | Class           | Arguments                                                                                                                       | Note section |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `t0_fingerprint.gd`            | `T0Fp`          | `out_json manifest_json pack1[:noreplace] pack2 …`: mount, then fingerprint every source path                                   | §2.1, §2.7   |
| `t1_delta_cost.gd`             | `T1DeltaCost`   | `N pack1 [pack2 …]`: per-open cost of delta-patched entries                                                                     | §2.1         |
| `t2_rebuild.gd`                | `T2Rebuild`     | `old_pck manifest_json dl_dir out_pck packer\|packer_res\|writer`                                                               | §2.2         |
| `t2b_bake.gd`                  | `T2bBake`       | `base patch manifest out`: bake a native delta patch into a full pack                                                           | §2.2         |
| `t3_chunks.gd`                 | `T3Chunks`      | `old_pck v1_recipe v2_recipe chunk_dir out_path expected_sha256`                                                                | §2.3         |
| `t3b_zchunks.gd`               | `T3bZChunks`    | as `t3`, with zstd-per-chunk frames, plus `[full_store_dir]`                                                                    | §2.3         |
| `t4_delta_trick.gd`            | `T4Delta`       | `files base_pck zd_dir list_json v2_manifest` or `whole base_pck patchfrom_zst out_pck expected_sha copy\|append`               | §2.4         |
| `t4b_vcdl.gd`                  | `T4bVcdl`       | `old patch out expected_sha`                                                                                                    | §2.4         |
| `t4c_bytewise.gd`              | `T4cBytewise`   | none: byte-wise loop cost                                                                                                       | §2.4         |
| `t4d_plain.gd`                 | —               | `frame.zst`: `decompress` on a `--patch-from` frame returns 0 bytes                                                             | §2.4         |
| `t5b_loose.gd`                 | `T5bLoose`      | `[dir]`: runs `loose_tests.gd` (what loads from `user://` without import)                                                       | §2.5         |
| `t5c_zip.gd`                   | `T5cZip`        | `zip_deflate zip_stored src_pck`: `ZIPReader`/`ZIPPacker` throughput                                                            | §2.5         |
| `t7_semantics.gd`              | `T7Semantics`   | `case [extra…]`, one case per process: `pck_true`, `zip_false`, `removal_false`, `inplace`, `newpath`, `container`, `sparse`, … | §2.7         |
| `t7b.gd`                       | —               | none: offset limit and `CACHE_MODE_REPLACE_DEEP`                                                                                | §2.7         |
| `t7c_uid.gd`, `t7d_uid_rep.gd` | `T7cUid`, —     | `pack …` (`t7c`, all mounted with replace) or `pack[:noreplace] …` (`t7d`): UID registration                                    | §2.7         |
| `t8_removed.gd`                | —               | `pack[:noreplace] …`: are removed files still visible                                                                           | §2.7         |
| `t9_private_bake.gd`           | `T9PrivateBake` | `old_pck zd_dir list_json v2_manifest dl_dir out_pck`: private-namespace per-file bake                                          | §2.4, §4     |

## Prerequisites

| Tool     | Version measured                                                                                                                | Needed for                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Godot    | 4.7.2-stable official (`ed1daf0bf`): standard editor binary, official `linux_release.x86_64` and `linux_debug.x86_64` templates | import, export, runner                 |
| Python   | 3.11.15 with numpy 2.4.6, Pillow 12.3.0, soundfile 0.14.0 (libsndfile with Vorbis), zstandard 0.25.0                            | project generator, offline tools       |
| Node     | 22                                                                                                                              | `tools/fastcdc.cjs`                    |
| zstd CLI | 1.5.5                                                                                                                           | whole-file and per-file `--patch-from` |
| Fonts    | `DMMono-Regular.ttf`, `IBMPlexSerif-Regular.ttf` (SIL OFL, Google Fonts)                                                        | project generator                      |

## Environment variables

| Variable           | Used by                               | Default                                              |
| ------------------ | ------------------------------------- | ---------------------------------------------------- |
| `GODOT`            | `build.sh`, `tplrun.sh`               | `godot` on `PATH`                                    |
| `GODOT_TEMPLATES`  | `tplrun.sh`                           | `~/.local/share/godot/export_templates/4.7.2.stable` |
| `FONTS_DIR`        | `tools/gen_project.py`                | `fonts/` in this directory                           |
| `FASTCDC_SEGMENTS` | `tools/fastcdc.cjs` (file-aware mode) | unset                                                |

The tools otherwise use paths relative to this directory (`out/`, `logs/`, `runner/`, `tpl/`), so
run them from here.

## Run it

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype/patching
python3.11 -m venv venv
venv/bin/pip install numpy==2.4.6 pillow==12.3.0 soundfile==0.14.0 zstandard==0.25.0
```

1. **Projects.** Put the two fonts in `fonts/` (or set `FONTS_DIR`), then generate v1, copy it and
   derive v2, and import both:

   ```sh
   venv/bin/python tools/gen_project.py proj_v1
   cp -r proj_v1 proj_v2 && venv/bin/python tools/make_v2.py proj_v2
   ./build.sh proj_v1 && ./build.sh proj_v2
   ```

2. **Exports** (A6 §1.2). The output extension picks PCK or ZIP; preset `LinuxDelta` sets
   `patch_delta_encoding=true`:

   ```sh
   mkdir -p out
   godot --headless --verbose --path proj_v1 --export-pack Linux "$PWD/out/v1.pck"
   godot --headless --verbose --path proj_v2 --export-pack Linux "$PWD/out/v2.pck"
   godot --headless --verbose --path proj_v2 --export-patch Linux "$PWD/out/v2_patch.pck" --patches "$PWD/out/v1.pck"
   godot --headless --verbose --path proj_v2 --export-patch LinuxDelta "$PWD/out/v2_delta.pck" --patches "$PWD/out/v1.pck"
   godot --headless --verbose --path proj_v1 --export-pack Linux "$PWD/out/v1.zip"
   godot --headless --verbose --path proj_v2 --export-pack Linux "$PWD/out/v2.zip"
   godot --headless --verbose --path proj_v2 --export-patch Linux "$PWD/out/v2_patch.zip" --patches "$PWD/out/v1.pck"
   ```

   `out/v1.pck` and `out/v2.pck` are all the [content vectors](../content/README.md) need.

3. **Offline artefacts** (the CI stand-in):

   ```sh
   venv/bin/python tools/manifest.py out/v1.pck out/v1.manifest.json
   venv/bin/python tools/manifest.py out/v2.pck out/v2.manifest.json
   zstd -19 -k out/v1.pck out/v2.pck                                    # whole-file baselines
   zstd -19 --patch-from=out/v1.pck out/v2.pck -o out/v1_to_v2.patchfrom.zst
   venv/bin/python tools/vcd_lite.py out/v1.pck out/v2.pck out/v1_to_v2.vcdl
   venv/bin/python tools/vcd_lite.py out/v1.pck out/v2.pck out/v1_to_v2_b16.vcdl 16
   mkdir -p out/r && venv/bin/python tools/chunk_rerun.py               # chunk table, recipes, missing chunks
   ```

   Three inputs of the runner were prepared by hand and have no script (see Known limits):
   `out/dl/<sha256>`, the raw bytes of every v2 entry whose SHA-256 is not in v1 (34 here);
   `out/zd/<v2 sha256>.zst`, `zstd -19 --patch-from=<v1 entry bytes> <v2 entry bytes>` for each
   entry whose path is in v1 but whose bytes changed (24 here); and `out/zd/list.json`, the JSON
   array of those 24 paths.

4. **Client side on the editor.** Import once so the `class_name` scripts register, then run a
   test with `--script`. Pass absolute paths:

   ```sh
   godot --headless --path runner --import
   godot --headless --path runner --script res://t3_chunks.gd -- "$PWD/out/v1.pck" \
     "$PWD/out/r/cdc_v1.pck_65536.json" "$PWD/out/r/cdc_v2.pck_65536.json" "$PWD/out/r/chunks_65536" \
     "$PWD/out/v2_rebuilt.pck" "$(sha256sum out/v2.pck | cut -d' ' -f1)"
   ```

   The mount-semantics scripts (`t4 whole`, `t7`, `t7b`, `t9`) also write to and read from
   `user://packs/`, which for this project is `~/.local/share/godot/app_userdata/patchrunner/packs/`
   on Linux. Copy `out/v1.pck` and `out/v2.pck` there first.

5. **Client side on the release template.** Official 4.6+ templates ignore `--path`, `--script`
   and `--main-pack` (see A5 §1), so `tplrun.sh` exports the runner as a pack next to a copy of the
   template and sets `run/main_loop_type` to the test's class:

   ```sh
   ./tplrun.sh release T3Chunks "$PWD/out/v1.pck" "$PWD/out/r/cdc_v1.pck_65536.json" \
     "$PWD/out/r/cdc_v2.pck_65536.json" "$PWD/out/r/chunks_65536" "$PWD/out/v2_rebuilt.pck" \
     "$(sha256sum out/v2.pck | cut -d' ' -f1)"
   ./tplrun.sh release T4cBytewise
   ```

## Expected results

A6 ran on a 4-vCPU Xeon @ 2.10 GHz, warm cache, release template unless marked "editor".

- **Packs:** `v1.pck` 37,001,008 B (620 entries); `v2.pck` 37,697,544 B (625 entries), 9,796,975 B
  as zstd -19. In the pack, v1→v2 is 24 changed entries, 10 added and 5 removed.
- **Correctness oracle:** every successful route gives 371/371 resource fingerprints and 625/625
  raw-file SHA-256s, the same as mounting the CI-built `v2.pck`.
- **Rebuild and deltas:** the GDScript PCK writer is byte-identical to the exporter (42 ms build +
  167 ms SHA-256 for 36 MB); per-file `--patch-from` through a GDDL delta PCK gives 24/24 files
  byte-identical to v2 (2.7 ms to write the delta PCK); the whole-pack delta decodes in 48–53 ms;
  the private-namespace bake takes 55 ms plus 163 ms of SHA-256.
- **Chunk sync:** 424 chunks at 64 KiB, 7.5 MB fetched raw (1.82 MB as zstd per chunk), verified at
  ~80–100 MB/s.

Methods for the 36 MiB v1→v2 pair (A6 §3.1, condensed):

| Method                                                       | Wire bytes (saved)             | Client CPU, 36 MB                              |
| ------------------------------------------------------------ | ------------------------------ | ---------------------------------------------- |
| Full download                                                | 9.80 MB (0%)                   | ~0.2 s verify                                  |
| Native patch PCK overlay (`--export-patch`)                  | 0.99 MB (−90%)                 | mount <1 ms; no per-load cost                  |
| Native **delta** patch PCK overlay                           | 0.60 MB (−94%)                 | mount <1 ms; +2.9 ms per open of a 2.8 MB file |
| Polaris-built delta PCK (CLI `--patch-from` per file + GDDL) | 0.60 MB (−94%)                 | as above                                       |
| **Bake** a delta into a full pack (private namespace)        | 0.60 MB (−94%)                 | ~0.23 s                                        |
| Whole-file `--patch-from` via GDDL                           | 0.60 MB (−94%)                 | ~0.25–0.29 s (0.05 s decode)                   |
| Per-file download + client rebuild                           | 0.99 MB (−90%)                 | ~0.21 s                                        |
| Chunk sync, FastCDC 64 KiB                                   | 1.93 MB incl. index (−80%)     | ~0.36–0.45 s                                   |
| Chunk sync, **file-aware** FastCDC 64 KiB                    | **1.05 MB incl. index (−89%)** | same                                           |
| VCDIFF-lite copy/add                                         | 0.64–0.65 MB (−93%)            | ~0.24 s                                        |
| bsdiff-style byte-wise patch in GDScript                     | —                              | ~1.1 s for the loop alone: not viable          |
| ZIP overlay (`--export-patch` to `.zip`)                     | 1.17 MB (−88%)                 | mount <1 ms; reads ~1.8× slower                |

Generated projects, exports, logs, the template copy and the virtualenv are git-ignored.

## Engine sources

The experiment read, but does not vendor, these files of Godot 4.7.2-stable (tag `4.7.2-stable`,
commit `ed1daf0bf001b61586d9930840f2f1394092c079`, at
https://github.com/godotengine/godot/tree/ed1daf0bf001b61586d9930840f2f1394092c079):

- `core/io/{file_access_pack,file_access_patched,delta_encoding,compression,pck_packer,file_access_zip,file_access_compressed}.{h,cpp}`
- `core/config/project_settings.cpp`, `core/string/translation_server.cpp`, `main/main.cpp`
- `editor/export/{editor_export,editor_export_platform,editor_export_platform_pc,editor_export_preset}.cpp`
- `scene/resources/{packed_scene,resource_format_text}.cpp`
- `modules/{betsy,cvtt,etcpak}/config.py`, `modules/zip/{zip_packer,zip_reader}.cpp`
- `platform/web/os_web.cpp`, `platform/web/js/libs/library_godot_os.js`,
  `platform/web/js/engine/{engine,config,preloader}.js`
- class reference: `doc/classes/{FileAccess,PCKPacker,PackedByteArray,ProjectSettings,Image,FontFile,AudioStreamWAV}.xml`,
  `modules/vorbis/doc_classes/AudioStreamOggVorbis.xml`, `modules/zip/doc_classes/{ZIPPacker,ZIPReader}.xml`

## Known limits

From the note (A6 §7):

- **Web:** source reading only; no browser build was run.
- **Mobile:** no Android or iOS device. All timings are x86-64 desktop; the Android
  `load_resource_pack` stall (godot#105009) and low-end SHA-256 throughput remain open.
- **Windows file locking:** not tested.
- **Multi-version history:** only one v1→v2 pair was built.
- The trailer trick's effect on a live mount of the same file is inferred, not tested.
- Numbers are single runs on a warm cache, except `t3b` (three runs, range reported).

From porting the experiment into the repo:

- **Packs are not byte-reproducible across environments.** The generator is seeded, but PNG, OGG and
  WAV encoding depend on Pillow, libsndfile/libvorbis and numpy versions, and the fonts the
  experiment copied (SHA-256 `f98ada96…` for `DMMono-Regular.ttf`, 48,852 B; `77cd233a…` for
  `IBMPlexSerif-Regular.ttf`, 160,380 B) are older builds than the current `google/fonts` files.
  Expect the same shape of results with different byte counts.
- **Hand-prepared inputs were not kept as scripts:** `out/dl/`, `out/zd/` and `out/zd/list.json`
  (described in step 3); the small `user://packs/` fixtures of `t7`/`t7b` (`A.pck`, `B.pck`,
  `Brm.pck`, `A.zip`, `B.zip`, `container.bin`, `sparse.bin`, `sparse2.bin`), built with
  `tools/pck.py` as §2.7 describes; the stored-ZIP variant `v2_stored.zip`; the offset and container
  layouts; and the 160 MB synthetic pair (`big_old.bin`, `big_new.bin`, `big.pf.zst`) of §2.4.
- `tplrun.sh` edits `runner/project.godot`; restore it before committing.
