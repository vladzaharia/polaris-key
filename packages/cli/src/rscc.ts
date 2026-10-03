/**
 * Bounded decompression of a Godot compressed binary resource (`RSCC`, FileAccessCompressed), so
 * the pack lint can scan an imported model's `.scn` (P4-27). The device applies the same rules
 * in `PKeyPck.rscc_body` (sdks/godot/addons/polaris_key/packs/pck.gd) with the same messages, and
 * the shared fixtures in `test/godotFixtures.test.ts` hold the two to identical verdicts.
 *
 * Layout (little-endian u32s), as FileAccessCompressed writes it:
 *
 *   "RSCC", mode, block size, total (uncompressed bytes),
 *   bc = ⌊total / block size⌋ + 1 compressed block sizes,
 *   the bc compressed blocks, then "RSCC" again, ending the entry.
 *
 * Every block but the last decodes to exactly `block size` bytes; the last to `total % block
 * size` (zero when the total is a multiple: Godot still writes an empty frame for it).
 *
 * Everything in the header is untrusted, and nothing is allocated or decoded until it has been
 * bounded: the mode must be zstd (2); the block size within {@link RSCC_MIN_BLOCK}..
 * {@link RSCC_MAX_BLOCK}; the total at most {@link RSCC_MAX_TOTAL}; the block table and every
 * block within the entry; the closing magic exactly at the end; and, across one pack, the
 * declared totals within {@link RSCC_PACK_BUDGET} (counted before anything is decoded). Each
 * block must then be exactly one single-segment zstd frame (no skippable frame, no dictionary, no
 * second frame, no window descriptor, no zstd block above 128 KiB or above the block's size)
 * whose header declares the block's size, and must decode to exactly that size; the decoder is given that size as its
 * output capacity, so a block that lies about its size (a bomb) stops at it and is refused.
 * Godot's own decoder (libzstd's one-shot `ZSTD_decompressDCtx`) would accept concatenated or
 * skippable frames, so the frame walk is this file's: it is what keeps the device, whose
 * `PackedByteArray.decompress` is that call, and the CLI's single-frame wasm decoder agreeing.
 */

import { decode as wasmDecode } from "@polaris-key/zstd-wasm";

/**
 * The largest total an `RSCC` resource may declare: 64 MiB. Shared with the device
 * (`PKeyPck.RSCC_MAX_TOTAL`). Measured with Godot 4.7.2's `--headless --import` of script-written
 * glTFs (P4-27 audit): a skinned character (a 300×300 grid mesh, 90,601 vertices, 60 joints, 20
 * animations of 10 s at 30 fps; a 17.8 MB `.glb`) imports to an `.scn` declaring 18,216,754 bytes;
 * a 700×700 grid mesh (980,000 triangles, a 21 MB `.glb`, with the importer's LODs and shadow
 * mesh) to 58,746,302 bytes. The cap is about 4× the character, capped at 64 MiB: it admits
 * both, and a model above it must be split. Single-segment RLE blocks regenerate 128 KiB from 4
 * bytes, so a tiny entry can declare the cap; the cap and {@link RSCC_PACK_BUDGET} bound that.
 */
export const RSCC_MAX_TOTAL = 67108864;
/**
 * The decompressed bytes one pack's `RSCC` entries may declare in total: 512 MiB (eight entries
 * at the cap, about 28 of the measured character). Counted in directory order from each entry's
 * declared total once its header is in bounds, before its blocks are read or decoded; the entry
 * that takes the running sum past the budget, and every `RSCC` entry after it, is refused.
 */
export const RSCC_PACK_BUDGET = 536870912;
/** The largest zstd block (`ZSTD_BLOCKSIZE_MAX`): no block of any type may declare more. */
export const ZSTD_BLOCK_MAX = 131072;
/** The smallest block size admitted (Godot writes 4096); bounds the block count to cap / 4096. */
export const RSCC_MIN_BLOCK = 4096;
/** The largest block size admitted: 1 MiB. */
export const RSCC_MAX_BLOCK = 1048576;
/** FileAccessCompressed's mode for zstd (`Compression::MODE_ZSTD`). */
export const RSCC_MODE_ZSTD = 2;

const ZSTD_MAGIC = 0xfd2fb528;

/** The decompressed body, or why the resource is refused (after "a compressed binary resource (RSCC) "). */
export type RsccResult = { body: Uint8Array } | { why: string };

/** One pack's running count of declared `RSCC` bytes (see {@link RSCC_PACK_BUDGET}). */
export interface RsccBudget {
  used: number;
}

/** Decode one zstd frame to exactly `size` bytes, or throw. */
export type FrameDecoder = (frame: Uint8Array, size: number) => Uint8Array;

/**
 * Whether `f` is exactly one zstd frame whose header declares `size` content bytes: the frame
 * magic first, the Single_Segment flag set (so no window descriptor: every frame Godot writes has
 * it, and the 32-bit wasm decoder and a 64-bit device disagree on a window of 2^31), no reserved
 * bit, no dictionary id, a content size equal to `size`, a block walk (raw, RLE or compressed; no
 * reserved type; no block declaring more than 128 KiB or more than `size`: for raw and RLE that
 * is the regenerated size, and libzstd versions differ on enforcing it) that ends with the
 * last-block flag and the optional checksum exactly at the end. A frame of 0 bytes may carry only empty raw blocks
 * and no checksum, so neither side needs to decode it (the device's `decompress` takes no
 * zero-size output).
 */
