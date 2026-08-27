// @polaris-key/react/identity — the Identity service's UI surface: sign-in / sign-out and the
// profile the signed license document carries.
//
// `supportsOidcLogin` is derived from the identity service's discovery fragment, so a product
// with no identity service offers no OIDC button rather than one that leads to a 404.

export { usePolarisAuth } from "../react/hooks.js";
export type { UsePolarisAuth } from "../react/hooks.js";
export {
  PolarisLogin,
  type PolarisLoginProps,
} from "../components/PolarisLogin.js";
export {
  PolarisLogout,
  type PolarisLogoutProps,
} from "../components/PolarisLogout.js";
export type { OidcSignInHandle } from "../core/index.js";
export type { DocProfile } from "@polaris-key/protocol/license";
