# P4-27 Scan compressed (RSCC) resources in packs

| Field       | Value                                                             |
| ----------- | ----------------------------------------------------------------- |
| Phase       | P4: Packs                                                         |
| Size        | 0.5–0.75 engineer-weeks                                           |
| Depends on  | [P4-08](P4-08-godot-packs.md), [P4-22](P4-22-ci-chunk-indexes.md) |
| Unblocks    | none                                                              |
| Role        | `pkey-godot-engineer`                                             |
| Plan mode   | no                                                                |
| Gates       | all SDKs; cli bundle; threat model                                |
| Human input | none                                                              |
| Repo        | `vladzaharia/polaris-key`                                         |

## Goal

Admit packs that carry imported models. Godot's scene importer writes the imported `.scn` as a
compressed binary resource (`RSCC`, FileAccessCompressed), which P4-08's validators refuse under any
name, so every pack with an imported `.glb`/`.gltf`/`.blend`/`.fbx` is refused today. Decompress
`RSCC` in both validators and run the same fail-closed marker scan on the decompressed bytes.

## Read first

- P4-08's brief and its "Corrections from implementation" (the three audit rounds), `pck.gd` and
  `packages/cli/src/packLint.ts`, and THREAT-MODEL "Pack bytes on the device (P4-08)".
- The engine-written fixture `packages/cli/test/fixtures/godot-real-imports/` (`tri.glb.import` and
  its `.scn`), pinned as refused in `audit-real-import-model`.

## Scope

**In:**

- Decompress `RSCC` in both `pck.gd` (`PackedByteArray.decompress`) and `packLint.ts` (the
  `@polaris-key/zstd-wasm` decoder P4-22 brought into the CLI and Action), **mode 2 (zstd) only**;
  any other mode is refused.
- Treat every header field as untrusted: block size, total size and block count are bounded before
  allocation; each block must decode to exactly its declared size; the total is capped (a constant
  shared by both sides); trailing magic checked; anything malformed or over the cap is refused.
- The decompressed body must start a valid binary resource and then gets the existing raw-marker
  scan (and every other RSRC rule) exactly as an uncompressed RSRC would.
- Verdict parity: new shared fixtures in `godotFixtures.test.ts` (real engine-written imports
  admitted; RSCC with a marker refused; wrong mode, oversized total, truncated block, block that
  decodes long/short, decompression bomb within the cap's arithmetic all refused), run on 4.7.2
  and 4.4.1.
- Flip `audit-real-import-model` to admitted; update THREAT-MODEL and `docs/build/ci.md`.

**Out:** other compression modes; any change to what is scanned for.

## Acceptance

- [x] A pack with an engine-imported model is admitted on both sides; every hostile RSCC fixture is
      refused with identical lines.
- [x] The full green gate passes, including Godot 4.7.2 (editor and template) and 4.4.1.

## Corrections from implementation

- **The body has no `RSRC` magic.** Godot's binary saver writes the magic only to an uncompressed
  file, so a decompressed `RSCC` body starts at the header words after it. "Starts a valid binary
  resource" is therefore: at least five header words, with the big-endian and real64 flags each 0
  or 1 (`rsccBodyIsResource`, the same test in `pck.gd`). The marker rule then runs on the body
  exactly as on an `RSRC` entry.
- **A frame walk on both sides.** The engine's decoder (libzstd's one-shot `ZSTD_decompressDCtx`,
  which `PackedByteArray.decompress` calls) accepts concatenated and skippable frames and a frame
  without a content size; `@polaris-key/zstd-wasm` refuses them. To keep verdicts identical,
  both validators first walk each block (`zstdFrameOk` / `zstd_frame_ok`): one frame, no
  reserved bit, no dictionary id, a content size equal to the block's, the block headers and the
  optional checksum ending exactly at the block's end. A block that fails is "not one zstd frame
  of N bytes"; one that passes but does not decode to exactly N (a corrupt frame, or one that lies
  about its size) is "does not decode to N bytes". Every frame is walked before any allocation.
