/**
 * A container variant's chunk index and shared chunk bundles (P4-22; plans/P4-10.md §2.3, §2.4).
 *
 * `pkey release publish` gives every container variant of `CHUNK_MIN_PAYLOAD_BYTES` (4 MiB) or
 * more a `pkey-chunks/1` index when `chunk` is in the pack's `patch.strategies` and the Worker's
 * discovery advertises `release.chunks`:
 *
 *   - **Chunking** is `fastcdc-2016-nc1` (A7's `gen/fastcdc.cjs`: the xorshift32 gear table seeded
 *     `0x9e3779b9`, min = avg/4, max = avg × 4, a remainder ≤ min kept as one chunk) over §2.4's
 *     file-aware segments: every files-index entry, with the gaps between them, a gap shorter
 *     than `padMerge` (64) bytes that directly follows an entry joining that entry's segment. So
 *     no chunk spans two entries. The chunker and the segments are an exact mirror of the corpus
 *     generator's (`tools/gen-content-chunks.ts`), which imports nothing it checks; the CLI test
 *     reproduces `(id, len)` of `conformance/corpus/v2/content/blobs/chunks/v{1,2}.pkc`.
 *   - **Storage**: each chunk is one `zstd -19` frame with its content size, or raw when the frame
 *     is not smaller (`storeMany`, 400 inputs per zstd process).
 *   - **Bundles** are shared along one chain (one deliverable, one variant key, one gating class):
 *     an id the proven prior index holds keeps its location (bundle, offset, clen), but only in a
 *     bundle the stage round reports `present`; every other unique chunk goes into new bundles in
 *     first-use order, a bundle closed before it would pass `bundleTarget` (4 MiB). The bundle
 *     table lists bundles in the order records first reference them. A bundle is a blob
 *     (`blobKey`, `blobs/sha256/<hex>` or `gated/…`), uploaded in stage rounds like every pack
 *     object.
 *   - **Lints** (A7 §11.5), before anything is published: every new frame's header declares a
 *     content size equal to `len`, it decodes with `@polaris-key/zstd-wasm` (the device decoder)
 *     to `len` bytes, and its SHA-256 is the id; every reused location equals the proven prior
 *     index's; the records' ids and lengths equal the chunker's output over the payload; each new
 *     bundle's length equals its table size; laying the same chunks out twice gives the same
 *     index; and the stored index passes client-core's `parseChunkIndex` bound to the payload,
 *     under `MAX_PUBLISHED_INDEX_BYTES`. An index above that bound is not published: the variant
 *     omits `chunks` and the publish warns.
 *
 * CONTENT ADMISSION. Chunks and bundles are cut from a payload only after the whole payload has
 * passed the publish lint (`packLint.ts`: the admission list, the data-only scan by content head,
 * A7's path rules). A bundle is named by its hash and carries no path, so no chunk can reach a
 * device without the lint its whole file got.
 */

import { createHash } from "node:crypto";
import { CHUNKS_FORMAT } from "@polaris-key/protocol/core";
import type {
  ChunkIndexDoc,
  ChunkParams,
  ChunkRecord,
  ChunksRef,
} from "@polaris-key/protocol/packs";
import { parseChunkIndex } from "@polaris-key/client-core/packs";
import { MAX_PUBLISHED_INDEX_BYTES } from "@polaris-key/manifest";
import { decode as wasmDecode } from "@polaris-key/zstd-wasm";
import { storeMany, type Stored, type Zstd } from "./packArtifacts.js";

/** A container variant gets a chunk index from this payload size up (plans/P4-10.md §2.4). */
export const CHUNK_MIN_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** §2.4's parameters, frozen per release and signed as `chunks.params`. */
export const CHUNK_PARAMS = {
  chunker: "fastcdc-2016-nc1",
  fileAware: true,
  avgSize: 65536,
  minSize: 16384,
  maxSize: 262144,
  padMerge: 64,
  bundleTarget: 4194304,
  bundleLayout: "shared",
  zstdLevel: 19,
} as const;

