/**
 * P4-03 — the PCK directory, the strip step, the admission list and the pack artifacts: the
 * files index and gaps object rebuild a payload byte for byte, every delta decodes with the zstd
 * CLI, the dictionary-magic rule, and the index bound. Needs `zstd` ≥ 1.5.5 on PATH (the brief's
 * Verify block).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseFilesIndex } from "@polaris-key/client-core/packs";
import { MAX_PUBLISHED_INDEX_BYTES } from "@polaris-key/manifest";
import {
  buildFilesDelta,
  buildPayload,
  buildPayloadDelta,
  containerPayload,
  filesRefOf,
  lintPck,
  lintTreePaths,
  noiseReport,
  readPck,
  remapTargets,
  selfCheckPayload,
  stripPck,
  zstdCli,
  type BuiltPayload,
  type Payload,
} from "../src/index.js";
import {
  kaykitForbidden,
  kaykitUnstripped,
  kaykitV1,
  kaykitV2,
  manyEntries,
  PREFIX,
  sha,
  writeTestPck,
} from "./packFixtures.js";

const work = mkdtempSync(path.join(os.tmpdir(), "pkey-pack-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const z = zstdCli(work);

/** Decode with the zstd CLI, independently of the code under test. */
function unzstd(frame: Uint8Array, patchFrom?: Uint8Array): Uint8Array {
  const d = mkdtempSync(path.join(work, "dec-"));
  writeFileSync(path.join(d, "in.zst"), frame);
  const args = [
    "-d",
    "-q",
    "-f",
    "--long=31",
    path.join(d, "in.zst"),
    "-o",
    path.join(d, "out"),
  ];
  if (patchFrom) {
    writeFileSync(path.join(d, "base"), patchFrom);
    args.splice(1, 0, `--patch-from=${path.join(d, "base")}`);
  }
  execFileSync("zstd", args);
  return new Uint8Array(readFileSync(path.join(d, "out")));
}

const lintOpts = { prefixes: [PREFIX], engine: "godot-4.7" };

function container(
  files: [string, Uint8Array][],
  opts = {},
): { bytes: Uint8Array; p: Payload } {
  const bytes = writeTestPck(files, opts);
  return { bytes, p: containerPayload(bytes, readPck(bytes)) };
}

