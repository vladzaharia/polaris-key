/// <reference types="@cloudflare/workers-types" />

// Product OIDC — the Identity service's sign-in engine (design spec §2.1, D-14).
//
// Each product has one server-selected OIDC provider (platform default or custom) plus
// product-scoped group mapping/provisioning. A browser sign-in mints/locates a license for the
// identity; generic provisioning hooks turn verified claims into entitlements + secrets. The
// CLI/loopback flow polls for a per-device token. ID tokens are verified against the issuer
// JWKS via jose (asymmetric algs only).
//
// ── THE ROUTE MOVE (§R1) ────────────────────────────────────────────────────────────────────
//
// Every surface here now answers under `/<p>/identity/auth/…`; `routes.ts` is the sub-router.
// The old top-level spellings are GONE — not aliased. Nothing external ships them: an SDK reads
// its URLs out of `/.well-known/polaris.json`, and the one place a path was ever pinned is an
// operator's IdP redirect-URI registration, which is per-product configuration an operator
// re-registers (`oidc_config.redirect_uris_json` moves with it — see `beginAuthFlow`).
//
// ── P0-20: THE SPLIT ────────────────────────────────────────────────────────────────────────
//
// This file is the barrel. The code lives in `productOidc/` (the HTTP flows) and in Core:
//
//   config.ts      the flow records, their store addresses, issuer resolution, rate limits
//   userCode.ts    the RFC 8628 user code (also `portal/deviceLogin.ts`'s)
//   browserFlow.ts GET  /auth/start          (`handleAuthStart`)
//   deviceFlow.ts  POST /auth/device/start, GET|POST /auth/device, /auth/device/verify
//                  (`handleAuthDeviceStart`, `handleAuthDeviceEntry`, `handleAuthDeviceVerify`)
//   pages.ts       the branded pages those flows render
//   callback.ts    GET  /auth/callback       (`handleAuthCallback`, `completeBrowserFlow`)
//   chooser.ts     the licence chooser       (`handleAuthChoose`)
//   deviceApproval.ts  the explicit approval of a device-code sign-in (I-37)
//   poll.ts        POST /auth/device/poll    (`handleAuthDevicePoll`, `authorizeAndMint`)
//   activate.ts    `activateFromIdentity`, the adapter over the issuance engine
//
//   core/licensing/issue.ts         `issueLicense`, the issuance engine, and the auto-issue policy
//   core/licensing/provisioning.ts  the provisioning hooks (verified claim -> entitlement/secret)

export type {
  AutoIssueGrant,
  AutoIssueGrantVia,
  IdentityPolicyGroup,
  OidcIdentity,
} from "../../core/licensing/issue.js";
export {
  identityIssuePolicy,
  previewIdentityIssue,
} from "../../core/licensing/issue.js";
export {
  applyProvisioning,
  mergeProvisionedOverrides,
  type ProvisioningDeclaredKeys,
} from "../../core/licensing/provisioning.js";
export { activateFromIdentity } from "./productOidc/activate.js";
export { deviceFlowKey, flowKey } from "./productOidc/config.js";
export {
  USER_CODE_ALPHABET,
  deviceUserKey,
  formatUserCode,
  generateUserCode,
  normalizeUserCode,
} from "./productOidc/userCode.js";
export { handleAuthStart } from "./productOidc/browserFlow.js";
export {
  handleAuthDeviceEntry,
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
} from "./productOidc/deviceFlow.js";
export { handleAuthCallback } from "./productOidc/callback.js";
export { handleAuthChoose } from "./productOidc/chooser.js";
export { handleAuthDeviceApprove } from "./productOidc/deviceApproval.js";
export { authorizeAndMint, handleAuthDevicePoll } from "./productOidc/poll.js";
