// The Node zstd backend for packs (plans/P4-01.md §2.7, §5 "zstd per SDK"; PARITY §6.2, §6.3).
//
// `node:zlib` has zstd from 22.15, but before 22.19 (and in 24.0–24.5) it silently ignores the
// `dictionary` option, so a `--patch-from` frame decodes as corruption; and engines allows 22.0,
// which has no zstd at all. So at start-up the backend decodes a tiny built-in prefix vector:
//
//   * plain frames go through `node:zlib` whenever it has zstd (streamed for a whole payload,
//     with the window bounded by the frame's content size), else the WASM decoder;
//   * `--patch-from` frames go through `node:zlib` only when the probe decoded the vector byte
//     for byte, else through `@polaris-key/zstd-wasm` (P = 30 there);
//   * `zstd-patch-from` is advertised when the prefix decoder the backend ended up with decodes
//     the vector — the WASM decoder always does, so a working install always advertises it.
//
// `node:zlib` detects the dictionary type itself, which §2.7 rule 3 allows only because rule 5
// keeps every published base from starting with the dictionary magic; the appliers refuse such a
// base before any decoder sees it. The window check runs in the appliers whatever the decoder.

import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import {
  READ_CHUNK,
  windowLogMax,
  type ByteSource,
  type ZstdPort,
} from "@polaris-key/client-core";

/** The zstd surface of `node:zlib` from 22.15, which `@types/node` for 22.0 does not declare. */
interface ZlibZstd {
  zstdDecompressSync(
    buf: Uint8Array,
    opts?: {
      dictionary?: Uint8Array;
      maxOutputLength?: number;
      params?: Record<number, number>;
    },
  ): Buffer;
  createZstdDecompress(opts?: {
    maxOutputLength?: number;
    params?: Record<number, number>;
  }): zlib.Gzip;
  constants: Record<string, number>;
}

/** `node:zlib`'s zstd, or null on a Node without it (before 22.15). */
function zlibZstd(): ZlibZstd | null {
  const z = zlib as unknown as Partial<ZlibZstd>;
  return typeof z.zstdDecompressSync === "function" &&
    typeof z.createZstdDecompress === "function" &&
    z.constants !== undefined
    ? (z as ZlibZstd)
    : null;
}

/** `ZSTD_d_windowLogMax` (libzstd's 100). */
function windowParam(z: ZlibZstd): number {
  return z.constants.ZSTD_d_windowLogMax ?? 100;
}

// ── The probe vector ───────────────────────────────────────────────────────────────────────
// A 432-byte base and a `zstd --patch-from` frame (zstd 1.5.7) that decodes over it to a
// 469-byte target. The base is generated, so only the 80-byte frame is a literal.

const PROBE_BASE = new TextEncoder().encode(
  Array.from(
    { length: 6 },
    (_, i) =>
      `polaris key probe line ${String(i).padStart(3, "0")}: the quick brown fox jumps over the lazy dog\n`,
  ).join(""),
);
const PROBE_FRAME = Uint8Array.from(
  "28b52ffd64d500150200540230736c65657079206361740a313278797a357461696c20616464656420666f70726f62650a0a00db6bf840c481b4bbab0c04d021809e01ca9ab04cf0c8b204205fff9e32"
    .match(/../g)!
    .map((h) => parseInt(h, 16)),
);
const PROBE_SIZE = 469;
const PROBE_SHA256 =
  "cb0e436ee45ab5d453e18dd20612ce36c56e371dbf940bc5cabd20fd0ef27c27";
/** base + target, so `windowLogMax` is 10. */
const PROBE_MEM_BYTES = 901;

/** Whether a prefix decoder turns the probe vector into its target, byte for byte. */
export async function probePrefixDecoder(
  decodeWithPrefix: ZstdPort["decodeWithPrefix"],
): Promise<boolean> {
  try {
    const out = await decodeWithPrefix(
      PROBE_FRAME,
      PROBE_BASE,
      PROBE_SIZE,
      windowLogMax(PROBE_MEM_BYTES)!,
    );
    return (
      out.byteLength === PROBE_SIZE &&
      createHash("sha256").update(out).digest("hex") === PROBE_SHA256
    );
  } catch {
    return false;
  }
}

