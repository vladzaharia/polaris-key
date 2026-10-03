// `applyChunk`, chunk sync from seeds (plans/P4-10.md §2.5; notes/A7 §3.4; P4-11), over injected
// ports. `content/cases.json#applyCases` (`strategy: chunk`) pins every verdict and counter.
//
//  1. The target index is read by its ref and parsed bound to the variant's payload
//     (`parseChunkIndex`'s codes).
//  2. The seed map S: id → (seed, offset), first occurrence over seeds in order, then over each
//     seed's records in order. A seed whose index does not parse is skipped.
//  3. The request runs, the planner's rule exactly (`chunkRuns`): the records neither seeded nor
//     already fetched, in payload order; a fetched record joins the current run when it is in the
//     same bundle at `offset == prev.offset + prev.clen`. Seeded and duplicate records between two
//     contiguous fetched ones do not break a run. Each run is one single-range request.
//  4. For each target record in order: copy from a seed (not re-hashed: seeds were verified at
//     install), else copy from the output when the id was already written, else take the next
//     `clen` bytes of its run: fewer than `clen` → `chunk-bundle-truncated {chunk}`; a decode
//     error, a wrong length or a wrong SHA-256 → `chunk-corrupt {chunk}`.
//  5. The payload's SHA-256 → `payload-hash-mismatch`; with `repair`, A7's repair pass first:
//     every seed-sourced record whose bytes no longer hash to its id is refetched (one request per
//     record, not counted in `requests`) and reported in `repairedChunks`.
//
// Memory: the parsed index, the seed map and one chunk (`clen + len`, at most 2 ×
// `MAX_CHUNK_BYTES`); the output streams to the host's positional sink, never a buffer, and a run's
// body is read as it arrives. Nothing throws: a port that throws is the step's verdict, and a
// transport that fails or refuses is `network-error` with `detail` (`range-refused` makes the
// engine fall back to the next strategy; `interrupted` keeps the run journal for a resume).

import type { ChunkIndexDoc, ChunkRecord } from "@polaris-key/protocol/packs";
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNK_INDEX_BYTES,
} from "@polaris-key/protocol/core";
import { parseChunkIndex, type ChunkIndexErrorCode } from "./chunks.js";
import {
  readAll,
  webCryptoSha256,
  type ByteSink,
  type ByteSource,
  type ObjectPort,
  type Sha256Port,
  type ZstdPort,
} from "./ports.js";

/** One seed: an installed (or embedded) container payload whose chunk index is kept. */
export interface ChunkSeed {
  index: ChunkIndexDoc;
  payload: ByteSource;
}

/** A range request's answer, as the applier reads it. `ok`: the body (shorter than asked when the
 *  object ends inside the range, or the transfer was cut short). `refused`: the server answered
 *  with anything but the exact range of the same object (a `200`, another `Content-Range`, another
 *  `ETag`), so the strategy stops and the host falls back. A throw is an interrupted transfer. */
export type ChunkRangeResponse =
  | { status: "ok"; chunks: AsyncIterable<Uint8Array> }
  | { status: "refused" };

/** One single-range request: `length` bytes of bundle `bundle` (its SHA-256) from `offset`. */
export type ChunkRangeFetch = (req: {
  bundle: string;
  offset: number;
  length: number;
}) => Promise<ChunkRangeResponse>;

/** The output: a positional sink the applier can read back (duplicate copies, the repair pass,
 *  a resumed run's re-hash). */
