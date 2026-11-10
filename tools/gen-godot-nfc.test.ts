import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATA_PATH,
  EXTRACT_PATH,
  FIXTURE_PATH,
  buildTables,
  crossCheckWithNode,
  fixtureInputs,
  loadExtract,
  nfcReference,
  renderAll,
  run,
} from "./gen-godot-nfc.js";
import { readFileSync } from "node:fs";

const x = loadExtract();
const t = buildTables(x);
// The tables are pinned to UCD 16.0 and are the reference. Node 22.23's ICU 78 (Unicode 17) agrees
// with them on every code point and every (starter, mark) pair, so the comparison runs on any Node
// that carries Unicode 16 or newer; CI pins the Node version (.github/actions/setup-js).
const nodeHasNfc16 = parseFloat(process.versions.unicode ?? "0") >= 16;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let v = a;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

describe("godot-nfc tables", () => {
  it("record the source hashes and Unicode 16.0", () => {
    expect(x.unicodeVersion).toBe("16.0.0");
    for (const s of Object.values(x.source))
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("have the expected shape", () => {
    expect(t.decomp.size).toBeGreaterThan(2000);
    expect(t.pairs.size).toBeGreaterThan(900);
    expect(t.ccc.get(0x0301)).toBe(230);
    expect(t.pairs.get(`${0x65},${0x308}`)).toBe(0xeb);
    // A script exclusion and a singleton never compose.
    expect([...t.pairs.values()]).not.toContain(0x958);
    expect([...t.pairs.values()]).not.toContain(0x212b);
  });

  it("the committed outputs are fresh", async () => {
    const root = join(__dirname, "..");
    for (const [p, content] of await renderAll(root))
      expect(readFileSync(join(root, p), "utf8") === content, p).toBe(true);
  });

  it("run() writes into a scratch root and --check then passes", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-godot-nfc-"));
    mkdirSync(join(root, dirname(EXTRACT_PATH)), { recursive: true });
    writeFileSync(
      join(root, EXTRACT_PATH),
      readFileSync(join(__dirname, "..", EXTRACT_PATH)),
    );
    expect((await run({ check: true, root })).sort()).toEqual(
      [DATA_PATH, FIXTURE_PATH].sort(),
    );
    await run({ check: false, root });
    expect(await run({ check: true, root })).toEqual([]);
  });
});

describe.skipIf(!nodeHasNfc16)(
  "reference NFC equals Node's String.prototype.normalize",
  () => {
    it("for every code point", () => {
      const bad: number[] = [];
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const s = String.fromCodePoint(cp);
        if (nfcReference(s, t) !== s.normalize("NFC")) bad.push(cp);
      }
      expect(bad).toEqual([]);
    });

    it("for every (starter, mark) pair", () => {
      const starters = new Set<number>();
      for (const k of t.pairs.keys()) starters.add(Number(k.split(",")[0]));
      for (const cp of t.decomp.keys()) starters.add(cp);
      const marks = [...t.ccc.keys()];
      const bad: string[] = [];
      for (const a of starters)
        for (const m of marks) {
          const s = String.fromCodePoint(a, m);
          if (nfcReference(s, t) !== s.normalize("NFC")) bad.push(s);
        }
      expect(bad).toEqual([]);
    });

    it("for the fixture inputs and a seeded fuzz over the whole BMP and the supplementary planes", () => {
      expect(crossCheckWithNode(t)?.bad).toEqual([]);
      const rnd = mulberry32(0x504b4559 ^ 0x1234);
      const marks = [...t.ccc.keys()];
      const comps = [...t.decomp.keys()];
      const bad: string[] = [];
      for (let i = 0; i < 20000; i++) {
        let s = "";
        const n = 1 + Math.floor(rnd() * 10);
        for (let k = 0; k < n; k++) {
          const r = rnd();
          const cp =
            r < 0.35
              ? marks[Math.floor(rnd() * marks.length)]!
              : r < 0.7
                ? comps[Math.floor(rnd() * comps.length)]!
                : r < 0.85
                  ? 0x1100 + Math.floor(rnd() * 0x100)
                  : 0x41 + Math.floor(rnd() * 0x30);
          s += String.fromCodePoint(cp);
        }
        if (nfcReference(s, t) !== s.normalize("NFC")) bad.push(s);
      }
      expect(bad).toEqual([]);
    });

    it("for every device-label corpus row (raw after steps 1-2 is cleaned by the corpus; NFC part checked)", () => {
      const corpus = JSON.parse(
        readFileSync(
          join(__dirname, "../conformance/corpus/v2/device-label.json"),
          "utf8",
        ),
      ) as {
        cases: { raw: string }[];
        helloCases: { raw: string; expect: string | null }[];
      };
      for (const r of [...corpus.cases, ...corpus.helloCases])
        expect(nfcReference(r.raw, t)).toBe(r.raw.normalize("NFC"));
      // The expected HELLO outputs are NFC fixed points.
      for (const r of corpus.helloCases)
        if (r.expect !== null) expect(nfcReference(r.expect, t)).toBe(r.expect);
    });
  },
);

describe("fixture inputs", () => {
  it("are deterministic and cover the 2000 seeded strings", () => {
    const a = fixtureInputs(t);
    expect(a).toEqual(fixtureInputs(t));
    expect(a.length).toBeGreaterThan(2000 + 2000);
  });
});
