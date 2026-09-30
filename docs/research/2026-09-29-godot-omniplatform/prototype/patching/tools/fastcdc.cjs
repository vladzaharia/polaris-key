// FastCDC (Xia et al. 2016, normalized chunking level 1) + fixed-size chunking.
// usage: node fastcdc.cjs <file> <avg|fixed:SIZE> [avg] -> JSON [{ofs,size,sha256}]
const fs = require("fs");
const crypto = require("crypto");

// Deterministic gear table (same seed as the GDScript port).
function gearTable() {
  const g = new Uint32Array(256);
  let x = 0x9e3779b9 >>> 0;
  for (let i = 0; i < 256; i++) {
    // xorshift32
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    g[i] = x;
  }
  return g;
}
const GEAR = gearTable();

function masks(avg) {
  const bits = Math.round(Math.log2(avg));
  // mask with (bits+1) / (bits-1) ones spread in the high half (normalized chunking)
  const mk = (n) =>
    n >= 32 ? 0xffffffff : ((((1 << n) >>> 0) - 1) << (32 - n)) >>> 0;
  return { maskS: mk(bits + 1), maskL: mk(bits - 1) };
}

function fastcdc(buf, avg) {
  const min = avg >> 2,
    max = avg * 4;
  const { maskS, maskL } = masks(avg);
  const out = [];
  let start = 0;
  const n = buf.length;
  while (start < n) {
    let remaining = n - start;
    if (remaining <= min) {
      out.push([start, remaining]);
      break;
    }
    let end = Math.min(remaining, max);
    let normal = Math.min(end, avg);
    let h = 0,
      i = min;
    let cut = end;
    for (; i < normal; i++) {
      h = ((h << 1) + GEAR[buf[start + i]]) >>> 0;
      if ((h & maskS) === 0) {
        cut = i + 1;
        break;
      }
    }
    if (cut === end && i >= normal) {
      for (; i < end; i++) {
        h = ((h << 1) + GEAR[buf[start + i]]) >>> 0;
        if ((h & maskL) === 0) {
          cut = i + 1;
          break;
        }
      }
    }
    out.push([start, cut]);
    start += cut;
  }
  return out;
}

function fixed(buf, size) {
  const out = [];
  for (let o = 0; o < buf.length; o += size)
    out.push([o, Math.min(size, buf.length - o)]);
  return out;
}

const [file, mode] = process.argv.slice(2);
const buf = fs.readFileSync(file);
const t0 = process.hrtime.bigint();
let chunks;
if (process.env.FASTCDC_SEGMENTS) {
  chunks = [];
  const segs = JSON.parse(fs.readFileSync(process.env.FASTCDC_SEGMENTS));
  for (const [so, ss] of segs)
    for (const [o, s] of fastcdc(buf.subarray(so, so + ss), parseInt(mode)))
      chunks.push([so + o, s]);
} else
  chunks = mode.startsWith("fixed:")
    ? fixed(buf, parseInt(mode.slice(6)))
    : fastcdc(buf, parseInt(mode));
const t1 = process.hrtime.bigint();
const res = chunks.map(([o, s]) => ({
  ofs: o,
  size: s,
  sha256: crypto
    .createHash("sha256")
    .update(buf.subarray(o, o + s))
    .digest("hex"),
}));
process.stderr.write(
  `${file} ${mode}: ${chunks.length} chunks, chunking ${(Number(t1 - t0) / 1e6).toFixed(0)} ms\n`,
);
process.stdout.write(JSON.stringify(res));
// file-aware mode: FASTCDC_SEGMENTS=<json [[ofs,size],...]> chunks each segment independently (never crossing entries)
