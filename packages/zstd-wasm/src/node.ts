// @polaris-key/zstd-wasm, Node entry: compiles the committed `zdec.wasm` once, on first use,
// and instantiates it per decode (plans/P4-01.md §2.13).

import { readFileSync } from "node:fs";
import { createZstdWasm, type ZstdWasm } from "./core.js";

export {
  ZstdWasmError,
  type ZstdWasm,
  type ZstdWasmErrorCode,
} from "./core.js";

let decoder: ZstdWasm | null = null;
function get(): ZstdWasm {
  if (decoder === null) {
    const bytes = readFileSync(new URL("./zdec.wasm", import.meta.url));
    decoder = createZstdWasm(new WebAssembly.Module(bytes));
  }
  return decoder;
}

/** Decode exactly one zstd frame whose declared content size is `size`. */
export const decode: ZstdWasm["decode"] = (frame, size) =>
  get().decode(frame, size);
/** Decode one `zstd --patch-from` frame over `prefix`, refusing a window above
 *  2^`windowLogMax` before decoding. */
export const decodeWithPrefix: ZstdWasm["decodeWithPrefix"] = (
  frame,
  prefix,
  size,
  windowLogMax,
) => get().decodeWithPrefix(frame, prefix, size, windowLogMax);
/** libzstd's version number (10507). */
export const version: ZstdWasm["version"] = () => get().version();
