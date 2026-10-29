// @polaris-key/ui-core/browser: the framework-neutral browser client and gate controller both
// web kits share (UI-KITS.md DL18). The browser adapter itself lives in ./sdk (the cookie and
// bearer transports, discovery, the offline store); `@polaris-key/react` re-exports it from its
// own subpaths, and `@polaris-key/elements` builds `<pk-gate config>` on the controller. Nothing
// here imports a framework.

export {
  GateDriver,
  createBrowserClient,
  handleOf,
  openManage,
  parseGateConfig,
  type BrowserClientSeams,
  type GateConfig,
  type GateDriverOptions,
  type GateSnapshot,
  type UpdateOffer,
} from "./driver.js";
export { gateInput, type ErrorLike, type GateStep } from "./input.js";
export { openLink, safeLink } from "./links.js";
export {
  BrowserAdapter,
  InsecureBaseUrlError,
  browserAdapter,
  type BrowserAdapterOptions,
} from "./sdk/browser/browserAdapter.js";
export { PolarisError } from "./sdk/core/index.js";
export type {
  OidcSignInHandle,
  PolarisAdapter,
  PolarisState,
} from "./sdk/core/index.js";
