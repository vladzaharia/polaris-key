// Unit proofs for the pack functions P4-21 lands (plans/P4-01.md §2.3–§2.8). The corpus pins
// the record claims across SDKs (`cases.json#packRecordCases`), and P4-04's content corpus
// then pins the files index, the path rules and the stamp; these pin the edges in isolation.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkPaths,
  contentClaims,
  isPackId,
  objectRef,
  parseContentStamp,
  parseFilesIndex,
  releaseRecordClaims,
  treeDigest,
  variantKey,
} from "../src/index.js";
import * as packs from "../src/packs/index.js";

const sha = (s: string | Uint8Array): string =>
  createHash("sha256").update(s).digest("hex");
const H = (n: number): string => sha(`h${n}`);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("the /packs subpath", () => {
  it("exports the same functions as the barrel", () => {
    expect(packs.parseFilesIndex).toBe(parseFilesIndex);
    expect(packs.isPackId).toBe(isPackId);
  });
});

describe("isPackId and variantKey (§2.3)", () => {
  it("is DELIVERABLE_ID_PATTERN, at most 64 bytes, never app", () => {
    expect(isPackId("diceroll.core3d")).toBe(true);
    expect(isPackId("a")).toBe(true);
    expect(isPackId("app")).toBe(false);
    expect(isPackId("Core")).toBe(false);
    expect(isPackId("a".repeat(64))).toBe(true);
    expect(isPackId("a".repeat(65))).toBe(false);
    expect(isPackId("a\n")).toBe(false);
    expect(isPackId(7)).toBe(false);
  });
  it("sorts axes by bytes and joins axis=value with ;", () => {
    expect(variantKey({})).toBe("");
    expect(variantKey({ texture: "astc", locale: "fr" })).toBe(
      "locale=fr;texture=astc",
    );
  });
});

describe("objectRef (§2.3)", () => {
  const ref = { sha256: H(1), bytes: 10, size: 20, codec: "zstd" };
  it("accepts any vocabulary codec and checks none's bytes === size", () => {
    expect(objectRef(ref, "/full", 0, 0)).toBe(true);
    expect(objectRef({ ...ref, codec: "lz4" }, "/full", 0, 0)).toBe(true);
    expect(objectRef({ ...ref, codec: "none" }, "/full", 0, 0)).toBe(false);
    expect(objectRef({ ...ref, codec: "none", bytes: 20 }, "/f", 0, 0)).toBe(
      true,
    );
  });
  it("applies the minimums and the pointer set", () => {
    expect(objectRef({ ...ref, bytes: 0 }, "/files", 1, 1)).toBe(false);
    expect(objectRef(ref, "/full", 0, 0, new Set(["/full/size"]))).toBe(false);
    expect(objectRef({ ...ref, sha256: H(1).toUpperCase() }, "/f", 0, 0)).toBe(
      false,
    );
    expect(objectRef({ ...ref, codec: "" }, "/f", 0, 0)).toBe(false);
  });
});

const PIN = {
  pack: "diceroll.core3d",
  release: { sha256: H(2), seq: 12, version: "1.4.0" },
};
const EXPECT = {
  pack: "diceroll.core3d",
  required: true,
  delivery: "essential",
};

describe("contentClaims and parseContentStamp (§2.4, §2.8)", () => {
  const content = { contentApi: 4, pins: [PIN], expects: [EXPECT] };
  it("accepts the shape and ignores reserved members", () => {
    expect(contentClaims(content)).toBe(true);
    expect(
      contentClaims({
        ...content,
        holds: 1,
        packChannels: {},
        expects: [{ ...EXPECT, pack: "other", delivery: "background" }],
      }),
    ).toBe(true);
  });
  it("refuses a duplicate pin, a zero contentApi and a non-boolean required", () => {
    expect(contentClaims({ ...content, pins: [PIN, PIN] })).toBe(false);
    expect(contentClaims({ ...content, contentApi: 0 })).toBe(false);
    expect(
      contentClaims({ ...content, expects: [{ ...EXPECT, required: 1 }] }),
    ).toBe(false);
    expect(contentClaims({ ...content, pins: [{ ...PIN, pack: "app" }] })).toBe(
      false,
    );
  });
  it("parses a stamp with strict JSON and stamp-level pointers", () => {
    const text = JSON.stringify({ format: "pkey-content/1", ...content });
    expect(parseContentStamp(text)).toEqual({ ok: true, content });
    expect(parseContentStamp(enc(text))).toEqual({ ok: true, content });
    const bad = { ok: false, error: "content-stamp-invalid" };
    expect(
      parseContentStamp(text.replace("pkey-content/1", "pkey-content/2")),
    ).toEqual(bad);
    expect(
      parseContentStamp(text.replace('"contentApi":4', '"contentApi":4.0')),
    ).toEqual(bad);
    expect(
      parseContentStamp(
        text.replace('"contentApi":4', '"contentApi":4,"contentApi":5'),
      ),
    ).toEqual(bad);
    expect(parseContentStamp(`\ufeff${text}`)).toEqual(bad);
    const bom = enc(`\ufeff${text}`);
    expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(parseContentStamp(bom)).toEqual(bad);
    expect(parseContentStamp(new Uint8Array([0xff]))).toEqual(bad);
  });
});