- **The empty last block.** When the total is a multiple of the block size Godot still writes a
  last frame, of 0 bytes (`28 b5 2f fd 20 00 01 00 00`, measured). `decompress` takes no zero
  output size, so a 0-byte block must hold only empty raw blocks and no checksum, and neither side
  decodes it. Pinned by `rscc-empty-tail` and, on the device, by an engine-written
  `FileAccess.open_compressed` file of 8192 bytes.
- **Bounds.** `RSCC_MAX_TOTAL` (64 MiB since the audit below) on both sides; block size
  4096–1 MiB (Godot writes 4096; the floor caps the block count at 65,537); modes other than 2
  refused. The CLI stays synchronous: the wasm decoder's `decode` is synchronous, so `lintPck`'s
  signature is unchanged.
- **4.4.1's framing is 4.7.2's.** A script-written 20×20 grid `.glb` imported by both engines
  (`godot-real-imports/` and `godot-real-imports-4.4.1/`) gives the same RSCC layout with other
  bodies; both are admitted.
- **Timings.** The CLI (wasm decoder, one instance per block) decodes the 4.7.2 import of a
  96×96 grid (446 kB, 164 blocks, 670 kB body) in about 6 ms. The device's `rscc_body` decodes
  4 MiB (1025 blocks, half zeros, half random) in 2 ms on the 4.7.2 editor and release template
  and 5 ms on the 4.4.1 editor (the `pck rscc` info line in the packs suite).
- **Audit round (GAP 1a, 1b, 2).** (1a) Frames must be single-segment on both sides: a window
  descriptor of 2^31 is refused by the 32-bit wasm libzstd and accepted by a 64-bit device
  (`rscc-window-31`). (1b) No zstd block may declare more than 128 KiB or more than the frame's
  size (`rscc-raw-block-200k`). (2) Single-segment RLE regenerates 128 KiB per 4 bytes, so the
  cap was a cheap amplifier: `RSCC_MAX_TOTAL` drops to 64 MiB, measured (a script-written skinned
  character, 300×300 grid, 60 joints, 20 animations of 10 s at 30 fps, imports to an 18,216,754-
  byte body; a 700×700 grid mesh, 980,000 triangles, to 58,746,302; the cap is about 4× the
  character, capped at 64 MiB), and `RSCC_PACK_BUDGET` = 512 MiB bounds a pack's declared RSCC
  bytes in directory order, counted from the header before decoding (`rscc-over-pack-budget`:
  the ninth of nine 64 MiB − 4 KiB entries is refused). The device's marker scan
  (`first_present`, which replaced `find_bytes` for every caller, uncompressed resources and
  text included) hex-encodes 1 MiB windows overlapping by the longest marker − 1 and searches
  each natively, re-checking a window with its decimal form only for a hit at an odd hex
  offset, so its GDScript work is per window, not per hit; `_without_backslashes` became a
  native string replace. `rscc-g-run` (64 MiB of `G` after a header) is admitted and checked in
  751–839 ms (4.7.2 editor), 738 ms (4.7.2 release template) and 488–514 ms (4.4.1), bounded at 5 s in the suite; the per-hit scan spent
  about 62 ms per MiB of `G`. (2d) The CLI keeps one wasm instance per frame: zdec.c's bump
  allocator never frees and the module exports no reset, so a shared instance would grow by
  every block; instantiation is cheap (64 MiB in 16,385 blocks of 4096 decodes in 602 ms; the
  lint of `rscc-g-run` takes 24 ms and of `rscc-over-pack-budget` 124 ms).
- **Follow-up: a flaky P3-10 test.** `updater guard: ready confirms after BOOT_OK_SECONDS`
  (tests/updater/test_guard.gd, its 0.2 s timing assertion) is flaky under load: it failed once
  in the editor while the JS gate loaded the machine and once in the release template, and a
  third full 4.7.2 run was green. It is not changed here.
