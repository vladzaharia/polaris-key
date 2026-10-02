// The content corpus's chunk half (plans/P4-10.md §2.3–§2.5, §4.2): the reference chunker
// (`fastcdc-2016-nc1`, a port of A7's `gen/fastcdc.cjs`, with §2.4's file-aware segments and
// padding rule), the bundle packer (shared along a chain), the `pkey-chunks/1` writer and parser,
// the `<ref>` mutations (`truncate`, `xor`, `putU16`, `putU32`, `putU64`) and the reference chunk
// applier (a port of A7's `content.mjs` chunk path with P4-01's kebab codes).
//
// `tools/gen-content-corpus.ts` uses it. Like that file it imports nothing it checks (P3-02's
// rule): every rule here is restated, never taken from `@polaris-key/client-core`.

import { createHash } from "node:crypto";
import { decode } from "@polaris-key/zstd-wasm";

// Restated literals (plans/P4-10.md §2.3).
export const CHUNKS_FORMAT = "pkey-chunks/1";
export const MAX_CHUNK_INDEX_BYTES = 16777216;
export const MAX_CHUNK_BYTES = 4194304;
const MAGIC = [0x50, 0x4b, 0x45, 0x59, 0x43, 0x48, 0x4e, 0x4b];
const HEADER_BYTES = 64;
const RECORD_BYTES = 48;
const FLAG_FILE_AWARE = 1;
const TWO_32 = 4294967296;
const TWO_53 = 9007199254740992;

const sha256Hex = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

function hexAt(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < at + n; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}
function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── the u64 rule ─────────────────────────────────────────────────────────────────────────────

/** A u64 read as `hi × 2^32 + lo` from two u32 reads, saturated at 2^53 (§2.3). */
export function getU64(dv: DataView, at: number): number {
  const v = dv.getUint32(at + 4, true) * TWO_32 + dv.getUint32(at, true);
  return v >= TWO_53 ? TWO_53 : v;
}
/** A u64 written as two u32 words, low first; `v` below 2^53. */
function putU64(dv: DataView, at: number, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`putU64 ${v}`);
  dv.setUint32(at, v % TWO_32, true);
  dv.setUint32(at + 4, Math.floor(v / TWO_32), true);
}

// ── `<ref>` mutations ────────────────────────────────────────────────────────────────────────

export type Mutation =
  | { op: "truncate"; length: number }
  | { op: "xor"; offset: number; value: number }
  | { op: "putU16"; offset: number; value: number }
  | { op: "putU32"; offset: number; value: number }
  | { op: "putU64"; offset: number; value: number };

/** Apply `<ref>` mutations in order to a copy (little-endian `put*`, `putU64` value < 2^53). */
export function mutateBytes(
  b: Uint8Array,
  muts: readonly Mutation[] | undefined,
): Uint8Array {
  if (!muts || muts.length === 0) return b;
  let out = b.slice();
  for (const m of muts) {
    if (m.op === "truncate") {
      out = out.slice(0, m.length);
      continue;
    }
    if (m.op === "xor") {
      out[m.offset] = out[m.offset]! ^ m.value;
      continue;
    }
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    if (m.op === "putU16") dv.setUint16(m.offset, m.value, true);
    else if (m.op === "putU32") dv.setUint32(m.offset, m.value, true);
    else putU64(dv, m.offset, m.value);
  }
  return out;
}

// ── `fastcdc-2016-nc1` (A7's `gen/fastcdc.cjs`, unchanged) ────────────────────────────────────

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

