/// <reference types="@cloudflare/workers-types" />

/**
 * The Config service descriptor (design spec §5.1).
 *
 * Config is the service a product can run entirely on its own: signed settings distribution to
 * any registered device, with no licence anywhere in the picture (D-08). Everything it owns —
 * the catalog, the profiles, the signed config document, and edge minting — is reachable
 * without the License service being enabled.
 */

import type {
  DiscoveryContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import { handleConfigRoutes } from "./routes.js";
import { hasApprovedEdgeMintRecipes, mintIsPublic } from "./mint.js";
import { handleConfigAdmin } from "./admin/index.js";

export const configService: ServiceDescriptor = {
  slug: "config",
  handle: handleConfigRoutes,
  /** `config/{catalog,profiles,mint}` on the console API (§R1; `mint` is P0-12). */
  adminHandle: handleConfigAdmin,
  /**
   * Config's slice of `/.well-known/polaris.json` (design spec §4.3): the document and catalog
   * URLs, the catalog version a client should expect, and whether edge minting is available.
   *
   * `mint.available` is a CAPABILITY answer, not a route list. The per-recipe URLs are not
   * advertised: recipe ids are operator-chosen and a client that needs one was told which by the
   * catalog entry whose `delivery` is `edgeMint`. Publishing the inventory to anonymous callers
   * would enumerate a product's third-party integrations for nothing.
   *
   * It counts APPROVED recipes only (P0-12): a recipe that arrived by push and is still pending
   * operator approval cannot be minted, so advertising it would only send clients to a 404.
   */
  discoveryFragment: async ({ product, db, base }: DiscoveryContext) => ({
    enabled: true,
    schemaVersion: product.schemaVersion,
    endpoints: {
      document: `${base}/config/document`,
      schema: `${base}/config/schema`,
    },
    mint: {
      available: await hasApprovedEdgeMintRecipes(
        db,
        product.slug,
        mintIsPublic(product),
      ),
    },
  }),
};

export { handleConfigDocument, resolveConfigPayload } from "./document.js";
export { handleSchema } from "./schema.js";
export {
  getApprovedEdgeMintConfig,
  getEdgeMintConfig,
  handleMintAuth,
  handleMintToken,
  hasApprovedEdgeMintRecipes,
  mintIsPublic,
} from "./mint.js";
