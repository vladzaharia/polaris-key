import type {
  AppConsentView,
  KeyPreview,
  LicenseChoiceView,
  ReplaceView,
  SignInContinueRequest,
  SignInRedirect,
  SignInRequestView,
} from "@polaris-key/protocol/identity";
import { sessionApi } from "./api/session.js";
import { accountApi } from "./api/account.js";
import { libraryApi } from "./api/library.js";
import { signinApi } from "./api/signin.js";
import { productApi } from "./api/product.js";
import { deviceLoginApi } from "./api/deviceLogin.js";
import { requestApi } from "./api/request.js";

export type {
  AppConsentView,
  KeyPreview,
  LicenseChoiceView,
  ReplaceView,
  SignInContinueRequest,
  SignInRedirect,
  SignInRequestView,
};

export type {
  PortalAccount,
  PortalMe,
  PortalProvider,
  PortalCapabilities,
  PortalSession,
} from "./api/session.js";
export type { PortalConnection, PortalSsoNext } from "./api/transport.js";
export { readSsoNext, PortalApiError, setPortalCsrf } from "./api/transport.js";
export type {
  PortalEntitlement,
  PortalLicenseOrigin,
  PortalLicenseSummary,
  PortalKey,
  PortalDevice,
  PortalLicenseDetail,
  PortalArtifact,
  PortalRelease,
  PortalStatus,
  PortalPresentation,
  PortalLicenseSeats,
  PortalLibrary,
  PortalLibraryItem,
  PortalLicensedItem,
  PortalEntryItem,
  PortalPreviewVerdict,
  PortalKeyPreview,
  PortalKeyEntries,
  PortalDiscoverReason,
  PortalDiscoverTerms,
  PortalObtainPathKind,
  PortalObtainPath,
  PortalStorefrontStore,
  PortalDiscoverOffer,
  PortalStorefrontProduct,
  PortalDiscoverClaim,
} from "./api/library.js";
export {
  isEntryItem,
  offerFromWire,
  storefrontProductFromWire,
} from "./api/library.js";
export type {
  PortalProductDevice,
  PortalProduct,
  PortalFileReason,
  PortalDownloadFile,
  PortalRecommendation,
  PortalStoreLink,
  PortalDownloads,
  PortalInstallSource,
  PortalPackageFeed,
  PortalRegistryToken,
  PortalPackageAccess,
  PortalPersonalToken,
  PortalReadableFeed,
  PortalLegacyToken,
  PortalPersonalTokens,
  PortalMintTokenInput,
} from "./api/product.js";
export type {
  PortalAvatar,
  PortalProfileSource,
  PortalProfileSourceOption,
  PortalBirthdateSource,
  PortalProfile,
  PortalProfileChange,
  PortalRemoveRefusal,
  PortalMethod,
  PortalMethodEmail,
  PortalPasskey,
  PortalLinkAccount,
  PortalLinkReason,
  PortalLinkView,
  PortalMethods,
  PortalEmailMethodStart,
} from "./api/account.js";
export type {
  PortalPasskeyOptions,
  PortalGate,
  PortalGateChoice,
  PortalEmailSent,
  PortalSignInFlow,
} from "./api/signin.js";
export type {
  PortalDeviceLoginStart,
  PortalDeviceLoginPoll,
  PortalDeviceLoginRequest,
} from "./api/deviceLogin.js";

/**
 * The portal's API client, composed from one object per area (`portal/api/<area>.ts`; the types
 * and the methods that use them live together). Every importer and test mock still reads this
 * file.
 */
export const portalApi = {
  ...sessionApi,
  ...accountApi,
  ...libraryApi,
  ...signinApi,
  ...productApi,
  ...deviceLoginApi,
  ...requestApi,
};
