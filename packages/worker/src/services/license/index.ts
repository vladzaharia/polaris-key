/// <reference types="@cloudflare/workers-types" />

/**
 * The License service descriptor — one directory, one descriptor, nothing in Core learns the
 * name (design spec §5.1).
 *
 * This module is also the service's PUBLIC face for the pre-suite modules that have not been
 * carved yet: `requireLicensedDevice` is re-exported here so identity's browser session, the
 * portal and the OIDC flows keep the licence-gated token check they have always had while they
 * still live at the top level. Those are legacy call sites reaching INTO a service, which the
 * boundary rule permits in that direction only; the reverse — a service reaching back out —
 * is what it refuses.
 */

import type {
  DiscoveryContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import { handleLicenseRoutes } from "./routes.js";
import { handleLicenseAdmin } from "./admin/index.js";

export const licenseService: ServiceDescriptor = {
  slug: "license",
  handle: handleLicenseRoutes,
  /** `license/{licenses,tiers,policy}` on the console API (§R1). */
  adminHandle: handleLicenseAdmin,
  /** License's slice of `/.well-known/polaris.json` (design spec §4.3): the activation, token
   *  and document URLs a client needs to obtain and refresh a grant. */
  discoveryFragment: async ({ base }: DiscoveryContext) => ({
    enabled: true,
    endpoints: {
      activate: `${base}/license/activate`,
      enroll: `${base}/license/enroll`,
      token: `${base}/license/token`,
      deauthorize: `${base}/license/deauthorize`,
      document: `${base}/license/document`,
    },
  }),
};

// ── Compat surface for the not-yet-carved modules ────────────────────────────────────────────
export { requireLicensedDevice, type LicensedDeviceToken } from "./auth.js";
export { authorizeDevice, docProfile, tierExpiresAt } from "./authz.js";
export type { AuthzError } from "./authz.js";
export { authorizationError, shapeLicense } from "./activation.js";
