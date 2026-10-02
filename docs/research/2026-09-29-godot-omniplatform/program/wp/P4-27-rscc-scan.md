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
