// The web side of packs (plans/P4-01.md §5 order 1, P4-06): `createBrowserPacks`, the OPFS store
// and the browser's zstd and SHA-256 ports.

export {
  WASM_MEM_BUDGET,
  browserZstd,
  defaultWebMemBudget,
  createBrowserPacks,
  hashWasmSha256,
  type BrowserPacks,
  type BrowserPacksOptions,
} from "./browserPacks.js";
export {
  opfsPackStore,
  type DirHandle,
  type FileHandle,
  type OpfsPackStore,
} from "./opfs.js";
export {
  FILES_TREE_HANDLER,
  PackError,
  memoryPackStateStore,
  memoryPackStorage,
  type PackEstimate,
  type PackHandler,
  type PackInstall,
  type PackProgress,
  type PacksSnapshot,
} from "@polaris-key/client-core";
