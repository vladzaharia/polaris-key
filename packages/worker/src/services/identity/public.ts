/**
 * Identity's public surface for the console (P0-17): the one module under
 * `services/identity/` that `console/` may import (`test/boundaries.test.ts`). It re-exports exactly
 * what the console uses; anything new the console needs from this service is added here.
 */

export type { AccountContext } from "./accounts/links.js";
// ST-30: the console's door into accounts (cookie v2, `consoleSubject`).
export {
  accountMayOpenConsole,
  consoleAccountForMember,
  consoleAssertedEmail,
  consoleLinkedAccount,
  consoleVerifiedPrimaryEmail,
  consoleActorAliases,
  consoleDirectory,
  consoleDirectoryPeople,
  consoleDirectoryRead,
  type ConsoleDirectoryPerson,
  consoleRootHolders,
  type ConsoleDirectoryEntry,
  consoleMemberIdForIdpSub,
  consoleSignIn,
  consoleSubject,
  consolePasskeyCeremony,
  consoleRpId,
  listConsoleMethods,
  consolePasskeyAddable,
  markConsoleMethodStrong,
  type ConsoleMethod,
  type MarkStrongResult,
  consoleTokenSubject,
  consolePasskeyOptions,
  consolePasskeyAvailable,
  accountHasConsolePasskey,
  consolePasskeySignIn,
  type ConsolePasskeyRefusal,
  type ConsolePasskeySignInResult,
  endConsoleSession,
  endConsoleSessionsForAccount,
  type ConsoleIdentity,
  type ConsoleRefusal,
  type ConsoleSignInResult,
} from "./consoleAccount.js";
export {
  accountAddresses,
  accountsVerifyingEmail,
  accountsWithVerifiedPrimaryEmail,
} from "./accounts/repo.js";
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
// I-31: Platform → Connections (the operator's side of `identity_connections`).
export {
  changeDomain,
  connectionView,
  createConnection,
  deleteConnection,
  listConnectionViews,
  previewDiscovery,
  updateConnection,
  type ConnectionView,
  type DomainAction,
  type Refusal as ConnectionRefusal,
} from "./connections/admin.js";
export {
  startConnectionTest,
  takeTestResult,
} from "./connections/testSignIn.js";
export {
  SIGNIN_PROVIDER_KINDS,
  signInProviderConfigured,
  signInRegistration,
  signInRegistrations,
  signInSites,
} from "./providers/config.js";
export { turnstileEnabled } from "./card/turnstile.js";
// ST-34.5: the console's half of `pkey login` (the CLI purpose of PX-W14 device login).
export {
  DEVICE_LOGIN_APPROVE_LIMIT,
  cliDeviceLoginDecide,
  cliDeviceLoginLookup,
  type CliDeviceLoginView,
} from "./portal/deviceLogin.js";
