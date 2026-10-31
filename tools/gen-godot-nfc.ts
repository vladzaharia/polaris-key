// The Godot NFC generator (GODOT-NFC.1, CC-14 D-20).
//
//   pnpm gen godot-nfc                # (re)write the table and the fixture
//   pnpm gen godot-nfc --check        # regenerate in memory; exit 1 if a file differs
//   pnpm exec tsx tools/gen-godot-nfc.ts --extract-from <dir>   # rebuild tools/unicode/nfc-16.0.json
//
// Godot has no Unicode normalisation, and WIRE-CONTRACT-V5 §15.6 needs NFC in the peer HELLO
// cleaner. This family generates the tables the GDScript `PKeyNfc` runs over (UCD 16.0, matching the
// step-1/2 ranges that DEVICE-LABEL-STRIP D-1 froze) from one committed extract of the Unicode
// Character Database, and a fixture of expected NFC outputs computed by the TypeScript reference
// below. The reference is cross-checked against Node's String.prototype.normalize("NFC") in the
// tools test (and here, where process.versions.unicode >= 16). Nothing is fetched on a normal run
// or on --check.
//
// Inputs:  tools/unicode/nfc-16.0.json (the extract; its source hashes are recorded inside it).
// Outputs: sdks/godot/addons/polaris_key/core/text/nfc_data.gd (packed int arrays)
//          sdks/godot/tests/fixtures/nfc_cases.json (code points and seeded strings -> NFC)

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EXTRACT_PATH = "tools/unicode/nfc-16.0.json";
export const DATA_PATH = "sdks/godot/addons/polaris_key/core/text/nfc_data.gd";
export const FIXTURE_PATH = "sdks/godot/tests/fixtures/nfc_cases.json";
export const FUZZ_SEED = 0x504b4559;
export const FUZZ_COUNT = 2000;

/** The committed extract: what NFC needs from UnicodeData.txt and CompositionExclusions.txt. */
export interface Extract {
  unicodeVersion: string;
  source: Record<string, { url: string; sha256: string }>;
  /** "LO HI CCC" (hex, hex, decimal) for every range of non-zero canonical combining class. */
  ccc: string[];
  /** Hex code point -> its one-step canonical decomposition ("0041 0300"); no compatibility tags. */
  decomposition: Record<string, string>;
  /** CompositionExclusions.txt: the script-specific and post-composition-version exclusions. */
  exclusions: string[];
}

const hex = (n: number): string =>
  n.toString(16).toUpperCase().padStart(4, "0");

// ── The extract, built once from unicode.org's files ───────────────────────────────────────────

