/**
 * Identity's public surface for the console (P0-17): the one module under
 * `services/identity/` that `console/` may import (`test/boundaries.test.ts`). It re-exports exactly
 * what the console uses; anything new the console needs from this service is added here.
 */

export type { AccountContext } from "./accounts/links.js";
export { platformMigrationReport } from "./accounts/platformMigration.js";
export {
  countListedUsersByProduct,
  deleteProductUserData,
  detachProductUserLicense,
  exportProductUser,
  type HolderMoveResult,
  licenseHolderMoves,
  listProductUsers,
  lookupProductUser,
  makeLicenseFloating,
  productUserDetail,
  reassignLicenseHolder,
  recordDevicesSignedOut,
  RELINK_DAILY_ALERT_COUNT,
  relinkLicense,
  type RelinkRefusal,
  undoRelink,
} from "./accounts/productUsers.js";
export {
  ALLOWED_ID_TOKEN_ALGS,
  ID_TOKEN_CLOCK_TOLERANCE,
  ID_TOKEN_MAX_AGE,
} from "./idToken.js";
export { storefrontTileView } from "./portal/discover.js";
export {
  getPortalProductSettings,
  portalProductSettingsView,
} from "./portal/repo.js";
export { storefrontAnalytics } from "./portal/store/analytics.js";
export { type Persona, previewPersona } from "./portal/store/obtain.js";
export { polarisKeyStatus } from "./portal/store/panelStatus.js";
export { SIGNIN_ENV } from "./providers/config.js";