/** FastCDC over each segment (file-aware) — or over the whole payload when `segments` is null. */
export function chunkPayload(
  payload: Uint8Array,
  segments: readonly [number, number][] | null,
  avg: number,
): Chunk[] {
  const segs = segments ?? [[0, payload.byteLength] as [number, number]];
  const out: Chunk[] = [];
  for (const [so, ss] of segs)
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

// ── bundles (§2.4: unique chunks in first-use order, shared along a chain) ───────────────────

export type ChunkRecord = [
  id: string,
  len: number,
  clen: number,
  bundle: number,
  offset: number,
];

export interface ChunkIndexDoc {
  fileAware: boolean;
  payloadSize: number;
  payloadSha256: string;
  records: ChunkRecord[];
  bundles: [sha256: string, size: number][];
}

/**
 * Lay out a release's chunks: an id the prior index holds keeps its location (bundle, offset,
 * clen); every other unique chunk goes into new bundles in first-use order, a bundle closed
 * before it would pass `target`. The table lists bundles in the order records first reference
 * them. `stored(id)` is the chunk's stored bytes (one zstd frame, or raw when not smaller).
 */
export function layoutChunks(
  chunks: readonly Chunk[],
  stored: (id: string) => Uint8Array,
  target: number,
  prior: ChunkIndexDoc | null,
): { records: ChunkRecord[]; table: [string, number][]; fresh: Uint8Array[] } {
  const priorLoc = new Map<
    string,
    { sha: string; size: number; offset: number; clen: number }
  >();
  if (prior)
    for (const [id, , clen, bi, offset] of prior.records)
      if (!priorLoc.has(id)) {
        const [sha, size] = prior.bundles[bi]!;
        priorLoc.set(id, { sha, size, offset, clen });
      }
  const fresh: Uint8Array[][] = [];
  const freshLen: number[] = [];
  const placed = new Map<
    string,
    { key: string | number; offset: number; clen: number }
  >();
  for (const c of chunks) {
    if (placed.has(c.id)) continue;
    const p = priorLoc.get(c.id);
    if (p) {
      placed.set(c.id, { key: p.sha, offset: p.offset, clen: p.clen });
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
  const sizeOf = new Map<string, number>();
  if (prior) for (const [sha, size] of prior.bundles) sizeOf.set(sha, size);
  const keyOf = (k: string | number): string =>
    typeof k === "number" ? sha256Hex(freshBytes[k]!) : k;
  for (const b of freshBytes) sizeOf.set(sha256Hex(b), b.byteLength);
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

/** The `pkey-chunks/1` bytes of an index (§2.3, A7 §3.1). */
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

// ── `parseChunkIndex` (§2.3) ─────────────────────────────────────────────────────────────────

export type ChunkFailure = {
  ok: false;
  error: string;
  chunk?: number;
  bundle?: number;
};
export type ChunkParse = { ok: true; index: ChunkIndexDoc } | ChunkFailure;

const cfail = (
  error: string,
  at?: { chunk: number } | { bundle: number },
): ChunkFailure => ({ ok: false, error, ...(at ?? {}) });

/** Steps 1–10 over decoded index bytes (`payload` null skips step 10). */
export function refParseChunkIndexBytes(
  b: Uint8Array,
  payload: { size: number; sha256: string } | null,
): ChunkParse {
  if (b.byteLength < HEADER_BYTES) return cfail("chunks-bad-length");
  for (let i = 0; i < 8; i++)
    if (b[i] !== MAGIC[i]) return cfail("chunks-bad-magic");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(8, true) !== 1) return cfail("chunks-unsupported-version");
  if (dv.getUint16(10, true) !== RECORD_BYTES)
    return cfail("chunks-bad-record-size");
  const flags = dv.getUint32(12, true);
  if ((flags & ~FLAG_FILE_AWARE) !== 0) return cfail("chunks-bad-flags");
  const n = dv.getUint32(16, true);
  const nb = dv.getUint32(20, true);
  // Exact arithmetic (BigInt): 48 × count never wraps.
  if (
    BigInt(b.byteLength) !==
    BigInt(HEADER_BYTES) + BigInt(RECORD_BYTES) * (BigInt(n) + BigInt(nb))
  )
    return cfail("chunks-bad-length");
  const payloadSize = getU64(dv, 24);
  const bundles: [string, number][] = [];
  for (let j = 0; j < nb; j++) {
    const o = HEADER_BYTES + RECORD_BYTES * (n + j);
    if (dv.getUint32(o + 40, true) !== 0 || dv.getUint32(o + 44, true) !== 0)
      return cfail("chunks-reserved-nonzero", { bundle: j });
    bundles.push([hexAt(b, o, 32), getU64(dv, o + 32)]);
  }
  const records: ChunkRecord[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const o = HEADER_BYTES + RECORD_BYTES * i;
    const len = dv.getUint32(o + 32, true);
    const clen = dv.getUint32(o + 36, true);
    const bi = dv.getUint32(o + 40, true);
    const bo = dv.getUint32(o + 44, true);
    if (len === 0) return cfail("chunks-zero-length", { chunk: i });
    if (clen === 0 || clen > len) return cfail("chunks-bad-clen", { chunk: i });
    if (bi >= nb) return cfail("chunks-bad-bundle-ref", { chunk: i });
    if (bo + clen > bundles[bi]![1])
      return cfail("chunks-bad-bundle-range", { chunk: i });
    total += len;
    records.push([hexAt(b, o, 32), len, clen, bi, bo]);
  }
  if (total !== payloadSize) return cfail("chunks-size-mismatch");
  const payloadSha256 = hexAt(b, 32, 32);
  if (
    payload !== null &&
    (payloadSha256 !== payload.sha256 || payloadSize !== payload.size)
  )
    return cfail("chunks-payload-mismatch");
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

export interface ChunksRefLike {
  sha256: string;
  bytes: number;
  size: number;
  codec: string;
}

/** `parseChunkIndex(stored, ref, payload | null)` (§2.3), step 0 included. */
export function refParseChunkIndex(
  stored: Uint8Array,
  ref: ChunksRefLike,
  payload: { size: number; sha256: string } | null,
): ChunkParse {
  if (ref.size > MAX_CHUNK_INDEX_BYTES) return cfail("chunks-ref-mismatch");
  if (stored.byteLength !== ref.bytes || sha256Hex(stored) !== ref.sha256)
    return cfail("chunks-ref-mismatch");
  let b: Uint8Array;
  if (ref.codec === "none") b = stored;
  else if (ref.codec === "zstd") {
    try {
      b = decode(stored, ref.size);
    } catch {
      return cfail("chunks-ref-mismatch");
    }
  } else return cfail("chunks-ref-mismatch");
  if (b.byteLength !== ref.size) return cfail("chunks-ref-mismatch");
  return refParseChunkIndexBytes(b, payload);
}

// ── `applyChunk` (§2.5, A7 §3.4) ─────────────────────────────────────────────────────────────

export interface ChunkSeed {
  payload: Uint8Array;
  index: Uint8Array;
}

export type ChunkVerdict =
  | {
      ok: true;
      sha256: string;
      size: number;
      fetchedChunks: number;
      fetchedBytes: number;
      requests: number;
      seedChunks: number;
      selfChunks: number;
      repairedChunks: number[];
    }
  | ChunkFailure;

/**
 * The reference chunk applier. `objects(sha256)` is the blob store (the target index and the
 * bundles); a range request answers the object sliced to the range and clipped at its end. A run
 * (one request) continues while the bundle stays the same and `offset == prev.offset +
 * prev.clen`; a seeded or duplicate record between two fetched ones does not break it.
 */
export function refApplyChunk(
  variant: {
    payload: { size: number; sha256: string };
    chunks: ChunksRefLike;
  },
  seeds: readonly ChunkSeed[],
  objects: (sha256: string) => Uint8Array | null,
  repair: boolean,
): { verdict: ChunkVerdict; out?: Uint8Array } {
  const payload = variant.payload;
  const parsed = refParseChunkIndex(
    objects(variant.chunks.sha256) ?? new Uint8Array(),
    variant.chunks,
    payload,
  );
  if (!parsed.ok) return { verdict: parsed };
  const T = parsed.index;
  // The seed map: first occurrence over seeds in order, then over records.
  const S = new Map<string, [number, number]>();
  seeds.forEach((s, si) => {
    const p = refParseChunkIndexBytes(s.index, null);
    if (!p.ok) return;
    let off = 0;
    for (const [id, len] of p.index.records) {
      if (!S.has(id)) S.set(id, [si, off]);
      off += len;
    }
  });
  const range = (sha: string, start: number, len: number): Uint8Array => {
    const o = objects(sha);
    if (o === null || start >= o.byteLength) return new Uint8Array();
    return o.subarray(start, Math.min(o.byteLength, start + len));
  };
  // The request runs (the planner's rule), each fetched with one single-range request.
  interface Run {
    bi: number;
    start: number;
    len: number;
    buf: Uint8Array | null;
  }
  const runOf = new Map<number, Run>();
  const runs: Run[] = [];
  {
    const seen = new Set<string>();
    let prev: ChunkRecord | null = null;
    T.records.forEach((r, i) => {
      const [id, , clen, bi, bo] = r;
      if (S.has(id) || seen.has(id)) return;
      seen.add(id);
      if (prev === null || bi !== prev[3] || bo !== prev[4] + prev[2])
        runs.push({ bi, start: bo, len: 0, buf: null });
      const run = runs[runs.length - 1]!;
      run.len = bo + clen - run.start;
      runOf.set(i, run);
      prev = r;
    });
  }
  const fetchRecord = (
    i: number,
    r: ChunkRecord,
  ): Uint8Array | ChunkFailure => {
    const [id, len, clen, bi, bo] = r;
    const run = runOf.get(i);
    let raw: Uint8Array;
    if (run) {
      run.buf ??= range(T.bundles[run.bi]![0], run.start, run.len);
      raw = run.buf.subarray(bo - run.start, bo - run.start + clen);
    } else raw = range(T.bundles[bi]![0], bo, clen);
    if (raw.byteLength < clen)
      return cfail("chunk-bundle-truncated", { chunk: i });
    let data: Uint8Array;
    if (clen === len) data = raw;
    else {
      try {
        data = decode(raw, len);
      } catch {
        return cfail("chunk-corrupt", { chunk: i });
      }
    }
    if (data.byteLength !== len || sha256Hex(data) !== id)
      return cfail("chunk-corrupt", { chunk: i });
    return data;
  };
  const out = new Uint8Array(T.payloadSize);
  const first = new Map<string, number>();
  const kinds: ("seed" | "self" | "fetch")[] = [];
  const st = {
    fetchedChunks: 0,
    fetchedBytes: 0,
    seedChunks: 0,
    selfChunks: 0,
  };
  let pos = 0;
  for (let i = 0; i < T.records.length; i++) {
    const r = T.records[i]!;
    const [id, len, clen] = r;
    let data: Uint8Array;
    const seeded = S.get(id);
    if (seeded) {
      const [si, so] = seeded;
      data = seeds[si]!.payload.subarray(so, so + len);
      kinds.push("seed");
      st.seedChunks++;
    } else if (first.has(id)) {
      const f = first.get(id)!;
      data = out.subarray(f, f + len);
      kinds.push("self");
      st.selfChunks++;
    } else {
      const got = fetchRecord(i, r);
      if (!(got instanceof Uint8Array)) return { verdict: got };
      data = got;
      kinds.push("fetch");
      st.fetchedChunks++;
      st.fetchedBytes += clen;
    }
    if (!first.has(id)) first.set(id, pos);
    out.set(data, pos);
    pos += len;
  }
  const repaired: number[] = [];
  if (sha256Hex(out) !== payload.sha256) {
    if (!repair) return { verdict: cfail("payload-hash-mismatch") };
    pos = 0;
    for (let i = 0; i < T.records.length; i++) {
      const r = T.records[i]!;
      const len = r[1];
      if (
        kinds[i] === "seed" &&
        sha256Hex(out.subarray(pos, pos + len)) !== r[0]
      ) {
        runOf.delete(i);
        const got = fetchRecord(i, r);
        if (!(got instanceof Uint8Array)) return { verdict: got };
        out.set(got, pos);
        repaired.push(i);
      }
      pos += len;
    }
    if (sha256Hex(out) !== payload.sha256)
      return { verdict: cfail("payload-hash-mismatch") };
  }
  return {
    verdict: {
      ok: true,
      sha256: payload.sha256,
      size: out.byteLength,
      fetchedChunks: st.fetchedChunks,
      fetchedBytes: st.fetchedBytes,
      requests: runs.length,
      seedChunks: st.seedChunks,
      selfChunks: st.selfChunks,
      repairedChunks: repaired,
    },
    out,
  };
}