describe("checkPaths (§2.7, A7 §3.3)", () => {
  const cases: [string[], string | null, string?][] = [
    [
      [
        "assets/a.json",
        "assets/b.json",
        ".godot/imported/x.ctex",
        "a b/c@2x+1.png",
      ],
      null,
    ],
    [["assets/../../evil"], "files-unsafe-path"],
    [["assets/./a"], "files-unsafe-path"],
    [["/etc/passwd"], "files-unsafe-path"],
    [["assets\\a.json"], "files-unsafe-path"],
    [["C:/x"], "files-unsafe-path"],
    [["assets//a"], "files-unsafe-path"],
    [["assets/"], "files-unsafe-path"],
    [["a\u001fb"], "files-unsafe-path"],
    [["assets/caf\u00e9.json"], "files-unsafe-path"],
    [["assets/a:b"], "files-unsafe-path"],
    [["a/b", "a/b"], "files-duplicate-path"],
    [["Assets/A.json", "assets/a.json"], "files-case-collision"],
    [["a/b", "A/B/c"], "files-path-conflict"],
    [["a/b/c", "a/b"], "files-path-conflict"],
    [["assets/a./b"], "files-unsafe-path"],
    [["assets/aux.json"], "files-unsafe-path"],
    [["a".repeat(1025)], "files-unsafe-path"],
    [["a".repeat(1024)], null],
    [[".pkey/pack.json"], "files-unsafe-path"],
    [[".PKey/x"], "files-unsafe-path"],
    [["x/.pkey/y"], null],
  ];
  for (const [paths, error] of cases)
    it(`${JSON.stringify(paths).slice(0, 60)} → ${error ?? "ok"}`, () => {
      const r = checkPaths(paths);
      if (error === null) expect(r).toEqual({ ok: true });
      else
        expect(r).toEqual({ ok: false, error, path: paths[paths.length - 1] });
    });
});

describe("treeDigest (§2.7)", () => {
  it("hashes the empty string for an empty tree", async () => {
    expect(await treeDigest([])).toBe(sha(""));
  });
  it("sorts by path bytes and writes `<sha256> <size> <path>\\n`", async () => {
    const files = [
      { path: "b", size: 2, sha256: H(4) },
      { path: "a.b-c", size: 0, sha256: H(5) },
      { path: "a.b.c", size: 10, sha256: H(6) },
    ];
    expect(await treeDigest(files)).toBe(
      sha(`${H(5)} 0 a.b-c\n${H(6)} 10 a.b.c\n${H(4)} 2 b\n`),
    );
  });
});

