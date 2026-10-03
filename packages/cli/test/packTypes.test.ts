/**
 * P4-16 — the publish lints of the v3 pack types and their publish end to end: `data.json`
 * (strict JSON, the declared formatVersion signed), `l10n.table` (the device's plain parsers and
 * locale rule), `ml.model` (model.json), `audio.bank` (bank.json), `custom.<name>` (path rules
 * only) and `godot.zip` (a strict stored-entry zip, then the godot.pck admission list).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishPack, type PackPublishOptions } from "../src/index.js";
import { lintTypeTree, readGodotZip } from "../src/packTypes.js";
import { lintPck } from "../src/packLint.js";
import { zipStore } from "../src/zip.js";
import type { PayloadFile } from "../src/packArtifacts.js";
import { capture, cleanup, instant } from "./publishFixture.js";
import {
  actionsEnv,
  BASE,
  kaykitV2,
  kaykitUnstripped,
  l10nTrees,
  packRepo,
  packServer,
  PREFIX,
  sha,
  SLUG,
  testReleaseKey,
  writeTestPck,
} from "./packFixtures.js";

afterEach(cleanup);

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string | Uint8Array>): PayloadFile[] =>
  Object.keys(o)
    .sort()
    .map((p) => {
      const data =
        typeof o[p] === "string" ? enc(o[p] as string) : (o[p] as Uint8Array);
      return { path: p, size: data.byteLength, sha256: sha(data), data };
    });

describe("lintTypeTree", () => {
  it("data.json: strict JSON objects pass, anything else fails with its path", async () => {
    expect(
      (await lintTypeTree("data.json", files({ "a.json": '{"x":1}' }), {}))
        .errors,
    ).toEqual([]);
    for (const bad of ['{"x":1,}', "[1]", '{"x":1} trailing', "﻿{}"]) {
      const r = await lintTypeTree(
        "data.json",
        files({ "a.json": "{}", "b.json": bad }),
        {},
      );
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^b\.json: data\.json not strict JSON/);
    }
  });

  it("l10n.table: PO, CSV and JSON tables pass; another locale or a malformed table fails", async () => {
    const po = (lang: string) =>
      `msgid ""\nmsgstr "Language: ${lang}\\n"\n\nmsgid "a"\nmsgstr "b"\n`;
    expect(
      (
        await lintTypeTree(
          "l10n.table",
          files({
            "a.po": po("fr"),
            "b.csv": "keys,fr\nk,v\n",
            "c.json": '{"locale":"fr","messages":{"k":"v"}}',
          }),
          { locale: "fr" },
        )
      ).errors,
    ).toEqual([]);
    const wrong = await lintTypeTree(
      "l10n.table",
      files({ "a.po": po("de") }),
      {
        locale: "fr",
      },
    );
    expect(wrong.errors[0]).toMatch(/^a\.po: l10n\.table a table whose locale/);
    const bad = await lintTypeTree(
      "l10n.table",
      files({ "t.csv": "keys,fr\na,b,c\n" }),
      {},
    );
    expect(bad.errors[0]).toMatch(/^t\.csv: l10n\.table not a table/);
  });

  it("ml.model: a valid model.json passes; a missing or malformed one fails", async () => {
    const ok = files({
      "model.json": '{"runtime":"onnx","file":"m.onnx","memBytes":1024}',
      "m.onnx": "ONNX",
    });
    expect((await lintTypeTree("ml.model", ok, {})).errors).toEqual([]);
    for (const f of <Record<string, string>[]>[
      { "m.onnx": "ONNX" },
      {
        "model.json": '{"runtime":"onnx","file":"x.onnx","memBytes":1}',
        "m.onnx": "x",
      },
      { "model.json": '{"runtime":"onnx","file":"m.onnx"}', "m.onnx": "x" },
    ])
      expect((await lintTypeTree("ml.model", files(f), {})).errors[0]).toMatch(
        /^model\.json: an ml\.model pack carries a model\.json/,
      );
  });

  it("audio.bank: a valid bank.json passes; a missing, malformed or dangling one fails", async () => {
    const ok = files({
      "bank.json":
        '{"middleware":"fmod","version":"2.02.22","banks":["Master.bank"]}',
      "Master.bank": "RIFF",
    });
    expect((await lintTypeTree("audio.bank", ok, {})).errors).toEqual([]);
    for (const [f, why] of [
      [{ "Master.bank": "RIFF" }, /bank\.json at its root/],
      [{ "bank.json": '{"middleware":"FMOD","version":"2.02"}' }, /middleware/],
      [{ "bank.json": '{"middleware":"fmod","version":"2"}' }, /version/],
      [
        {
          "bank.json":
            '{"middleware":"fmod","version":"2.02","banks":["X.bank"]}',
        },
        /banks names/,
      ],
    ] as [Record<string, string>, RegExp][])
      expect(
        (await lintTypeTree("audio.bank", files(f), {})).errors[0],
      ).toMatch(why);
  });

  it("custom.<name> and files.tree: no content lint", async () => {
    for (const t of ["custom.dialogue", "files.tree"])
      expect(
        (await lintTypeTree(t, files({ "x.bin": "\u0000\u0001" }), {})).errors,
      ).toEqual([]);
  });
});

describe("readGodotZip", () => {
  const stored = () =>
    new Uint8Array(
      zipStore(kaykitV2().map(([name, data]) => ({ name, data }))),
    );

  it("reads a stored zip's entries at their data offsets, and lintPck admits it", () => {
    const b = stored();
    const dir = readGodotZip(b);
    expect(dir.entries.map((e) => e.path)).toEqual(kaykitV2().map(([p]) => p));
    for (const e of dir.entries) {
      const want = kaykitV2().find(([p]) => p === e.path)![1];
      expect(b.subarray(e.offset, e.offset + e.size)).toEqual(want);
    }
    expect(lintPck(dir, b, { prefixes: [PREFIX] }).errors).toEqual([]);
  });

  it("lintPck refuses a script and an out-of-prefix entry in a zip", () => {
    const b = new Uint8Array(
      zipStore([
        ...kaykitV2().map(([name, data]) => ({ name, data })),
        { name: "assets/kaykit/roll.gd", data: enc("extends Node\n") },
        { name: "other/x.json", data: enc("{}") },
      ]),
    );
    const errors = lintPck(readGodotZip(b), b, { prefixes: [PREFIX] }).errors;
    expect(errors.some((e) => e.startsWith("assets/kaykit/roll.gd:"))).toBe(
      true,
    );
    expect(errors.some((e) => e.startsWith("other/x.json:"))).toBe(true);
  });

  it("refuses a polyglot, a comment, a compressed entry, a bad path, a data descriptor and a bad CRC", () => {
    const one = (name: string, data = enc("{}")) =>
      new Uint8Array(zipStore([{ name, data }]));
    const cases: [Uint8Array, RegExp][] = [];
    // Bytes before the first entry (a PCK with a zip after it, say).
    const pre = new Uint8Array([...enc("XXXX"), ...one("a.json")]);
    cases.push([pre, /does not start with a local file header/]);
    // A comment (it could end in GDPC).
    const c = one("a.json");
    const withComment = new Uint8Array([...c, ...enc("abcd")]);
    new DataView(withComment.buffer).setUint16(c.byteLength - 2, 4, true);
    cases.push([withComment, /does not end with an end-of-central-directory/]);
    // Method 8 in both headers.
    const m = one("a.json");
    const dv = new DataView(m.buffer);
    dv.setUint16(8, 8, true);
    const cd = dv.getUint32(m.byteLength - 6, true);
    dv.setUint16(cd + 10, 8, true);
    cases.push([m, /a compressed entry/]);
    cases.push([one("a/../b.json"), /not a normal path/]);
    cases.push([one("/abs.json"), /not a normal path/]);
    const d = one("a.json");
    const dd = new DataView(d.buffer);
    dd.setUint16(6, 0x0808, true);
    dd.setUint16(dd.getUint32(d.byteLength - 6, true) + 8, 0x0808, true);
    cases.push([d, /data descriptor/]);
    const crc = one("a.json");
    crc[crc.indexOf(0x7b, 30)] = 0x5b; // "{" → "[" in the data
    cases.push([crc, /CRC-32/]);
    const dup = new Uint8Array(
      zipStore([
        { name: "a.json", data: enc("{}") },
        { name: "a.json", data: enc("{}") },
      ]),
    );
    cases.push([dup, /listed twice/]);
    // GDPC anywhere (a PCK inside an entry's data, at a self-contained export's embedded offset).
    cases.push([
      one("a.bin", enc("xxGDPCyy")),
      /holds the bytes GDPC at offset/,
    ]);
    // An entry comment (it could hide a ZIP64 locator).
    const withEntryComment = (() => {
      const z = one("a.json");
      const v = new DataView(z.buffer);
      const cdAt = v.getUint32(z.byteLength - 6, true);
      const cdLen = v.getUint32(z.byteLength - 10, true);
      const out = new Uint8Array(z.byteLength + 2);
      out.set(z.subarray(0, cdAt + cdLen));
      out.set(enc("hi"), cdAt + cdLen);
      out.set(z.subarray(cdAt + cdLen), cdAt + cdLen + 2);
      const o = new DataView(out.buffer);
      o.setUint16(cdAt + 32, 2, true);
      o.setUint32(out.byteLength - 10, cdLen + 2, true);
      return out;
    })();
    cases.push([withEntryComment, /entry comment/]);
    cases.push([
      new Uint8Array(zipStore([{ name: "../x/", data: new Uint8Array() }])),
      /not a normal path/,
    ]);
    for (const [b, why] of cases) expect(() => readGodotZip(b)).toThrow(why);
  });
});

// ── Publishing ──────────────────────────────────────────────────────────────────────────────

const key = testReleaseKey();

function opts(
  cwd: string,
  server: ReturnType<typeof packServer>,
  deliverable: string,
): { io: ReturnType<typeof capture>; o: PackPublishOptions } {
  // Each pack's variants live under their own directory: dist/<pack id without the product>/.
  const io = capture();
  return {
    io,
    o: {
      cwd,
      product: SLUG,
      deliverable,
      version: "1.0.0",
      dir: `dist/${deliverable.replace("diceroll.", "")}`,
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      releaseKeyPem: key.pem,
      now: 1_759_300_000,
    },
  };
}

const EXTRA = `    diceroll.events:
      kind: pack
      type: data.json
      formatVersion: 3
    diceroll.strings:
      kind: pack
      type: l10n.table
      variants:
        locale: [fr]
    diceroll.model:
      kind: pack
      type: ml.model
    diceroll.banks:
      kind: pack
      type: audio.bank
    diceroll.dialogue:
      kind: pack
      type: custom.dialogue
      formatVersion: 2
    diceroll.mods:
      kind: pack
      type: godot.zip
      handler:
        prefixes: ["${PREFIX}"]
      requires:
        engine: godot-4.7
`;

async function repo(dist: Record<string, Uint8Array>) {
  return packRepo(
    key,
    {
      "default/diceroll.core3d.pck": writeTestPck(kaykitUnstripped()),
      ...l10nTrees(),
      ...dist,
    },
    { extraPacks: EXTRA },
  );
}

describe("pkey release publish for the v3 types", () => {
  it("signs a data.json pack with its declared formatVersion and a hot activation", async () => {
    const cwd = await repo({
      "events/default/events/winter.json": enc('{"snow":true}'),
    });
    const server = packServer();
    const res = await publishPack(opts(cwd, server, "diceroll.events").o);
    expect(res.record).toMatchObject({
      type: "data.json",
      formatVersion: 3,
      handler: { activation: "hot" },
    });
    expect(res.record!.variants[0]!.files.layout).toBe("tree");
  });

  it("signs custom.dialogue with its formatVersion and l10n.table per locale variant", async () => {
    const cwd = await repo({
      "dialogue/default/intro.txt": enc("Hello"),
      "strings/locale=fr/fr.po": enc(
        'msgid ""\nmsgstr "Language: fr\\n"\n\nmsgid "a"\nmsgstr "b"\n',
      ),
    });
    const server = packServer();
    const d = await publishPack(opts(cwd, server, "diceroll.dialogue").o);
    expect(d.record).toMatchObject({
      type: "custom.dialogue",
      formatVersion: 2,
    });
    const s = await publishPack(opts(cwd, server, "diceroll.strings").o);
    expect(s.record).toMatchObject({ type: "l10n.table", formatVersion: 1 });
    expect(s.record!.variants[0]!.variant).toEqual({ locale: "fr" });
  });

  it("refuses each type's lint failure with its path, before any request", async () => {
    const cases: [string, Record<string, Uint8Array>, RegExp][] = [
      [
        "diceroll.events",
        { "events/default/a.json": enc("{'x':1}") },
        /default\/a\.json: data\.json not strict JSON/,
      ],
      [
        "diceroll.strings",
        { "strings/locale=fr/de.csv": enc("keys,de\na,b\n") },
        /locale=fr\/de\.csv: l10n\.table a table whose locale/,
      ],
      [
        "diceroll.model",
        { "model/default/m.onnx": enc("x") },
        /default\/model\.json: an ml\.model pack/,
      ],
      [
        "diceroll.banks",
        { "banks/default/Master.bank": enc("RIFF") },
        /default\/bank\.json: an audio\.bank pack/,
      ],
    ];
    for (const [deliverable, dist, why] of cases) {
      const cwd = await repo(dist);
      const server = packServer();
      await expect(
        publishPack(opts(cwd, server, deliverable).o),
      ).rejects.toThrow(why);
      expect(server.calls).toEqual([]);
    }
  });

  it("publishes a godot.zip as a container with its marker beside it, and refuses a deflated one", async () => {
    const zip = new Uint8Array(
      zipStore(kaykitV2().map(([name, data]) => ({ name, data }))),
    );
    const cwd = await repo({ "mods/default/mods.zip": zip });
    const server = packServer();
    const res = await publishPack(opts(cwd, server, "diceroll.mods").o);
    expect(res.record).toMatchObject({
      type: "godot.zip",
      formatVersion: 1,
      handler: { prefixes: [PREFIX], activation: "restart" },
    });
    const v = res.record!.variants[0]!;
    expect(v.files.layout).toBe("container");
    expect(v.payload).toEqual({ size: zip.byteLength, sha256: sha(zip) });
    const marker = JSON.parse(
      await readFile(
        path.join(cwd, "dist/mods/default/mods.zip.pkey.json"),
        "utf8",
      ),
    );
    expect(marker.release).toBe(res.recordJws);

    const bad = new Uint8Array(zip);
    const dv = new DataView(bad.buffer);
    dv.setUint16(8, 8, true);
    const cwd2 = await repo({ "mods/default/mods.zip": bad });
    const server2 = packServer();
    await expect(
      publishPack(opts(cwd2, server2, "diceroll.mods").o),
    ).rejects.toThrow(/mods\.zip: .*local header disagrees/);
    expect(server2.calls).toEqual([]);
  });
});
