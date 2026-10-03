// Section-bit legibility proofs (committed PNGs under preview/proofs/).
//
//   pnpm --filter @polaris-key/brand proofs
//
// The console header colours the K's terminal bit by section (docs/design/BRAND.md, "The section
// bit"). The kit allows the bit only at a rendered glyph of >= 48 px. These sheets show every
// section's bit at 32, 40 and 48 CSS px, at 1x and 2x, on the header ground of each theme, plus an
// 8x nearest-neighbour magnification of the 1x pixels, so the minimum can be judged on real
// rasters. 32 px is drawn twice: the kit-correct service cut (which has no bit) and, for
// comparison only, the display master forced down to 32 px with its bit. Core (the platform) has
// no bit at all (owner decision 2026-10-03), so its row shows the bare K in every column.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type OverlayOptions } from "sharp";

import { GEOMETRY } from "../src/generated/geometry.js";
import { SERVICE_ACCENTS } from "../src/generated/tokens.js";
import { markSvg } from "../src/marks/svg.js";
import { BRAND } from "../src/tokens/primitives.js";
import {
  SERVICE_IDS,
  SERVICE_LABEL,
  type Theme,
} from "../src/tokens/source.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, "preview", "proofs");

/**
 * The display master at any size with a coloured bit, or none for `null` (bypasses the size rule,
 * for proofs only).
 */
function forcedDisplay(size: number, theme: Theme, bit: string | null): string {
  const [grid, parts] = GEOMETRY.key.display;
  const fill = (role: string) =>
    role === "gold"
      ? bit
      : role === "star"
        ? BRAND.star[theme]
        : BRAND.violet[theme];
  const paths = parts
    .filter(([role]) => role !== "gold" || bit !== null)
    .map(([role, d]) => `<path d="${d}" fill="${fill(role)}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${grid} ${grid}">${paths}</svg>`;
}

async function raster(svg: string, scale: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 72 * scale })
    .png()
    .toBuffer();
}

const COLS: {
  label: string;
  size: number;
  svg: (t: Theme, id: (typeof SERVICE_IDS)[number]) => string;
}[] = [
  {
    label: "32 service cut (kit)",
    size: 32,
    svg: (t) => markSvg({ size: 32, theme: t }),
  },
  {
    label: "32 display + bit (not allowed)",
    size: 32,
    svg: (t, id) => forcedDisplay(32, t, SERVICE_ACCENTS[t][id].bit),
  },
  {
    label: "40 display + bit (not allowed)",
    size: 40,
    svg: (t, id) => forcedDisplay(40, t, SERVICE_ACCENTS[t][id].bit),
  },
  {
    label: "48 display + bit",
    size: 48,
    svg: (t, id) => markSvg({ size: 48, theme: t, bit: id }),
  },
];

async function sheet(theme: Theme): Promise<Buffer> {
  const ground = BRAND.page[theme];
  const ink = theme === "dark" ? "#dbe4ff" : "#262d40";
  const labelW = 130;
  const headerH = 40;
  const rowH = 410;
  // Each column: the 1x and 2x renders stacked in a 110 px strip, then the 8x magnification.
  const colW = COLS.map((c) => 110 + c.size * 8 + 30);
  const colX = colW.map(
    (_, i) => labelW + colW.slice(0, i).reduce((a, b) => a + b, 0),
  );
  const width = labelW + colW.reduce((a, b) => a + b, 0);
  const height = headerH + SERVICE_IDS.length * rowH;
  const composites: OverlayOptions[] = [];
  const texts: string[] = [];
  COLS.forEach((col, ci) => {
    const x = colX[ci]!;
    texts.push(
      `<text x="${x + 6}" y="24" font-family="Rubik, Helvetica, Arial, sans-serif" font-size="13" fill="${ink}">${col.label}: 1x · 2x · 8x of 1x</text>`,
    );
  });
  for (const [ri, id] of SERVICE_IDS.entries()) {
    const y = headerH + ri * rowH;
    texts.push(
      `<text x="10" y="${y + 40}" font-family="Rubik, Helvetica, Arial, sans-serif" font-size="14" font-weight="700" fill="${ink}">${SERVICE_LABEL[id]}</text>`,
      `<text x="10" y="${y + 60}" font-family="Rubik, Helvetica, Arial, sans-serif" font-size="12" fill="${ink}">${SERVICE_ACCENTS[theme][id].bit ?? "no bit"}</text>`,
    );
    for (const [ci, col] of COLS.entries()) {
      const x = colX[ci]!;
      const svg = col.svg(theme, id);
      const one = await raster(svg, 1);
      const two = await raster(svg, 2);
      const eight = await sharp(one)
        .resize(col.size * 8, col.size * 8, { kernel: "nearest" })
        .png()
        .toBuffer();
      composites.push({ input: one, left: x + 8, top: y + 20 });
      composites.push({ input: two, left: x + 8, top: y + 80 });
      composites.push({ input: eight, left: x + 110, top: y + 8 });
    }
  }
  const labels = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${texts.join("")}</svg>`,
  );
  composites.unshift({
    input: await sharp(labels).png().toBuffer(),
    left: 0,
    top: 0,
  });
  return sharp({ create: { width, height, channels: 4, background: ground } })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

mkdirSync(OUT, { recursive: true });
for (const theme of ["dark", "light"] as const) {
  const path = join(OUT, `section-bit-${theme}.png`);
  writeFileSync(path, await sheet(theme));
  console.log(`wrote ${path}`);
}
