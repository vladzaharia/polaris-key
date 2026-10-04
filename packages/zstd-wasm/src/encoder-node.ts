// @polaris-key/zstd-wasm/encoder, Node entry (P4-17): compiles the committed `zenc.wasm` once, on
// first use, and instantiates it per encode (`encoder.ts`).

import { readFileSync } from "node:fs";
import { createZstdEncoder, type ZstdEncoder } from "./encoder.js";

export {
  ZstdEncodeError,
  wasmWindowLogMax,
  type EncodeInput,
  type PatchFromOptions,
  type PatchFromResult,
  type ZstdEncodeErrorCode,
  type ZstdEncoder,
} from "./encoder.js";

let encoder: ZstdEncoder | null = null;
function get(): ZstdEncoder {
  if (encoder === null) {
    const bytes = readFileSync(new URL("./zenc.wasm", import.meta.url));
    encoder = createZstdEncoder(new WebAssembly.Module(bytes));
  }
  return encoder;
}

/** One verified `zstd --patch-from` frame (levels 1–15). */
export const patchFrom: ZstdEncoder["patchFrom"] = (opts) =>
  get().patchFrom(opts);
/** libzstd's version number (10507). */
export const encoderVersion: ZstdEncoder["version"] = () => get().version();
