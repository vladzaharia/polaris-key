// Unit tests for the §12.7.1 device label and the §15.6 HELLO cleaning. The corpus rows
// (`device-label.json`) run in conformance/runners/node/deviceLabel.test.ts; these pin the edges
// the corpus cannot carry: the tables against the Unicode properties, idempotence over a seeded
// fuzz, and a lone surrogate (Swift and Godot cannot hold one, so no corpus row does).
import { describe, expect, it } from "vitest";
import {
  DEVICE_LABEL_SPACE,
  DEVICE_LABEL_STRIP,
} from "@polaris-key/protocol/identity";
import { cleanDisplayLabel, normalizeDeviceLabel } from "../src/deviceLabel.js";

type Ranges = readonly (readonly [number, number])[];
const inRanges = (t: Ranges, cp: number): boolean =>
  t.some(([lo, hi]) => cp >= lo && cp <= hi);

/** mulberry32, the generator's PRNG: the fuzz is the same on every run. */
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

const POOL = [
  0x41, 0x61, 0x65, 0x6f, 0x20, 0x20, 0x20, 0x31, 0x300, 0x301, 0x308, 0x30a,
  0x323, 0x93c, 0x915, 0x958, 0xe9, 0x2126, 0x212b, 0x3b1, 0x4e2d, 0x1f3ae,
  0x1100, 0x1161, 0xac00,
];
const STRIP = DEVICE_LABEL_STRIP.filter(([lo]) => lo < 0xd800 || lo > 0xdfff);

function fuzzString(rnd: () => number): string {
  const n = Math.floor(rnd() * (rnd() < 0.1 ? 140 : 24));
  let out = "";
  for (let i = 0; i < n; i++) {
    const r = rnd();
    let cp: number;
    if (r < 0.4) cp = POOL[Math.floor(rnd() * POOL.length)]!;
    else if (r < 0.65) {
      const [lo, hi] = STRIP[Math.floor(rnd() * STRIP.length)]!;
      cp = lo + Math.floor(rnd() * (hi - lo + 1));
    } else if (r < 0.8) {
      const [lo, hi] =
        DEVICE_LABEL_SPACE[Math.floor(rnd() * DEVICE_LABEL_SPACE.length)]!;
      cp = lo + Math.floor(rnd() * (hi - lo + 1));
    } else if (r < 0.9) {
      const t = rnd() < 0.5 ? DEVICE_LABEL_SPACE : STRIP;
      const [lo, hi] = t[Math.floor(rnd() * t.length)]!;
      cp = [lo - 1, lo, hi, hi + 1][Math.floor(rnd() * 4)]!;
    } else cp = Math.floor(rnd() * 0x30000);
    if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0x41;
    out += String.fromCodePoint(cp);
  }
  if (rnd() < 0.05)
    out += String.fromCharCode(0xd800 + Math.floor(rnd() * 0x800));
  return out;
}

describe("normalizeDeviceLabel", () => {
  it("is not a string: no label", () => {
    expect(normalizeDeviceLabel(undefined)).toBeNull();
    expect(normalizeDeviceLabel(null)).toBeNull();
    expect(normalizeDeviceLabel(42)).toBeNull();
    expect(cleanDisplayLabel(undefined)).toBeNull();
  });

  it("is idempotent", () => {
    const once = normalizeDeviceLabel("  Den\u202e PC\t\t");
    expect(once).toBe("Den PC");
    expect(normalizeDeviceLabel(once)).toBe(once);
  });

  it("counts code points, never UTF-16 units", () => {
    const emoji = "\u{1f3ae}".repeat(70);
    expect(Array.from(normalizeDeviceLabel(emoji)!)).toHaveLength(64);
    expect(Array.from(cleanDisplayLabel(emoji)!)).toHaveLength(64);
  });

  it("deletes a lone surrogate (D-8)", () => {
    expect(normalizeDeviceLabel("A\ud800B\udfffC")).toBe("ABC");
    expect(cleanDisplayLabel("A\ud83dB")).toBe("AB");
    expect(normalizeDeviceLabel("\udc00")).toBeNull();
  });

  it("does not compose after the strip (§12.7.1 has no NFC); the HELLO cleaning does", () => {
    expect(normalizeDeviceLabel("e\u200b\u0301")).toBe("e\u0301");
    expect(cleanDisplayLabel("e\u200b\u0301")).toBe("\u00e9");
  });
});

describe("the tables", () => {
  // The node run by CI carries Unicode 16 (Node 22.13, ICU 76). An older runtime skips the
  // comparison with a note: the tables are frozen at 16.0 on purpose.
  const major = Number((process.versions.unicode ?? "0").split(".")[0]);
  const stale = major < 16;
  if (stale)
    console.warn(
      `deviceLabel tables: process.versions.unicode ${process.versions.unicode} < 16, comparison skipped`,
    );

  it.skipIf(stale)(
    "equal White_Space + U+2800 and Cc | Cf | Default_Ignorable_Code_Point | Cs",
    () => {
      const space = /^\p{White_Space}$/u;
      const strip =
        /^(?:\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point}|\p{Cs})$/u;
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        const ch = String.fromCodePoint(cp);
        const wantSpace = cp !== 0x20 && (space.test(ch) || cp === 0x2800);
        if (inRanges(DEVICE_LABEL_SPACE, cp) !== wantSpace)
          throw new Error(`space table differs at U+${cp.toString(16)}`);
        // The strip table also lists the whitespace controls step 1 maps first.
        if (
          !wantSpace &&
          cp !== 0x20 &&
          inRanges(DEVICE_LABEL_STRIP, cp) !== strip.test(ch)
        )
          throw new Error(`strip table differs at U+${cp.toString(16)}`);
      }
    },
  );

  it("are ascending, disjoint inclusive pairs", () => {
    for (const t of [DEVICE_LABEL_SPACE, DEVICE_LABEL_STRIP]) {
      let prev = -2;
      for (const [lo, hi] of t) {
        expect(lo).toBeLessThanOrEqual(hi);
        expect(lo).toBeGreaterThan(prev + 1);
        prev = hi;
      }
    }
  });

  it("NFC never introduces a mapped or stripped code point", () => {
    const member = (cp: number): boolean =>
      cp === 0x20 ||
      inRanges(DEVICE_LABEL_SPACE, cp) ||
      inRanges(DEVICE_LABEL_STRIP, cp);
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (member(cp)) {
        // NFC output holds only NFC-stable code points: a member that is stable must not be a
        // composition result.
        if (ch.normalize("NFC") === ch && ch.normalize("NFD") !== ch)
          throw new Error(`U+${cp.toString(16)} is a member and a composition`);
        continue;
      }
      for (const out of ch.normalize("NFC"))
        if (member(out.codePointAt(0)!))
          throw new Error(`NFC of U+${cp.toString(16)} holds a member`);
    }
  });
});

describe("idempotence over 20,000 seeded strings", () => {
  for (const [name, clean] of [
    ["normalizeDeviceLabel", normalizeDeviceLabel],
    ["cleanDisplayLabel", cleanDisplayLabel],
  ] as const)
    it(name, () => {
      const rnd = mulberry32(0x504b4559);
      for (let i = 0; i < 20_000; i++) {
        const raw = fuzzString(rnd);
        const once = clean(raw);
        if (once === null) continue;
        expect(clean(once)).toBe(once);
        expect(Array.from(once).length).toBeLessThanOrEqual(64);
        expect(once.startsWith(" ") || once.endsWith(" ")).toBe(false);
        expect(once.includes("  ")).toBe(false);
      }
    });
});
