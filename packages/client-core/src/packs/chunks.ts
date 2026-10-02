// `pkey-chunks/1`, the binary chunk index (plans/P4-10.md §2.3; WIRE-CONTRACT-V4 §2.6), and its
// parser. `content/cases.json#chunkIndexCases` pins `parseChunkIndex`. Pure, never throws.
//
// Layout (all little-endian), exactly A7 §3.1:
//
//   header   64 B   "PKEYCHNK" | version u16 = 1 | recordSize u16 = 48 | flags u32 (bit 0
//                   fileAware) | chunkCount u32 | bundleCount u32 | payloadSize u64 |
//                   payloadSha256[32]
//   chunks   48 B   id[32] | len u32 | clen u32 | bundle u32 | offset u32, in payload order
//   bundles  48 B   sha256[32] | size u64 | reserved u64
//
// The u64 rule: a u64 is read as `hi × 2^32 + lo` from two u32 reads (low word first) and
// saturated at 2^53, never through a native 64-bit read, so every SDK (GDScript's `int`, a JS
// double) reaches the same value. Every read goes through a `DataView`, never a typed-array view
// at an unaligned offset.

import { MAX_CHUNK_INDEX_BYTES } from "@polaris-key/protocol/core";
import type { ChunkIndexDoc, ChunkRecord } from "@polaris-key/protocol/packs";
import { sha256Hex, type ZstdDecode } from "./files.js";

/** `PKEYCHNK`. */
const MAGIC = [0x50, 0x4b, 0x45, 0x59, 0x43, 0x48, 0x4e, 0x4b] as const;
const HEADER_BYTES = 64;
const RECORD_BYTES = 48;
const FLAG_FILE_AWARE = 1;
const TWO_32 = 4294967296;
const TWO_53 = 9007199254740992;

/** The chunk-index codes (plans/P4-10.md §2.7), in check order. */
export type ChunkIndexErrorCode =
  | "chunks-ref-mismatch"
  | "chunks-bad-length"
  | "chunks-bad-magic"
  | "chunks-unsupported-version"
  | "chunks-bad-record-size"
  | "chunks-bad-flags"
  | "chunks-reserved-nonzero"
  | "chunks-zero-length"
  | "chunks-bad-clen"
  | "chunks-bad-bundle-ref"
  | "chunks-bad-bundle-range"
  | "chunks-size-mismatch"
  | "chunks-payload-mismatch";

/** The variant's `chunks` member as the parser reads it: an object ref. */
export interface ChunkIndexRef {
  sha256: string;
  bytes: number;
  size: number;
  codec: string;
}

export interface ParseChunkIndexOptions {
  /** Decodes a `codec: "zstd"` index. Without it, a zstd index is `chunks-ref-mismatch`. */
  decode?: ZstdDecode;
  /** The largest `ref.size` accepted, `MAX_CHUNK_INDEX_BYTES` by default. CI and the Worker
   *  pass `MAX_PUBLISHED_INDEX_BYTES`. */
  maxBytes?: number;
}

export type ParseChunkIndexResult =
  | { ok: true; index: ChunkIndexDoc }
  | {
      ok: false;
      error: ChunkIndexErrorCode;
      chunk?: number;
      bundle?: number;
    };

/** A u64 at `at` by the u64 rule: two u32 reads, low word first, saturated at 2^53. */
export function readU64(dv: DataView, at: number): number {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  const v = hi * TWO_32 + lo;
  return v >= TWO_53 ? TWO_53 : v;
}

