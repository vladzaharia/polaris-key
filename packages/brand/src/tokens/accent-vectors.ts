// The accent resolver's shared vectors: INPUTS ONLY. `pnpm gen:brand` runs src/accent.ts over
// them and writes fixtures/accent-vectors.json plus a copy (or native literals) into every SDK's
// tests, so the Swift, Kotlin, GDScript and Python ports are held to the TypeScript answer and a
// change to the algorithm cannot land without every port following (UI-KITS.md §3.3).
//
// The first rows are the spec's own table (Tidewater's icon-derived teal, the core violet, Drift
// Kart's own orange, danger); the rest cover the edges: a light teal and a yellow (ink labels), a
// blue and a pink (white), a navy too dark for a dark scheme, greys, black and white.

import { BRAND } from "./primitives.js";

/** One colour of a synthetic icon: RGBA bytes and how many pixels carry it. */
export type PixelRun = readonly [
  r: number,
  g: number,
  b: number,
  a: number,
  count: number,
];

/** Icons for deriveAccent, as pixel runs (expanded in order, 4 bytes a pixel). */
export const DERIVE_VECTORS: readonly {
  name: string;
  note: string;
  pixels: readonly PixelRun[];
}[] = [
  {
    name: "tidewater",
    note: "Tidewater Studio's icon (UI-KITS §8): deep-sea ground, two teal waves (one at 75 % over the ground), a sand sun, transparent corners.",
    pixels: [
      [0x0b, 0x3a, 0x48, 255, 2600],
      [0x5f, 0xe3, 0xcf, 255, 700],
      [0x92, 0xc6, 0xc2, 255, 700],
      [0xf5, 0xd3, 0x8a, 255, 150],
      [0, 0, 0, 0, 96],
    ],
  },
  {
    name: "drift-kart",
    note: "Drift Kart's icon: an orange ground, a near-black kart and cream speed lines.",
    pixels: [
      [0xff, 0x5a, 0x2c, 255, 2900],
      [0x1a, 0x0b, 0x06, 255, 700],
      [0xff, 0xf3, 0xe8, 255, 300],
    ],
  },
  {
    name: "greyscale",
    note: "A greyscale icon: no cluster, so the kit falls back to ink.",
    pixels: [
      [0x20, 0x20, 0x20, 255, 3000],
      [0xe0, 0xe0, 0xe0, 255, 1000],
    ],
  },
  {
    name: "small-accent",
    note: "A vivid red under 8 % of the opaque area: too small to be the accent.",
    pixels: [
      [0x30, 0x30, 0x34, 255, 3800],
      [0xe0, 0x20, 0x20, 255, 300],
    ],
  },
  {
    name: "translucent-ignored",
    note: "A violet only at alpha 100 (not opaque) over a green: the green wins.",
    pixels: [
      [0x7a, 0x2f, 0xff, 100, 3000],
      [0x2e, 0xa0, 0x4f, 255, 1000],
    ],
  },
  {
    name: "two-clusters",
    note: "A dull blue covering most of the icon and a saturated yellow at 10 %: saturation wins.",
    pixels: [
      [0x4a, 0x5a, 0x7a, 255, 3600],
      [0xff, 0xd4, 0x00, 255, 400],
    ],
  },
  {
    name: "empty",
    note: "A fully transparent icon.",
    pixels: [[0, 0, 0, 0, 64]],
  },
];

/** Inputs for resolveAccent. `derive:` names an icon above; its derived colour is the input. */
export const RESOLVE_VECTORS: readonly { name: string; input: string }[] = [
  { name: "tidewater", input: "derive:tidewater" },
  { name: "core-violet-dark", input: BRAND.violet.dark },
  { name: "core-violet-light", input: BRAND.violet.light },
  { name: "drift-kart", input: "#ff6a3d" },
  { name: "light-teal", input: "#5fe3cf" },
  { name: "yellow", input: "#ffd400" },
  { name: "blue", input: "#0050ff" },
  { name: "pink", input: "#e91e63" },
  { name: "green", input: "#00a86b" },
  { name: "navy", input: "#1b1f3b" },
  { name: "grey", input: "#808080" },
  { name: "black", input: "#000000" },
  { name: "white", input: "#ffffff" },
  { name: "short-hex", input: "#f60" },
];
