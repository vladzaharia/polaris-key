/**
 * P4-08 — the fixtures the Godot SDK's device-side checks run over, so the publish lint and the
 * device cannot drift (P4-03 recorded that P4-08 MUST apply the same admission list and embedded-
 * code rule on the device, over the same fixture PCKs).
 *
 * `sdks/godot/tests/fixtures/packs/` holds:
 *
 *   check/<name>.pck      PCKs from `writeTestPck` (packFixtures.ts) and their lint verdicts in
 *   check/verdicts.json   `lintPck`'s exact error strings (the header and directory refusals the
 *                         reader raises are recorded as `reader`), which the Godot packs suite
 *                         compares line for line with `PKeyPck`'s
 *   update/               the kaykit v1 and v2 data packs (stripped, admissible) and every object
 *                         `pkey release publish` would store for them — full, the files index and
 *                         gaps, the file blobs, the v1→v2 payload delta and files delta — plus
 *                         `manifest.json` with the record variants; the Godot engine tests sign
 *                         pack records over them and install v2 by delta, file and full
 *
 * This test regenerates all of it in memory. The PCKs and verdicts must equal the committed files
 * byte for byte. The zstd objects depend on the zstd build, so they are held to what they decode
 * to: each committed object hashes to its name, and decodes (with the zstd CLI) to the payloads,
 * index entries, gaps and delta results the generator produces now. `PKEY_WRITE_GODOT_FIXTURES=1`
 * rewrites the directory. Needs `zstd` ≥ 1.5.5 on PATH (like packArtifacts.test.ts).
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildFilesDelta,
  buildPayload,
  buildPayloadDelta,
  containerPayload,
  filesRefOf,
  lintPck,
  readPck,
  zstdCli,
} from "../src/index.js";
import {
  binaryResource,
  kaykitForbidden,
  kaykitUnstripped,
  kaykitV1,
  kaykitV2,
  PREFIX,
  sha,
  uidCache,
  writeTestPck,
  type PckOptions,
} from "./packFixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(
  here,
  "..",
  "..",
  "..",
  "sdks",
  "godot",
  "tests",
  "fixtures",
  "packs",
);
const WRITE = process.env.PKEY_WRITE_GODOT_FIXTURES === "1";
const ENGINE = "godot-4.7";

const work = mkdtempSync(path.join(os.tmpdir(), "pkey-godot-fixtures-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const enc = (t: string) => new TextEncoder().encode(t);

/** Decode with the zstd CLI, independently of the code under test. */
function unzstd(frame: Uint8Array, patchFrom?: Uint8Array): Uint8Array {
  const d = mkdtempSync(path.join(work, "dec-"));
  writeFileSync(path.join(d, "in.zst"), frame);
  const args = ["-d", "-q", "-f", "--long=31", path.join(d, "in.zst"), "-o"];
  args.push(path.join(d, "out"));
  if (patchFrom) {
    writeFileSync(path.join(d, "base"), patchFrom);
    args.splice(1, 0, `--patch-from=${path.join(d, "base")}`);
  }
  execFileSync("zstd", args);
  return new Uint8Array(readFileSync(path.join(d, "out")));
}

/** A binary resource string with `pad` extra NULs counted in its (enlarged) u32 length. */
function paddedString(text: string, pad: number): Uint8Array {
  const b = enc(`${text}\0`);
  const out = new Uint8Array(4 + b.length + pad);
  new DataView(out.buffer).setUint32(0, b.length + pad, true);
  out.set(b, 4);
  return out;
}

/** `RSRC`, the header words, then the given strings and opaque data. */
function binaryRaw(strings: Uint8Array[]): Uint8Array {
  const head = new Uint8Array(20);
  head.set(enc("RSRC"));
  new DataView(head.buffer).setUint32(8, 4, true);
  return new Uint8Array(
    Buffer.concat([head, ...strings, new Uint8Array(64).fill(0x41)]),
  );
}

/**
 * A file the real Godot editor wrote, verbatim: 4.7.2's in test/fixtures/godot-real-imports/,
 * 4.4.1's in godot-real-imports-4.4.1/.
 */
function realImport(name: string, engine = ""): Uint8Array {
  const dir =
    engine === "" ? "godot-real-imports" : `godot-real-imports-${engine}`;
  return new Uint8Array(readFileSync(path.join(here, "fixtures", dir, name)));
}

// ── P4-27: compressed binary resources (RSCC) ────────────────────────────────

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** A zstd block header: last flag, type (0 raw, 1 RLE, 2 compressed), size. */
const zblock = (last: boolean, type: number, size: number) => {
  const h = (last ? 1 : 0) | (type << 1) | (size << 3);
  return new Uint8Array([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]);
};

/**
 * One zstd frame written by hand (deterministic, unlike any encoder's output, so the PCKs can be
 * byte-compared): single segment, content size `fcs` (default: the content's length), the
 * content as raw blocks of at most 128 KiB, `extra` bytes added to the last block's payload.
 */