function hexAt(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < at + n; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

const fail = (
  error: ChunkIndexErrorCode,
  at?: { chunk: number } | { bundle: number },
): ParseChunkIndexResult => ({ ok: false, error, ...(at ?? {}) });

/**
 * `parseChunkIndex(stored, ref, payload | null, {decode, maxBytes})` (plans/P4-10.md §2.3): the
 * index, or the first failure in this order:
 *
 *  0. `ref.size` above `maxBytes` (before anything is decoded), the stored SHA-256 or length
 *     differs from the ref, a `zstd` ref fails to decode, or the decoded length is not
 *     `ref.size` → `chunks-ref-mismatch`;
 *  1. length < 64 → `chunks-bad-length`; 2. magic → `chunks-bad-magic`; 3. version ≠ 1 →
 *     `chunks-unsupported-version`; 4. recordSize ≠ 48 → `chunks-bad-record-size`;
 *     5. `flags & ~1` → `chunks-bad-flags`;
 *  6. length ≠ 64 + 48 × (chunkCount + bundleCount), in exact arithmetic → `chunks-bad-length`;
 *  7. bundle records in order: reserved ≠ 0 → `chunks-reserved-nonzero {bundle}`;
 *  8. chunk records in order: `len == 0` → `chunks-zero-length`; `clen == 0 || clen > len` →
 *     `chunks-bad-clen`; `bundle ≥ bundleCount` → `chunks-bad-bundle-ref`;
 *     `offset + clen > bundles[bundle].size` → `chunks-bad-bundle-range`, each `{chunk}`;
 *  9. Σ len ≠ payloadSize → `chunks-size-mismatch`;
 * 10. with `payload`, (`payloadSha256`, `payloadSize`) ≠ (`payload.sha256`, `payload.size`) →
 *     `chunks-payload-mismatch`.
 *
 * Never throws.
 */
export async function parseChunkIndex(
  stored: Uint8Array,
  ref: ChunkIndexRef,
  payload: { size: number; sha256: string } | null,
  opts: ParseChunkIndexOptions = {},
): Promise<ParseChunkIndexResult> {
  try {
    // 0. The stored object against its ref, then the decode.
    const max = opts.maxBytes ?? MAX_CHUNK_INDEX_BYTES;
    if (typeof ref.size !== "number" || ref.size > max)
      return fail("chunks-ref-mismatch");
    if (stored.byteLength !== ref.bytes) return fail("chunks-ref-mismatch");
    if ((await sha256Hex(stored)) !== ref.sha256)
      return fail("chunks-ref-mismatch");
    let b: Uint8Array;
    if (ref.codec === "none") b = stored;
    else if (ref.codec === "zstd" && opts.decode) {
      try {
        b = await opts.decode(stored, ref.size);
      } catch {
        return fail("chunks-ref-mismatch");
      }
    } else return fail("chunks-ref-mismatch");
    if (!(b instanceof Uint8Array) || b.byteLength !== ref.size)
      return fail("chunks-ref-mismatch");
    return parseChunkIndexBytes(b, payload);
  } catch {
    return fail("chunks-ref-mismatch");
  }
}

/** Steps 1–10 of `parseChunkIndex` over the decoded index bytes (no ref). Never throws. */
export function parseChunkIndexBytes(
  b: Uint8Array,
  payload: { size: number; sha256: string } | null,
): ParseChunkIndexResult {
  if (b.byteLength < HEADER_BYTES) return fail("chunks-bad-length");
  for (let i = 0; i < MAGIC.length; i++)
    if (b[i] !== MAGIC[i]) return fail("chunks-bad-magic");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(8, true) !== 1) return fail("chunks-unsupported-version");
  if (dv.getUint16(10, true) !== RECORD_BYTES)
    return fail("chunks-bad-record-size");
  const flags = dv.getUint32(12, true);
  if ((flags & ~FLAG_FILE_AWARE) !== 0) return fail("chunks-bad-flags");
  const n = dv.getUint32(16, true);
  const nb = dv.getUint32(20, true);
  // Both counts are below 2^32, so 64 + 48 × (n + nb) < 2^39 is exact in a double.
  if (b.byteLength !== HEADER_BYTES + RECORD_BYTES * (n + nb))
    return fail("chunks-bad-length");
  const payloadSize = readU64(dv, 24);
  const payloadSha256 = hexAt(b, 32, 32);

  const bundles: [string, number][] = [];
  for (let j = 0; j < nb; j++) {
    const o = HEADER_BYTES + RECORD_BYTES * (n + j);
    if (dv.getUint32(o + 40, true) !== 0 || dv.getUint32(o + 44, true) !== 0)
      return fail("chunks-reserved-nonzero", { bundle: j });
    bundles.push([hexAt(b, o, 32), readU64(dv, o + 32)]);
  }
  const records: ChunkRecord[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const o = HEADER_BYTES + RECORD_BYTES * i;
    const len = dv.getUint32(o + 32, true);
    const clen = dv.getUint32(o + 36, true);
    const bundle = dv.getUint32(o + 40, true);
    const offset = dv.getUint32(o + 44, true);
    if (len === 0) return fail("chunks-zero-length", { chunk: i });
    if (clen === 0 || clen > len) return fail("chunks-bad-clen", { chunk: i });
    if (bundle >= nb) return fail("chunks-bad-bundle-ref", { chunk: i });
    if (offset + clen > bundles[bundle]![1])
      return fail("chunks-bad-bundle-range", { chunk: i });
    total += len;
    records.push([hexAt(b, o, 32), len, clen, bundle, offset]);
  }
  // Σ len stays an exact double: at `MAX_CHUNK_INDEX_BYTES` (349,523 records) it is below
  // 1.5 × 10^15 < 2^53, so a saturated `payloadSize` never compares equal by accident.
  if (total !== payloadSize) return fail("chunks-size-mismatch");
  if (
    payload !== null &&
    (payloadSha256 !== payload.sha256 || payloadSize !== payload.size)
  )
    return fail("chunks-payload-mismatch");
  return {
    ok: true,
    index: {
      fileAware: (flags & FLAG_FILE_AWARE) !== 0,
      payloadSize,
      payloadSha256,
      records,
      bundles,
    },
  };
}
