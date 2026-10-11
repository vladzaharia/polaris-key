// @polaris-key/react/identity — the headless profile/authentication hook. Render the shared
// sign-in form with `SignIn` from `@polaris-key/react/kit`.
//
// `supportsOidcLogin` is derived from the identity service's discovery fragment, so a product
// with no identity service offers no OIDC button rather than one that leads to a 404.
export { usePolarisAuth } from "../react/hooks.js";
export type { UsePolarisAuth } from "../react/hooks.js";
export type { OidcSignInHandle } from "../core/index.js";
export type { DocProfile } from "@polaris-key/protocol/license";
