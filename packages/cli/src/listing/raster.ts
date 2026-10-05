/**
 * The pixel operations `pkey listing assets` composes listing art with (A-18d; notes/S-15 §7.4).
 *
 * Everything here is plain integer arithmetic over 8-bit straight-alpha RGBA, on purpose: the
 * outputs are checked against golden pixel hashes, and the same inputs must give the same pixels
 * on a developer's arm64 laptop and on CI's x86_64 runner. An image library's SIMD resamplers and
 * float compositors do not promise that, so `sharp` (`io.ts`) only decodes the inputs and encodes
 * the outputs; the geometry (crop, resize, composite, blur, key) happens here.
 *
 * Resampling: a downscale is an exact area average (each source pixel weighted by the fraction of
 * it the output pixel covers), an upscale is bilinear with centre-aligned samples, both separable,
 * on premultiplied alpha so a transparent pixel's colour never bleeds into its neighbours. Weights
 * are fixed point (1/16384) and always sum to exactly one.
 */

import { createHash } from "node:crypto";

/** An 8-bit, straight-alpha RGBA image. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, row-major, R G B A. */
  readonly data: Uint8Array;
}

export type Rgba = readonly [number, number, number, number];
export type Rgb = readonly [number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SCALE = 16384;
const HALF = SCALE / 2;

export function makeRaster(width: number, height: number): Raster {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error(
      `a raster must be at least 1x1 pixels (got ${width}x${height})`,
    );
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** A canvas of one colour. */
export function fill(width: number, height: number, color: Rgba): Raster {
  const r = makeRaster(width, height);
  const d = r.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = color[0];
    d[i + 1] = color[1];
    d[i + 2] = color[2];
    d[i + 3] = color[3];
  }
  return r;
}

/** A copy of `rect` of `src` (which must lie inside it). */
export function crop(src: Raster, rect: Rect): Raster {
  const { x, y, width, height } = rect;
  if (x < 0 || y < 0 || x + width > src.width || y + height > src.height)
    throw new Error(
      `crop ${width}x${height}+${x}+${y} is outside the ${src.width}x${src.height} image`,
    );
  const out = makeRaster(width, height);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * src.width + x) * 4;
    out.data.set(src.data.subarray(from, from + width * 4), row * width * 4);
  }
  return out;
}

interface Taps {
  /** First source index of each output index. */
  start: Int32Array;
  /** Number of source taps of each output index. */
  count: Int32Array;
  /** Offset into `weight` of each output index's first tap. */
  offset: Int32Array;
  /** Fixed-point weights (sum 16384 per output index). */
  weight: Int32Array;
}

/** The fixed-point taps that map `srcN` samples onto `dstN`. */
function taps(srcN: number, dstN: number): Taps {
  const start = new Int32Array(dstN);
  const count = new Int32Array(dstN);
  const offset = new Int32Array(dstN);
  const weights: number[] = [];
  for (let i = 0; i < dstN; i++) {
    const ws: number[] = [];
    let first: number;
    if (dstN <= srcN) {
      // Area average, in units of 1/dstN of a source pixel: output i covers
      // [i*srcN, (i+1)*srcN), source pixel j covers [j*dstN, (j+1)*dstN).
      const lo = i * srcN;
      const hi = (i + 1) * srcN;
      first = Math.floor(lo / dstN);
      const last = Math.ceil(hi / dstN) - 1;
      for (let j = first; j <= last; j++) {
        const overlap = Math.min(hi, (j + 1) * dstN) - Math.max(lo, j * dstN);
        ws.push(Math.floor((overlap * SCALE * 2 + srcN) / (2 * srcN)));
      }
    } else {
      // Bilinear, centre-aligned: x = ((2i+1)*srcN - dstN) / (2*dstN).
      const den = 2 * dstN;
      const num = (2 * i + 1) * srcN - dstN;
      if (num <= 0) {
        first = 0;
        ws.push(SCALE);
      } else {
        first = Math.floor(num / den);
        const frac = num - first * den;
        const w1 = Math.floor((frac * SCALE * 2 + den) / (2 * den));
        if (first + 1 >= srcN || w1 === 0) ws.push(SCALE);
        else ws.push(SCALE - w1, w1);
      }
    }
    // The weights must sum to exactly one: the rounding remainder goes to the largest tap.
    const sum = ws.reduce((a, b) => a + b, 0);
    if (sum !== SCALE) {
      let big = 0;
      for (let k = 1; k < ws.length; k++) if (ws[k]! > ws[big]!) big = k;
      ws[big] = ws[big]! + (SCALE - sum);
    }
    start[i] = first;
    count[i] = ws.length;
    offset[i] = weights.length;
    weights.push(...ws);
  }
  return { start, count, offset, weight: Int32Array.from(weights) };
}

