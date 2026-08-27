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

import type { ServiceDescriptor } from "../../core/registry.js";
import type { Env } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import { handleLicenseRoutes } from "./routes.js";

export const licenseService: ServiceDescriptor = {
  slug: "license",
  handle: handleLicenseRoutes,
  /**
   * License's slice of `/.well-known/polaris.json`. Core assembles the whole document from the
   * enabled services' fragments in T1.6; until then it is only reachable through the registry,
   * so this is the shape that lands there rather than a second discovery implementation.
   */
  discoveryFragment: async (product: Product, _env: Env) => ({
    enabled: true,
    endpoints: {
      activate: `/${product.slug}/license/activate`,
      enroll: `/${product.slug}/license/enroll`,
      token: `/${product.slug}/license/token`,
      deauthorize: `/${product.slug}/license/deauthorize`,
      document: `/${product.slug}/license/document`,
    },
  }),
};

// ── Compat surface for the not-yet-carved modules ────────────────────────────────────────────
export { requireLicensedDevice, type LicensedDeviceToken } from "./auth.js";
export { authorizeDevice, docProfile, tierExpiresAt } from "./authz.js";
export type { AuthzError } from "./authz.js";
export { authorizationError, shapeLicense } from "./activation.js";