describe("parseFilesIndex (§2.7)", () => {
  const entry = (
    path: string,
    size: number,
    offset?: number,
  ): Record<string, unknown> => {
    const h = sha(`file:${path}`);
    return {
      path,
      ...(offset === undefined ? {} : { offset }),
      size,
      sha256: h,
      blob: { sha256: h, bytes: size, codec: "none" },
    };
  };
  const container = (files: Record<string, unknown>[], size = 100) => ({
    format: "pkey-files/1",
    layout: "container",
    payload: { size, sha256: H(9) },
    files,
  });
  const refOf = (text: string, over: Record<string, unknown> = {}) => {
    const b = enc(text);
    return {
      stored: b,
      ref: {
        format: "pkey-files/1",
        layout: "container",
        sha256: sha(b),
        bytes: b.length,
        size: b.length,
        codec: "none",
        gaps: { size: 70 },
        ...over,
      },
    };
  };
  const variant = { payload: { size: 100, sha256: H(9) } };
  const parse = async (
    doc: unknown,
    over: Record<string, unknown> = {},
    text?: string,
  ) => {
    const { stored, ref } = refOf(text ?? JSON.stringify(doc), over);
    return parseFilesIndex(stored, ref, variant);
  };
  const files = [entry("a", 10, 0), entry("b", 0, 20), entry("c", 20, 20)];

  it("accepts a container whose zero-size entry shares its offset with the next", async () => {
    const r = await parse(container(files));
    expect(r.ok).toBe(true);
  });
  it("decodes a zstd index through the caller's decoder", async () => {
    const text = JSON.stringify(container(files));
    const frame = new Uint8Array([1, 2, 3]);
    const r = await parseFilesIndex(
      frame,
      {
        layout: "container",
        sha256: sha(frame),
        bytes: 3,
        size: enc(text).length,
        codec: "zstd",
        gaps: { size: 70 },
      },
      variant,
      { decode: () => enc(text) },
    );
    expect(r.ok).toBe(true);
    const thrown = await parseFilesIndex(
      frame,
      {
        layout: "container",
        sha256: sha(frame),
        bytes: 3,
        size: 4,
        codec: "zstd",
      },
      variant,
      {
        decode: () => {
          throw new Error("corrupt");
        },
      },
    );
    expect(thrown).toEqual({ ok: false, error: "files-index-invalid" });
  });
  it("refuses an index over the limit before it is hashed or decoded", async () => {
    let decoded = false;
    const r = await parseFilesIndex(
      new Uint8Array(1),
      {
        layout: "tree",
        sha256: H(1),
        bytes: 1,
        size: 33554433,
        codec: "zstd",
      },
      variant,
      {
        decode: () => {
          decoded = true;
          return new Uint8Array();
        },
      },
    );
    expect(r).toEqual({ ok: false, error: "files-index-invalid" });
    expect(decoded).toBe(false);
  });
  const invalid = { ok: false, error: "files-index-invalid" };
  it("refuses a stored-hash or length mismatch, a duplicate member and a near-integer", async () => {
    expect(await parse(container(files), { sha256: H(1) })).toEqual(invalid);
    expect(await parse(container(files), { bytes: 1 })).toEqual(invalid);
    const text = JSON.stringify(container(files));
    expect(
      await parse(
        null,
        {},
        text.replace(
          '"format":"pkey-files/1"',
          '"format":"pkey-files/1","format":"x"',
        ),
      ),
    ).toEqual(invalid);
    expect(
      await parse(
        null,
        {},
        text.replace('"offset":20,', '"offset":20.000000000000001,'),
      ),
    ).toEqual(invalid);
  });
  it("refuses a byte-order mark, stored or decoded (§1.2 rule 2)", async () => {
    const text = JSON.stringify(container(files));
    expect(await parse(null, {}, text)).toMatchObject({ ok: true });
    const bom = enc(`\ufeff${text}`);
    expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await parse(null, {}, `\ufeff${text}`)).toEqual(invalid);
    const frame = new Uint8Array([1, 2, 3]);
    expect(
      await parseFilesIndex(
        frame,
        {
          layout: "container",
          sha256: sha(frame),
          bytes: 3,
          size: bom.length,
          codec: "zstd",
          gaps: { size: 70 },
        },
        variant,
        { decode: () => bom },
      ),
    ).toEqual(invalid);
  });
  it("refuses an unknown format, a payload mismatch and blob rules", async () => {
    expect(
      await parse({ ...container(files), format: "pkey-files/2" }),
    ).toEqual(invalid);
    expect(await parse(container(files, 99))).toEqual(invalid);
    const badNone = entry("z", 5, 40);
    (badNone.blob as Record<string, unknown>).bytes = 4;
    expect(await parse(container([...files, badNone]))).toEqual(invalid);
    const lz4 = entry("z", 5, 40);
    (lz4.blob as Record<string, unknown>).codec = "lz4";
    expect(await parse(container([...files, lz4]))).toEqual(invalid);
  });
  it("reports path failures with the path, before the layout", async () => {
    expect(
      await parse(container([entry("a", 1, 0), entry("A", 1, 0)])),
    ).toEqual({ ok: false, error: "files-case-collision", path: "A" });
  });
  it("refuses overlapping entries and a gaps size that does not match", async () => {
    expect(
      await parse(container([entry("a", 10, 0), entry("b", 10, 5)]), {
        gaps: { size: 80 },
      }),
    ).toEqual({ ok: false, error: "files-layout-mismatch" });
    expect(await parse(container(files), { gaps: { size: 71 } })).toEqual({
      ok: false,
      error: "files-layout-mismatch",
    });
    expect(
      await parse(container([entry("a", 10, 95)]), { gaps: { size: 90 } }),
    ).toEqual({ ok: false, error: "files-layout-mismatch" });
  });
  it("checks a tree's order, total and treeDigest", async () => {
    const tf = [entry("a", 10), entry("b", 20)];
    const digest = await treeDigest(tf as never);
    const tree = (fs: Record<string, unknown>[], d = digest, size = 30) => ({
      format: "pkey-files/1",
      layout: "tree",
      payload: { size, sha256: d },
      files: fs,
    });
    const run = (doc: Record<string, unknown>) => {
      const b = enc(JSON.stringify(doc));
      const p = doc.payload as { size: number; sha256: string };
      return parseFilesIndex(
        b,
        {
          layout: "tree",
          sha256: sha(b),
          bytes: b.length,
          size: b.length,
          codec: "none",
        },
        { payload: p },
      );
    };
    expect((await run(tree(tf))).ok).toBe(true);
    expect(await run(tree([tf[1]!, tf[0]!]))).toEqual(invalid);
    expect(await run(tree(tf, H(3)))).toEqual(invalid);
    expect(await run(tree(tf, digest, 31))).toEqual(invalid);
  });
});

