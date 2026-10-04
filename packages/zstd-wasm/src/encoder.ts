// The lazy-delta encoder over one compiled `zenc.wasm` (P4-17, notes/S-08 §6): one
// `zstd --patch-from` frame per call, with the parameters `zstd --single-thread -<level>
// --patch-from=<from> <to>` picks (not its exact bytes: test/encoder.test.ts), verified by decoding it over the base in the same instance before it
// is returned. Each call instantiates the module afresh (zenc.c's bump allocator never frees), so
// a job's linear memory is garbage once the call returns, and it never shares an instance.
//
// Peak linear memory is from + to + the level's match state (S-08 §4.2: ≈ 78 MiB for a 32 MiB
// pair at level 9). The caller enforces its size cap BEFORE calling (`maxInputBytes` refuses
// here too), because workerd enforces neither the isolate's 128 MB nor `cpu_ms` locally (S-08
// §2.5): a pair over the cap would pass every local test and fail only in production.

/** Why an encode was refused. */
export type ZstdEncodeErrorCode =
  /** The level is outside 1..15 (single-threaded levels ≥ 16 break down, S-08 §4.1). */
  | "level"
  /** An input is larger than `maxInputBytes`, or its sizes are not integers. */
  | "input-size"
  /** An input's stored bytes did not arrive with its declared length, or its frame did not decode. */
  | "input"
  /** An input's decoded SHA-256 is not the one the caller expects. */
  | "input-digest"
  /** The frame grew past `maxFrameBytes`; nothing is returned. */
  | "frame-too-large"
  /** The frame did not decode back to the target (the S-08 verify). */
  | "verify"
  /** The module could not allocate. */
  | "memory"
  /** libzstd refused a parameter or failed while encoding. */
  | "encode";

export class ZstdEncodeError extends Error {
  readonly code: ZstdEncodeErrorCode;
  constructor(code: ZstdEncodeErrorCode, message: string) {
    super(message);
    this.name = "ZstdEncodeError";
    this.code = code;
  }
}

/** One side of the pair, as it is stored: one zstd frame with its content size, or raw. */
export interface EncodeInput {
  /** The decoded length (the payload's size). */
  size: number;
  /** The stored length (`size` when `codec` is `none`). */
  bytes: number;
  /** `zstd`: one frame whose content size is `size`; `none`: the payload as is. */
  codec: "zstd" | "none";
  /** The decoded SHA-256 the caller expects (lowercase hex); checked before encoding. */
  sha256: string;
  /** The stored bytes, in order (an R2 body, or any byte chunks). */
  read(): ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
}

export interface PatchFromOptions {
  from: EncodeInput;
  to: EncodeInput;
  /** 1..15. P4-17 uses 9 (S-08 §6). */
  level: number;
  /** Refuse an input whose decoded size is above this (P4-17: `LAZY_DELTA_MAX_BYTES`). */
  maxInputBytes: number;
  /** Abandon the encode once the frame exceeds this many bytes (not worth keeping). */
  maxFrameBytes?: number;
}

export interface PatchFromResult {
  /** The bare frame: content size and checksum set, one frame. */
  frame: Uint8Array;
  /** SHA-256 of `frame`. */
  sha256: string;
  /** The frame's window log (the target's bit length plus one, as the CLI chooses it). */
  windowLog: number;
  /** Whether long-distance matching was on. */
  longMode: boolean;
  /** The first four bytes of the decoded base (`37 a4 30 ec` is the caller's to refuse). */
  baseHead: Uint8Array;
  /** The instance's linear memory at its peak, in bytes (the memory-budget tests read it). */
  memoryBytes: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  ze_alloc(n: number): number;
  ze_mark(): number;
  ze_reset(mark: number): void;
  ze_decode(
    dst: number,
    size: number,
    src: number,
    n: number,
    prefix: number,
    pn: number,
    wlm: number,
  ): bigint;
  ze_dbegin(
    dst: number,
    size: number,
    prefix: number,
    pn: number,
    wlm: number,
  ): number;
  ze_dstep(src: number, n: number): bigint;
  ze_dpos(): number;
  ze_begin(prefix: number, pn: number, srcSize: bigint, level: number): number;
  ze_info(i: number): number;
  ze_input(p: number, n: number): number;
  ze_step(out: number, cap: number): bigint;
  ze_remaining(): number;
  ze_version(): number;
}

/** wasm32 addresses 4 GiB; one side is bounded well below it. */
const MAX_SIDE = 2 ** 31;
const OUT_CHUNK = 1 << 20;
const IN_CHUNK = 1 << 17;
const HASH_CHUNK = 1 << 20;
const HEX64 = /^[0-9a-f]{64}$/;