/**
 * `src` resampled to `width` x `height` (any aspect; callers crop first to keep it). An unchanged
 * size answers a copy.
 */
export function resize(src: Raster, width: number, height: number): Raster {
  if (width === src.width && height === src.height)
    return { width, height, data: src.data.slice() };
  const sw = src.width;
  const sh = src.height;
  // Premultiplied planes: colour c*a (0..65025), alpha a*255 (0..65025).
  const pre = new Uint32Array(sw * sh * 4);
  const s = src.data;
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3]!;
    pre[i] = s[i]! * a;
    pre[i + 1] = s[i + 1]! * a;
    pre[i + 2] = s[i + 2]! * a;
    pre[i + 3] = a * 255;
  }
  // Horizontal pass: sw x sh -> width x sh.
  const hx = taps(sw, width);
  const mid = new Uint32Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    const rowIn = y * sw * 4;
    const rowOut = y * width * 4;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const n = hx.count[x]!;
      const o = hx.offset[x]!;
      let p = rowIn + hx.start[x]! * 4;
      for (let k = 0; k < n; k++, p += 4) {
        const w = hx.weight[o + k]!;
        r += pre[p]! * w;
        g += pre[p + 1]! * w;
        b += pre[p + 2]! * w;
        a += pre[p + 3]! * w;
      }
      const q = rowOut + x * 4;
      mid[q] = Math.floor((r + HALF) / SCALE);
      mid[q + 1] = Math.floor((g + HALF) / SCALE);
      mid[q + 2] = Math.floor((b + HALF) / SCALE);
      mid[q + 3] = Math.floor((a + HALF) / SCALE);
    }
  }
  // Vertical pass: width x sh -> width x height, then un-premultiply.
  const vy = taps(sh, height);
  const out = makeRaster(width, height);
  const d = out.data;
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const n = vy.count[y]!;
    const o = vy.offset[y]!;
    const first = vy.start[y]! * stride;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let p = first + x * 4;
      for (let k = 0; k < n; k++, p += stride) {
        const w = vy.weight[o + k]!;
        r += mid[p]! * w;
        g += mid[p + 1]! * w;
        b += mid[p + 2]! * w;
        a += mid[p + 3]! * w;
      }
      r = Math.floor((r + HALF) / SCALE);
      g = Math.floor((g + HALF) / SCALE);
      b = Math.floor((b + HALF) / SCALE);
      a = Math.floor((a + HALF) / SCALE);
      const q = (y * width + x) * 4;
      if (a === 0) {
        d[q] = d[q + 1] = d[q + 2] = d[q + 3] = 0;
        continue;
      }
      d[q] = Math.min(255, Math.floor((r * 510 + a) / (2 * a)));
      d[q + 1] = Math.min(255, Math.floor((g * 510 + a) / (2 * a)));
      d[q + 2] = Math.min(255, Math.floor((b * 510 + a) / (2 * a)));
      d[q + 3] = Math.min(255, Math.floor((2 * a + 255) / 510));
    }
  }
  return out;
}

/** `top` drawn over `base` at (`x`, `y`), source-over, clipped to `base`. Mutates `base`. */
export function composite(
  base: Raster,
  top: Raster,
  x: number,
  y: number,
): Raster {
  const bd = base.data;
  const td = top.data;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(base.width, x + top.width);
  const y1 = Math.min(base.height, y + top.height);
  for (let by = y0; by < y1; by++) {
    for (let bx = x0; bx < x1; bx++) {
      const t = ((by - y) * top.width + (bx - x)) * 4;
      const sa = td[t + 3]!;
      if (sa === 0) continue;
      const b = (by * base.width + bx) * 4;
      if (sa === 255) {
        bd[b] = td[t]!;
        bd[b + 1] = td[t + 1]!;
        bd[b + 2] = td[t + 2]!;
        bd[b + 3] = 255;
        continue;
      }
      const da = bd[b + 3]!;
      const keep = da * (255 - sa); // destination share, in 255^2 units
      const outA = sa * 255 + keep;
      for (let c = 0; c < 3; c++) {
        const num = td[t + c]! * sa * 255 + bd[b + c]! * keep;
        bd[b + c] = Math.floor((num * 2 + outA) / (2 * outA));
      }
      bd[b + 3] = Math.floor((outA * 2 + 255) / 510);
    }
  }
  return base;
}

/** `src` over an opaque colour: every pixel opaque. */
export function flatten(src: Raster, color: Rgb): Raster {
  return composite(
    fill(src.width, src.height, [color[0], color[1], color[2], 255]),
    src,
    0,
    0,
  );
}