function zframe(
  content: Uint8Array,
  o: { fcs?: number; extra?: number; checksum?: boolean } = {},
): Uint8Array {
  const fcs = o.fcs ?? content.length;
  const ck = o.checksum ? 0x04 : 0;
  let head: Uint8Array;
  if (fcs < 256) head = new Uint8Array([0x20 | ck, fcs]);
  else if (fcs < 65536 + 256) {
    head = new Uint8Array([0x60 | ck, 0, 0]);
    new DataView(head.buffer).setUint16(1, fcs - 256, true);
  } else head = cat(new Uint8Array([0xa0 | ck]), u32(fcs));
  const body = cat(content, new Uint8Array(o.extra ?? 0).fill(0x41));
  const parts: Uint8Array[] = [u32(0xfd2fb528), head];
  const MAX = 131072;
  if (body.length === 0) parts.push(zblock(true, 0, 0));
  for (let at = 0; at < body.length; at += MAX) {
    const piece = body.subarray(at, at + MAX);
    parts.push(zblock(at + MAX >= body.length, 0, piece.length), piece);
  }
  if (o.checksum) parts.push(u32(0));
  return cat(...parts);
}

/** Godot's frame for an empty last block (measured: `ZSTD_compressCCtx` of 0 bytes). */
const EMPTY_FRAME = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x01, 0x00, 0x00,
]);

/** An RSCC file: header, block table, the frames, the closing magic. */
function rscc(
  frames: Uint8Array[],
  total: number,
  o: { mode?: number; bs?: number; sizes?: number[] } = {},
): Uint8Array {
  const sizes = o.sizes ?? frames.map((f) => f.length);
  return cat(
    enc("RSCC"),
    u32(o.mode ?? 2),
    u32(o.bs ?? 4096),
    u32(total),
    ...sizes.map(u32),
    ...frames,
    enc("RSCC"),
  );
}

/** An RSCC of `body`, cut into `bs` blocks the way FileAccessCompressed does, raw frames. */
function rsccOf(body: Uint8Array, bs = 4096): Uint8Array {
  const bc = Math.floor(body.length / bs) + 1;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < bc; i++) {
    const piece = body.subarray(i * bs, Math.min(body.length, (i + 1) * bs));
    frames.push(piece.length === 0 ? EMPTY_FRAME : zframe(piece));
  }
  return rscc(frames, body.length, { bs });
}

/**
 * A binary resource body as an RSCC holds it: the RSRC file without its magic, so the header
 * words come first (big-endian 0, real64 0, version 4.7, format 6), then `binaryResource`'s
 * strings and data.
 */
const resBody = (types: string[], props: string[], seed: number) =>
  cat(
    u32(0),
    u32(0),
    u32(4),
    u32(7),
    u32(6),
    binaryResource(types, props, seed).subarray(20),
  );

/** `n` bytes of resource-shaped body (header words, then noise without markers). */
function plainBody(n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set(resBody(["Mesh"], ["surfaces"], 11).subarray(0, n));
  for (let i = 600; i < n; i++) b[i] = (i * 7 + 3) & 0x7f;
  return b;
}

const TRI_SCN = "tri.glb-6ed0665643de460f848bf1abf5ed7ae0.scn";
const GRID_SCN = "grid.glb-9b02adf25d7711b0ef870695e4d4a20b.scn";

/**
 * P4-27: real engine-written RSCC imports (admitted) and every hostile shape (refused with the
 * same line on both sides). The hostile `.scn`s sit under the prefix: the scan judges content,
 * not location. `tri` is the 4.7.2 editor's single-triangle import (2 blocks); `grid` a 20×20
 * grid mesh `.glb` written by a script, imported by 4.7.2 and by 4.4.1 (same RSCC framing, other
 * bodies; 5 blocks each, files verbatim under fixtures/godot-real-imports{,-4.4.1}/).
 */
