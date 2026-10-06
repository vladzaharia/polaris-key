// A QR code encoder (SDK parity pass §3.12, `identity.devicecode`'s QR): ISO/IEC 18004, byte mode,
// error-correction level M, versions 1-10 (up to 213 bytes, enough for a device-code
// `verificationUriComplete`). All eight masks are scored by the standard's penalty rules and the
// lowest wins, so the output is deterministic.
//
// The same encoder the Worker's download page uses (packages/worker/src/services/distribution/page/
// qr.ts), itself a port of the Godot addon's (`sdks/godot/addons/polaris_key/ui/qr/qr_encoder.gd`);
// all three are held to the same reference fixtures (`sdks/godot/tests/qr/fixtures.json`, Nayuki's
// qrcodegen 1.8.0). No dependency, no I/O.

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 10;

/** Per version (index 0 unused), level M: [EC codewords per block, blocks in group 1, data
 *  codewords per group-1 block, blocks in group 2, data codewords per group-2 block]. */
const BLOCKS: readonly (readonly number[])[] = [
  [],
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

/** Alignment-pattern centre coordinates per version. */
const ALIGN: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

/** The format-information bits for error-correction level M. */
const ECL_M_BITS = 0;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  // GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

/** A finished symbol: `size` x `size` modules, row-major, 1 = dark. */
export interface QrCode {
  version: number;
  mask: number;
  size: number;
  modules: Uint8Array;
}

/** How many bytes version `v` holds at level M in byte mode. */
export function qrCapacity(v: number): number {
  return Math.floor((dataCodewords(v) * 8 - 4 - countBits(v)) / 8);
}

function countBits(v: number): number {
  return v <= 9 ? 8 : 16;
}

function dataCodewords(v: number): number {
  const b = BLOCKS[v]!;
  return b[1]! * b[2]! + b[3]! * b[4]!;
}

/**
 * The QR code for `text` (UTF-8, byte mode, level M): the smallest version from `minVersion`
 * that fits, the best-scoring mask unless `mask` (0-7) is forced. `null` when the text does not
 * fit version 10 (213 bytes) or an argument is out of range.
 */
export function encodeQr(
  text: string,
  minVersion = QR_MIN_VERSION,
  mask = -1,
): QrCode | null {
  return encodeQrBytes(new TextEncoder().encode(text), minVersion, mask);
}

export function encodeQrBytes(
  data: Uint8Array,
  minVersion = QR_MIN_VERSION,
  mask = -1,
): QrCode | null {
  if (
    !Number.isInteger(minVersion) ||
    minVersion < QR_MIN_VERSION ||
    minVersion > QR_MAX_VERSION ||
    !Number.isInteger(mask) ||
    mask < -1 ||
    mask > 7
  )
    return null;
  let version = -1;
  for (let v = minVersion; v <= QR_MAX_VERSION; v++) {
    if (data.length <= qrCapacity(v)) {
      version = v;
      break;
    }
  }
  if (version < 0) return null;
  const codewords = buildCodewords(data, version);
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const fn = new Uint8Array(size * size);
  drawFunctionPatterns(modules, fn, size, version);
  drawCodewords(modules, fn, size, codewords);
  let chosen = mask;
  if (chosen < 0) {
    let best = -1;
    for (let m = 0; m < 8; m++) {
      applyMask(modules, fn, size, m);
      drawFormat(modules, fn, size, m);
      const p = qrPenalty(modules, size);
      if (best < 0 || p < best) {
        best = p;
        chosen = m;
      }
      applyMask(modules, fn, size, m); // XOR again: undo
    }
  }
  applyMask(modules, fn, size, chosen);
  drawFormat(modules, fn, size, chosen);
  return { version, mask: chosen, size, modules };
}

// ── Data: bit stream, blocks, Reed-Solomon, interleave ──────────────────────────────────────

function buildCodewords(data: Uint8Array, version: number): Uint8Array {
  const bits: number[] = [];
  const append = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(data.length, countBits(version));
  for (const byte of data) append(byte, 8);
  const capacityBits = dataCodewords(version) * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  const stream: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    stream.push(b);
  }
  let pad = 0xec;
  while (stream.length < dataCodewords(version)) {
    stream.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }

  const spec = BLOCKS[version]!;
  const ecLen = spec[0]!;
  const generator = rsGenerator(ecLen);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (let group = 0; group < 2; group++) {
    const count = spec[1 + group * 2]!;
    const length = spec[2 + group * 2]!;
    for (let k = 0; k < count; k++) {
      const block = stream.slice(at, at + length);
      at += length;
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, generator));
    }
  }
  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++)
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  for (let i = 0; i < ecLen; i++)
    for (const block of ecBlocks) out.push(block[i]!);
  return Uint8Array.from(out);
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The monic generator polynomial of `degree`, highest coefficient first, leading 1 dropped. */
function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!;
      next[j + 1] = next[j + 1]! ^ mul(g[j]!, EXP[i]!);
    }
    g = next;
  }
  return g.slice(1);
}