describe("releaseRecordClaims over pack and app records (§2.3, §2.4)", () => {
  const ref = (n: number, size = 100) => ({
    sha256: H(n),
    bytes: 50,
    size,
    codec: "zstd",
  });
  const pack = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    aud: "djdl",
    deliverable: "djdl.levels",
    kind: "pack",
    version: "1.1.0",
    seq: 2,
    issuedAt: 1700000000,
    type: "godot.pck",
    formatVersion: 4,
    variants: [
      {
        variant: { texture: "s3tc" },
        payload: { size: 100, sha256: H(10) },
        full: ref(11),
        files: {
          format: "pkey-files/1",
          layout: "container",
          ...ref(12),
          gaps: ref(13, 30),
        },
        deltas: [
          {
            method: "zstd-patch-from",
            scope: "payload",
            from: H(14),
            memBytes: 200,
            artifact: { sha256: H(15), bytes: 10 },
          },
          {
            method: "zstd-patch-from",
            scope: "files",
            from: H(14),
            memBytes: 20,
            patch: ref(16),
            data: { sha256: H(17), bytes: 10 },
          },
        ],
        requires: { engine: "godot-4.7" },
      },
    ],
    ...over,
  });
  const ok = (doc: unknown) =>
    releaseRecordClaims(doc, { expectedAud: "djdl" });
  it("accepts a pack record and refuses builds, a pack id of app and a container without gaps", () => {
    expect(ok(pack())).toBe(true);
    expect(ok(pack({ builds: [] }))).toBe(false);
    expect(ok(pack({ deliverable: "app" }))).toBe(false);
    const p = pack();
    delete (p.variants[0]!.files as Record<string, unknown>).gaps;
    expect(ok(p)).toBe(false);
  });
  it("refuses duplicate variant keys and differing axis sets", () => {
    const v = pack().variants[0]!;
    expect(ok(pack({ variants: [v, v] }))).toBe(false);
    expect(
      ok(pack({ variants: [v, { ...v, variant: { locale: "fr" } }] })),
    ).toBe(false);
    expect(
      ok(pack({ variants: [v, { ...v, variant: { texture: "etc2" } }] })),
    ).toBe(true);
  });
  it("app records check content and embeds; other kinds ignore them", () => {
    const app = {
      schemaVersion: 1,
      aud: "djdl",
      deliverable: "app",
      kind: "app",
      version: "1.5.0",
      seq: 15,
      issuedAt: 1700000000,
      content: { contentApi: 4, pins: [PIN], expects: [EXPECT] },
      builds: [
        {
          id: "web",
          platform: "web",
          arch: "wasm32",
          format: "zip",
          embeds: ["diceroll.core3d"],
          artifacts: [],
        },
      ],
    };
    expect(ok(app)).toBe(true);
    expect(ok({ ...app, content: null })).toBe(false);
    expect(
      ok({ ...app, builds: [{ ...app.builds[0], embeds: ["a", "a"] }] }),
    ).toBe(false);
    expect(
      ok({
        ...app,
        kind: "future",
        content: 5,
        builds: [{ ...app.builds[0], embeds: 7 }],
      }),
    ).toBe(true);
  });
});