export function buildExtract(
  unicodeData: string,
  exclusionsText: string,
  hashes: { unicodeData: string; exclusions: string },
): Extract {
  const ccc = new Map<number, number>();
  const decomposition: Record<string, string> = {};
  let rangeStart = -1;
  for (const line of unicodeData.split("\n")) {
    if (line === "") continue;
    const f = line.split(";");
    const cp = parseInt(f[0]!, 16);
    const name = f[1]!;
    const cc = parseInt(f[3]!, 10);
    if (name.endsWith(", First>")) rangeStart = cp;
    if (cc !== 0) {
      const lo = name.endsWith(", Last>") ? rangeStart : cp;
      for (let c = lo; c <= cp; c++) ccc.set(c, cc);
    }
    const d = f[5]!;
    if (d !== "" && !d.startsWith("<"))
      decomposition[hex(cp)] = d.split(" ").join(" ");
  }
  const sorted = [...ccc.entries()].sort((a, b) => a[0] - b[0]);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (
      j + 1 < sorted.length &&
      sorted[j + 1]![0] === sorted[j]![0] + 1 &&
      sorted[j + 1]![1] === sorted[i]![1]
    )
      j++;
    ranges.push(`${hex(sorted[i]![0])} ${hex(sorted[j]![0])} ${sorted[i]![1]}`);
    i = j + 1;
  }
  const exclusions: string[] = [];
  for (const raw of exclusionsText.split("\n")) {
    const m = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*(?:#|$)/.exec(raw);
    if (!m) continue;
    const lo = parseInt(m[1]!, 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    for (let c = lo; c <= hi; c++) exclusions.push(hex(c));
  }
  const base = "https://www.unicode.org/Public/16.0.0/ucd/";
  return {
    unicodeVersion: "16.0.0",
    source: {
      "UnicodeData.txt": {
        url: base + "UnicodeData.txt",
        sha256: hashes.unicodeData,
      },
      "CompositionExclusions.txt": {
        url: base + "CompositionExclusions.txt",
        sha256: hashes.exclusions,
      },
    },
    ccc: ranges,
    decomposition,
    exclusions,
  };
}

export function loadExtract(root = ROOT): Extract {
  return JSON.parse(readFileSync(join(root, EXTRACT_PATH), "utf8")) as Extract;
}

// ── The tables ─────────────────────────────────────────────────────────────────────────────────

export interface Tables {
  /** Code point -> canonical combining class, non-zero only. */
  ccc: Map<number, number>;
  /** Code point -> its FULL canonical decomposition (recursive; Hangul syllables are algorithmic). */
  decomp: Map<number, number[]>;
  /** "first,second" -> primary composite (exclusions, singletons and non-starter decompositions out). */
  pairs: Map<string, number>;
}

const SBase = 0xac00;
const LBase = 0x1100;
const VBase = 0x1161;
const TBase = 0x11a7;
const LCount = 19;
const VCount = 21;
const TCount = 28;
const NCount = VCount * TCount;
const SCount = LCount * NCount;

export function buildTables(x: Extract): Tables {
  const ccc = new Map<number, number>();
  for (const r of x.ccc) {
    const [lo, hi, c] = r.split(" ");
    for (let cp = parseInt(lo!, 16); cp <= parseInt(hi!, 16); cp++)
      ccc.set(cp, parseInt(c!, 10));
  }
  const oneStep = new Map<number, number[]>();
  for (const [k, v] of Object.entries(x.decomposition))
    oneStep.set(
      parseInt(k, 16),
      v.split(" ").map((h) => parseInt(h, 16)),
    );
  const full = (cp: number): number[] => {
    const d = oneStep.get(cp);
    return d ? d.flatMap(full) : [cp];
  };
  const decomp = new Map<number, number[]>();
  for (const cp of oneStep.keys()) decomp.set(cp, full(cp));
  const excluded = new Set(x.exclusions.map((h) => parseInt(h, 16)));
  const pairs = new Map<string, number>();
  for (const [cp, d] of oneStep) {
    if (d.length !== 2) continue; // singletons never compose
    if (excluded.has(cp)) continue;
    if ((ccc.get(cp) ?? 0) !== 0 || (ccc.get(d[0]!) ?? 0) !== 0) continue; // non-starter decompositions
    pairs.set(`${d[0]},${d[1]}`, cp);
  }
  return { ccc, decomp, pairs };
}

// ── The TypeScript reference ───────────────────────────────────────────────────────────────────

export function nfcReference(s: string, t: Tables): string {
  const cps: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= SBase && cp < SBase + SCount) {
      const si = cp - SBase;
      cps.push(
        LBase + Math.floor(si / NCount),
        VBase + Math.floor((si % NCount) / TCount),
      );
      if (si % TCount !== 0) cps.push(TBase + (si % TCount));
      continue;
    }
    const d = t.decomp.get(cp);
    if (d) cps.push(...d);
    else cps.push(cp);
  }
  // Canonical ordering: a stable sort of each run of non-zero classes.
  for (let i = 0; i < cps.length; ) {
    if ((t.ccc.get(cps[i]!) ?? 0) === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < cps.length && (t.ccc.get(cps[j]!) ?? 0) !== 0) j++;
    const run = cps
      .slice(i, j)
      .map((cp, k) => ({ cp, k, c: t.ccc.get(cp)! }))
      .sort((a, b) => a.c - b.c || a.k - b.k);
    run.forEach((e, k) => (cps[i + k] = e.cp));
    i = j;
  }
  // Composition.
  const out: number[] = [];
  let starter = -1;
  let lastCc = 0;
  for (const c of cps) {
    const cc = t.ccc.get(c) ?? 0;
    if (starter >= 0 && (lastCc === 0 || lastCc < cc)) {
      const a = out[starter]!;
      let comp: number | undefined;
      if (a >= LBase && a < LBase + LCount && c >= VBase && c < VBase + VCount)
        comp = SBase + ((a - LBase) * VCount + (c - VBase)) * TCount;
      else if (
        a >= SBase &&
        a < SBase + SCount &&
        (a - SBase) % TCount === 0 &&
        c > TBase &&
        c < TBase + TCount
      )
        comp = a + (c - TBase);
      else comp = t.pairs.get(`${a},${c}`);
      if (
        comp !== undefined &&
        (lastCc === 0 ? out.length - 1 === starter : true)
      ) {
        out[starter] = comp;
        continue;
      }
    }
    if (cc === 0) {
      starter = out.length;
      lastCc = 0;
    } else lastCc = cc;
    out.push(c);
  }
  return String.fromCodePoint(...out);
}