describe("the PCK directory and the strip step", () => {
  it("reads a v4 PCK's entries, offsets and header", () => {
    const bytes = writeTestPck(kaykitV1());
    const dir = readPck(bytes);
    expect(dir.header).toEqual({
      formatVersion: 4,
      engine: { major: 4, minor: 7, patch: 2 },
      flags: 2,
    });
    expect(dir.entries.map((e) => e.path)).toEqual(kaykitV1().map(([p]) => p));
    for (const [i, [, data]] of kaykitV1().entries()) {
      const e = dir.entries[i]!;
      expect(sha(bytes.subarray(e.offset, e.offset + e.size))).toBe(sha(data));
    }
  });

  it("reads the v2 layout (directory after the reserved words, res:// paths) and v3", () => {
    for (const opts of [
      {
        version: 2,
        resPrefix: true,
        engine: [4, 3, 0] as [number, number, number],
      },
      { version: 3 },
    ]) {
      const bytes = writeTestPck(kaykitUnstripped(), opts);
      const dir = readPck(bytes);
      expect(dir.header.formatVersion).toBe(opts.version);
      expect(dir.entries.map((e) => e.path)).toEqual(
        kaykitUnstripped().map(([p]) => p),
      );
      const s = stripPck(bytes);
      expect(s.removed).toEqual([
        "project.binary",
        ".godot/global_script_class_cache.cfg",
      ]);
      expect(s.directory.header).toEqual(dir.header);
      expect(s.directory.entries.map((e) => e.rawPath)).toEqual(
        dir.entries.slice(0, -2).map((e) => e.rawPath),
      );
    }
  });

  it("refuses an encrypted directory, a sparse bundle, an encrypted entry, a patch entry and v1", () => {
    expect(() => readPck(writeTestPck(kaykitV1(), { flags: 3 }))).toThrow(
      /encrypted directory/,
    );
    expect(() => readPck(writeTestPck(kaykitV1(), { flags: 6 }))).toThrow(
      /sparse bundle/,
    );
    expect(() =>
      readPck(
        writeTestPck(kaykitV1(), {
          entryFlags: { "assets/kaykit/data/level_001.json": 1 },
        }),
      ),
    ).toThrow(/assets\/kaykit\/data\/level_001\.json: an encrypted entry/);
    expect(() =>
      readPck(
        writeTestPck(kaykitV1(), {
          entryFlags: { "assets/kaykit/data/level_002.json": 4 },
        }),
      ),
    ).toThrow(/level_002\.json: a patch pack's delta entry/);
    expect(() => readPck(writeTestPck(kaykitV1(), { version: 1 }))).toThrow(
      /format v1/,
    );
    expect(() =>
      readPck(new TextEncoder().encode("PK\u0003\u0004 not a pck at all")),
    ).toThrow(/not a Godot PCK/);
  });

  it("strips exactly project.binary and the class cache, keeps the header, and then passes the lint", () => {
    const src = writeTestPck(kaykitUnstripped(), { flags: 0 });
    const before = lintPck(readPck(src), src, lintOpts);
    expect(before.errors.sort()).toEqual([
      ".godot/global_script_class_cache.cfg: --export-pack's .godot/global_script_class_cache.cfg replaces the main pack's copy.",
      "project.binary: --export-pack's project.binary replaces the main pack's copy.",
    ]);
    const s = stripPck(src);
    expect(s.removed).toEqual([
      "project.binary",
      ".godot/global_script_class_cache.cfg",
    ]);
    expect(s.directory.header.flags).toBe(0);
    expect(s.directory.entries.map((e) => e.path)).toEqual(
      kaykitV1().map(([p]) => p),
    );
    expect(lintPck(s.directory, s.bytes, lintOpts)).toEqual({
      errors: [],
      warnings: [],
    });
    // Idempotent: a stripped PCK is returned as is.
    expect(stripPck(s.bytes).bytes).toBe(s.bytes);
  });
});

describe("the admission list (notes/S-05 §5 (f))", () => {
  it("rejects the script, the native library, the out-of-prefix path and an orphaned import, each with its path", () => {
    const bytes = writeTestPck(kaykitForbidden());
    const r = lintPck(readPck(bytes), bytes, lintOpts);
    expect(r.errors).toEqual([
      "assets/kaykit/roll.gd: a script; a pack carries data only (S-07 row 13).",
      "assets/kaykit/bin/libdice.so: a native library or GDExtension; a pack carries data only.",
      "other/thing.png: outside the handler prefixes (res://assets/kaykit/).",
      ".godot/imported/orphan.png-ffff.s3tc.ctex: no in-prefix .remap or .import names it, so nothing in the pack could load it.",
    ]);
  });

  it("passes a clean pack: an imported artefact of an in-prefix source, an exported file a .remap names, uid_cache.bin", () => {
    const bytes = writeTestPck(kaykitV1());
    expect(lintPck(readPck(bytes), bytes, lintOpts)).toEqual({
      errors: [],
      warnings: [],
    });
    const paths = readPck(bytes).entries.map((e) => e.path);
    expect(paths).toContain(
      ".godot/imported/dice.png-0123456789abcdef.s3tc.ctex",
    );
    expect(paths).toContain(
      ".godot/exported/133200997/export-0123abcd-board.scn",
    );
    expect(paths).toContain(".godot/uid_cache.bin");
  });

  it("refuses a .remap that points to a script, a GDExtension, and an engine outside requires.engine", () => {
    const files: [string, Uint8Array][] = [
      ...kaykitV1(),
      [
        "assets/kaykit/pack_class.gd.remap",
        new TextEncoder().encode(
          '[remap]\n\npath="res://assets/kaykit/pack_class.gdc"\n',
        ),
      ],
      [
        "assets/kaykit/x.gdextension",
        new TextEncoder().encode("[configuration]\n"),
      ],
    ];
    const bytes = writeTestPck(files, { engine: [4, 6, 1] });
    expect(lintPck(readPck(bytes), bytes, lintOpts).errors).toEqual([
      "the PCK header says engine 4.6.1, outside requires.engine godot-4.7.",
      "assets/kaykit/pack_class.gd.remap: remaps a script (assets/kaykit/pack_class.gdc); a pack carries data only.",
      "assets/kaykit/x.gdextension: a native library or GDExtension; a pack carries data only.",
    ]);
    expect(
      remapTargets(
        '[remap]\npath.s3tc="res://a/b.ctex"\npath.etc2="res://a/c.ctex"\n[deps]\ndest_files=["res://a/b.ctex", "res://a/c.ctex"]\nsource_file="res://x.png"\n',
      ),
    ).toEqual(["a/b.ctex", "a/c.ctex"]);
  });

  it("1,000 entries pass silently, 1,001 pass with a warning, 20,001 fail", () => {
    const at = (n: number) => {
      const bytes = writeTestPck(manyEntries(n));
      return lintPck(readPck(bytes), bytes, lintOpts);
    };
    expect(at(1000)).toEqual({ errors: [], warnings: [] });
    const w = at(1001);
    expect(w.errors).toEqual([]);
    expect(w.warnings).toEqual([
      "1001 entries, above 1000: mounting it stalls longer (S-05 §4.1); consider splitting the pack.",
    ]);
    expect(at(20001).errors[0]).toMatch(
      /^20001 entries; a pack is at most 20000/,
    );
  }, 60_000);

  it("a tree's path rules come from client-core's checkPaths", () => {
    expect(lintTreePaths(["a/b.txt", "a/c.txt"]).errors).toEqual([]);
    expect(lintTreePaths(["a/b.txt", "A/B.txt"]).errors).toEqual([
      "A/B.txt: files-case-collision",
    ]);
    expect(lintTreePaths([".pkey/pack.json"]).errors).toEqual([
      ".pkey/pack.json: files-unsafe-path",
    ]);
  });
});

describe("the files index, the gaps object and the rebuild", () => {
  let b1: BuiltPayload;
  let b2: BuiltPayload;
  const v1 = container(kaykitV1());
  const v2 = container(kaykitV2());

  it("v2's index validates (parseFilesIndex) and gaps plus files rebuild v2 byte for byte", async () => {
    b1 = await buildPayload(z, v1.p);
    b2 = await buildPayload(z, v2.p);
    await selfCheckPayload(z, b2);
    const parsed = await parseFilesIndex(
      b2.indexStored.stored,
      filesRefOf(b2),
      { payload: b2.payload },
      {
        decode: (f) => unzstd(f),
        maxBytes: MAX_PUBLISHED_INDEX_BYTES,
      },
    );
    expect(parsed.ok).toBe(true);
    expect(b2.indexStored.ref.codec).toBe("zstd");
    // Rebuild independently: gap₀, file₀, gap₁, … with the zstd CLI.
    const gaps = unzstd(b2.gaps!.stored);
    const parts: Uint8Array[] = [];
    let g = 0;
    let pos = 0;
    for (const e of b2.index.files) {
      parts.push(gaps.subarray(g, g + (e.offset! - pos)));
      g += e.offset! - pos;
      const blob = [...b2.blobs.values()].find(
        (s) => s.ref.sha256 === e.blob.sha256,
      )!;
      parts.push(e.blob.codec === "zstd" ? unzstd(blob.stored) : blob.stored);
      pos = e.offset! + e.size;
    }
    parts.push(gaps.subarray(g));
    const rebuilt = Buffer.concat(parts);
    expect(sha(rebuilt)).toBe(sha(v2.bytes));
    expect(b2.payload).toEqual({
      size: v2.bytes.byteLength,
      sha256: sha(v2.bytes),
    });
    // full: one zstd frame with its content size.
    expect(sha(unzstd(b2.full.stored))).toBe(sha(v2.bytes));
    expect(b2.full.ref).toMatchObject({
      codec: "zstd",
      size: v2.bytes.byteLength,
    });
    // Incompressible files are stored raw (codec none, bytes = size, blob sha = file sha).
    const ctex = b2.index.files.find((e) => e.path.endsWith(".ctex"))!;
    expect(ctex.blob).toEqual({
      sha256: ctex.sha256,
      bytes: ctex.size,
      codec: "none",
    });
  });

  it("every per-entry delta decodes with zstd -d --patch-from=<old entry>; the whole delta decodes to v2", () => {
    const fd = buildFilesDelta(
      z,
      { sha256: b1.payload.sha256, files: b1.files },
      b2,
    );
    if ("skipped" in fd) throw new Error(fd.skipped);
    const byPath = new Map(b1.files.map((f) => [f.path, f]));
    expect(fd.doc.entries.map((e) => e.path)).toEqual([
      ".godot/imported/dice.png-0123456789abcdef.s3tc.ctex",
      "assets/kaykit/data/level_003.json",
      "assets/kaykit/data/level_010.json",
      ".godot/uid_cache.bin",
    ]);
    const op = (p: string) => fd.doc.entries.find((e) => e.path === p)!.op;
    expect(op(".godot/imported/dice.png-0123456789abcdef.s3tc.ctex")).toBe(
      "delta",
    );
    expect(op("assets/kaykit/data/level_003.json")).toBe("delta");
    expect(op("assets/kaykit/data/level_010.json")).toBe("blob");
    for (const e of fd.doc.entries) {
      const slice = fd.dataStored.subarray(e.offset, e.offset + e.length);
      const out =
        e.op === "delta"
          ? unzstd(slice, byPath.get(e.path)!.data)
          : e.codec === "zstd"
            ? unzstd(slice)
            : slice;
      expect(sha(out)).toBe(e.to);
    }
    expect(fd.doc).toMatchObject({
      format: "pkey-patch/1",
      scope: "files",
      method: "zstd-patch-from",
      from: b1.payload.sha256,
      to: b2.payload.sha256,
      data: { sha256: sha(fd.dataStored), bytes: fd.dataStored.byteLength },
    });
    expect(fd.delta.patch.size).toBeGreaterThan(0);
    const pd = buildPayloadDelta(
      z,
      { bytes: v1.bytes, sha256: b1.payload.sha256 },
      b2 as BuiltPayload & { layout: "container" },
      v2.bytes,
    );
    if ("skipped" in pd) throw new Error(pd.skipped);
    expect(sha(unzstd(pd.stored, v1.bytes))).toBe(sha(v2.bytes));
    expect(pd.delta.memBytes).toBe(v1.bytes.byteLength + v2.bytes.byteLength);
  });

  it("never builds a zstd-patch-from frame against a base starting 37 A4 30 EC", async () => {
    const magic = new Uint8Array([0x37, 0xa4, 0x30, 0xec, ...noise(4000)]);
    const base: Payload = {
      layout: "tree",
      files: [
        {
          path: "a.bin",
          size: magic.byteLength,
          sha256: sha(magic),
          data: magic,
        },
      ],
    };
    const edited = new Uint8Array(magic);
    edited[2000] = edited[2000]! ^ 1;
    const target: Payload = {
      layout: "tree",
      files: [
        {
          path: "a.bin",
          size: edited.byteLength,
          sha256: sha(edited),
          data: edited,
        },
      ],
    };
    const bb = await buildPayload(z, base);
    const bt = await buildPayload(z, target);
    const fd = buildFilesDelta(
      z,
      { sha256: bb.payload.sha256, files: bb.files },
      bt,
    );
    if ("skipped" in fd) throw new Error(fd.skipped);
    expect(fd.doc.entries.map((e) => e.op)).toEqual(["blob"]);
    expect(fd.magicBases).toEqual(["a.bin"]);
    const pd = buildPayloadDelta(
      z,
      { bytes: magic, sha256: sha(magic) },
      { ...bt, layout: "container" } as BuiltPayload & { layout: "container" },
      edited,
    );
    expect(pd).toEqual({
      skipped:
        "the base starts with the zstd dictionary magic 37 A4 30 EC (§2.7 rule 5)",
    });
  });

  it("refuses an index above MAX_PUBLISHED_INDEX_BYTES before compressing it", async () => {
    const data = new TextEncoder().encode("x");
    const long = "d".repeat(180);
    const files = Array.from({ length: 22000 }, (_, i) => ({
      path: `${long}/${String(i).padStart(6, "0")}-${"n".repeat(150)}.txt`,
      size: 1,
      sha256: sha(data),
      data,
    }));
    await expect(buildPayload(z, { layout: "tree", files })).rejects.toThrow(
      new RegExp(
        `Polaris Key reads at most ${MAX_PUBLISHED_INDEX_BYTES} per index`,
      ),
    );
  }, 60_000);

  it("reports re-import noise: a reordered uid cache and a stamp-sized edit, never the CI stamp", () => {
    const report = noiseReport(b1.files, b2.files);
    expect(report).toEqual([
      ".godot/imported/dice.png-0123456789abcdef.s3tc.ctex: 3 bytes changed at equal length — likely a re-import stamp.",
      ".godot/uid_cache.bin: its entries were rewritten in another order — re-import noise.",
    ]);
    const stamp = (s: string) => {
      const d = new TextEncoder().encode(s);
      return [
        { path: "project.binary", size: d.byteLength, sha256: sha(d), data: d },
      ];
    };
    expect(noiseReport(stamp("aaaa"), stamp("aaab"))).toEqual([]);
  });
});

function noise(n: number): number[] {
  const out: number[] = [];
  let x = 7;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out.push(x >>> 24);
  }
  return out;
}