const MAGIC = [0x50, 0x4b, 0x45, 0x59, 0x43, 0x48, 0x4e, 0x4b];
const HEADER_BYTES = 64;
const RECORD_BYTES = 48;
const FLAG_FILE_AWARE = 1;
const TWO_32 = 4294967296;

const sha256Hex = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── `fastcdc-2016-nc1` (A7's `gen/fastcdc.cjs`; mirrors `tools/gen-content-chunks.ts`) ────────

function gearTable(): Uint32Array {
  const g = new Uint32Array(256);
  let x = 0x9e3779b9 >>> 0;
  for (let i = 0; i < 256; i++) {
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

function masks(avg: number): { maskS: number; maskL: number } {
  const bits = Math.round(Math.log2(avg));
  const mk = (n: number): number =>
    n >= 32 ? 0xffffffff : ((((1 << n) >>> 0) - 1) << (32 - n)) >>> 0;
  return { maskS: mk(bits + 1), maskL: mk(bits - 1) };
}

/** FastCDC (Xia et al. 2016, normalized chunking level 1): `[start, length]` pairs over `buf`;
 *  min = avg/4, max = avg × 4, a remainder ≤ min kept as one chunk. */
export function fastcdc(buf: Uint8Array, avg: number): [number, number][] {
  const min = avg >> 2;
  const max = avg * 4;
  const { maskS, maskL } = masks(avg);
  const out: [number, number][] = [];
  let start = 0;
  const n = buf.length;
  while (start < n) {
    const remaining = n - start;
    if (remaining <= min) {
      out.push([start, remaining]);
      break;
    }
    const end = Math.min(remaining, max);
    const normal = Math.min(end, avg);
    let h = 0;
    let i = min;
    let cut = end;
    for (; i < normal; i++) {
      h = ((h << 1) + GEAR[buf[start + i]!]!) >>> 0;
      if ((h & maskS) === 0) {
        cut = i + 1;
        break;
      }
    }
    if (cut === end && i >= normal) {
      for (; i < end; i++) {
        h = ((h << 1) + GEAR[buf[start + i]!]!) >>> 0;
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

/**
 * §2.4's segments of a container payload: every files-index entry, with the gaps between them.
 * A gap shorter than `padMerge` bytes that directly follows an entry joins that entry's segment;
 * the header, the directory and longer gaps stay segments of their own, so no chunk spans two
 * entries. `entries` are in offset order; zero-size entries add no segment.
 */
export function containerSegments(
  entries: readonly { offset: number; size: number }[],
  payloadSize: number,
  padMerge: number,
): [number, number][] {
  const segs: [number, number][] = [];
  let pos = 0;
  let lastIsEntry = false;
  const gap = (to: number): void => {
    if (to <= pos) return;
    const g = to - pos;
    if (lastIsEntry && g < padMerge) segs[segs.length - 1]![1] += g;
    else segs.push([pos, g]);
    lastIsEntry = false;
    pos = to;
  };
  for (const e of entries) {
    gap(e.offset);
    if (e.size > 0) {
      segs.push([e.offset, e.size]);
      lastIsEntry = true;
      pos = e.offset + e.size;
    }
  }
  gap(payloadSize);
  return segs;
}

export interface Chunk {
  offset: number;
  len: number;
  id: string;
}

/** FastCDC over each segment (file-aware). Throws unless the chunks tile the payload. */
export function chunkPayload(
  payload: Uint8Array,
  segments: readonly [number, number][],
  avg: number,
): Chunk[] {
  const out: Chunk[] = [];
  for (const [so, ss] of segments)
    for (const [o, n] of fastcdc(payload.subarray(so, so + ss), avg)) {
      const offset = so + o;
      out.push({
        offset,
        len: n,
        id: sha256Hex(payload.subarray(offset, offset + n)),
      });
    }
  let end = 0;
  for (const c of out) {
    if (c.offset !== end) throw new Error("chunks do not tile the payload");
    end += c.len;
  }
  if (end !== payload.byteLength) throw new Error("chunks miss the tail");
  return out;
}

/** The chunks of a container payload at §2.4's parameters. */
export function chunkContainer(
  bytes: Uint8Array,
  files: readonly { offset?: number; size: number }[],
): Chunk[] {
  return chunkPayload(
    bytes,
    containerSegments(
      files.map((f) => ({ offset: f.offset!, size: f.size })),
      bytes.byteLength,
      CHUNK_PARAMS.padMerge,
    ),
    CHUNK_PARAMS.avgSize,
  );
}

// ── Bundles ───────────────────────────────────────────────────────────────────

/** A location an earlier, proven index gives a chunk. */
export interface PriorLocation {
  bundle: string;
  bundleSize: number;
  offset: number;
  clen: number;
}

/**
 * The reusable locations of a proven prior index: the first location of each id, in bundles
 * `present(bundleSha)` accepts (the stage round's `present`, P4-10 §2.4).
 */
export function priorLocations(
  prior: ChunkIndexDoc,
  present: (bundleSha256: string) => boolean,
): Map<string, PriorLocation> {
  const out = new Map<string, PriorLocation>();
  for (const [id, , clen, bi, offset] of prior.records) {
    if (out.has(id)) continue;
    const [bundle, bundleSize] = prior.bundles[bi]!;
    if (present(bundle)) out.set(id, { bundle, bundleSize, offset, clen });
  }
  return out;
}

export interface ChunkLayout {
  records: ChunkRecord[];
  table: [sha256: string, size: number][];
  /** The new bundles' bytes, in creation order. */
  fresh: Uint8Array[];
}

/**
 * Lay out a release's chunks (mirrors `layoutChunks` in `tools/gen-content-chunks.ts`): an id
 * `reuse` holds keeps that location; every other unique chunk goes into new bundles in
 * first-use order, a bundle closed before it would pass `target`. The table lists bundles in the
 * order records first reference them. `stored(id)` is a new chunk's stored bytes.
 */
export function layoutChunks(
  chunks: readonly Chunk[],
  stored: (id: string) => Uint8Array,
  target: number,
  reuse: ReadonlyMap<string, PriorLocation>,
): ChunkLayout {
  const fresh: Uint8Array[][] = [];
  const freshLen: number[] = [];
  const placed = new Map<
    string,
    { key: string | number; offset: number; clen: number }
  >();
  const sizeOf = new Map<string, number>();
  for (const c of chunks) {
    if (placed.has(c.id)) continue;
    const p = reuse.get(c.id);
    if (p) {
      placed.set(c.id, { key: p.bundle, offset: p.offset, clen: p.clen });
      sizeOf.set(p.bundle, p.bundleSize);
      continue;
    }
    const blob = stored(c.id);
    let k = fresh.length - 1;
    if (k < 0 || freshLen[k]! + blob.byteLength > target) {
      fresh.push([]);
      freshLen.push(0);
      k++;
    }
    placed.set(c.id, { key: k, offset: freshLen[k]!, clen: blob.byteLength });
    fresh[k]!.push(blob);
    freshLen[k]! += blob.byteLength;
  }
  const freshBytes = fresh.map((parts) => {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  });
  const freshSha = freshBytes.map((b) => sha256Hex(b));
  freshBytes.forEach((b, i) => sizeOf.set(freshSha[i]!, b.byteLength));
  const keyOf = (k: string | number): string =>
    typeof k === "number" ? freshSha[k]! : k;
  const tableIndex = new Map<string, number>();
  const table: [string, number][] = [];
  const records: ChunkRecord[] = [];
  for (const c of chunks) {
    const p = placed.get(c.id)!;
    const sha = keyOf(p.key);
    let bi = tableIndex.get(sha);
    if (bi === undefined) {
      bi = table.length;
      tableIndex.set(sha, bi);
      table.push([sha, sizeOf.get(sha)!]);
    }
    records.push([c.id, c.len, p.clen, bi, p.offset]);
  }
  return { records, table, fresh: freshBytes };
}

/** A u64 written as two u32 words, low first; `v` below 2^53. */
function putU64(dv: DataView, at: number, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`putU64 ${v}`);
  dv.setUint32(at, v % TWO_32, true);
  dv.setUint32(at + 4, Math.floor(v / TWO_32), true);
}

/** The `pkey-chunks/1` bytes of an index (plans/P4-10.md §2.3, A7 §3.1). */
export function writeChunkIndex(doc: ChunkIndexDoc): Uint8Array {
  const n = doc.records.length;
  const nb = doc.bundles.length;
  const out = new Uint8Array(HEADER_BYTES + RECORD_BYTES * (n + nb));
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, RECORD_BYTES, true);
  dv.setUint32(12, doc.fileAware ? FLAG_FILE_AWARE : 0, true);
  dv.setUint32(16, n, true);
  dv.setUint32(20, nb, true);
  putU64(dv, 24, doc.payloadSize);
  out.set(hexBytes(doc.payloadSha256), 32);
  for (const [i, [id, len, clen, bi, bo]] of doc.records.entries()) {
    const o = HEADER_BYTES + RECORD_BYTES * i;
    out.set(hexBytes(id), o);
    dv.setUint32(o + 32, len, true);
    dv.setUint32(o + 36, clen, true);
    dv.setUint32(o + 40, bi, true);
    dv.setUint32(o + 44, bo, true);
  }
  for (const [j, [sha, size]] of doc.bundles.entries()) {
    const o = HEADER_BYTES + RECORD_BYTES * (n + j);
    out.set(hexBytes(sha), o);
    putU64(dv, o + 32, size);
  }
  return out;
}

/** The index's size for `records` records and `bundles` bundles, without writing it. */
export function chunkIndexBytes(records: number, bundles: number): number {
  return HEADER_BYTES + RECORD_BYTES * (records + bundles);
}

/**
 * The Frame_Content_Size a zstd frame header declares (RFC 8878 §3.1.1.1), or null when the
 * frame has none, is not a zstd frame, or declares one at or above 2^53.
 */
export function frameContentSize(frame: Uint8Array): number | null {
  if (
    frame.byteLength < 5 ||
    frame[0] !== 0x28 ||
    frame[1] !== 0xb5 ||
    frame[2] !== 0x2f ||
    frame[3] !== 0xfd
  )
    return null;
  const d = frame[4]!;
  if ((d & 0x08) !== 0) return null;
  const single = (d & 0x20) !== 0;
  const dictBytes = [0, 1, 2, 4][d & 0x03]!;
  const fcsFlag = d >> 6;
  const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!;
  if (fcsBytes === 0) return null;
  const at = 5 + (single ? 0 : 1) + dictBytes;
  if (frame.byteLength < at + fcsBytes) return null;
  let v = 0;
  for (let i = fcsBytes - 1; i >= 0; i--) v = v * 256 + frame[at + i]!;
  if (fcsBytes === 2) v += 256;
  return Number.isSafeInteger(v) ? v : null;
}

// ── One variant's chunk index ────────────────────────────────────────────────

/** A proven earlier index of the same chain, from the `--bases` cache. */
export interface ChunkChainBase {
  /** The cached release's version (reporting). */
  version: string;
  index: ChunkIndexDoc;
}

export interface BuiltChunks {
  /** The variant's `chunks` member. */
  ref: ChunksRef;
  /** The stored index object (one zstd frame when smaller). */
  index: Stored;
  doc: ChunkIndexDoc;
  /** The new bundles, by SHA-256 (each a pack object to upload). */
  bundles: Map<string, Uint8Array>;
  /** Report: records, new bundles, bytes in reused locations and in new bundles. */
  stats: {
    chunks: number;
    uniqueChunks: number;
    newBundles: number;
    reusedBundles: number;
    reusedBytes: number;
    newBytes: number;
  };
}

export type ChunkOutcome = BuiltChunks | { omitted: string };

export interface BuildChunksOptions {
  /** The largest index published (`MAX_PUBLISHED_INDEX_BYTES`; tests lower it). */
  maxIndexBytes?: number;
}

/**
 * Chunk a container payload, lay it out along `base`'s chain (`reuse` holding only the locations
 * in bundles the server reports present), store the new chunks and bundles, write the index, and
 * run every lint. Returns `{omitted}` when the written index would exceed the published bound.
 * Throws on a lint failure: nothing is published.
 */
export async function buildChunks(
  z: Zstd,
  payload: { bytes: Uint8Array; size: number; sha256: string },
  chunks: readonly Chunk[],
  base: ChunkChainBase | null,
  reuse: ReadonlyMap<string, PriorLocation>,
  opts: BuildChunksOptions = {},
): Promise<ChunkOutcome> {
  const maxIndexBytes = opts.maxIndexBytes ?? MAX_PUBLISHED_INDEX_BYTES;
  // The new chunks: every unique id `reuse` lacks, in first-use order.
  const firstAt = new Map<string, Chunk>();
  for (const c of chunks) if (!firstAt.has(c.id)) firstAt.set(c.id, c);
  const newIds = [...firstAt.keys()].filter((id) => !reuse.has(id));
  // The bound, early (with the one bundle any index lists, before compressing anything), then
  // exactly once the index is laid out.
  if (chunkIndexBytes(chunks.length, 1) > maxIndexBytes)
    return {
      omitted: `its chunk index would be at least ${chunkIndexBytes(chunks.length, 1)} bytes (${chunks.length} chunks); Polaris Key reads at most ${maxIndexBytes} per index`,
    };
  const storedNew = storeMany(
    z,
    newIds.map((id) => {
      const c = firstAt.get(id)!;
      return payload.bytes.subarray(c.offset, c.offset + c.len);
    }),
  );
  const frames = new Map<string, Stored>();
  newIds.forEach((id, i) => frames.set(id, storedNew[i]!));
  const stored = (id: string): Uint8Array => frames.get(id)!.stored;

  // Lint: every new chunk's stored bytes are exactly the chunk (frame header, device decoder,
  // SHA-256), before anything is laid out.
  for (const id of newIds) {
    const c = firstAt.get(id)!;
    const s = frames.get(id)!;
    let data: Uint8Array;
    if (s.ref.codec === "none") {
      data = s.stored;
    } else {
      const fcs = frameContentSize(s.stored);
      if (fcs !== c.len)
        throw new Error(
          `Self-check: chunk ${id.slice(0, 12)}…'s zstd frame declares content size ${fcs ?? "none"}, not ${c.len}; nothing was published.`,
        );
      try {
        data = wasmDecode(s.stored, c.len);
      } catch (e) {
        throw new Error(
          `Self-check: chunk ${id.slice(0, 12)}…'s frame does not decode with @polaris-key/zstd-wasm (${(e as Error).message}); nothing was published.`,
        );
      }
    }
    if (data.byteLength !== c.len || sha256Hex(data) !== id)
      throw new Error(
        `Self-check: chunk ${id.slice(0, 12)}… does not decode to its bytes; nothing was published.`,
      );
  }

  const layout = layoutChunks(chunks, stored, CHUNK_PARAMS.bundleTarget, reuse);
  const doc: ChunkIndexDoc = {
    fileAware: true,
    payloadSize: payload.size,
    payloadSha256: payload.sha256,
    records: layout.records,
    bundles: layout.table,
  };
  const bytes = writeChunkIndex(doc);
  if (bytes.byteLength > maxIndexBytes)
    return {
      omitted: `its chunk index is ${bytes.byteLength} bytes (${doc.records.length} chunks, ${doc.bundles.length} bundles); Polaris Key reads at most ${maxIndexBytes} per index`,
    };

  // Lint: the records are the chunker's output, in order.
  if (layout.records.length !== chunks.length)
    throw new Error("Self-check: the chunk index lost or gained records.");
  layout.records.forEach(([id, len], i) => {
    if (id !== chunks[i]!.id || len !== chunks[i]!.len)
      throw new Error(
        `Self-check: chunk record ${i} is not the chunker's output; nothing was published.`,
      );
  });
  // Lint: every reused location equals the proven prior index's; every new bundle's length
  // equals its table size.
  const freshBySha = new Map(layout.fresh.map((b) => [sha256Hex(b), b]));
  for (const [i, [id, , clen, bi, offset]] of layout.records.entries()) {
    const [bundle, size] = layout.table[bi]!;
    const fresh = freshBySha.get(bundle);
    if (fresh) {
      if (fresh.byteLength !== size)
        throw new Error(
          `Self-check: new bundle ${bundle.slice(0, 12)}… is ${fresh.byteLength} bytes, its table says ${size}.`,
        );
      const s = frames.get(id);
      if (
        !s ||
        s.stored.byteLength !== clen ||
        Buffer.compare(
          Buffer.from(fresh.subarray(offset, offset + clen)),
          Buffer.from(s.stored),
        ) !== 0
      )
        throw new Error(
          `Self-check: chunk record ${i} does not name its stored bytes in bundle ${bundle.slice(0, 12)}…`,
        );
      continue;
    }
    const p = reuse.get(id);
    if (
      !p ||
      p.bundle !== bundle ||
      p.bundleSize !== size ||
      p.offset !== offset ||
      p.clen !== clen
    )
      throw new Error(
        `Self-check: chunk record ${i} reuses a location the proven prior index${base ? ` (${base.version})` : ""} does not give; nothing was published.`,
      );
  }
  // Lint: the same input lays out to the same index.
  const again = writeChunkIndex({
    ...doc,
    ...(() => {
      const l = layoutChunks(chunks, stored, CHUNK_PARAMS.bundleTarget, reuse);
      return { records: l.records, bundles: l.table };
    })(),
  });
  if (Buffer.compare(Buffer.from(again), Buffer.from(bytes)) !== 0)
    throw new Error("Self-check: laying the chunks out twice differs.");

  // The index object, and client-core's parse bound to the payload (what ingest runs).
  const [index] = storeMany(z, [bytes]);
  const params: ChunkParams = {
    ...CHUNK_PARAMS,
    bundleLayout: base && reuse.size > 0 ? "shared" : "fresh",
  };
  const ref: ChunksRef = {
    format: CHUNKS_FORMAT,
    ...index!.ref,
    params,
  };
  const parsed = await parseChunkIndex(index!.stored, ref, payload, {
    decode: (frame, size) => wasmDecode(frame, size),
    maxBytes: maxIndexBytes,
  });
  if (!parsed.ok)
    throw new Error(
      `Self-check: the chunk index fails parseChunkIndex (${parsed.error}${parsed.chunk !== undefined ? ` at chunk ${parsed.chunk}` : ""}${parsed.bundle !== undefined ? ` at bundle ${parsed.bundle}` : ""}); nothing was published.`,
    );

  const bundles = new Map<string, Uint8Array>();
  for (const [sha, b] of freshBySha) bundles.set(sha, b);
  const reusedBundles = layout.table.filter(([sha]) => !bundles.has(sha));
  let reusedBytes = 0;
  const counted = new Set<string>();
  for (const [id, , clen, bi] of layout.records) {
    if (counted.has(id)) continue;
    counted.add(id);
    if (!bundles.has(layout.table[bi]![0])) reusedBytes += clen;
  }
  return {
    ref,
    index: index!,
    doc,
    bundles,
    stats: {
      chunks: chunks.length,
      uniqueChunks: firstAt.size,
      newBundles: bundles.size,
      reusedBundles: reusedBundles.length,
      reusedBytes,
      newBytes: [...bundles.values()].reduce((a, b) => a + b.byteLength, 0),
    },
  };
}