export function zstdFrameOk(f: Uint8Array, size: number): boolean {
  const n = f.byteLength;
  if (n < 6) return false;
  const dv = new DataView(f.buffer, f.byteOffset, n);
  if (dv.getUint32(0, true) !== ZSTD_MAGIC) return false;
  const fhd = f[4]!;
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  if ((fhd & 0x08) !== 0 || (fhd & 0x03) !== 0) return false;
  if (single !== 1) return false;
  let p = 5;
  const fcsLen = [1, 2, 4, 8][fcsFlag]!;
  if (p + fcsLen > n) return false;
  let fcs: number;
  if (fcsLen === 1) fcs = f[p]!;
  else if (fcsLen === 2) fcs = dv.getUint16(p, true) + 256;
  else if (fcsLen === 4) fcs = dv.getUint32(p, true);
  else {
    if (dv.getUint32(p + 4, true) !== 0) return false;
    fcs = dv.getUint32(p, true);
  }
  if (fcs !== size) return false;
  p += fcsLen;
  for (;;) {
    if (p + 3 > n) return false;
    const h = f[p]! | (f[p + 1]! << 8) | (f[p + 2]! << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const bsize = h >>> 3;
    if (type === 3) return false;
    if (bsize > ZSTD_BLOCK_MAX || bsize > size) return false;
    if (size === 0 && (type !== 0 || bsize !== 0)) return false;
    const payload = type === 1 ? 1 : bsize;
    if (payload > n - p) return false;
    p += payload;
    if (last === 1) break;
  }
  if (checksum === 1) {
    if (size === 0) return false;
    p += 4;
  }
  return p === n;
}

/**
 * The decompressed body of an `RSCC` resource, or why it is refused. `decode` is the zstd
 * decoder (the CLI's `@polaris-key/zstd-wasm`; a test may pass another); `budget` the pack's
 * running count, which the declared total is added to once the header is in bounds.
 *
 * The wasm decoder instantiates its module per frame: zdec.c's bump allocator never frees, so
 * one instance per lint would grow by every block it decodes, and the module exports no reset.
 * Instantiating a compiled module is cheap next to the decode (a 64 MiB body of 16,385 blocks of
 * 4096 decodes in well under a second), so the lint keeps the package's API.
 */
export function rsccBody(
  data: Uint8Array,
  decode: FrameDecoder = wasmDecode,
  budget?: RsccBudget,
): RsccResult {
  const n = data.byteLength;
  if (n < 16) return { why: "whose header is truncated" };
  const dv = new DataView(data.buffer, data.byteOffset, n);
  const mode = dv.getUint32(4, true);
  if (mode !== RSCC_MODE_ZSTD)
    return {
      why: `in compression mode ${mode}; only zstd (mode ${RSCC_MODE_ZSTD}) is inspected`,
    };
  const bs = dv.getUint32(8, true);
  if (bs < RSCC_MIN_BLOCK || bs > RSCC_MAX_BLOCK)
    return {
      why: `with block size ${bs}, outside ${RSCC_MIN_BLOCK}..${RSCC_MAX_BLOCK}`,
    };
  const total = dv.getUint32(12, true);
  if (total > RSCC_MAX_TOTAL)
    return {
      why: `that declares ${total} bytes, above the ${RSCC_MAX_TOTAL}-byte cap`,
    };
  if (budget !== undefined) {
    budget.used += total;
    if (budget.used > RSCC_PACK_BUDGET)
      return {
        why: `that takes the pack's declared RSCC bytes to ${budget.used}, past the ${RSCC_PACK_BUDGET}-byte budget`,
      };
  }
  const bc = Math.floor(total / bs) + 1;
  const tableEnd = 16 + 4 * bc;
  if (tableEnd > n) return { why: "whose block table runs past the end" };
  const starts: number[] = [];
  const sizes: number[] = [];
  let pos = tableEnd;
  for (let i = 0; i < bc; i++) {
    const cs = dv.getUint32(16 + 4 * i, true);
    if (cs > n - pos) return { why: `whose block ${i} runs past the end` };
    starts.push(pos);
    sizes.push(cs);
    pos += cs;
  }
  if (
    pos + 4 > n ||
    data[pos] !== 0x52 ||
    data[pos + 1] !== 0x53 ||
    data[pos + 2] !== 0x43 ||
    data[pos + 3] !== 0x43
  )
    return { why: "without its closing RSCC magic" };
  if (pos + 4 !== n) return { why: "with bytes after its closing RSCC magic" };
  const want = (i: number) => (i === bc - 1 ? total - (bc - 1) * bs : bs);
  const frame = (i: number) =>
    data.subarray(starts[i]!, starts[i]! + sizes[i]!);
  // Every frame's structure first, so nothing is allocated for a resource that cannot decode.
  for (let i = 0; i < bc; i++)
    if (!zstdFrameOk(frame(i), want(i)))
      return {
        why: `whose block ${i} is not one zstd frame of ${want(i)} bytes`,
      };
  const body = new Uint8Array(total);
  for (let i = 0; i < bc; i++) {
    const w = want(i);
    if (w === 0) continue;
    let out: Uint8Array;
    try {
      out = decode(frame(i), w);
    } catch {
      return { why: `whose block ${i} does not decode to ${w} bytes` };
    }
    if (out.byteLength !== w)
      return { why: `whose block ${i} does not decode to ${w} bytes` };
    body.set(out, i * bs);
  }
  return { body };
}

/**
 * Whether a decompressed body opens like a binary resource. Godot's binary saver writes the
 * `RSRC` magic only to an uncompressed file, so an `RSCC` body starts at the header words after
 * it: the big-endian and real64 flags (each 0 or 1), then the major, minor and format versions.
 * A body shorter than those five words, or with another flag value, is not a resource (and a
 * nested `RSCC` or a text resource fails here too).
 */
export function rsccBodyIsResource(body: Uint8Array): boolean {
  if (body.byteLength < 20) return false;
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return dv.getUint32(0, true) <= 1 && dv.getUint32(4, true) <= 1;
}