function rsccFixtures(): CheckFixture[] {
  const tri = realImport(TRI_SCN);
  const at = "assets/kaykit/";
  const set = (bytes: Uint8Array, off: number, v: number) => {
    const c = bytes.slice();
    new DataView(c.buffer).setUint32(off, v, true);
    return c;
  };
  // A body that names GDScript: an RSRC with an embedded script's type, without the magic.
  const scriptBody = resBody(
    ["PackedScene", "GDScript"],
    ["nodes", "script"],
    12,
  );
  // …and one whose marker straddles a block boundary (the body is scanned whole).
  const straddle = plainBody(8192 + 100);
  straddle.set(enc("GDScript"), 4096 - 3);
  const block = plainBody(4096);
  return [
    {
      name: "rscc-real-import-grid",
      files: [
        ...kaykitV1(),
        [`${at}grid.glb.import`, realImport("grid.glb.import")],
        [`.godot/imported/${GRID_SCN}`, realImport(GRID_SCN)],
      ],
    },
    {
      name: "rscc-real-import-grid-4.4.1",
      files: [
        ...kaykitV1(),
        [`${at}grid.glb.import`, realImport("grid.glb.import", "4.4.1")],
        [`.godot/imported/${GRID_SCN}`, realImport(GRID_SCN, "4.4.1")],
      ],
    },
    {
      // A total that is a multiple of the block size: Godot writes an empty last frame.
      name: "rscc-empty-tail",
      files: [...kaykitV1(), [`${at}tail.scn`, rsccOf(plainBody(8192))]],
    },
    {
      name: "rscc-script",
      files: [
        ...kaykitV1(),
        [`${at}script.scn`, rsccOf(scriptBody)],
        [`${at}straddle.res`, rsccOf(straddle)],
        [`${at}model.png`, rsccOf(scriptBody)],
      ],
    },
    {
      name: "rscc-mode",
      files: [
        ...kaykitV1(),
        [`${at}deflate.scn`, set(tri, 4, 1)],
        [`${at}fastlz.scn`, set(tri, 4, 0)],
        [`${at}gzip.scn`, set(tri, 4, 3)],
      ],
    },
    {
      name: "rscc-over-cap",
      files: [
        ...kaykitV1(),
        // Only the header: nothing past it is read.
        [
          `${at}big.scn`,
          cat(enc("RSCC"), u32(2), u32(1048576), u32(268435457)),
        ],
        [`${at}max.scn`, set(set(tri, 8, 1048576), 12, 0xffffffff)],
      ],
    },
    {
      name: "rscc-header",
      files: [
        ...kaykitV1(),
        [`${at}short.scn`, enc("RSCC\x02\0\0\0")],
        [`${at}tiny-blocks.scn`, set(tri, 8, 16)],
        [`${at}huge-blocks.scn`, set(tri, 8, 1048577)],
        [`${at}zero-blocks.scn`, set(tri, 8, 0)],
        // A total under the cap whose block table (1001 sizes) needs more bytes than the file has.
        [`${at}table.scn`, set(tri, 12, 4096 * 1000)],
      ],
    },
    {
      name: "rscc-truncated",
      files: [
        ...kaykitV1(),
        [`${at}cut.scn`, tri.subarray(0, tri.length - 100)],
        [`${at}no-magic.scn`, tri.subarray(0, tri.length - 4)],
      ],
    },
    {
      name: "rscc-decodes-long-short",
      files: [
        ...kaykitV1(),
        // The frame says 4000 for a 4096 block: refused before decoding.
        [
          `${at}says-short.scn`,
          rscc([zframe(block.subarray(0, 4000)), EMPTY_FRAME], 4096),
        ],
        // The frame says 4096 but its blocks hold 4000 / 4196 bytes: the decoder refuses.
        [
          `${at}is-short.scn`,
          rscc(
            [zframe(block.subarray(0, 4000), { fcs: 4096 }), EMPTY_FRAME],
            4096,
          ),
        ],
        [
          `${at}is-long.scn`,
          rscc([zframe(block, { extra: 100 }), EMPTY_FRAME], 4096),
        ],
        // The last block is a remainder (100 bytes), and must be exactly that.
        [
          `${at}tail-long.scn`,
          rscc([zframe(block), zframe(block.subarray(0, 101))], 4196),
        ],
        // An empty last block may only be empty raw blocks with no checksum.
        [
          `${at}tail-nonempty.scn`,
          rscc(
            [zframe(block), zframe(new Uint8Array(0), { extra: 1, fcs: 0 })],
            4096,
          ),
        ],
        [
          `${at}tail-checksum.scn`,
          rscc(
            [zframe(block), zframe(new Uint8Array(0), { checksum: true })],
            4096,
          ),
        ],
      ],
    },
    {
      name: "rscc-frames",
      files: [
        ...kaykitV1(),
        // Two frames in one block: libzstd's one-shot decode (the engine's) would take both.
        [
          `${at}two-frames.scn`,
          rscc(
            [
              cat(
                zframe(block.subarray(0, 2048)),
                zframe(block.subarray(2048)),
              ),
              EMPTY_FRAME,
            ],
            4096,
          ),
        ],
        // A skippable frame before the block's frame.
        [
          `${at}skippable.scn`,
          rscc(
            [cat(u32(0x184d2a50), u32(4), u32(0), zframe(block)), EMPTY_FRAME],
            4096,
          ),
        ],
        // No content size in the frame header.
        [
          `${at}no-size.scn`,
          rscc(
            [
              cat(
                u32(0xfd2fb528),
                new Uint8Array([0x00, 0x58]),
                zblock(true, 0, 4096),
                block,
              ),
              EMPTY_FRAME,
            ],
            4096,
          ),
        ],
        // A dictionary id.
        [
          `${at}dict.scn`,
          rscc(
            [
              cat(
                u32(0xfd2fb528),
                new Uint8Array([0x61, 0x07]),
                u32(0).subarray(0, 2),
                zblock(true, 0, 4096),
                block,
              ),
              EMPTY_FRAME,
            ],
            4096,
          ),
        ],
        // A reserved block type.
        [
          `${at}reserved.scn`,
          rscc(
            [
              cat(
                u32(0xfd2fb528),
                new Uint8Array([0x60, 0x00, 0x0f]),
                zblock(true, 3, 4096),
                block,
              ),
              EMPTY_FRAME,
            ],
            4096,
          ),
        ],
        // Not zstd at all.
        [`${at}not-zstd.scn`, rscc([block.subarray(0, 64), EMPTY_FRAME], 4096)],
      ],
    },
    {
      name: "rscc-count",
      files: [
        ...kaykitV1(),
        // The table's sizes sum short of the blocks: the closing magic is not where it says.
        [
          `${at}sum-short.scn`,
          rscc([zframe(block), EMPTY_FRAME], 4096, { sizes: [4000, 9] }),
        ],
        // …or past them.
        [
          `${at}sum-long.scn`,
          rscc([zframe(block), EMPTY_FRAME], 4096, { sizes: [4200, 9] }),
        ],
        // A total that needs three blocks over a file that holds two.
        [`${at}count.scn`, rscc([zframe(block), EMPTY_FRAME], 8192)],
        // The block sizes are right but a frame belongs to the next block.
        [`${at}swapped.scn`, rscc([EMPTY_FRAME, zframe(block)], 4096)],
      ],
    },
    {
      // A decompression bomb inside the cap's arithmetic: 4 MiB declared in 1 MiB blocks, each
      // frame declaring 1 MiB but holding 512 RLE blocks of 128 KiB (64 MiB). The decoders get
      // 1 MiB of room and stop there.
      name: "rscc-bomb",
      files: [...kaykitV1(), [`${at}bomb.scn`, rsccBomb()]],
    },
    {
      name: "rscc-trailing",
      files: [
        ...kaykitV1(),
        [`${at}after.scn`, cat(tri, enc("x"))],
        [`${at}twice.scn`, cat(tri, enc("RSCC"))],
      ],
    },
    {
      name: "rscc-body",
      files: [
        ...kaykitV1(),
        // A body that is not a binary resource: a nested RSCC, a text resource, too short.
        [`${at}nested.scn`, rsccOf(cat(tri, new Uint8Array(32)))],
        [
          `${at}text.scn`,
          rsccOf(enc('[gd_resource type="Resource" format=3]\n\n[resource]\n')),
        ],
        [`${at}short-body.scn`, rsccOf(new Uint8Array(19))],
        [`${at}empty.scn`, rsccOf(new Uint8Array(0))],
      ],
    },
  ];
}