export interface ChunkOutput extends ByteSink {
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ApplyChunkPorts {
  /** The stored target index, by the SHA-256 of its stored bytes. */
  objects: ObjectPort;
  zstd: ZstdPort;
  /** Default: WebCrypto over buffered input. */
  sha256?: Sha256Port;
  fetchRange: ChunkRangeFetch;
  output: ChunkOutput;
}

export interface ApplyChunkOptions {
  /** Run A7's repair pass when the rebuilt payload's hash fails. */
  repair?: boolean;
  /** Runs an earlier attempt completed (the run journal). Each record of such a run is read back
   *  from the output and re-hashed before reuse; one that differs refetches the whole run. */
  completedRuns?: ReadonlySet<number>;
  /** Called after every record of run `run` has been written (the engine persists its journal). */
  onRunDone?: (run: number) => void | Promise<void>;
  /** Called with the fetched bytes so far, after every run. */
  onProgress?: (fetchedBytes: number) => void;
}

export type ChunkApplyErrorCode =
  | ChunkIndexErrorCode
  | "chunk-bundle-truncated"
  | "chunk-corrupt"
  | "payload-hash-mismatch"
  | "network-error";

export interface ChunkApplyFailure {
  ok: false;
  error: ChunkApplyErrorCode;
  chunk?: number;
  bundle?: number;
  /** For `network-error`: `range-refused` (fall back) or `interrupted` (resume later). */
  detail?: "range-refused" | "interrupted";
}

export interface ChunkVerdictOk {
  ok: true;
  sha256: string;
  size: number;
  fetchedChunks: number;
  fetchedBytes: number;
  /** The single-range requests sent for runs (the planner adds one for the index). */
  requests: number;
  seedChunks: number;
  selfChunks: number;
  repairedChunks: number[];
}

export type ChunkVerdict = ChunkVerdictOk | ChunkApplyFailure;

/** One request run: its bundle index, byte range and the target records it carries, in order. */
export interface ChunkRun {
  bundle: number;
  offset: number;
  length: number;
  records: number[];
}

/**
 * The request runs over a target index given the seeded ids (plans/P4-10.md §2.5; the planner's
 * rule in `plan`): the records neither seeded nor already fetched, grouped while the bundle stays
 * the same and `offset == prev.offset + prev.clen`.
 */
export function chunkRuns(
  records: readonly ChunkRecord[],
  seeded: { has(id: string): boolean },
): ChunkRun[] {
  const runs: ChunkRun[] = [];
  const seen = new Set<string>();
  let prev: ChunkRecord | null = null;
  records.forEach((r, i) => {
    const [id, , clen, bundle, offset] = r;
    if (seeded.has(id) || seen.has(id)) return;
    seen.add(id);
    if (prev === null || bundle !== prev[3] || offset !== prev[4] + prev[2])
      runs.push({ bundle, offset, length: 0, records: [] });
    const run = runs[runs.length - 1]!;
    run.length = offset + clen - run.offset;
    run.records.push(i);
    prev = r;
  });
  return runs;
}

/** The seed map: id → [seed, offset], first occurrence over seeds in order, then records. */
export function seedMap(
  seeds: readonly ChunkSeed[],
): Map<string, [number, number]> {
  const s = new Map<string, [number, number]>();
  seeds.forEach((seed, si) => {
    let off = 0;
    for (const [id, len] of seed.index.records) {
      if (!s.has(id)) s.set(id, [si, off]);
      off += len;
    }
  });
  return s;
}

const fail = (
  error: ChunkApplyErrorCode,
  extra: Omit<ChunkApplyFailure, "ok" | "error"> = {},
): ChunkVerdict => ({ ok: false, error, ...extra });

/** Reads a run's body record by record, holding only the record being read. */
class RunReader {
  private readonly it: AsyncIterator<Uint8Array>;
  private pending: Uint8Array = new Uint8Array();
  private ended = false;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.it = chunks[Symbol.asyncIterator]();
  }

  /** Exactly `n` bytes, or fewer when the body ends first. Throws when the transfer fails. */
  async take(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let have = 0;
    while (have < n) {
      if (this.pending.byteLength === 0) {
        if (this.ended) break;
        const { done, value } = await this.it.next();
        if (done) {
          this.ended = true;
          break;
        }
        this.pending = value;
        continue;
      }
      const k = Math.min(n - have, this.pending.byteLength);
      out.set(this.pending.subarray(0, k), have);
      this.pending = this.pending.subarray(k);
      have += k;
    }
    return have === n ? out : out.subarray(0, have);
  }

  /** Stop reading (releases the body). */
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      await this.it.return?.();
    } catch {
      // Closing a body that already failed is not an error.
    }
  }
}

