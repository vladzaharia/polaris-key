// @polaris-key/node/packs — the Node side of packs (plans/P4-01.md §5 order 1, P4-06).

export {
  probePrefixDecoder,
  selectNodeZstd,
  wasmZstd,
  type NodeZstd,
  type NodeZstdInfo,
  type SelectNodeZstdOptions,
} from "./zstd.js";
export {
  PacksClient,
  type NodeEmbeddedPack,
  type NodePacksOptions,
  type PacksWiring,
} from "./client.js";
export {
  DirPackStorage,
  directoryTreeDigest,
  fileSource,
  measureFile,
  measureTree,
  walkTree,
  type DirPackStorageOptions,
} from "./storage.js";
export {
  FILES_TREE_HANDLER,
  // P4-16: the v3 pack-type handlers (data.json and l10n.table built in; ml.model registered by
  // the host with its budget; custom.<name> through registerHandler).
  DataJsonHandler,
  L10nTableHandler,
  MlModelHandler,
  bcp47Canonical,
  type DataJsonHandlerOptions,
  type L10nMessage,
  type L10nTable,
  type L10nTableHandlerOptions,
  type MlModel,
  type MlModelHandlerOptions,
  type ModelDescriptor,
  type PackCheckRefusal,
  type PackPayloadAccess,
  type StagedPack,
  PackError,
  type PackHandler,
  type PackInstall,
  type PackProgress,
  type PacksSnapshot,
} from "@polaris-key/client-core";
