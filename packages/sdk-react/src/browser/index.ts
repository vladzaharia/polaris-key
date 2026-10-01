// @polaris-key/react/browser — the cookie-session OIDC transport (online-only).

export {
  BrowserAdapter,
  browserAdapter,
  splitSessionDoc,
  WEB_OUTLET_STAMP,
  type BrowserAdapterOptions,
  type BrowserUpdateConfig,
} from "./browserAdapter.js";
export {
  buildDownloadUrlFor,
  decideBrowserUpdate,
  type BrowserDecideOptions,
  type BrowserDecideResult,
  type UpdateSlices,
} from "./update.js";
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