/**
 * `applyChunk(variant, seeds, ports, opts)` (plans/P4-10.md §2.5): the payload rebuilt into
 * `ports.output`, or the first failure. Never throws.
 */
export async function applyChunk(
  variant: {
    payload: { size: number; sha256: string };
    chunks?: unknown;
  },
  seeds: readonly ChunkSeed[],
  ports: ApplyChunkPorts,
  opts: ApplyChunkOptions = {},
): Promise<{ verdict: ChunkVerdict; index?: ChunkIndexDoc }> {
  const sha256 = ports.sha256 ?? webCryptoSha256;
  const payload = variant.payload;
  const ref = variant.chunks as
    | { sha256: string; bytes: number; size: number; codec: string }
    | undefined;
  let current: { error: ChunkApplyErrorCode; chunk?: number } = {
    error: "chunks-ref-mismatch",
  };
  let reader: RunReader | null = null;
  try {
    if (typeof ref !== "object" || ref === null)
      return { verdict: fail("chunks-ref-mismatch") };
    // 1. The target index, bounded before a byte is read (parseChunkIndex step 0 again).
    let stored: Uint8Array = new Uint8Array();
    if (
      typeof ref.bytes === "number" &&
      typeof ref.size === "number" &&
      ref.bytes <= MAX_CHUNK_INDEX_BYTES &&
      ref.size <= MAX_CHUNK_INDEX_BYTES
    ) {
      const src = await ports.objects(ref.sha256).catch(() => null);
      if (src !== null && src.size === ref.bytes) stored = await readAll(src);
    }
    const parsed = await parseChunkIndex(stored, ref, payload, {
      decode: (frame, size) => ports.zstd.decode(frame, size),
    });
    if (!parsed.ok) {
      const { ok: _ok, ...rest } = parsed;
      return { verdict: { ok: false, ...rest } };
    }
    const T = parsed.index;
    // A chunk longer than `MAX_CHUNK_BYTES` makes the strategy unusable (planTarget); refuse it
    // before anything is fetched or allocated.
    for (const [i, r] of T.records.entries())
      if (r[1] > MAX_CHUNK_BYTES)
        return { verdict: fail("chunk-corrupt", { chunk: i }), index: T };

    // 2–3. The seed map and the runs.
    const S = seedMap(seeds);
    const runs = chunkRuns(T.records, S);
    const runOf = new Map<number, number>();
    runs.forEach((run, k) => {
      for (const i of run.records) runOf.set(i, k);
    });
    const posOf: number[] = [];
    {
      let p = 0;
      for (const r of T.records) {
        posOf.push(p);
        p += r[1];
      }
    }
    const lastOfRun = new Map<number, number>();
    runs.forEach((run, k) =>
      lastOfRun.set(run.records[run.records.length - 1]!, k),
    );

    /** Decode and verify one fetched record's stored bytes. */
    const verify = async (
      i: number,
      raw: Uint8Array,
    ): Promise<Uint8Array | ChunkVerdict> => {
      const [id, len, clen] = T.records[i]!;
      if (raw.byteLength < clen)
        return fail("chunk-bundle-truncated", { chunk: i });
      let data: Uint8Array;
      if (clen === len) data = raw;
      else {
        try {
          const d = await ports.zstd.decode(raw, len);
          if (!(d instanceof Uint8Array))
            return fail("chunk-corrupt", { chunk: i });
          data = d;
        } catch {
          return fail("chunk-corrupt", { chunk: i });
        }
      }
      const h = sha256();
      h.update(data);
      if (data.byteLength !== len || (await h.digest()) !== id)
        return fail("chunk-corrupt", { chunk: i });
      return data;
    };

    /** One single-range request; a refusal or a throw is the verdict. */
    const open = async (
      bundle: number,
      offset: number,
      length: number,
    ): Promise<RunReader | ChunkVerdict> => {
      let res: ChunkRangeResponse;
      try {
        res = await ports.fetchRange({
          bundle: T.bundles[bundle]![0],
          offset,
          length,
        });
      } catch {
        return fail("network-error", { detail: "interrupted" });
      }
      if (res.status !== "ok")
        return fail("network-error", { detail: "range-refused" });
      return new RunReader(res.chunks);
    };

    /** Whether every record of a journalled run still hashes to its id in the output. */
    const runIntact = async (k: number): Promise<boolean> => {
      for (const i of runs[k]!.records) {
        const [id, len] = T.records[i]!;
        const got = await ports.output.read(posOf[i]!, len);
        const h = sha256();
        h.update(got);
        if (got.byteLength !== len || (await h.digest()) !== id) return false;
      }
      return true;
    };

    // 4. Every record, in payload order.
    const hasher = sha256();
    const kinds: ("seed" | "self" | "fetch")[] = [];
    const first = new Map<string, number>();
    const st = {
      fetchedChunks: 0,
      fetchedBytes: 0,
      seedChunks: 0,
      selfChunks: 0,
    };
    let requests = 0;
    let openRun = -1;
    let resumedRun = -1;
    for (let i = 0; i < T.records.length; i++) {
      const [id, len, clen] = T.records[i]!;
      const pos = posOf[i]!;
      current = { error: "chunk-corrupt", chunk: i };
      let data: Uint8Array;
      const seeded = S.get(id);
      if (seeded !== undefined) {
        const [si, so] = seeded;
        const got = await seeds[si]!.payload.read(so, len);
        if (got.byteLength === len) data = got;
        else {
          // A short seed keeps its place; the payload hash (or the repair pass) catches it.
          data = new Uint8Array(len);
          data.set(got.subarray(0, Math.min(len, got.byteLength)));
        }
        kinds.push("seed");
        st.seedChunks++;
      } else if (first.has(id)) {
        const f = first.get(id)!;
        data = await ports.output.read(f, len);
        kinds.push("self");
        st.selfChunks++;
      } else {
        const k = runOf.get(i)!;
        if (k !== openRun && k !== resumedRun) {
          if (reader !== null) await reader.close();
          reader = null;
          if (opts.completedRuns?.has(k) && (await runIntact(k)))
            resumedRun = k;
          else {
            const run = runs[k]!;
            const r = await open(run.bundle, run.offset, run.length);
            if (!(r instanceof RunReader)) return { verdict: r, index: T };
            reader = r;
            openRun = k;
            requests++;
          }
        }
        if (k === resumedRun) {
          data = await ports.output.read(pos, len);
        } else {
          let raw: Uint8Array;
          try {
            raw = await reader!.take(clen);
          } catch {
            return {
              verdict: fail("network-error", { detail: "interrupted" }),
              index: T,
            };
          }
          const got = await verify(i, raw);
          if (!(got instanceof Uint8Array)) return { verdict: got, index: T };
          data = got;
        }
        kinds.push("fetch");
        st.fetchedChunks++;
        st.fetchedBytes += clen;
      }
      if (!first.has(id)) first.set(id, pos);
      if (kinds[i] !== "fetch" || runOf.get(i) !== resumedRun)
        await ports.output.write(pos, data);
      hasher.update(data);
      const done = lastOfRun.get(i);
      if (done !== undefined) {
        if (reader !== null && openRun === done) {
          await reader.close();
          reader = null;
        }
        await opts.onRunDone?.(done);
        opts.onProgress?.(st.fetchedBytes);
      }
    }

    // 5. The payload hash, with the repair pass.
    const repaired: number[] = [];
    if ((await hasher.digest()) !== payload.sha256) {
      if (opts.repair !== true)
        return { verdict: fail("payload-hash-mismatch"), index: T };
      for (let i = 0; i < T.records.length; i++) {
        if (kinds[i] !== "seed") continue;
        const [id, len, clen, bundle, offset] = T.records[i]!;
        current = { error: "chunk-corrupt", chunk: i };
        const back = await ports.output.read(posOf[i]!, len);
        const h = sha256();
        h.update(back);
        if (back.byteLength === len && (await h.digest()) === id) continue;
        const r = await open(bundle, offset, clen);
        if (!(r instanceof RunReader)) return { verdict: r, index: T };
        let raw: Uint8Array;
        try {
          raw = await r.take(clen);
        } catch {
          return {
            verdict: fail("network-error", { detail: "interrupted" }),
            index: T,
          };
        } finally {
          await r.close();
        }
        const got = await verify(i, raw);
        if (!(got instanceof Uint8Array)) return { verdict: got, index: T };
        await ports.output.write(posOf[i]!, got);
        repaired.push(i);
      }
      current = { error: "payload-hash-mismatch" };
      const again = sha256();
      for (let at = 0; at < T.payloadSize; ) {
        const n = Math.min(1 << 20, T.payloadSize - at);
        const part = await ports.output.read(at, n);
        if (part.byteLength === 0) break;
        again.update(part);
        at += part.byteLength;
      }
      if ((await again.digest()) !== payload.sha256)
        return { verdict: fail("payload-hash-mismatch"), index: T };
    }
    return {
      verdict: {
        ok: true,
        sha256: payload.sha256,
        size: T.payloadSize,
        fetchedChunks: st.fetchedChunks,
        fetchedBytes: st.fetchedBytes,
        requests,
        seedChunks: st.seedChunks,
        selfChunks: st.selfChunks,
        repairedChunks: repaired,
      },
      index: T,
    };
  } catch {
    return {
      verdict:
        current.chunk === undefined
          ? fail(current.error)
          : fail(current.error, { chunk: current.chunk }),
    };
  } finally {
    if (reader !== null) await (reader as RunReader).close();
  }
}