// ── Output 1: the GDScript table ───────────────────────────────────────────────────────────────

function wrap(nums: number[], indent = "\t", width = 96): string {
  const lines: string[] = [];
  let cur = indent;
  for (const n of nums) {
    const tok = `${n},`;
    if (cur.length + tok.length + 1 > width && cur !== indent) {
      lines.push(cur.trimEnd());
      cur = indent;
    }
    cur += tok + " ";
  }
  if (cur.trim() !== "") lines.push(cur.trimEnd());
  return lines.join("\n");
}

export function renderGd(x: Extract, t: Tables): string {
  const ccc: number[] = [];
  const keys = [...t.ccc.keys()].sort((a, b) => a - b);
  for (let i = 0; i < keys.length; ) {
    let j = i;
    while (
      j + 1 < keys.length &&
      keys[j + 1] === keys[j]! + 1 &&
      t.ccc.get(keys[j + 1]!) === t.ccc.get(keys[i]!)
    )
      j++;
    ccc.push(keys[i]!, keys[j]!, t.ccc.get(keys[i]!)!);
    i = j + 1;
  }
  const decomp: number[] = [];
  for (const cp of [...t.decomp.keys()].sort((a, b) => a - b)) {
    const d = t.decomp.get(cp)!;
    decomp.push(cp, d.length, ...d);
  }
  const compose: number[] = [];
  const triples = [...t.pairs.entries()]
    .map(([k, v]) => {
      const [a, b] = k.split(",").map(Number);
      return [a!, b!, v] as const;
    })
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (const tr of triples) compose.push(...tr);
  return `# GENERATED FILE — do not edit by hand.
#
# Written by \`pnpm gen godot-nfc\` (tools/gen-godot-nfc.ts) from ${EXTRACT_PATH},
# the Unicode Character Database ${x.unicodeVersion}:
#   UnicodeData.txt           sha256 ${x.source["UnicodeData.txt"]!.sha256}
#   CompositionExclusions.txt sha256 ${x.source["CompositionExclusions.txt"]!.sha256}
# \`pnpm gen godot-nfc --check\` fails the green gate on any difference.
class_name PKeyNfcData
extends RefCounted
## The Unicode ${x.unicodeVersion} tables behind PKeyNfc (NFC; WIRE-CONTRACT-V5 §15.6, CC-14 D-20).
## Hangul syllables are algorithmic and are not listed. Plain Arrays of int: a packed-array
## constructor is not a constant expression in GDScript; PKeyNfc packs them on first use.

const UNICODE_VERSION := "${x.unicodeVersion}"

## Canonical combining classes, non-zero only: ${ccc.length / 3} runs of (first, last, class).
const CCC: Array = [
${wrap(ccc)}
]

## Full canonical decompositions: ${t.decomp.size} entries of (code point, length, parts...).
const DECOMP: Array = [
${wrap(decomp)}
]

## Primary composites: ${triples.length} triples of (first, second, composite), sorted by (first, second).
const COMPOSE: Array = [
${wrap(compose)}
]
`;
}

// ── Output 2: the fixture ──────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toHex = (s: string): string =>
  [...s].map((c) => hex(c.codePointAt(0)!)).join(" ");

