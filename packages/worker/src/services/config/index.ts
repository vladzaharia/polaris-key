/// <reference types="@cloudflare/workers-types" />

/**
 * The Config service descriptor (design spec §5.1).
 *
 * Config is the service a product can run entirely on its own: signed settings distribution to
 * any registered device, with no licence anywhere in the picture (D-08). Everything it owns —
 * the catalog, the profiles, the signed config document, and edge minting — is reachable
 * without the License service being enabled.
 */

import type { ServiceDescriptor } from "../../core/registry.js";
import type { Env } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import { handleConfigRoutes } from "./routes.js";

export const configService: ServiceDescriptor = {
  slug: "config",
  handle: handleConfigRoutes,
  /** Config's slice of `/.well-known/polaris.json`; Core assembles the whole document in T1.6. */
  discoveryFragment: async (product: Product, _env: Env) => ({
    enabled: true,
    schemaVersion: product.schemaVersion,
    endpoints: {
      document: `/${product.slug}/config/document`,
      schema: `/${product.slug}/config/schema`,
    },
  }),
};

export { handleConfigDocument, resolveConfigPayload } from "./document.js";
export { handleSchema } from "./schema.js";
export { getEdgeMintConfig, handleMintAuth, handleMintToken } from "./mint.js";