/** A ranged object download as `chunkRangeFetch` reads it (the engine's `ObjectFetch`). */
type RangedObjectFetch = (req: {
  sha256: string;
  offset: number;
  length: number;
  ifRange: string | null;
}) => Promise<{
  status: number;
  contentRange: string | null;
  etag?: string | null;
  chunks: AsyncIterable<Uint8Array>;
}>;

const CONTENT_RANGE_RE = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/;

/**
 * The chunk strategy's `fetchRange` over the host's object fetch (plans/P4-10.md §2.5): one
 * single-range request per run, `Range: bytes=<o>-<o+len-1>` with `If-Range: "<bundle sha256>"`
 * (the host also sends `Accept-Encoding: identity` where it may). Only a `206` whose
 * `Content-Range` is exactly `bytes o-e/<size>` for the request is read, or one that starts at `o`
 * and ends at `<size> − 1 < e` (clipped at the object's end: the records past it are then
 * `chunk-bundle-truncated`); an `ETag`, when present, must be exactly the quoted bundle hash.
 * Anything else (a `200`, another range, another tag) is `refused`, and the body is never read.
 * The body is cut at the range's length.
 */
export function chunkRangeFetch(fetch: RangedObjectFetch): ChunkRangeFetch {
  return async ({ bundle, offset, length }) => {
    const tag = `"${bundle}"`;
    const res = await fetch({ sha256: bundle, offset, length, ifRange: tag });
    const end = offset + length - 1;
    const m =
      res.status === 206 && res.contentRange !== null
        ? CONTENT_RANGE_RE.exec(res.contentRange.trim())
        : null;
    let take = -1;
    if (
      m !== null &&
      (res.etag === undefined || res.etag === null || res.etag === tag)
    ) {
      const o = Number(m[1]);
      const e = Number(m[2]);
      const size = Number(m[3]);
      if (o === offset && e === end && end < size) take = length;
      else if (o === offset && e < end && e === size - 1 && e >= o)
        take = e - o + 1;
    }
    if (take < 0) {
      // Never read a refused body; release it.
      try {
        await res.chunks[Symbol.asyncIterator]().return?.();
      } catch {
        // Releasing a refused body is best effort.
      }
      return { status: "refused" };
    }
    return { status: "ok", chunks: capped(res.chunks, take) };
  };
}

/** At most `n` bytes of a body, then the body is released. */
async function* capped(
  chunks: AsyncIterable<Uint8Array>,
  n: number,
): AsyncGenerator<Uint8Array> {
  let left = n;
  if (left <= 0) return;
  for await (const c of chunks) {
    if (c.byteLength >= left) {
      yield c.subarray(0, left);
      return;
    }
    left -= c.byteLength;
    yield c;
  }
}
