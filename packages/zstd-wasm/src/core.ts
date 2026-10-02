// The decoder over one compiled `zdec.wasm` (plans/P4-01.md §2.13). Each call instantiates the
// module afresh: zdec.c's bump allocator never frees, so a decode's linear memory becomes
// garbage when the call returns, and no decode outlives its own memory (decision 36).

/** Why a decode was refused. `window`, `header`, `not-one-frame` and `size` are refused before
 *  any byte is decoded. */
export type ZstdWasmErrorCode =
  | "header"
  | "not-one-frame"
  | "size"
  | "window"
  | "memory"
  | "length"
  | "argument"
  | "decode";

export class ZstdWasmError extends Error {
  readonly code: ZstdWasmErrorCode;
  constructor(code: ZstdWasmErrorCode, message: string) {
    super(message);
    this.name = "ZstdWasmError";
    this.code = code;
  }
}

interface Exports {
  memory: WebAssembly.Memory;
  zd_alloc(n: number): number;
  zd_decode(
    dst: number,
    size: number,
    src: number,
    n: number,
    prefix: number,
    pn: number,
    wlm: number,
  ): bigint;
  zd_version(): number;
}

const REFUSALS: Record<number, [ZstdWasmErrorCode, string]> = {
  [-1]: [
    "header",
    "the frame header does not parse (or it is a skippable frame)",
  ],
  [-2]: ["not-one-frame", "the input is not exactly one zstd frame"],
  [-3]: [
    "size",
    "the frame's content size is absent or differs from the expected size",
  ],
  [-4]: ["window", "the frame's window is above 2^windowLogMax"],
  [-5]: ["memory", "the decoder could not allocate"],
  [-6]: ["length", "the decode produced another length"],
  [-7]: ["argument", "windowLogMax is outside 10..31"],
};

/** The largest output one wasm32 decode may produce here: 2 GiB. */
const MAX_SIZE = 2 ** 31;

export interface ZstdWasm {
  /** Decode exactly one zstd frame whose declared content size is `size`. Throws
   *  `ZstdWasmError` otherwise. */
  decode(frame: Uint8Array, size: number): Uint8Array;
  /**
   * Decode one `zstd --patch-from` frame with `prefix` as its raw-content prefix (the whole
   * base). Before decoding, refuses a frame whose header does not parse, whose window is above
   * 2^`windowLogMax` (§2.7 rule 3; `windowLogMax` an integer 10–31, `max(10, min(30,
   * ⌈log2(memBytes)⌉))` for this wasm32 decoder) or whose content size is not `size`.
   */
  decodeWithPrefix(
    frame: Uint8Array,
    prefix: Uint8Array,
    size: number,
    windowLogMax: number,
  ): Uint8Array;
  /** libzstd's `ZSTD_versionNumber()`: 10507 for 1.5.7. */
  version(): number;
}

function run(
  module: WebAssembly.Module,
  frame: Uint8Array,
  prefix: Uint8Array | null,
  size: number,
  windowLogMax: number,
): Uint8Array {
  if (!(frame instanceof Uint8Array))
    throw new ZstdWasmError("argument", "frame must be a Uint8Array");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE)
    throw new ZstdWasmError("argument", `size ${size} is not 0..2^31`);
  if (prefix !== null) {
    if (!(prefix instanceof Uint8Array))
      throw new ZstdWasmError("argument", "prefix must be a Uint8Array");
    if (
      !Number.isInteger(windowLogMax) ||
      windowLogMax < 10 ||
      windowLogMax > 31
    )
      throw new ZstdWasmError("argument", "windowLogMax is outside 10..31");
  }
  const x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  const put = (bytes: Uint8Array): number => {
    const p = x.zd_alloc(bytes.byteLength);
    if (p === 0)
      throw new ZstdWasmError("memory", "the decoder could not allocate");
    new Uint8Array(x.memory.buffer, p, bytes.byteLength).set(bytes);
    return p;
  };
  const src = put(frame);
  const pre = prefix === null ? 0 : put(prefix);
  const dst = x.zd_alloc(size);
  if (dst === 0)
    throw new ZstdWasmError("memory", "the decoder could not allocate");
  const r = Number(
    x.zd_decode(
      dst,
      size,
      src,
      frame.byteLength,
      pre,
      prefix === null ? 0 : prefix.byteLength,
      prefix === null ? 0 : windowLogMax,
    ),
  );
  if (r < 0) {
    const known = REFUSALS[r];
    if (known) throw new ZstdWasmError(known[0], known[1]);
    throw new ZstdWasmError("decode", `libzstd error ${-1000 - r}`);
  }
  // Copy out: the instance's memory is dropped with the instance.
  return new Uint8Array(x.memory.buffer, dst, size).slice();
}

/** A decoder over a compiled module. The Node and workerd entries call this once. */
export function createZstdWasm(module: WebAssembly.Module): ZstdWasm {
  return {
    decode: (frame, size) => run(module, frame, null, size, 0),
    decodeWithPrefix: (frame, prefix, size, windowLogMax) =>
      run(module, frame, prefix, size, windowLogMax),
    version: () =>
      (
        new WebAssembly.Instance(module, {}).exports as unknown as Exports
      ).zd_version(),
  };
}
