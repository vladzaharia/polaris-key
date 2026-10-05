import { deflateSync } from "node:zlib";

/**
 * Stand-in developer art for the browser checks: real PNGs (so the browser decodes them under the
 * portal's CSP), drawn as flat bands of a product's palette with a disc, like the mockups'
 * stand-in key art. Encoded here with zlib; no image library.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export type Rgb = readonly [number, number, number];

/** A `width`×`height` PNG: `bands` stacked top to bottom, and a disc of `disc` colour. */
export function artPng(
  width: number,
  height: number,
  bands: readonly Rgb[],
  disc: Rgb,
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const cx = width * 0.72;
  const cy = height * 0.38;
  const r = Math.min(width, height) * 0.22;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    const band =
      bands[
        Math.min(bands.length - 1, Math.floor((y / height) * bands.length))
      ]!;
    for (let x = 0; x < width; x++) {
      const inDisc = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      const c = inDisc ? disc : band;
      const o = row + 1 + x * 3;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