function rsccBomb(): Uint8Array {
  const MiB = 1048576;
  const rle = cat(
    ...Array.from({ length: 512 }, (_, i) =>
      cat(zblock(i === 511, 1, 131072), new Uint8Array([0x41])),
    ),
  );
  const frame = cat(u32(0xfd2fb528), new Uint8Array([0xa0]), u32(MiB), rle);
  return rscc([frame, frame, frame, frame, EMPTY_FRAME], 4 * MiB, { bs: MiB });
}

interface CheckFixture {
  name: string;
  files: [string, Uint8Array][];
  opts?: PckOptions;
}

/** The directory-check fixtures: P4-03's admission-list and embedded-code probes, verbatim. */
function checkFixtures(): CheckFixture[] {
  const be = binaryResource(["PackedScene"], ["nodes"], 3);
  const beScript = new Uint8Array(
    Buffer.concat([
      be,
      Buffer.from([0, 0, 0, 14]),
      Buffer.from("script/source\0"),
    ]),
  );
  const exported = ".godot/exported/9/export-ffff-x.scn";
  return [
    { name: "kaykit-v1", files: kaykitV1() },
    {
      name: "kaykit-unstripped",
      files: kaykitUnstripped(),
      opts: { flags: 0 },
    },
    { name: "kaykit-forbidden", files: kaykitForbidden() },
    {
      name: "remap-script-gdextension-engine",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/pack_class.gd.remap",
          enc('[remap]\n\npath="res://assets/kaykit/pack_class.gdc"\n'),
        ],
        ["assets/kaykit/x.gdextension", enc("[configuration]\n")],
      ],
      opts: { engine: [4, 6, 1] },
    },
    {
      name: "embedded-text",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/probe.tscn",
          enc(
            '[gd_scene load_steps=2 format=3 uid="uid://probe"]\n\n[sub_resource type="GDScript" id="GDScript_x"]\nscript/source = "extends Node\nfunc _ready(): OS.execute(\\"sh\\", [])"\n\n[node name="Probe" type="Node"]\nscript = SubResource("GDScript_x")\n',
          ),
        ],
        [
          "assets/kaykit/sneaky.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[resource]\nscript/source = "extends Resource"\n',
          ),
        ],
      ],
    },
    {
      name: "ext-script-ok",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/die.tscn",
          enc(
            '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://scripts/die.gd" id="1_a"]\n\n[node name="Die" type="Node3D"]\nscript = ExtResource("1_a")\n',
          ),
        ],
      ],
    },
    {
      name: "embedded-binary",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/a.scn",
          binaryResource(["PackedScene", "GDScript"], ["nodes"], 4),
        ],
        ["assets/kaykit/b.res", beScript],
        [
          "assets/kaykit/c.res",
          binaryResource(["Resource"], ["data"], 5, "RSCC"),
        ],
        ["assets/kaykit/d.scn", enc("not a resource")],
        ["assets/kaykit/e.res", binaryResource(["Mesh"], ["surfaces"], 6)],
      ],
    },
    {
      name: "exported-script",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/x.tscn.remap",
          enc(`[remap]\n\npath="res://${exported}"\n`),
        ],
        [
          exported,
          binaryResource(
            ["PackedScene", "GDScript"],
            ["nodes", "script/source"],
            7,
          ),
        ],
      ],
    },
    // P4-08 review B1: paths the engine would normalise into another place.
    {
      name: "path-dotdot",
      files: [...kaykitV1(), ["assets/kaykit/../../escaped.txt", enc("hello")]],
    },
    {
      name: "path-trailing-dot",
      files: [
        ...kaykitV1(),
        ["assets/kaykit/evil.gd/.", enc("extends Node\n")],
      ],
    },
    {
      name: "path-dot-segment",
      files: [
        ...kaykitV1(),
        ["assets/kaykit/./evil.gd/", enc("extends Node\n")],
      ],
    },
    // B2: resources are found by content, whatever the extension.
    {
      name: "content-binary-extensions",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/look.material",
          binaryResource(["StandardMaterial3D", "GDScript"], ["albedo"], 8),
        ],
        [
          "assets/kaykit/walk.anim",
          binaryResource(["Animation"], ["tracks", "script/source"], 9),
        ],
        [
          "assets/kaykit/m.mesh",
          binaryResource(["ArrayMesh", "CSharpScript"], ["surfaces"], 10),
        ],
        [
          "assets/kaykit/z.material",
          binaryResource(["StandardMaterial3D"], ["albedo"], 11, "RSCC"),
        ],
        [
          "assets/kaykit/level.cfg",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[sub_resource type="GDScript" id="s"]\nscript/source = "extends Resource"\n',
          ),
        ],
        [
          "assets/kaykit/plain.material",
          binaryResource(["StandardMaterial3D"], ["albedo"], 12),
        ],
      ],
    },
    // N6: an in-prefix .import or .remap names files of this pack only, and so does the uid cache.
    {
      name: "remap-outside-pack",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/coin.png.import",
          enc(
            '[remap]\n\nimporter="texture"\npath="res://.godot/imported/basegame.png-1234.ctex"\n',
          ),
        ],
        [
          "assets/kaykit/odd.tscn.remap",
          enc('[remap]\n\npath="res://assets/kaykit/../../game/main.scn"\n'),
        ],
        [
          "assets/kaykit/abs.tscn.remap",
          enc('[remap]\n\npath="/tmp/elsewhere.scn"\n'),
        ],
      ],
    },
    {
      name: "uid-cache-outside-pack",
      files: kaykitV1().map(([p, b]): [string, Uint8Array] =>
        p === ".godot/uid_cache.bin"
          ? [
              p,
              uidCache([
                [1111n, "res://assets/kaykit/dice.png"],
                [4444n, "res://main_res/base.tres"],
              ]),
            ]
          : [p, b],
      ),
    },
    // P4-08 validator audit, GAP 1: every spelling of an embedded script in a text resource is
    // refused by the fail-closed content rule, not by a section regex.
    {
      name: "audit-text-spellings",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/inline.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[resource]\nname = "x" [sub_resource type="GDScript" id="s"]\n',
          ),
        ],
        [
          "assets/kaykit/multiline.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[sub_resource\ntype="GDScript"\nid="s"]\nscript/source = "extends Resource"\n',
          ),
        ],
        [
          "assets/kaykit/bracket.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[sub_resource id="a]b" type="GDScript"]\n',
          ),
        ],
        [
          "assets/kaykit/stringname.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[sub_resource type=&"GDScript" id="s"]\n',
          ),
        ],
        [
          "assets/kaykit/escaped.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[sub_resource type="GD\\u0053cript" id="s"]\n',
          ),
        ],
        [
          "assets/kaykit/objinline.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[resource]\nscript = Object(GDScript,"script/source":"extends Resource")\n',
          ),
        ],
        // GAP A: an unknown escape keeps its character (`\S` reads as `S`).
        [
          "assets/kaykit/passthrough.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[sub_resource type="GD\\Script" id="s"]\n',
          ),
        ],
        [
          "assets/kaykit/passthrough-src.tres",
          enc(
            '[gd_resource type="Resource" format=3]\n\n[resource]\n"script\\/source" = "extends Resource"\n',
          ),
        ],
      ],
    },
    {
      name: "audit-text-legit",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/material.tres",
          enc(
            '[gd_resource type="StandardMaterial3D" format=3 uid="uid://mat"]\n\n[resource]\nalbedo_color = Color(1, 0.5, 0.2, 1)\nmetallic = 0.3\n',
          ),
        ],
      ],
    },
    // GAP 2: CR-only line endings (JS's `m` flag breaks lines at CR; PCRE2 in Godot at LF).
    {
      name: "audit-cr",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/cr.tres",
          enc(
            '[gd_scene load_steps=2 format=3 uid="uid://probe"]\n\n[sub_resource type="GDScript" id="GDScript_x"]\nscript/source = "extends Node\nfunc _ready(): OS.execute(\\"sh\\", [])"\n\n[node name="Probe" type="Node"]\nscript = SubResource("GDScript_x")\n'.replace(
              /\n/g,
              "\r",
            ),
          ),
        ],
      ],
    },
    // GAP 3: NUL-padded strings with enlarged lengths still decode to the type in the engine.
    {
      name: "audit-binary-padded",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/padded.res",
          binaryRaw([
            paddedString("Resource", 0),
            paddedString("script/source", 7),
            paddedString("GDScript", 9),
          ]),
        ],
      ],
    },
    // Threat model (a): a binary reference to an app script (ext type `Script`) names no marker
    // and is ADMITTED, the same residual as the text `[ext_resource type="Script"]`.
    {
      name: "audit-binary-extref",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/extref.res",
          binaryRaw([
            paddedString("Resource", 0),
            paddedString("Script", 0),
            paddedString("res://scripts/die.gd", 0),
          ]),
        ],
      ],
    },
    // GAP 4: a path key the engine reads that the target scan would not.
    {
      name: "audit-remap-dodges",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/a.png.import",
          enc('[remap]\n\nimporter="texture"\npath.s3tc.x="res://main.gd"\n'),
        ],
        [
          "assets/kaykit/b.tres.remap",
          enc('[remap]\n\npath=&"res://assets/kaykit/data/level_000.json"\n'),
        ],
        // GAP B: a path key anywhere in a line, after a metadata `}`, quoted with an escape, or
        // behind a control byte.
        ["assets/kaykit/c.png.import", enc('[remap] path="res://main.gd"\n')],
        [
          "assets/kaykit/d.png.import",
          enc('[remap]\n\nimporter="texture" path="res://main.gd"\n'),
        ],
        [
          "assets/kaykit/e.png.import",
          enc(
            '[remap]\n\nimporter="texture"\nmetadata={\n"vram_texture": true\n} path="res://main.gd"\n',
          ),
        ],
        [
          "assets/kaykit/f.tres.remap",
          enc('[remap]\n\n"pat\\h"="res://main.gd"\n'),
        ],
        [
          "assets/kaykit/g.tres.remap",
          enc('[remap]\n\n\x01path="res://main.gd"\n'),
        ],
      ],
    },
    // GAP 6: a NUL byte in a text resource is refused; a non-resource whose first byte (0x85, a
    // PCRE2 \v) hides a head is not a resource to either side, and nothing loads a `.bin`.
    {
      name: "audit-nul",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/nulbyte.tres",
          enc(
            '[gd_resource type="Resource" format=3]\0\n[sub_resource type="GDScript" id="s"]\n',
          ),
        ],
      ],
    },
    // P4-22 review: a BOM before a text head under an unrecognised extension is still sniffed.
    {
      name: "audit-bom-head",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/level.bin",
          new Uint8Array([
            0xef,
            0xbb,
            0xbf,
            ...enc(
              '[gd_resource type="Resource" format=3]\n\n[sub_resource type="GDScript" id="s"]\n',
            ),
          ]),
        ],
      ],
    },
    {
      name: "audit-x-bin",
      files: [
        ...kaykitV1(),
        [
          "assets/kaykit/x.bin",
          new Uint8Array([
            0x85,
            ...enc(
              '[gd_resource type="Resource" format=3]\n\n[sub_resource type="GDScript" id="s"]\n',
            ),
          ]),
        ],
      ],
    },
    // GAP C: a texture and a model imported by the real 4.7.2 editor (`--headless --import` in a
    // scratch project with the assets under res://assets/kaykit/), verbatim: the .import files
    // with their [params] (`import_script/path=""`, `materials/extract_path=""`, …) and the
    // files they name. Both are ADMITTED on both sides: the scene importer writes its .scn
    // COMPRESSED (RSCC, FileAccessCompressed with zstd blocks of 4096), which P4-27 decompresses,
    // bounded, and scans (the `rscc-*` fixtures below).
    {
      name: "audit-real-import-texture",
      files: [
        ...kaykitV1(),
        ["assets/kaykit/red.png.import", realImport("red.png.import")],
        [
          ".godot/imported/red.png-744f559d28819288f09084fd723b7b8b.ctex",
          realImport("red.png-744f559d28819288f09084fd723b7b8b.ctex"),
        ],
      ],
    },
    {
      name: "audit-real-import-model",
      files: [
        ...kaykitV1(),
        ["assets/kaykit/tri.glb.import", realImport("tri.glb.import")],
        [
          ".godot/imported/tri.glb-6ed0665643de460f848bf1abf5ed7ae0.scn",
          realImport("tri.glb-6ed0665643de460f848bf1abf5ed7ae0.scn"),
        ],
      ],
    },
    ...rsccFixtures(),
    // The reader: layouts it reads, and the header and entry flags it refuses with a path.
    {
      name: "reader-v2-res",
      files: kaykitV1(),
      opts: { version: 2, resPrefix: true, engine: [4, 3, 0] },
    },
    { name: "reader-v3", files: kaykitV1(), opts: { version: 3 } },
    { name: "reader-encrypted-dir", files: kaykitV1(), opts: { flags: 3 } },
    { name: "reader-sparse", files: kaykitV1(), opts: { flags: 6 } },
    {
      name: "reader-entry-encrypted",
      files: kaykitV1(),
      opts: { entryFlags: { "assets/kaykit/data/level_001.json": 1 } },
    },
    {
      name: "reader-entry-removal",
      files: kaykitV1(),
      opts: { entryFlags: { "assets/kaykit/data/level_004.json": 2 } },
    },
    {
      name: "reader-entry-delta",
      files: kaykitV1(),
      opts: { entryFlags: { "assets/kaykit/data/level_002.json": 4 } },
    },
  ];
}

