// @polaris-key/zstd-wasm, browser entry (`@polaris-key/zstd-wasm/browser`; P4-06). A page cannot
// compile a 69 KB module synchronously on its main thread (engines cap synchronous compiles at a
// few KB), so this entry is asynchronous: `loadZstdWasm()` fetches the committed `zdec.wasm`
// beside this file (bundlers resolve `new URL("./zdec.wasm", import.meta.url)` as an asset),
// compiles it once and returns the same decoder the Node and workerd entries expose. Each decode
// still instantiates the module afresh, so a decode's linear memory is garbage once it returns.

import { createZstdWasm, type ZstdWasm } from "./core.js";

export {
  ZstdWasmError,
  createZstdWasm,
  type ZstdWasm,
  type ZstdWasmErrorCode,
} from "./core.js";

let loading: Promise<ZstdWasm> | null = null;

/**
 * Compile `zdec.wasm` (once per page; later calls share the first) and return the decoder.
 * `source` overrides where the module comes from: a URL, the module's bytes, or an already
 * compiled `WebAssembly.Module` (a host that bundles the bytes itself).
 */
export function loadZstdWasm(
  source?: string | URL | ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<ZstdWasm> {
  if (source !== undefined) return compile(source).then(createZstdWasm);
  loading ??= compile(new URL("./zdec.wasm", import.meta.url))
    .then(createZstdWasm)
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}

async function compile(
  source: string | URL | ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source;
  if (source instanceof ArrayBuffer || source instanceof Uint8Array)
    return WebAssembly.compile(source as BufferSource);
  const res = await fetch(source);
  if (!res.ok)
    throw new Error(`zstd-wasm: fetching zdec.wasm failed (${res.status})`);
  return WebAssembly.compile(await res.arrayBuffer());
}
