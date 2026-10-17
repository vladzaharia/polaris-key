/**
 * `@polaris-key/manifest/integration`: the one integration content generator (SP-33a, SDX-02).
 *
 * - `renderSdkConfig`: the generated configuration module per SDK (`pkey sdk --write`).
 * - `renderSdkSetup`: install, config and a kit-first start for one SDK.
 * - `renderUsage`: one feature's code per SDK, lane (kit, library, server) and framework.
 * - `sdkFit`: which SDK, host and framework fit a product and a repo.
 *
 * `renderFeedSetup` and `renderOutletBlock` stay siblings in the package root. The console, the CLI
 * and the docs call these functions; none keeps its own snippets.
 */

export {
  SDK_CONFIG_DEFAULT_OUT,
  SDK_CONFIG_MARKER,
  SDK_LANGS,
  isSdkLang,
  renderSdkConfig,
  type SdkConfigFacts,
  type SdkLang,
} from "./sdkConfig.js";
export {
  SDK_IDS,
  sdkFit,
  type FitPlatform,
  type RepoSignals,
  type SdkFit,
  type SdkHost,
  type SdkId,
  type SdkTarget,
} from "./fit.js";
export {
  DEFAULT_USAGE_CONTEXT,
  FEATURE_DOCS,
  INTEGRATION_FEATURES,
  INTEGRATION_LANES,
  SDK_KIT_DOCS,
  SDK_LIBRARY_DOCS,
  allUsageBlocks,
  renderUsage,
  usageFrameworks,
  type IntegrationBlock,
  type IntegrationFeature,
  type IntegrationLane,
  type UsageContext,
  type UsageLanguage,
} from "./usage.js";
export {
  DEFAULT_BASE_URL,
  SDK_LABELS,
  SDK_REGISTRY_ORIGIN,
  renderSdkSetup,
  sdkInstall,
  sdkInstallNote,
  type SdkConfigFile,
  type SdkSetup,
  type SdkSetupContext,
  type TrustPin,
} from "./setup.js";
export { pinFingerprint, sdkAddCommand, type PinFingerprint } from "./pins.js";