/** The input strings: every code point with a decomposition or a class, then seeded mixtures. */
export function fixtureInputs(t: Tables): string[] {
  const cps = new Set<number>([...t.decomp.keys(), ...t.ccc.keys()]);
  const inputs = [...cps]
    .sort((a, b) => a - b)
    .map((cp) => String.fromCodePoint(cp));
  // Hangul syllable edges.
  for (const cp of [SBase, SBase + 1, SBase + TCount, SBase + SCount - 1])
    inputs.push(String.fromCodePoint(cp));
  const starters = new Set<number>();
  for (const k of t.pairs.keys()) starters.add(Number(k.split(",")[0]));
  const pool = [
    ...[...starters].sort((a, b) => a - b),
    ...[...t.pairs.values()].sort((a, b) => a - b),
    ...[...t.ccc.keys()].sort((a, b) => a - b),
    ...[...t.decomp.keys()].sort((a, b) => a - b),
    ...Array.from({ length: LCount }, (_, i) => LBase + i),
    ...Array.from({ length: VCount }, (_, i) => VBase + i),
    ...Array.from({ length: TCount - 1 }, (_, i) => TBase + 1 + i),
    ...Array.from({ length: 12 }, (_, i) => SBase + i * TCount * 7),
    0x20,
    0x41,
    0x61,
    0x7a,
    0x30,
    0xe9,
    0x4e00,
    0x1f600,
    0x10ffff,
  ];
  const rnd = mulberry32(FUZZ_SEED);
  for (let i = 0; i < FUZZ_COUNT; i++) {
    const n = 1 + Math.floor(rnd() * 12);
    let s = "";
    for (let k = 0; k < n; k++)
      s += String.fromCodePoint(pool[Math.floor(rnd() * pool.length)]!);
    inputs.push(s);
  }
  return inputs;
}

export async function renderFixture(t: Tables): Promise<string> {
  const rows = fixtureInputs(t).map((s) => [
    toHex(s),
    toHex(nfcReference(s, t)),
  ]);
  const json = {
    description:
      "NFC (Unicode 16.0) of every code point with a decomposition or a combining class, the Hangul edges, and 2000 seeded mixtures; generated by `pnpm gen godot-nfc`. Rows are [input, expected] as space-separated hex code points. Seed 0x504b4559 (mulberry32).",
    unicodeVersion: "16.0.0",
    rows,
  };
  return prettier.format(JSON.stringify(json), { parser: "json" });
}

// ── The cross-check against the engine's own tables ───────────────────────────────────────────

/** Compares the reference with Node's NFC over the fixture inputs. Returns null when Node's Unicode is older. */
export function crossCheckWithNode(
  t: Tables,
): { checked: number; bad: string[] } | null {
  if (parseFloat(process.versions.unicode ?? "0") < 16) return null;
  const bad: string[] = [];
  const inputs = fixtureInputs(t);
  for (const s of inputs)
    if (nfcReference(s, t) !== s.normalize("NFC")) bad.push(toHex(s));
  return { checked: inputs.length, bad };
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

export async function renderAll(root = ROOT): Promise<Map<string, string>> {
  const x = loadExtract(root);
  const t = buildTables(x);
  return new Map([
    [DATA_PATH, renderGd(x, t)],
    [FIXTURE_PATH, await renderFixture(t)],
  ]);
}

export async function run(opts: {
  check: boolean;
  root?: string;
}): Promise<string[]> {
  const root = opts.root ?? ROOT;
  const stale: string[] = [];
  for (const [path, content] of await renderAll(root)) {
    const abs = join(root, path);
    let current: string | undefined;
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    stale.push(path);
    if (opts.check) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return stale;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--extract-from");
  if (at >= 0) {
    const dir = args[at + 1]!;
    const ud = readFileSync(join(dir, "UnicodeData.txt"));
    const ex = readFileSync(join(dir, "CompositionExclusions.txt"));
    const sha = (b: Buffer): string =>
      createHash("sha256").update(b).digest("hex");
    const x = buildExtract(ud.toString("utf8"), ex.toString("utf8"), {
      unicodeData: sha(ud),
      exclusions: sha(ex),
    });
    writeFileSync(
      join(ROOT, EXTRACT_PATH),
      await prettier.format(JSON.stringify(x), { parser: "json" }),
    );
    console.log(`wrote ${EXTRACT_PATH}`);
    return;
  }
  const check = args.includes("--check");
  const x = loadExtract();
  const cross = crossCheckWithNode(buildTables(x));
  if (cross === null)
    console.log(
      `note: Node's Unicode ${process.versions.unicode} < 16; Node cross-check skipped`,
    );
  else if (cross.bad.length > 0) {
    console.error(
      `reference differs from Node NFC on ${cross.bad.length} inputs, e.g. ${cross.bad[0]}`,
    );
    process.exit(2);
  }
  const stale = await run({ check });
  if (check) {
    for (const p of stale)
      console.error(`stale: ${p} — run \`pnpm gen godot-nfc\``);
    if (stale.length > 0) process.exit(1);
    console.log("up to date: 2 generated Godot NFC files");
    return;
  }
  for (const p of stale) console.log(`wrote ${p}`);
  if (stale.length === 0) console.log("nothing to write");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
