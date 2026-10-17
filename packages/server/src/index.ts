// @polaris-key/server: gate a server route with the app's signed licence document, verified
// offline (framework drop-ins plan §5, WIRE-CONTRACT-V4 §14). The root is the Fetch core; the
// frameworks are subpaths: ./express, ./hono, ./next, and ./testing for unit tests.

export {
  createPolarisKey,
  headerFields,
  PolarisKeyError,
  type HeadersInput,
  type PolarisKey,
  type PolarisKeyOptions,
  type PolarisServerConfig,
  type Requirement,
  type RouteOptions,
  type VerdictStep,
} from "./core.js";
export {
  PolarisLicense,
  type PolarisAuth,
  type PolarisUser,
  type Problem,
} from "./context.js";
export {
  verifyLicenseDocument,
  type VerifiedLicense,
  type VerifyLicenseDocumentOptions,
} from "./verifyLicenseDocument.js";
export {
  POLARIS_REQUEST_HEADERS,
  HEADER_LICENSE,
  HEADER_DEVICE,
} from "@polaris-key/protocol/core";
export type { BackendRefusalCode } from "@polaris-key/client-core/backend";
