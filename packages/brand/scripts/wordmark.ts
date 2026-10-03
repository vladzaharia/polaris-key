// Outline a wordmark from the bundled Rubik binary, the way the launch kit outlined its own.
//
// The kit's wordmarks ("Polaris Key", "Polaris Key Update") are Rubik Bold glyphs converted to
// SVG paths: each glyph is one <path> in font units (1000 per em, y up), placed at its pen
// position with `translate(x 0)` inside a group scaled by `scale(s -s)`. The path strings are
// what fontTools' SVGPathPen writes for a TrueType glyph (Python str() numbers: integer points as
// `660`, implied quadratic midpoints as `586.5` or `291.0`; `H` / `V` for axis-aligned lines),
// except that every other line is an explicit `L`. The pen advances by each glyph's advance
// width: no tracking, no kerning.
//
// This module reads the TrueType tables it needs (cmap, hmtx, loca, glyf) with no dependency,
// reproduces that output, and `verifyKitWordmarks` proves it: the generator re-outlines every
// kit lockup's text and requires the kit's bytes before it writes anything new. So a wordmark
// made here (the Delivery lockups) is the kit's construction, not an approximation of it.

import { readFileSync } from "node:fs";

export interface Font {
  unitsPerEm: number;
  /** Advance width of a glyph, in font units. */
  advance(gid: number): number;
  /** Glyph id for a code point (0 = .notdef). */
  glyphId(codePoint: number): number;
  /** The glyph's outline as an SVGPathPen path string ("" for an empty glyph). */
  path(gid: number): string;
}

