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