interface Generated {
  files: Map<string, Uint8Array>;
  /** The zstd objects, held to their decoded meaning in check mode. */
  objects: Map<string, Uint8Array>;
  manifest: Record<string, unknown>;
}

async function generate(): Promise<Generated> {
  const files = new Map<string, Uint8Array>();
  const verdicts: Record<string, unknown> = {};
  for (const f of checkFixtures()) {
    const bytes = writeTestPck(f.files, f.opts ?? {});
    files.set(`check/${f.name}.pck`, bytes);
    let v: unknown;
    try {
      const r = lintPck(readPck(bytes), bytes, {
        prefixes: [PREFIX],
        engine: ENGINE,
      });
      v = { errors: r.errors, warnings: r.warnings };
    } catch (e) {
      v = { reader: (e as Error).message };
    }
    verdicts[f.name] = v;
  }
  files.set(
    "check/verdicts.json",
    enc(
      JSON.stringify(
        { prefixes: [PREFIX], engine: ENGINE, fixtures: verdicts },
        null,
        2,
      ) + "\n",
    ),
  );

  // The update fixtures: kaykit v1 → v2, as `pkey release publish` stores them.
  const z = zstdCli(work);
  const v1 = writeTestPck(kaykitV1());
  const v2 = writeTestPck(kaykitV2());
  files.set("update/kaykit-v1.pck", v1);
  files.set("update/kaykit-v2.pck", v2);
  const p1 = containerPayload(v1, readPck(v1));
  const p2 = containerPayload(v2, readPck(v2));
  const b1 = await buildPayload(z, p1);
  const b2 = await buildPayload(z, p2);
  const pd = buildPayloadDelta(
    z,
    { bytes: v1, sha256: b1.payload.sha256 },
    b2 as typeof b2 & { layout: "container" },
    v2,
  );
  const fd = buildFilesDelta(
    z,
    { sha256: b1.payload.sha256, files: b1.files },
    b2,
  );
  if ("skipped" in pd) throw new Error(`payload delta: ${pd.skipped}`);
  if ("skipped" in fd) throw new Error(`files delta: ${fd.skipped}`);
  const objects = new Map<string, Uint8Array>();
  const keep = (b: Uint8Array) => objects.set(sha(b), b);
  for (const b of [b1, b2]) {
    keep(b.full.stored);
    keep(b.indexStored.stored);
    if (b.gaps) keep(b.gaps.stored);
    for (const s of b.blobs.values()) keep(s.stored);
  }
  keep(pd.stored);
  keep(fd.patchStored);
  keep(fd.dataStored);
  const variant = (b: typeof b1, deltas: unknown[]) => ({
    variant: {},
    payload: b.payload,
    full: b.full.ref,
    files: filesRefOf(b),
    requires: { engine: ENGINE },
    ...(deltas.length ? { deltas } : {}),
  });
  const manifest = {
    format: "pkey-godot-fixtures/1",
    prefixes: [PREFIX],
    engine: ENGINE,
    v1: { pck: "kaykit-v1.pck", variant: variant(b1, []) },
    v2: {
      pck: "kaykit-v2.pck",
      variant: variant(b2, [pd.delta, fd.delta]),
    },
    objects: [...objects.keys()].sort(),
  };
  return { files, objects, manifest };
}

