// `device-label.json`: the device label every SDK sends as `deviceName` (WIRE-CONTRACT-V5
// §12.7.1, plans/PX-W13.md §4) and the HELLO label of §15.6 (DEVICE-LABEL-STRIP).

import {
  refDeviceLabel,
  refHelloLabel,
  refIsSpace,
  refIsStrip,
} from "./reference/device-label.js";

// ── Device labels (device-label.json) ────────────────────────────────────────
// WIRE-CONTRACT-V5 §12.7.1 (plans/PX-W13.md §2.1, §4): the one normalisation every SDK applies to
// the label it sends as `deviceName`, and the Worker applies on receipt. Every row's `expect` is
// checked against the generator-local reference in `reference/device-label.ts`, which imports
// nothing from client-core or shared-protocol (a golden corpus that shares code with the
// implementation it checks cannot catch a bug in it). Strings are written with every non-ASCII code point escaped, so no bidi
// override or zero-width character sits literally in a committed file.

interface DeviceLabelCase {
  id: string;
  description: string;
  raw: string;
  expect: string | null;
}

const A63 = "A".repeat(63);
const A64 = "A".repeat(64);

const DEVICE_LABEL_CASES: DeviceLabelCase[] = [
  {
    id: "ascii-plain",
    description: "An ordinary ASCII label is unchanged.",
    raw: "Living room TV",
    expect: "Living room TV",
  },
  {
    id: "trim-and-collapse",
    description: "Runs of spaces collapse to one; both ends are trimmed.",
    raw: "  Living   room  TV  ",
    expect: "Living room TV",
  },
  {
    id: "tab-newline-crlf",
    description:
      "Step 1: tab, line feed, vertical tab, form feed and carriage return become spaces, then collapse.",
    raw: "Living\troom\n\u000b\u000cTV\r\n",
    expect: "Living room TV",
  },
  {
    id: "c0-controls",
    description:
      "Step 2: the C0 controls outside step 1 (here SOH, BEL and ESC) are deleted, not spaced. No row holds U+0000: a Godot String cannot.",
    raw: "Living\u0001room\u0007T\u001bV",
    expect: "LivingroomTV",
  },
  {
    id: "del-and-c1",
    description:
      "Step 2: DEL and the C1 controls are deleted; NEL (U+0085) is whitespace and becomes a space first.",
    raw: "Den\u007f\u0080\u0085PC\u009f",
    expect: "Den PC",
  },
  {
    id: "nbsp-ideographic-space",
    description: "Step 1: NBSP and the ideographic space become spaces.",
    raw: "Living\u00a0room\u3000TV",
    expect: "Living room TV",
  },
  {
    id: "line-paragraph-separators",
    description: "Step 1: U+2028 and U+2029 become spaces.",
    raw: "Living\u2028room\u2029TV",
    expect: "Living room TV",
  },
  {
    id: "arabic-letter-mark",
    description: "Step 2: the Arabic letter mark (U+061C) is deleted.",
    raw: "TV\u061c",
    expect: "TV",
  },
  {
    id: "zero-width-and-marks",
    description:
      "Step 2: zero-width space, non-joiner and joiner, and the LRM and RLM marks (U+200B-200F) are deleted.",
    raw: "Li\u200bving\u200c \u200dTV\u200e\u200f",
    expect: "Living TV",
  },
  {
    id: "rlo-spoof",
    description:
      "Step 2: a right-to-left override that would render the tail reversed (`exe.png`) is deleted, so the label reads in logical order.",
    raw: "Living room TV\u202egnp.exe",
    expect: "Living room TVgnp.exe",
  },
  {
    id: "bidi-embeddings",
    description:
      "Step 2: the bidi embeddings, pop and overrides (U+202A-202E) are deleted.",
    raw: "\u202aA\u202bB\u202cC\u202dD\u202e",
    expect: "ABCD",
  },
  {
    id: "invisible-operators",
    description:
      "Step 2: the word joiner and the invisible operators (U+2060-2064) are deleted.",
    raw: "A\u2060B\u2061C\u2062D\u2063E\u2064",
    expect: "ABCDE",
  },
  {
    id: "bidi-isolates",
    description: "Step 2: the bidi isolates (U+2066-2069) are deleted.",
    raw: "\u2066A\u2067B\u2068C\u2069",
    expect: "ABC",
  },
  {
    id: "byte-order-mark",
    description: "Step 2: a byte order mark (U+FEFF) is deleted.",
    raw: "\ufeffDeck",
    expect: "Deck",
  },
  {
    id: "non-latin-kept",
    description:
      "Letters, punctuation and symbols outside the two lists are kept as they are.",
    raw: "Gästezimmer-PC · 客厅",
    expect: "Gästezimmer-PC · 客厅",
  },
  {
    id: "no-unicode-normalisation",
    description:
      "There is no NFC step: a decomposed e and combining acute accent stay two code points.",
    raw: "Cafe\u0301",
    expect: "Cafe\u0301",
  },
  {
    id: "length-64-kept",
    description: "Exactly 64 code points: kept whole.",
    raw: A64,
    expect: A64,
  },
  {
    id: "length-65-cut",
    description: "65 code points: cut to the first 64.",
    raw: `${A64}B`,
    expect: A64,
  },
  {
    id: "astral-at-boundary-kept",
    description:
      "An astral emoji as the 64th code point is kept whole: the limit counts code points (64 here), not UTF-16 units (65).",
    raw: `${A63}\u{1f3ae}B`,
    expect: `${A63}\u{1f3ae}`,
  },
  {
    id: "astral-past-boundary-cut",
    description:
      "An astral emoji as the 65th code point is cut whole, never split into a lone surrogate.",
    raw: `${A64}\u{1f3ae}`,
    expect: A64,
  },
  {
    id: "cut-exposes-space",
    description:
      "Step 4 trims a trailing space the cut exposes: the 64th code point is a space.",
    raw: `${A63} B`,
    expect: A63,
  },
  {
    id: "length-after-cleaning",
    description:
      "The limit applies after steps 1-3: deleted code points and collapsed spaces do not count.",
    raw: `\u200b${"A ".repeat(40)}`,
    expect: "A ".repeat(32).trimEnd(),
  },
  {
    id: "all-whitespace-absent",
    description: "Only whitespace: nothing is left, so the label is absent.",
    raw: " \t\n\u3000 ",
    expect: null,
  },
  {
    id: "only-stripped-absent",
    description: "Only deleted code points: the label is absent.",
    raw: "\u200b\u202e\u0001",
    expect: null,
  },
  {
    id: "empty-absent",
    description: "The empty string is no label.",
    raw: "",
    expect: null,
  },
  {
    id: "zs-en-em-spaces",
    description:
      "Step 1: the Zs spaces U+2000-2005 (en, em, three-per-em, four-per-em, six-per-em, figure) become spaces.",
    raw: "A\u{2000}B\u{2001}C\u{2002}D\u{2003}E\u{2004}F\u{2005}G",
    expect: "A B C D E F G",
  },
  {
    id: "zs-thin-hair-spaces",
    description:
      "Step 1: the Zs spaces U+2006-200A (six-per-em, figure, punctuation, thin and hair among them) become spaces.",
    raw: "A\u{2006}B\u{2007}C\u{2008}D\u{2009}E\u{200a}F",
    expect: "A B C D E F",
  },
  {
    id: "zs-narrow-nbsp-mmsp-ogham",
    description:
      "Step 1: the narrow no-break space (U+202F), the medium mathematical space (U+205F) and the Ogham space mark (U+1680) become spaces.",
    raw: "A\u{202f}B\u{205f}C\u{1680}D",
    expect: "A B C D",
  },
  {
    id: "braille-blank",
    description:
      "Step 1: U+2800 BRAILLE PATTERN BLANK is not White_Space but renders blank; it becomes a space, and the trailing one is trimmed.",
    raw: "Ana\u{2800}Switch\u{2800}",
    expect: "Ana Switch",
  },
  {
    id: "mixed-blanks-collapse",
    description:
      "Steps 1 and 3: a space, the braille blank, the ideographic space and an em space collapse to one space.",
    raw: "Ana \u{2800}\u{3000}\u{2003}Switch",
    expect: "Ana Switch",
  },
  {
    id: "invisible-padding-spoof",
    description:
      "Step 2 (RED-N N3): the braille blank, the Hangul filler and a zero-width space after a name leave no trace, so padding cannot push text out of view.",
    raw: "Ana's iPhone\u{2800}\u{3164}\u{200b}",
    expect: "Ana's iPhone",
  },
  {
    id: "hangul-fillers",
    description:
      "Step 2: the Hangul fillers U+3164, U+115F, U+1160 and U+FFA0 are default-ignorable and deleted, not spaced.",
    raw: "Ana\u{3164}\u{115f}\u{1160}\u{ffa0}Switch",
    expect: "AnaSwitch",
  },
  {
    id: "hangul-filler-only-absent",
    description:
      "Steps 2 and 5: a label of one Hangul filler (the invisible-name trick) is absent.",
    raw: "\u{3164}",
    expect: null,
  },
  {
    id: "soft-hyphen-cgj",
    description:
      "Step 2: the soft hyphen (U+00AD) and the combining grapheme joiner (U+034F) are deleted.",
    raw: "Liv\u{00ad}ing\u{034f}",
    expect: "Living",
  },
  {
    id: "arabic-format-controls",
    description:
      "Step 2: the Arabic format characters U+0600-0605, U+06DD, U+070F, U+0890, U+0891 and U+08E2 are deleted.",
    raw: "A\u{0600}\u{0605}B\u{06dd}C\u{070f}D\u{0890}\u{0891}\u{08e2}",
    expect: "ABCD",
  },
  {
    id: "khmer-mongolian-ignorables",
    description:
      "Step 2: the Khmer inherent vowels (U+17B4-17B5) and the Mongolian free variation selectors and vowel separator (U+180B-180F) are deleted.",
    raw: "A\u{17b4}\u{17b5}B\u{180b}\u{180c}\u{180d}\u{180e}\u{180f}C",
    expect: "ABC",
  },
  {
    id: "word-joiner-block-rest",
    description:
      "Step 2: the rest of the U+2060-206F block, unassigned U+2065 and the deprecated formatting characters U+206A-206F, is deleted.",
    raw: "A\u{2065}B\u{206a}C\u{206f}D",
    expect: "ABCD",
  },
  {
    id: "variation-selectors",
    description:
      "Step 2: variation selectors U+FE00-FE0F are deleted, which turns a heart emoji into its text form; the space between the words stays.",
    raw: "\u{2764}\u{fe0f} TV\u{fe0e}",
    expect: "\u{2764} TV",
  },
  {
    id: "ideographic-variation",
    description:
      "Step 2: an ideographic variation selector (U+E0100, astral) is deleted.",
    raw: "\u{845b}\u{e0100}",
    expect: "\u{845b}",
  },
  {
    id: "tag-characters",
    description:
      "Step 2: the tag characters U+E0001 and U+E0020-E007F, which a flag-emoji sequence uses to name a subdivision, are deleted, leaving the black flag.",
    raw: "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}\u{e0001}",
    expect: "\u{1f3f4}",
  },
  {
    id: "unassigned-ignorables",
    description:
      "Step 2: unassigned default-ignorable code points (U+FFF0-FFF8, and U+E0000 and U+E0FFF at the ends of the tag block) are deleted.",
    raw: "A\u{fff0}B\u{fff8}C\u{e0000}D\u{e0fff}",
    expect: "ABCD",
  },
  {
    id: "interlinear-annotation",
    description:
      "Step 2: the interlinear annotation anchor, separator and terminator (U+FFF9-FFFB) are deleted.",
    raw: "A\u{fff9}B\u{fffa}C\u{fffb}",
    expect: "ABC",
  },
  {
    id: "astral-format-controls",
    description:
      "Step 2: the astral format characters U+110BD, U+110CD, U+13430-1343F, U+1BCA0-1BCA3 and U+1D173-1D17A are deleted.",
    raw: "A\u{110bd}B\u{110cd}C\u{13430}D\u{1343f}E\u{1bca0}F\u{1d173}G\u{1d17a}",
    expect: "ABCDEFG",
  },
  {
    id: "range-neighbours-kept-bmp",
    description:
      "The code points next to a BMP range are kept: U+00AC, U+00AE, U+115E, U+1161, U+17B3, U+17B6, U+2801, U+3163, U+3165, U+FE10 and U+FFA1.",
    raw: "\u{00ac}\u{00ae}\u{115e}\u{1161}\u{17b3}\u{17b6}\u{2801}\u{3163}\u{3165}\u{fe10}\u{ffa1}",
    expect:
      "\u{00ac}\u{00ae}\u{115e}\u{1161}\u{17b3}\u{17b6}\u{2801}\u{3163}\u{3165}\u{fe10}\u{ffa1}",
  },
  {
    id: "range-neighbours-kept-astral",
    description:
      "The code points next to an astral range are kept: U+110BC, U+110BE, U+1D172, U+1D17B and U+E1000.",
    raw: "\u{110bc}\u{110be}\u{1d172}\u{1d17b}\u{e1000}",
    expect: "\u{110bc}\u{110be}\u{1d172}\u{1d17b}\u{e1000}",
  },
  {
    id: "cut-after-invisibles",
    description:
      "The limit applies after step 2: 70 letters, each followed by a Hangul filler, are 70 code points once cleaned and are cut to 64.",
    raw: "A\u3164".repeat(70),
    expect: A64,
  },
  {
    id: "no-nfc-after-strip",
    description:
      "There is no NFC step in 12.7.1: after the zero-width space goes, e and the combining acute accent stay two code points (the HELLO rule of 15.6 composes them: hello-strip-then-nfc).",
    raw: "e\u{200b}\u{0301}",
    expect: "e\u{0301}",
  },
];

