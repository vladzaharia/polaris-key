// @polaris-key/react/browser — the cookie-session OIDC transport (online-only).

export {
  BrowserAdapter,
  browserAdapter,
  splitSessionDoc,
  type BrowserAdapterOptions,
} from "./browserAdapter.js";
export {
  discoverProduct,
  parseDiscovery,
  parseServices,
  type DiscoverOptions,
  type DiscoveryDocument,
  type DiscoveryResult,
  type ServiceFragment,
} from "./discovery.js";
export { fetchCatalog, type CatalogRequestOptions } from "./catalog.js";
export {
  buildDownloadUrl,
  buildInstallUrl,
  fetchChangelog,
  type ReleaseRequestOptions,
} from "./release.js";
export {
  indexedDbOfflineStore,
  newDeviceId,
  type OfflineRecord,
  type OfflineStore,
} from "./offline.js";