describe("the Godot SDK's pack fixtures (P4-08)", () => {
  it("are what the CLI's generator and lint produce today", async () => {
    const g = await generate();
    if (WRITE) {
      rmSync(OUT, { recursive: true, force: true });
      for (const [rel, b] of g.files) {
        mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
        writeFileSync(path.join(OUT, rel), b);
      }
      mkdirSync(path.join(OUT, "update", "objects"), { recursive: true });
      for (const [h, b] of g.objects)
        writeFileSync(path.join(OUT, "update", "objects", h), b);
      writeFileSync(
        path.join(OUT, "update", "manifest.json"),
        JSON.stringify(g.manifest, null, 2) + "\n",
      );
      return;
    }
    // The deterministic files: byte for byte.
    for (const [rel, b] of g.files) {
      const file = path.join(OUT, rel);
      expect(existsSync(file), `${rel} is committed`).toBe(true);
      expect(
        sha(new Uint8Array(readFileSync(file))),
        `${rel} (PKEY_WRITE_GODOT_FIXTURES=1 rewrites it)`,
      ).toBe(sha(b));
    }
    expect(readdirSync(path.join(OUT, "check")).sort()).toEqual(
      [...g.files.keys()]
        .filter((k) => k.startsWith("check/"))
        .map((k) => k.slice("check/".length))
        .sort(),
    );
    // The zstd objects: each hashes to its name and decodes to what the generator means.
    const committed = JSON.parse(
      readFileSync(path.join(OUT, "update", "manifest.json"), "utf8"),
    ) as {
      v1: { variant: Variant };
      v2: { variant: Variant };
      objects: string[];
    };
    const obj = (h: string): Uint8Array => {
      const b = new Uint8Array(
        readFileSync(path.join(OUT, "update", "objects", h)),
      );
      expect(sha(b), h).toBe(h);
      return b;
    };
    expect(readdirSync(path.join(OUT, "update", "objects")).sort()).toEqual(
      committed.objects,
    );
    const open = (ref: { sha256: string; codec: string }) =>
      ref.codec === "zstd" ? unzstd(obj(ref.sha256)) : obj(ref.sha256);
    const v1 = g.files.get("update/kaykit-v1.pck")!;
    const v2 = g.files.get("update/kaykit-v2.pck")!;
    for (const [key, bytes] of [
      ["v1", v1],
      ["v2", v2],
    ] as const) {
      const v = committed[key].variant;
      expect(v.payload).toEqual({ size: bytes.byteLength, sha256: sha(bytes) });
      expect(sha(open(v.full))).toBe(sha(bytes));
      const index = JSON.parse(new TextDecoder().decode(open(v.files))) as {
        files: {
          path: string;
          offset: number;
          size: number;
          sha256: string;
          blob: { sha256: string; codec: string };
        }[];
      };
      const dir = readPck(bytes);
      expect(index.files.map((f) => [f.path, f.offset, f.size])).toEqual(
        [...dir.entries]
          .sort((a, b) => a.offset - b.offset)
          .map((e) => [e.path, e.offset, e.size]),
      );
      for (const f of index.files)
        expect(sha(open(f.blob)), f.path).toBe(f.sha256);
      // Gaps plus files rebuild the payload.
      const gaps = open(v.files.gaps!);
      const parts: Uint8Array[] = [];
      let gp = 0;
      let pos = 0;
      for (const f of index.files) {
        parts.push(gaps.subarray(gp, gp + (f.offset - pos)));
        gp += f.offset - pos;
        parts.push(bytes.subarray(f.offset, f.offset + f.size));
        pos = f.offset + f.size;
      }
      parts.push(gaps.subarray(gp));
      expect(sha(Buffer.concat(parts))).toBe(sha(bytes));
    }
    const deltas = committed.v2.variant.deltas!;
    const payloadDelta = deltas.find((d) => d.scope === "payload")!;
    expect(sha(unzstd(obj(payloadDelta.artifact!.sha256), v1))).toBe(sha(v2));
    const filesDelta = deltas.find((d) => d.scope === "files")!;
    const patch = JSON.parse(
      new TextDecoder().decode(open(filesDelta.patch!)),
    ) as {
      entries: {
        path: string;
        op: string;
        to: string;
        offset: number;
        length: number;
        codec?: string;
      }[];
    };
    const data = obj(filesDelta.data!.sha256);
    const v1dir = readPck(v1);
    for (const e of patch.entries) {
      const slice = data.subarray(e.offset, e.offset + e.length);
      let out: Uint8Array;
      if (e.op === "delta") {
        const base = v1dir.entries.find((x) => x.path === e.path)!;
        out = unzstd(slice, v1.subarray(base.offset, base.offset + base.size));
      } else out = e.codec === "zstd" ? unzstd(slice) : slice;
      expect(sha(out), e.path).toBe(e.to);
    }
  }, 60_000);
});

interface Ref {
  sha256: string;
  bytes: number;
  size: number;
  codec: string;
}

interface Variant {
  payload: { size: number; sha256: string };
  full: Ref;
  files: Ref & { gaps?: Ref };
  deltas?: {
    scope: string;
    artifact?: { sha256: string };
    patch?: Ref;
    data?: { sha256: string };
  }[];
}