// ── HELLO labels (helloCases) ────────────────────────────────────────────────
// WIRE-CONTRACT-V5 §15.6: a peer's HELLO `label` and `app` are cleaned as a device label with
// NFC inserted after step 2: steps 1 and 2, NFC, then steps 3 to 5. The order makes the cleaner
// idempotent: with NFC first, deleting a code point could bring a base and a combining mark
// together and the next pass would compose them. Rows use only code points assigned by Unicode
// 13, because CPython 3.9 and JDK 17 ship UCD 13.

const HELLO_CASES: DeviceLabelCase[] = [
  {
    id: "hello-plain",
    description: "An ordinary label is unchanged.",
    raw: "Ana's Switch",
    expect: "Ana's Switch",
  },
  {
    id: "hello-nfd-to-nfc",
    description:
      "NFC composes a decomposed letter: e and a combining diaeresis (U+0308) become U+00EB.",
    raw: "Zoe\u{0308}'s Mac",
    expect: "Zo\u{00eb}'s Mac",
  },
  {
    id: "hello-strip-then-nfc",
    description:
      "The N2 regression: the zero-width space is deleted (step 2) before NFC, so e and the combining acute accent compose to U+00E9 in one pass, and a second pass changes nothing.",
    raw: "e\u{200b}\u{0301}",
    expect: "\u{00e9}",
  },
  {
    id: "hello-filler-then-nfc",
    description:
      "A Hangul filler between a and a combining grave accent is deleted first, so the two compose to U+00E0.",
    raw: "a\u{3164}\u{0300}",
    expect: "\u{00e0}",
  },
  {
    id: "hello-vs-then-nfc",
    description:
      "A variation selector between A and a combining ring above is deleted first, so the two compose to U+00C5.",
    raw: "A\u{fe0f}\u{030a}",
    expect: "\u{00c5}",
  },
  {
    id: "hello-singletons",
    description:
      "NFC maps the singletons OHM SIGN (U+2126) and ANGSTROM SIGN (U+212B) to omega (U+03A9) and A with ring above (U+00C5).",
    raw: "\u{2126} \u{212b}",
    expect: "\u{03a9} \u{00c5}",
  },
  {
    id: "hello-space-before-nfc",
    description: "Step 1 maps an en space to a space.",
    raw: "A\u{2000}B",
    expect: "A B",
  },
  {
    id: "hello-nfc-expands",
    description:
      "The cut counts code points after NFC: U+0958 becomes U+0915 U+093C, so 63 letters and U+0958 are 65 code points and the cut keeps U+0915 alone.",
    raw: `${A63}\u0958`,
    expect: `${A63}\u0915`,
  },
  {
    id: "hello-nfc-shrinks",
    description:
      "NFC can shrink a label below the cut: 64 pairs of e and a combining acute accent are 128 code points before NFC and 64 after, so all of them stay.",
    raw: "e\u0301".repeat(64),
    expect: "\u00e9".repeat(64),
  },
  {
    id: "hello-spoof-padding",
    description:
      "A Hangul filler and the braille blank after a name leave no trace (N3).",
    raw: "Ana's Switch\u{3164}\u{2800}",
    expect: "Ana's Switch",
  },
  {
    id: "hello-only-invisible",
    description:
      "Only invisible code points: nothing is left, so the label is absent (the host shows no label, or Unknown for an app).",
    raw: "\u{3164}\u{200b}\u{fe0f}",
    expect: null,
  },
];