/** True when any pixel is not fully opaque. */
export function hasTransparency(src: Raster): boolean {
  const d = src.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** Three passes of a box blur of `radius` (an approximate Gaussian), edges clamped. */
export function blur(src: Raster, radius: number): Raster {
  let cur = src;
  for (let pass = 0; pass < 3; pass++) {
    cur = boxPass(boxPass(cur, radius, true), radius, false);
  }
  return cur;
}

function boxPass(src: Raster, radius: number, horizontal: boolean): Raster {
  const { width, height } = src;
  const out = makeRaster(width, height);
  const n = radius * 2 + 1;
  const len = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const step = horizontal ? 4 : width * 4;
  const s = src.data;
  const d = out.data;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const i = Math.min(len - 1, Math.max(0, k));
        sum += s[base + i * step + c]!;
      }
      for (let i = 0; i < len; i++) {
        d[base + i * step + c] = Math.floor((sum * 2 + n) / (2 * n));
        const add = Math.min(len - 1, i + radius + 1);
        const drop = Math.max(0, i - radius);
        sum += s[base + add * step + c]! - s[base + drop * step + c]!;
      }
    }
  }
  return out;
}

/** The bounding box of the pixels `keep` selects, or `null` when none does. */
export function boundingBox(
  src: Raster,
  keep: (d: Uint8Array, i: number) => boolean,
): Rect | null {
  let minX = src.width;
  let minY = src.height;
  let maxX = -1;
  let maxY = -1;
  const d = src.data;
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      if (!keep(d, (y * src.width + x) * 4)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  return maxX < 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The largest difference of any channel (alpha included) from `color`. */
export function colorDistance(d: Uint8Array, i: number, color: Rgba): number {
  return Math.max(
    Math.abs(d[i]! - color[0]),
    Math.abs(d[i + 1]! - color[1]),
    Math.abs(d[i + 2]! - color[2]),
    Math.abs(d[i + 3]! - color[3]),
  );
}

export function pixelAt(src: Raster, x: number, y: number): Rgba {
  const i = (y * src.width + x) * 4;
  const d = src.data;
  return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

/** `round(a * b / c)` in integers. */
export function mulDiv(a: number, b: number, c: number): number {
  return Math.floor((2 * a * b + c) / (2 * c));
}

/** The size of `w` x `h` scaled to fit inside `boxW` x `boxH`, aspect kept. */
export function containSize(
  w: number,
  h: number,
  boxW: number,
  boxH: number,
): { width: number; height: number } {
  if (w * boxH >= h * boxW)
    return { width: boxW, height: Math.max(1, mulDiv(h, boxW, w)) };
  return { width: Math.max(1, mulDiv(w, boxH, h)), height: boxH };
}

/**
 * The largest `ratioW:ratioH` rectangle inside `w` x `h`, centred on the focal point (fractions of
 * the image, 0..1) and pushed back inside the image where it would cross an edge.
 */
export function coverRect(
  w: number,
  h: number,
  ratioW: number,
  ratioH: number,
  focal: { x: number; y: number },
): Rect {
  let cw: number;
  let ch: number;
  if (w * ratioH > h * ratioW) {
    ch = h;
    cw = Math.min(w, Math.max(1, mulDiv(h, ratioW, ratioH)));
  } else {
    cw = w;
    ch = Math.min(h, Math.max(1, mulDiv(w, ratioH, ratioW)));
  }
  const x = Math.min(w - cw, Math.max(0, Math.round(focal.x * w - cw / 2)));
  const y = Math.min(h - ch, Math.max(0, Math.round(focal.y * h - ch / 2)));
  return { x, y, width: cw, height: ch };
}

/** The raster's pixels as RGB (`3`, alpha dropped: callers flatten first) or RGBA (`4`). */
export function channels(src: Raster, n: 3 | 4): Uint8Array {
  if (n === 4) return src.data;
  const out = new Uint8Array(src.width * src.height * 3);
  const d = src.data;
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    out[j] = d[i]!;
    out[j + 1] = d[i + 1]!;
    out[j + 2] = d[i + 2]!;
  }
  return out;
}

/**
 * The golden-image hash: SHA-256 over a `pkey-pixels/1 <w>x<h>x<channels>` line and the raw
 * pixels, so it pins the pixels an output encodes, whatever the encoder's bytes.
 */
export function pixelSha256(
  width: number,
  height: number,
  n: 3 | 4,
  pixels: Uint8Array,
): string {
  return createHash("sha256")
    .update(`pkey-pixels/1 ${width}x${height}x${n}\n`)
    .update(pixels)
    .digest("hex");
}
