// `@polaris-key/node/core` — the always-on substrate: device principal, credential, trust, verified
// cache, monotonic clock floor, sync loop, telemetry, offline bundles, and the Node stores.
//
// A host that only wants Core (a headless daemon that ships settings and reports facts, with
// no licence at all) imports this and never pulls a service module.

export {
  CoreContext,
  InsecureBaseUrlError,
  normalizeBaseUrl,
  nowSec,
  DEFAULT_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type CoreOptions,
  type DocumentResult,
} from "./context.js";

export { TrustManager } from "./trust.js";
export { CacheManager, type CachedDoc, type LoadedCache } from "./cache.js";
export {
  TokenManager,
  chooseReacquireRoute,
  type ReacquireFn,
  type ReacquireInputs,
  type ReacquireRoute,
  type Reacquired,
  type TokenSource,
} from "./token.js";
export {
  sync,
  type DocOutcome,
  type SyncDeps,
  type SyncOptions,
  type SyncResult,
} from "./sync.js";
export {
  buildSnapshot,
  reportSnapshot,
  type ReportSnapshot,
} from "./telemetry.js";
export { importBundle, type ImportBundleResult } from "./bundle.js";

export {
  CACHE_VERSION,
  FileStore,
  InMemoryStore,
  KeyringStore,
  randomFallbackId,
  type CacheRecordV3,
  type KeyringStoreOptions,
  type Store,
  type StoreStatus,
} from "./store.js";
export {
  CACHEDIR_TAG_SIGNATURE,
  defaultDirBases,
  excludeFromBackup,
  resolveDirs,
  type BackupExclusion,
  type BackupHost,
  type DirOverrides,
  type DirsHost,
  type ProductDirs,
} from "./dirs.js";

export { copy, registerCopy, setCopyLocale, type CopyEntry } from "./copy.js";
