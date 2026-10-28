// `pkey-sync-cdc/1` (WIRE-CONTRACT-V5 §13.8.3): content-defined chunking of a file's plaintext,
// `fastcdc-2016-nc1`, streaming. Every implementation cuts at the same offsets (`cdcCases`).
//
//   gear[i]  xorshift32 from seed 0x9e3779b9: x ^= x << 13; x ^= x >> 17; x ^= x << 5 (32-bit),
//            one step per entry, 256 entries
//   min, max avg / 4 and avg * 4 (64 KiB, 256 KiB and 1 MiB by default)
//   masks    bits = round(log2(avg)); the strict mask has the top bits + 1 bits set, the loose mask
//            the top bits - 1
//   scan     per chunk, h starts at 0 at offset min; h = (h << 1) + gear[byte] (32-bit); up to
//            offset avg a cut where h & strict == 0, after it where h & loose == 0; the cut is
//            after the matching byte, else at max (or at the end of the input)
//   tail     what remains is one chunk when it is at most min bytes
//
// The scan of a chunk never looks past `max` bytes, so a chunk is decided as soon as `max` bytes
// are buffered (or the input ends) and the chunker holds at most `max` bytes at a time.

import {
  SYNC_CDC_AVG_BYTES,
  SYNC_CDC_GEAR_SEED,
} from "@polaris-key/protocol/sync";

export interface CdcParams {
  avg: number;
  min: number;
  max: number;
}

/** The parameters of `pkey-sync-cdc/1`: average 256 KiB, minimum 64 KiB, maximum 1 MiB. */
export const SYNC_CDC_PARAMS: CdcParams = cdcParams(SYNC_CDC_AVG_BYTES);

/** The parameters for an average chunk size (a power of two, at least 64). */
export function cdcParams(avg: number): CdcParams {
  if (!Number.isInteger(avg) || avg < 64 || (avg & (avg - 1)) !== 0)
    throw new RangeError("cdc average must be a power of two of at least 64");
  return { avg, min: avg >> 2, max: avg * 4 };
}

function gearTable(): Uint32Array {
  const g = new Uint32Array(256);
  let x = SYNC_CDC_GEAR_SEED >>> 0;
  for (let i = 0; i < 256; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    g[i] = x;
  }
  return g;
}
const GEAR = gearTable();

const topMask = (n: number): number =>
  n >= 32 ? 0xffffffff : (~(0xffffffff >>> n) & 0xffffffff) >>> 0;

/** The length of the chunk at the start of `buf[0..len)`, which is the rest of the input (`last`)
 *  or at least `max` bytes. */
function cutLength(buf: Uint8Array, len: number, p: CdcParams): number {
  if (len <= p.min) return len;
  const bits = Math.round(Math.log2(p.avg));
  const strict = topMask(bits + 1);
  const loose = topMask(bits - 1);
  const end = Math.min(len, p.max);
  const normal = Math.min(end, p.avg);
  let h = 0;
  for (let i = p.min; i < end; i++) {
    h = ((h << 1) + GEAR[buf[i]!]!) >>> 0;
    if ((h & (i < normal ? strict : loose)) === 0) return i + 1;
  }
  return end;
}

/** A push chunker: `push` returns the chunks that are decided, `finish` the rest. */
export class CdcChunker {
  readonly params: CdcParams;
  private readonly buf: Uint8Array;
  private len = 0;

  constructor(params: CdcParams = SYNC_CDC_PARAMS) {
    this.params = params;
    this.buf = new Uint8Array(params.max);
  }

  /** The chunks that `data` completes, in order. Each is a fresh copy. */
  push(data: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < data.length) {
      const take = Math.min(this.params.max - this.len, data.length - at);
      this.buf.set(data.subarray(at, at + take), this.len);
      this.len += take;
      at += take;
      if (this.len === this.params.max)
        this.emit(out, cutLength(this.buf, this.len, this.params));
    }
    return out;
  }

  /** The last chunks, once the input has ended. The chunker is empty afterwards. */
  finish(): Uint8Array[] {
    const out: Uint8Array[] = [];
    while (this.len > 0)
      this.emit(out, cutLength(this.buf, this.len, this.params));
    return out;
  }

  private emit(out: Uint8Array[], n: number): void {
    out.push(this.buf.slice(0, n));
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }
}

/** Chunks a stream of byte pieces of any size without holding more than `max` bytes of it. */
export async function* cdcStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  params: CdcParams = SYNC_CDC_PARAMS,
): AsyncGenerator<Uint8Array> {
  const chunker = new CdcChunker(params);
  for await (const piece of source) yield* chunker.push(piece);
  yield* chunker.finish();
}

/** The chunk lengths of a whole buffer (tests and tools; production code streams). */
export function cdcLengths(
  data: Uint8Array,
  params: CdcParams = SYNC_CDC_PARAMS,
): number[] {
  const c = new CdcChunker(params);
  return [...c.push(data), ...c.finish()].map((x) => x.length);
}
