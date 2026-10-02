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

- [ ] A pack with an engine-imported model is admitted on both sides; every hostile RSCC fixture is
      refused with identical lines.
- [ ] The full green gate passes, including Godot 4.7.2 (editor and template) and 4.4.1.

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
- **Bounds.** `RSCC_MAX_TOTAL` = 256 MiB on both sides (justified in `rscc.ts`); block size
  4096–1 MiB (Godot writes 4096; the floor caps the block count at 65,537); modes other than 2
  refused. The CLI stays synchronous: the wasm decoder's `decode` is synchronous, so `lintPck`'s
  signature is unchanged.
- **4.4.1's framing is 4.7.2's.** A script-written 20×20 grid `.glb` imported by both engines
  (`godot-real-imports/` and `godot-real-imports-4.4.1/`) gives the same RSCC layout with other
  bodies; both are admitted.
- **Timings.** The CLI decodes the 4.7.2 import of a 96×96 grid (446 kB, 164 blocks) in about
  6 ms. The device decodes 4 MiB (1025 blocks, half random) in a few ms on 4.7.2 and 4.4.1 (the
  `pck rscc` info line in the packs suite).
