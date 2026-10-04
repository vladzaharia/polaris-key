// @polaris-key/zstd-wasm/encoder, workerd entry (P4-17): `zenc.wasm` is imported as a compiled
// `WebAssembly.Module` (wrangler's CompiledWasm rule; workerd compiles no WebAssembly bytes at
// request time) and instantiated per encode (`encoder.ts`).

import zenc from "./zenc.wasm";
import { createZstdEncoder } from "./encoder.js";

export {
  ZstdEncodeError,
  wasmWindowLogMax,
  type EncodeInput,
  type PatchFromOptions,
  type PatchFromResult,
  type ZstdEncodeErrorCode,
  type ZstdEncoder,
} from "./encoder.js";

const encoder = createZstdEncoder(zenc);

/** One verified `zstd --patch-from` frame (levels 1–15). */
export const patchFrom = encoder.patchFrom;
/** libzstd's version number (10507). */
export const encoderVersion = encoder.version;
