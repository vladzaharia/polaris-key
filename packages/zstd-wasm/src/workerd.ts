// @polaris-key/zstd-wasm, workerd entry (the `workerd` export condition). workerd compiles no
// WebAssembly bytes at request time, so `zdec.wasm` is imported as a `WebAssembly.Module`
// (wrangler's CompiledWasm rule) and instantiated per decode: `zdec.c`'s bump allocator never
// returns memory, so each decode's linear memory is garbage once the call ends (decision 36).

import zdec from "./zdec.wasm";
import { createZstdWasm } from "./core.js";

export {
  ZstdWasmError,
  type ZstdWasm,
  type ZstdWasmErrorCode,
} from "./core.js";

const decoder = createZstdWasm(zdec);

/** Decode exactly one zstd frame whose declared content size is `size`. */
export const decode = decoder.decode;
/** Decode one `zstd --patch-from` frame over `prefix`, refusing a window above
 *  2^`windowLogMax` before decoding. */
export const decodeWithPrefix = decoder.decodeWithPrefix;
/** libzstd's version number (10507). */
export const version = decoder.version;