type Range = [number, number];

/** Step 1: White_Space without U+0020, and U+2800. Inclusive pairs, ascending. */
const SPACE_RANGES: Range[] = [
  [0x0009, 0x000d],
  [0x0085, 0x0085],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x2800, 0x2800],
  [0x3000, 0x3000],
];

/** Step 2: Cc, Cf, Default_Ignorable_Code_Point and Cs at Unicode 16.0. Inclusive pairs, ascending. */
const STRIP_RANGES: Range[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

const MAX_CODE_POINT = 0x10ffff;

function inRanges(table: Range[], cp: number): boolean {
  return table.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** seeded PRNG (mulberry32): the fuzz below must give the same strings on every run. */
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

const FUZZ_SEED = 0x504b4559;
const FUZZ_STRINGS = 20_000;

/** Combining marks, composable bases and the NFC edge cases the fuzz draws from. */
const FUZZ_POOL: number[] = [
  0x41, 0x61, 0x65, 0x6f, 0x20, 0x20, 0x20, 0x31, 0x300, 0x301, 0x308, 0x30a,
  0x323, 0x93c, 0x915, 0x958, 0xe9, 0x2126, 0x212b, 0x3b1, 0x4e2d, 0x1f3ae,
  0x1100, 0x1161, 0xac00,
];

function fuzzString(rnd: () => number): string {
  const strip = STRIP_RANGES.filter(([lo]) => lo < 0xd800 || lo > 0xdfff);
  const n = Math.floor(rnd() * (rnd() < 0.1 ? 140 : 24));
  let out = "";
  for (let i = 0; i < n; i++) {
    const r = rnd();
    let cp: number;
    if (r < 0.4) cp = FUZZ_POOL[Math.floor(rnd() * FUZZ_POOL.length)]!;
    else if (r < 0.65) {
      const [lo, hi] = strip[Math.floor(rnd() * strip.length)]!;
      cp = lo + Math.floor(rnd() * (hi - lo + 1));
    } else if (r < 0.8) {
      const [lo, hi] = SPACE_RANGES[Math.floor(rnd() * SPACE_RANGES.length)]!;
      cp = lo + Math.floor(rnd() * (hi - lo + 1));
    } else if (r < 0.9) {
      // a range edge or its neighbour
      const t = rnd() < 0.5 ? SPACE_RANGES : strip;
      const [lo, hi] = t[Math.floor(rnd() * t.length)]!;
      cp = [lo - 1, lo, hi, hi + 1][Math.floor(rnd() * 4)]!;
    } else cp = Math.floor(rnd() * 0x30000);
    if (cp < 0 || cp > MAX_CODE_POINT || (cp >= 0xd800 && cp <= 0xdfff))
      cp = 0x41;
    out += String.fromCodePoint(cp);
  }
  // a lone surrogate now and then: the cleaners delete it (D-8), the corpus holds no row for it
  if (rnd() < 0.05)
    out += String.fromCharCode(0xd800 + Math.floor(rnd() * 0x800));
  return out;
}

function checkRanges(): void {
  for (const [name, table] of [
    ["space", SPACE_RANGES],
    ["strip", STRIP_RANGES],
  ] as const) {
    let prev = -2;
    for (const [lo, hi] of table) {
      if (!(lo <= hi) || lo <= prev + 1)
        throw new Error(
          `deviceLabel ranges.${name}: not ascending and disjoint at ${lo.toString(16)}`,
        );
      prev = hi;
    }
  }
  // The tables, compared with the reference's own regex classes over every code point. Step 1
  // runs first, so a code point in both is a space; the strip table keeps the C0 and C1 blocks
  // whole, which makes the overlap exactly the controls that are White_Space.
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (inRanges(SPACE_RANGES, cp) !== refIsSpace(cp))
      throw new Error(
        `deviceLabel ranges.space differs from the reference at U+${cp.toString(16)}`,
      );
    if (inRanges(STRIP_RANGES, cp) !== refIsStrip(cp))
      throw new Error(
        `deviceLabel ranges.strip differs from the reference at U+${cp.toString(16)}`,
      );
  }
  // As Unicode 16.0 defines them, when this Node carries those tables (Node 22 does).
  const [major] = (process.versions.unicode ?? "0").split(".").map(Number);
  if (major !== undefined && major >= 16) {
    const space = /^\p{White_Space}$/u;
    const strip =
      /^(?:\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point}|\p{Cs})$/u;
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      const ch = String.fromCodePoint(cp);
      const wantSpace = cp !== 0x20 && (space.test(ch) || cp === 0x2800);
      const wantStrip = !wantSpace && cp !== 0x20 && strip.test(ch);
      if (wantSpace !== inRanges(SPACE_RANGES, cp))
        throw new Error(
          `deviceLabel ranges.space differs from the Unicode properties at U+${cp.toString(16)}`,
        );
      // the strip table also lists the controls step 1 maps first; any other difference is a bug
      if (wantStrip !== inRanges(STRIP_RANGES, cp) && !wantSpace)
        throw new Error(
          `deviceLabel ranges.strip differs from the Unicode properties at U+${cp.toString(16)}`,
        );
    }
  }
  // NFC closure: NFC of a string without a stripped or spaced code point adds none. A code point
  // that is in neither set must not decompose into one (checked below), and no set member may be
  // the result of a composition, so neither the decomposition nor the composition can introduce one.
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const inSet =
      cp === 0x20 || inRanges(SPACE_RANGES, cp) || inRanges(STRIP_RANGES, cp);
    if (inSet) {
      // NFC maps U+2000 and U+2001 (singletons) to U+2002 and U+2003, and NFC output only ever
      // holds NFC-stable code points. So a set member is a problem only when it is stable and
      // a composition result (it has a canonical decomposition of its own).
      if (ch.normalize("NFC") === ch && ch.normalize("NFD") !== ch)
        throw new Error(
          `deviceLabel: U+${cp.toString(16)} is in a set and is a composition result`,
        );
      continue;
    }
    for (const form of ["NFC", "NFD"] as const)
      for (const out of ch.normalize(form)) {
        const o = out.codePointAt(0)!;
        if (
          o === 0x20 ||
          inRanges(SPACE_RANGES, o) ||
          inRanges(STRIP_RANGES, o)
        )
          throw new Error(
            `deviceLabel: ${form} of U+${cp.toString(16)} contains U+${o.toString(16)}`,
          );
      }
  }
}