function rsRemainder(data: readonly number[], generator: number[]): number[] {
  const rem = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    for (let i = 0; i < rem.length - 1; i++)
      rem[i] = rem[i + 1]! ^ mul(generator[i]!, factor);
    rem[rem.length - 1] = mul(generator[generator.length - 1]!, factor);
  }
  return rem;
}

// ── Function patterns ────────────────────────────────────────────────────────────────────────

function setFn(
  modules: Uint8Array,
  fn: Uint8Array,
  size: number,
  x: number,
  y: number,
  dark: boolean,
): void {
  modules[y * size + x] = dark ? 1 : 0;
  fn[y * size + x] = 1;
}

function drawFunctionPatterns(
  modules: Uint8Array,
  fn: Uint8Array,
  size: number,
  version: number,
): void {
  for (let i = 0; i < size; i++) {
    setFn(modules, fn, size, 6, i, i % 2 === 0);
    setFn(modules, fn, size, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(modules, fn, size, xx, yy, dist !== 2 && dist !== 4);
        }
      }
  }
  const align = ALIGN[version]!;
  const last = align.length - 1;
  for (let i = 0; i < align.length; i++)
    for (let j = 0; j < align.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0)
      )
        continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          setFn(
            modules,
            fn,
            size,
            align[i]! + dx,
            align[j]! + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
    }
  drawFormat(modules, fn, size, 0); // reserves the area; redrawn after masking
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(modules, fn, size, a, b, dark);
      setFn(modules, fn, size, b, a, dark);
    }
  }
}

/** Both copies of the 15 format bits (level M, `mask`) and the dark module. */
function drawFormat(
  modules: Uint8Array,
  fn: Uint8Array,
  size: number,
  mask: number,
): void {
  const data = (ECL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i < 6; i++) setFn(modules, fn, size, 8, i, bit(i));
  setFn(modules, fn, size, 8, 7, bit(6));
  setFn(modules, fn, size, 8, 8, bit(7));
  setFn(modules, fn, size, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFn(modules, fn, size, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFn(modules, fn, size, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++)
    setFn(modules, fn, size, 8, size - 15 + i, bit(i));
  setFn(modules, fn, size, 8, size - 8, true);
}

// ── Placement and masking ────────────────────────────────────────────────────────────────────

function drawCodewords(
  modules: Uint8Array,
  fn: Uint8Array,
  size: number,
  data: Uint8Array,
): void {
  let i = 0;
  const total = data.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fn[y * size + x] === 0 && i < total) {
          modules[y * size + x] = (data[i >>> 3]! >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
  // Remainder bits (versions 2-6) stay light.
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
  return false;
}

function applyMask(
  modules: Uint8Array,
  fn: Uint8Array,
  size: number,
  mask: number,
): void {
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (fn[y * size + x] === 0 && maskBit(mask, x, y))
        modules[y * size + x] = modules[y * size + x]! ^ 1;
}

// ── Penalty (ISO/IEC 18004 §7.8.3) ───────────────────────────────────────────────────────────

/** The penalty score of a finished symbol: runs (N1), 2x2 blocks (N2), finder-like patterns
 *  (N3) and dark/light imbalance (N4). */
export function qrPenalty(modules: Uint8Array, size: number): number {
  let result = 0;
  for (const columns of [false, true]) {
    for (let a = 0; a < size; a++) {
      let runDark = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const dark = modules[columns ? b * size + a : a * size + b] === 1;
        if (dark === runDark) {
          run++;
          if (run === 5) result += N1;
          else if (run > 5) result++;
        } else {
          historyAdd(history, run, size);
          if (!runDark) result += finderCount(history) * N3;
          runDark = dark;
          run = 1;
        }
      }
      // Terminate the line against the light border.
      if (runDark) {
        historyAdd(history, run, size);
        run = 0;
      }
      run += size;
      historyAdd(history, run, size);
      result += finderCount(history) * N3;
    }
  }
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y * size + x];
      if (
        c === modules[y * size + x + 1] &&
        c === modules[(y + 1) * size + x] &&
        c === modules[(y + 1) * size + x + 1]
      )
        result += N2;
    }
  let darkCount = 0;
  for (const m of modules) darkCount += m;
  const total = size * size;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  result += Math.max(k, 0) * N4;
  return result;
}

function historyAdd(history: number[], run: number, size: number): void {
  let r = run;
  if (history[0] === 0) r += size; // the light border before the line's first run
  for (let i = history.length - 1; i > 0; i--) history[i] = history[i - 1]!;
  history[0] = r;
}

function finderCount(h: readonly number[]): number {
  const n = h[1]!;
  const core =
    n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
  return (
    (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) +
    (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0)
  );
}

/** The symbol's rows as `0`/`1` strings (the fixtures' shape). */
export function qrRows(code: QrCode): string[] {
  const rows: string[] = [];
  for (let y = 0; y < code.size; y++) {
    let row = "";
    for (let x = 0; x < code.size; x++)
      row += code.modules[y * code.size + x] ? "1" : "0";
    rows.push(row);
  }
  return rows;
}