function hexOf(buf: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

type DigestStreamCtor = new (
  algorithm: string,
) => WritableStream<ArrayBufferView> & {
  readonly digest: Promise<ArrayBuffer>;
};

/** SHA-256 of a view, in 1 MiB writes through workerd's `crypto.DigestStream` where it exists
 *  (no whole-buffer copy), else one `crypto.subtle.digest` (Node, tests). */
async function sha256Of(view: Uint8Array): Promise<string> {
  const Ctor = (crypto as unknown as { DigestStream?: DigestStreamCtor })
    .DigestStream;
  if (Ctor) {
    const sink = new Ctor("SHA-256");
    const w = sink.getWriter();
    for (let o = 0; o < view.byteLength; o += HASH_CHUNK)
      await w.write(
        view.subarray(o, Math.min(view.byteLength, o + HASH_CHUNK)),
      );
    await w.close();
    return hexOf(await sink.digest);
  }
  return hexOf(await crypto.subtle.digest("SHA-256", view.slice()));
}

async function* chunksOf(
  src: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in src) {
    yield* src as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (src as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function refusal(r: number): ZstdEncodeError {
  if (r === -5)
    return new ZstdEncodeError("memory", "the encoder could not allocate");
  if (r === -8)
    return new ZstdEncodeError("level", "the level is outside 1..15");
  return new ZstdEncodeError(
    "encode",
    `libzstd error ${r <= -1000 ? -1000 - r : r}`,
  );
}

/** libzstd's `ZSTD_compressBound`: the largest frame a `size`-byte input can produce. */
export function compressBound(size: number): number {
  const small = size < 128 * 1024 ? (128 * 1024 - size) >>> 11 : 0;
  return size + Math.floor(size / 256) + small;
}

/** The `windowLogMax` a wasm32 decoder uses for `memBytes` (WIRE-CONTRACT-V4 §2.6). */
export function wasmWindowLogMax(memBytes: number): number {
  const ceilLog2 = memBytes <= 1 ? 0 : (memBytes - 1).toString(2).length;
  return Math.max(10, Math.min(30, ceilLog2));
}

export interface ZstdEncoder {
  /** One verified `--patch-from` frame from `from` to `to`. Throws `ZstdEncodeError`. */
  patchFrom(opts: PatchFromOptions): Promise<PatchFromResult>;
  /** libzstd's `ZSTD_versionNumber()`: 10507 for 1.5.7. */
  version(): number;
}

export function createZstdEncoder(module: WebAssembly.Module): ZstdEncoder {
  return {
    version: () =>
      (
        new WebAssembly.Instance(module, {}).exports as unknown as Exports
      ).ze_version(),
    patchFrom: (opts) => patchFrom(module, opts),
  };
}

async function patchFrom(
  module: WebAssembly.Module,
  opts: PatchFromOptions,
): Promise<PatchFromResult> {
  const { from, to, level } = opts;
  if (!Number.isInteger(level) || level < 1 || level > 15)
    throw new ZstdEncodeError("level", "the level is outside 1..15");
  const cap = Math.min(opts.maxInputBytes, MAX_SIDE);
  for (const side of [from, to]) {
    if (
      !Number.isSafeInteger(side.size) ||
      !Number.isSafeInteger(side.bytes) ||
      side.size < 0 ||
      side.bytes < 0 ||
      (side.codec === "none" && side.bytes !== side.size) ||
      (side.codec !== "none" && side.codec !== "zstd") ||
      !HEX64.test(side.sha256)
    )
      throw new ZstdEncodeError(
        "input-size",
        "an input's sizes or codec are malformed",
      );
    if (side.size > cap || side.bytes > cap)
      throw new ZstdEncodeError(
        "input-size",
        `an input is larger than ${cap} bytes`,
      );
  }

  const x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  let peak = 0;
  const mem = (): Uint8Array => {
    const m = new Uint8Array(x.memory.buffer);
    if (m.byteLength > peak) peak = m.byteLength;
    return m;
  };
  const alloc = (n: number): number => {
    const p = x.ze_alloc(Math.max(1, n));
    if (p === 0)
      throw new ZstdEncodeError("memory", "the encoder could not allocate");
    mem();
    return p;
  };

  /** Stream one side's stored bytes, exactly `bytes` of them, to `sink` in chunks. */
  const stream = async (
    side: EncodeInput,
    sink: (chunk: Uint8Array) => void,
  ): Promise<void> => {
    let off = 0;
    for await (const chunk of chunksOf(side.read())) {
      if (off + chunk.byteLength > side.bytes)
        throw new ZstdEncodeError(
          "input",
          "an input is longer than its stored length",
        );
      sink(chunk);
      off += chunk.byteLength;
    }
    if (off !== side.bytes)
      throw new ZstdEncodeError(
        "input",
        "an input is shorter than its stored length",
      );
  };

  /**
   * Decode one frame, fed in chunks by `feed`, straight into dst[0..size) (`ze_dstep`: a stable
   * output buffer, so libzstd keeps no window of its own and the frame is never resident), with
   * an optional raw-content prefix and the windowLogMax libzstd enforces on this path. Throws
   * `input` (or the caller's code) unless exactly one frame of exactly `size` bytes arrived.
   */
  const decodeInto = async (
    dst: number,
    size: number,
    prefix: number,
    pn: number,
    wlm: number,
    feed: (sink: (chunk: Uint8Array) => void) => Promise<void>,
    code: ZstdEncodeErrorCode = "input",
  ): Promise<void> => {
    const rc = x.ze_dbegin(dst, size, prefix, pn, wlm);
    if (rc !== 0) throw refusal(rc);
    const inp = alloc(IN_CHUNK);
    let last = 1;
    await feed((chunk) => {
      for (let o = 0; o < chunk.byteLength; o += IN_CHUNK) {
        const part = chunk.subarray(
          o,
          Math.min(chunk.byteLength, o + IN_CHUNK),
        );
        if (last === 0)
          throw new ZstdEncodeError(code, "bytes follow the end of the frame");
        mem().set(part, inp);
        last = Number(x.ze_dstep(inp, part.byteLength));
        mem();
        if (last < 0)
          throw new ZstdEncodeError(code, `the frame did not decode (${last})`);
      }
    });
    if (last !== 0 || x.ze_dpos() !== size)
      throw new ZstdEncodeError(code, "the frame is not its declared size");
  };

  /**
   * Place one side's DECODED bytes in a fresh buffer and check their SHA-256. A `zstd` side is
   * decoded as it streams in, straight into the buffer (`ze_dstep`, a stable output buffer), so
   * its compressed bytes are never resident; the decoder context is reset away afterwards.
   */
  const place = async (side: EncodeInput): Promise<number> => {
    const dst = alloc(side.size);
    if (side.codec === "none") {
      let off = 0;
      await stream(side, (chunk) => {
        mem().set(chunk, dst + off);
        off += chunk.byteLength;
      });
    } else {
      const mark = x.ze_mark();
      await decodeInto(dst, side.size, 0, 0, 30, (sink) => stream(side, sink));
      x.ze_reset(mark);
    }
    const got = await sha256Of(mem().subarray(dst, dst + side.size));
    if (got !== side.sha256)
      throw new ZstdEncodeError(
        "input-digest",
        "an input's decoded SHA-256 is not the expected one",
      );
    return dst;
  };

  const base = await place(from);
  const baseHead = mem().slice(base, base + Math.min(4, from.size));
  const afterBase = x.ze_mark();
  const target = await place(to);

  const rc = x.ze_begin(base, from.size, BigInt(to.size), level);
  if (rc !== 0) throw refusal(rc);
  const windowLog = x.ze_info(0);
  const longMode = x.ze_info(1) === 1;
  if (x.ze_input(target, to.size) !== 0) throw refusal(-9);
  const out = alloc(OUT_CHUNK);
  // The frame goes straight into ONE buffer, preallocated at its largest allowed size, never into
  // a list of chunks and a copy: at the 32 MiB cap the JS side then holds the frame once while
  // linear memory is at its peak.
  const frameCap = opts.maxFrameBytes ?? compressBound(to.size);
  const frameBuf = new Uint8Array(frameCap);
  let frameBytes = 0;
  for (;;) {
    const w = Number(x.ze_step(out, OUT_CHUNK));
    mem();
    if (w < 0) throw refusal(w);
    if (w > 0) {
      if (frameBytes + w > frameCap)
        throw new ZstdEncodeError(
          "frame-too-large",
          `the frame grew past ${frameCap} bytes`,
        );
      frameBuf.set(mem().subarray(out, out + w), frameBytes);
      frameBytes += w;
    }
    if (x.ze_remaining() === 0) break;
  }
  const frame = frameBuf.subarray(0, frameBytes);

  // Verify (S-08 §6): drop the target and the context, keep the base resident, and decode the
  // frame over it, streamed in chunks, into a fresh buffer, with the window check every applier
  // makes (libzstd enforces windowLogMax on the streaming path).
  x.ze_reset(afterBase);
  const dst = alloc(to.size);
  const wlm = wasmWindowLogMax(from.size + to.size);
  await decodeInto(
    dst,
    to.size,
    base,
    from.size,
    wlm,
    async (sink) => {
      for (let o = 0; o < frame.byteLength; o += IN_CHUNK)
        sink(frame.subarray(o, Math.min(frame.byteLength, o + IN_CHUNK)));
    },
    "verify",
  );
  const decoded = await sha256Of(mem().subarray(dst, dst + to.size));
  if (decoded !== to.sha256)
    throw new ZstdEncodeError("verify", "the frame decoded to another target");
  return {
    frame,
    sha256: await sha256Of(frame),
    windowLog,
    longMode,
    baseHead,
    memoryBytes: peak,
  };
}