function checkRows(
  section: string,
  rows: DeviceLabelCase[],
  clean: (raw: string) => string | null,
): void {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`deviceLabel: duplicate id ${row.id}`);
    ids.add(row.id);
    const got = clean(row.raw);
    if (got !== row.expect)
      throw new Error(
        `deviceLabel ${section} ${row.id}: reference gives ${JSON.stringify(got)}, row says ${JSON.stringify(row.expect)}`,
      );
    // A row is its own fixed point: cleaning a cleaned label changes nothing.
    if (row.expect !== null && clean(row.expect) !== row.expect)
      throw new Error(
        `deviceLabel ${section} ${row.id}: expect is not a fixed point`,
      );
  }
}

function checkFuzz(
  name: string,
  clean: (raw: string) => string | null,
  seed: number,
): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < FUZZ_STRINGS; i++) {
    const raw = fuzzString(rnd);
    const once = clean(raw);
    if (once === null) continue;
    const twice = clean(once);
    if (twice !== once)
      throw new Error(
        `deviceLabel fuzz ${name} #${i}: not idempotent on ${JSON.stringify(raw)}: ${JSON.stringify(once)} then ${JSON.stringify(twice)}`,
      );
    const points = Array.from(once);
    if (
      points.length > 64 ||
      once.startsWith(" ") ||
      once.endsWith(" ") ||
      once.includes("  ") ||
      points.some((c) => {
        const cp = c.codePointAt(0)!;
        return inRanges(SPACE_RANGES, cp) || inRanges(STRIP_RANGES, cp);
      })
    )
      throw new Error(
        `deviceLabel fuzz ${name} #${i}: breaks the output shape on ${JSON.stringify(raw)}`,
      );
  }
}