export function loadFont(file: string): Font {
  const buf = readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => dv.getUint16(o);
  const i16 = (o: number) => dv.getInt16(o);
  const u32 = (o: number) => dv.getUint32(o);

  const tables = new Map<string, number>();
  const numTables = u16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(
      buf[rec]!,
      buf[rec + 1]!,
      buf[rec + 2]!,
      buf[rec + 3]!,
    );
    tables.set(tag, u32(rec + 8));
  }
  const table = (tag: string) => {
    const o = tables.get(tag);
    if (o === undefined) throw new Error(`font: no ${tag} table`);
    return o;
  };

  const head = table("head");
  const unitsPerEm = u16(head + 18);
  const longLoca = i16(head + 50) === 1;
  const numGlyphs = u16(table("maxp") + 4);
  const numHMetrics = u16(table("hhea") + 34);
  const hmtx = table("hmtx");
  const loca = table("loca");
  const glyf = table("glyf");

  const advance = (gid: number) =>
    u16(hmtx + 4 * Math.min(gid, numHMetrics - 1));

  const glyphOffset = (gid: number): [number, number] => {
    if (gid < 0 || gid >= numGlyphs) throw new Error(`font: glyph ${gid}`);
    return longLoca
      ? [u32(loca + gid * 4), u32(loca + gid * 4 + 4)]
      : [u16(loca + gid * 2) * 2, u16(loca + gid * 2 + 2) * 2];
  };

  // cmap: a Unicode BMP subtable, format 4.
  const cmap = table("cmap");
  let sub = -1;
  for (let i = 0; i < u16(cmap + 2); i++) {
    const rec = cmap + 4 + i * 8;
    const platform = u16(rec);
    const encoding = u16(rec + 2);
    const off = cmap + u32(rec + 4);
    if (
      u16(off) === 4 &&
      (platform === 0 || (platform === 3 && encoding === 1))
    ) {
      sub = off;
      break;
    }
  }
  if (sub < 0) throw new Error("font: no format-4 Unicode cmap");
  const segX2 = u16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  const glyphId = (cp: number): number => {
    for (let s = 0; s < segX2; s += 2) {
      if (u16(ends + s) < cp) continue;
      const start = u16(starts + s);
      if (start > cp) return 0;
      const delta = i16(deltas + s);
      const ro = u16(ranges + s);
      if (ro === 0) return (cp + delta) & 0xffff;
      const g = u16(ranges + s + ro + (cp - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  /** A glyph's contours: each a list of [x, y, onCurve]. Composites are flattened. */
  const contours = (gid: number): [number, number, boolean][][] => {
    const [start, end] = glyphOffset(gid);
    if (end === start) return [];
    const g = glyf + start;
    const n = i16(g);
    if (n < 0) {
      // Composite: offsets only (ARGS_ARE_XY_VALUES, no scale), which is all Rubik's Latin uses.
      const out: [number, number, boolean][][] = [];
      let p = g + 10;
      for (;;) {
        const flags = u16(p);
        const child = u16(p + 2);
        p += 4;
        let dx: number;
        let dy: number;
        if (flags & 0x0001) {
          dx = i16(p);
          dy = i16(p + 2);
          p += 4;
        } else {
          dx = dv.getInt8(p);
          dy = dv.getInt8(p + 1);
          p += 2;
        }
        if (!(flags & 0x0002))
          throw new Error(`font: glyph ${gid} uses point-matched components`);
        if (flags & (0x0008 | 0x0040 | 0x0080))
          throw new Error(`font: glyph ${gid} uses scaled components`);
        for (const c of contours(child))
          out.push(c.map(([x, y, on]) => [x + dx, y + dy, on]));
        if (!(flags & 0x0020)) break;
      }
      return out;
    }
    const endPts: number[] = [];
    for (let i = 0; i < n; i++) endPts.push(u16(g + 10 + i * 2));
    const count = n === 0 ? 0 : endPts[n - 1]! + 1;
    let p = g + 10 + n * 2;
    p += 2 + u16(p); // instructions
    const flags: number[] = [];
    while (flags.length < count) {
      const f = buf[p++]!;
      flags.push(f);
      if (f & 0x08) {
        const repeat = buf[p++]!;
        for (let r = 0; r < repeat; r++) flags.push(f);
      }
    }
    const coord = (short: number, same: number) => {
      const out: number[] = [];
      let v = 0;
      for (const f of flags) {
        if (f & short) {
          const d = buf[p++]!;
          v += f & same ? d : -d;
        } else if (!(f & same)) {
          v += i16(p);
          p += 2;
        }
        out.push(v);
      }
      return out;
    };
    const xs = coord(0x02, 0x10);
    const ys = coord(0x04, 0x20);
    const out: [number, number, boolean][][] = [];
    let s = 0;
    for (const e of endPts) {
      const c: [number, number, boolean][] = [];
      for (let i = s; i <= e; i++) c.push([xs[i]!, ys[i]!, !!(flags[i]! & 1)]);
      out.push(c);
      s = e + 1;
    }
    return out;
  };

  return {
    unitsPerEm,
    advance,
    glyphId,
    path: (gid) => svgPath(contours(gid)),
  };
}

// ── fontTools' SVGPathPen, for TrueType contours ────────────────────────────────────────────

/** A coordinate as Python's str(): ints bare, floats always with a fraction. */
type Num = { v: number; float: boolean };
const pyStr = ({ v, float }: Num) =>
  float && Number.isInteger(v) ? `${v}.0` : String(v);
const int = (v: number): Num => ({ v, float: false });
const mid = (a: Num, b: Num): Num => ({ v: 0.5 * (a.v + b.v), float: true });

type Pt = [Num, Num];

/**
 * fontTools `Glyph.draw` (glyf) feeding `SVGPathPen(None, ntos=str)` through `BasePen`: rotate
 * each contour to end on its first on-curve point, `moveTo` it, then `lineTo` / `qCurveTo` (the
 * latter decomposed with implied midpoints), skipping the closing `lineTo`, then `Z`. Lines are
 * `H`, `V` or an explicit `L` (the kit never uses SVG's implicit lineto).
 */
function svgPath(contours: [number, number, boolean][][]): string {
  const cmds: string[] = [];
  let last: string | null = null;
  let lx: number | null = null;
  let ly: number | null = null;
  const pt = (p: Pt) => `${pyStr(p[0])} ${pyStr(p[1])}`;

  const moveTo = (p: Pt) => {
    if (last === "M") cmds.pop();
    cmds.push(`M${pt(p)}`);
    last = "M";
    lx = p[0].v;
    ly = p[1].v;
  };
  const lineTo = (p: Pt) => {
    const [x, y] = [p[0].v, p[1].v];
    if (x === lx && y === ly) return;
    let cmd: string;
    let s: string;
    if (x === lx) {
      cmd = "V";
      s = pyStr(p[1]);
    } else if (y === ly) {
      cmd = "H";
      s = pyStr(p[0]);
    } else {
      cmd = "L";
      s = pt(p);
    }
    last = cmd;
    cmds.push(cmd + s);
    lx = x;
    ly = y;
  };
  const qCurveTo = (pts: Pt[]) => {
    for (let i = 0; i < pts.length - 2; i++) {
      const implied: Pt = [
        mid(pts[i]![0], pts[i + 1]![0]),
        mid(pts[i]![1], pts[i + 1]![1]),
      ];
      quad(pts[i]!, implied);
    }
    quad(pts[pts.length - 2]!, pts[pts.length - 1]!);
  };
  const quad = (c: Pt, p: Pt) => {
    cmds.push(`Q${pt(c)} ${pt(p)}`);
    last = "Q";
    lx = p[0].v;
    ly = p[1].v;
  };

  for (const contour of contours) {
    let pts: Pt[] = contour.map(([x, y]) => [int(x), int(y)]);
    let on = contour.map(([, , o]) => o);
    if (!on.includes(true)) {
      // All off-curve: start from the implied midpoint of the last and first points.
      const a = pts[pts.length - 1]!;
      const b = pts[0]!;
      const start: Pt = [mid(a[0], b[0]), mid(a[1], b[1])];
      moveTo(start);
      qCurveTo([...pts, start]);
    } else {
      const first = on.indexOf(true) + 1;
      pts = [...pts.slice(first), ...pts.slice(0, first)];
      on = [...on.slice(first), ...on.slice(0, first)];
      moveTo(pts[pts.length - 1]!);
      while (pts.length > 0) {
        const next = on.indexOf(true) + 1;
        if (next === 1) {
          if (pts.length > 1) lineTo(pts[0]!);
        } else qCurveTo(pts.slice(0, next));
        pts = pts.slice(next);
        on = on.slice(next);
      }
    }
    cmds.push("Z");
    last = "Z";
    lx = ly = null;
  }
  return cmds.join("");
}

// ── Setting a line ──────────────────────────────────────────────────────────────────────────

/** The kit's tracking, in font units: none (each glyph starts at the previous advance). */
export const KIT_TRACKING = 0;

export interface SetGlyph {
  x: number;
  d: string;
}

/**
 * Set `text` as the kit does: one path per character at its pen position (a space is an empty
 * `d=""`, as in the kit's files), plus the line's advance width.
 */
export function setLine(
  font: Font,
  text: string,
  tracking = KIT_TRACKING,
): { glyphs: SetGlyph[]; advance: number } {
  const glyphs: SetGlyph[] = [];
  let x = 0;
  let advance = 0;
  for (const ch of text) {
    const gid = font.glyphId(ch.codePointAt(0)!);
    if (gid === 0) throw new Error(`font: no glyph for ${JSON.stringify(ch)}`);
    glyphs.push({ x, d: font.path(gid) });
    advance = x + font.advance(gid);
    x = advance + tracking;
  }
  return { glyphs, advance };
}

/** The wordmark group's inner paths, in the kit's exact markup. */
export function glyphPaths(glyphs: SetGlyph[]): string {
  return glyphs
    .map((g) => `<path transform="translate(${g.x} 0)" d="${g.d}"/>`)
    .join("");
}
