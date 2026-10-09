#!/usr/bin/env node
/**
 * Derives the baked `pkey` logo (`src/logo.ts`) from the brand key mark's display-cut path data
 * (`packages/brand/kit/source/geometry.json`): the outline at one dot, the body's interior as a
 * 4x4 Bayer dither whose density rises from the spine to the blade tip, the star solid; 2x4
 * braille, 22 cells wide, 10 rows. Constants are baked, never computed at runtime; the drift test
 * (`test/logo.test.ts`) calls `renderLogo` on the current geometry and compares.
 *
 *   node packages/cli/scripts/gen-logo.mjs          # prints the constants for src/logo.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LOGO_COLS = 22;
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
/** [dx, dy, bit] of a braille cell's eight dots. */
const DOTS = [
  [0, 0, 1],
  [0, 1, 2],
  [0, 2, 4],
  [1, 0, 8],
  [1, 1, 16],
  [1, 2, 32],
  [0, 3, 64],
  [1, 3, 128],
];

/** A path of M, L, Q and Z commands as a polygon (each curve in six segments). */
function polygon(d) {
  const t = d.match(/[MLQZ]|-?[\d.]+/g);
  const pts = [];
  let i = 0;
  let cur = [0, 0];
  while (i < t.length) {
    const c = t[i++];
    if (c === "M" || c === "L") {
      cur = [+t[i++], +t[i++]];
      pts.push(cur);
    } else if (c === "Q") {
      const cx = +t[i++];
      const cy = +t[i++];
      const x = +t[i++];
      const y = +t[i++];
      for (let k = 1; k <= 6; k++) {
        const u = k / 6;
        pts.push([
          (1 - u) ** 2 * cur[0] + 2 * (1 - u) * u * cx + u * u * x,
          (1 - u) ** 2 * cur[1] + 2 * (1 - u) * u * cy + u * u * y,
        ]);
      }
      cur = [x, y];
    }
  }
  return pts;
}

function inside(p, x, y) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [a, b] = p[i];
    const [e, f] = p[j];
    if (b > y !== f > y && x < ((e - a) * (y - b)) / (f - b) + a) c = !c;
  }
  return c;
}

/**
 * `geometry` is the parsed geometry.json. Returns `{ art, star }`: ten rows of 22 characters
 * each (braille, U+0020 for an empty cell, trailing blanks trimmed) and ten rows of 22 `1`/`0`
 * flags, `1` where any lit dot belongs to the star.
 */
export function renderLogo(geometry) {
  const [grid, parts] = geometry.key.display;
  const polys = { body: [], star: [] };
  for (const [role, d] of parts)
    if (role in polys) polys[role].push(polygon(d));
  const px = LOGO_COLS * 2;
  const rows = Math.ceil(px / 4);
  const u = grid / px;
  const kindOf = (x, y) => {
    for (const k of ["star", "body"])
      if (polys[k].some((p) => inside(p, x * u + u / 2, y * u + u / 2)))
        return k;
    return null;
  };
  const edge = (x, y, k) =>
    ![
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].every(([a, b]) => kindOf(x + a, y + b) === k);
  const lit = (x, y) => {
    const k = kindOf(x, y);
    if (!k) return null;
    if (k === "star" || edge(x, y, k)) return k;
    const d = (x / px) * 0.9 + 0.05;
    return BAYER[y % 4][x % 4] / 16 < d * 0.7 ? k : null;
  };
  const art = [];
  const star = [];
  for (let r = 0; r < rows; r++) {
    let a = "";
    let s = "";
    for (let c = 0; c < LOGO_COLS; c++) {
      let m = 0;
      let isStar = false;
      for (const [dx, dy, bit] of DOTS) {
        const k = lit(c * 2 + dx, r * 4 + dy);
        if (k) m |= bit;
        if (k === "star") isStar = true;
      }
      a += m ? String.fromCharCode(0x2800 + m) : " ";
      s += isStar ? "1" : "0";
    }
    art.push(a.trimEnd());
    star.push(s);
  }
  while (art.length && art[art.length - 1] === "") {
    art.pop();
    star.pop();
  }
  return { art, star };
}

export function readGeometry() {
  return JSON.parse(
    readFileSync(
      new URL("../../brand/kit/source/geometry.json", import.meta.url),
      "utf8",
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { art, star } = renderLogo(readGeometry());
  console.log(`const ART = ${JSON.stringify(art, null, 2)};`);
  console.log(`const STAR = ${JSON.stringify(star, null, 2)};`);
}