export function buildDeviceLabelCorpus(): unknown {
  checkRanges();
  checkRows("cases", DEVICE_LABEL_CASES, refDeviceLabel);
  checkRows("helloCases", HELLO_CASES, refHelloLabel);
  checkFuzz("refDeviceLabel", refDeviceLabel, FUZZ_SEED);
  checkFuzz("refHelloLabel", refHelloLabel, FUZZ_SEED);
  return {
    deviceLabelVersion: 2,
    description:
      "Device labels (WIRE-CONTRACT-V5 section 12.7.1, plans/PX-W13.md section 2.1, DEVICE-LABEL-STRIP). Every SDK normalises the label it sends as `deviceName` (device-code sign-in, licence activation, registration), and the Worker normalises it again on receipt: (1) map every White_Space code point (U+0009-000D, U+0085, U+00A0, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000) and U+2800 to U+0020; (2) delete every control (Cc), format character (Cf), default-ignorable code point and surrogate as of Unicode 16.0; (3) collapse runs of U+0020 to one and trim both ends; (4) keep at most 64 code points (`DEVICE_LABEL_MAX_CODEPOINTS`; code points, never UTF-16 units) and trim a trailing space the cut exposes; (5) an empty result is no label: `expect: null`, the member is omitted and the Worker stores NULL. No Unicode normalisation; nothing is ever rejected. Cleaning a cleaned label changes nothing. `ranges` holds the step 1 set (`space`, without U+0020) and the step 2 set (`strip`) as inclusive [lo, hi] pairs of code points, ascending; the strip pairs keep the C0 and C1 blocks whole, and step 1 runs first, so a code point in both is a space. Each runner asserts its own tables equal `ranges`, that its `normalizeDeviceLabel` maps every `cases` `raw` to `expect`, and that every `expect` is a fixed point. `helloCases` is the same cleaner for a peer's HELLO `label` and `app` (section 15.6): steps 1 and 2, then NFC, then steps 3 to 5, counting the 64 code points after NFC. An SDK with no NFC and no peer session skips `helloCases` by name. Non-ASCII code points are written escaped. Append-only: a new row keeps `deviceLabelVersion`; a changed row or rule bumps it.",
    ranges: { space: SPACE_RANGES, strip: STRIP_RANGES },
    cases: DEVICE_LABEL_CASES,
    helloCases: HELLO_CASES,
  };
}