/** Which decoder serves each kind of frame, for diagnostics and `caps`. */
export interface NodeZstdInfo {
  /** `node:zlib` or `wasm`, for plain frames. */
  plain: "node:zlib" | "wasm";
  /** `node:zlib` or `wasm`, for `--patch-from` frames. */
  prefix: "node:zlib" | "wasm";
  /** True when `node:zlib` has zstd but its dictionary option failed the probe. */
  dictionaryIgnored: boolean;
  /** `["zstd-patch-from"]` when the prefix decoder decodes the probe, else empty. */
  patchMethods: string[];
}

export interface NodeZstd {
  zstd: ZstdPort;
  info: NodeZstdInfo;
}

/** `@polaris-key/zstd-wasm` as a `ZstdPort` (wasm32: P = 30). */
export function wasmZstd(): ZstdPort {
  return {
    pointerBits: 30,
    decode: (frame, size) => wasmDecode(frame, size),
    decodeWithPrefix: (frame, prefix, size, wlm) =>
      wasmDecodeWithPrefix(frame, prefix, size, wlm),
  };
}

function zlibPlain(z: ZlibZstd): Pick<ZstdPort, "decode" | "decodeStream"> {
  return {
    decode(frame, size) {
      const out = z.zstdDecompressSync(frame, {
        maxOutputLength: Math.max(size, 1),
        params: { [windowParam(z)]: windowLogMax(size)! },
      });
      if (out.byteLength !== size) throw new Error("zstd: length");
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
    async decodeStream(frame: ByteSource, size, onChunk) {
      const d = z.createZstdDecompress({
        params: { [windowParam(z)]: windowLogMax(size)! },
      });
      const pump = (async () => {
        for (let at = 0; at < frame.size; ) {
          const chunk = await frame.read(
            at,
            Math.min(READ_CHUNK, frame.size - at),
          );
          if (chunk.byteLength === 0) break;
          at += chunk.byteLength;
          if (!d.write(chunk))
            await new Promise<void>((resolve, reject) => {
              d.once("drain", resolve);
              d.once("error", reject);
            });
        }
        d.end();
      })();
      pump.catch(() => d.destroy());
      let total = 0;
      for await (const chunk of d as AsyncIterable<Buffer>) {
        total += chunk.byteLength;
        if (total > size) {
          d.destroy();
          throw new Error("zstd: overrun");
        }
        await onChunk(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        );
      }
      await pump;
      if (total !== size) throw new Error("zstd: length");
    },
  };
}

function zlibPrefix(z: ZlibZstd): ZstdPort["decodeWithPrefix"] {
  return (frame, prefix, size, wlm: number) => {
    const out = z.zstdDecompressSync(frame, {
      dictionary: prefix,
      maxOutputLength: Math.max(size, 1),
      params: { [windowParam(z)]: wlm },
    });
    if (out.byteLength !== size) throw new Error("zstd: length");
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  };
}

export interface SelectNodeZstdOptions {
  /** `auto` (the default) probes `node:zlib`; `wasm` uses the WASM decoder for everything;
   *  `fail-probe` behaves as a Node whose dictionary option is ignored (tests). */
  mode?: "auto" | "wasm" | "fail-probe";
}

/** Pick this process's zstd backend (probed once per call). */
export async function selectNodeZstd(
  opts: SelectNodeZstdOptions = {},
): Promise<NodeZstd> {
  const wasm = wasmZstd();
  const z = opts.mode === "wasm" ? null : zlibZstd();
  let zlibPrefixOk = false;
  if (z !== null && opts.mode !== "fail-probe")
    zlibPrefixOk = await probePrefixDecoder(zlibPrefix(z));
  const plain = z !== null ? zlibPlain(z) : null;
  const zstd: ZstdPort = {
    pointerBits: zlibPrefixOk ? 31 : 30,
    decode: plain?.decode ?? wasm.decode,
    decodeWithPrefix: zlibPrefixOk ? zlibPrefix(z!) : wasm.decodeWithPrefix,
    ...(plain?.decodeStream ? { decodeStream: plain.decodeStream } : {}),
  };
  const prefixWorks =
    zlibPrefixOk || (await probePrefixDecoder(wasm.decodeWithPrefix));
  return {
    zstd,
    info: {
      plain: plain !== null ? "node:zlib" : "wasm",
      prefix: zlibPrefixOk ? "node:zlib" : "wasm",
      dictionaryIgnored: z !== null && !zlibPrefixOk,
      patchMethods: prefixWorks ? ["zstd-patch-from"] : [],
    },
  };
}
