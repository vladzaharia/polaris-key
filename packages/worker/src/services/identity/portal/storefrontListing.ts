/**
 * `storefrontListing(db, product)` (PS-02): one product's Polaris Key listing state, resolved from
 * Identity's `portal_product_settings` (migration 0074) with the `discover_enabled` dual-read
 * (`core/storefront/polarisKeyListing.ts` holds the values and the resolution). PS-03's obtain-path
 * engine reads it; PS-06's console edits the values through the portal-settings route.
 *
 * A product that never wrote a settings row reads the defaults: `auto`, `eligible`, every path
 * kind, no labels.
 */

import type { Db } from "../../../core/platform.js";
import {
  resolveListing,
  type StorefrontListing,
} from "../../../core/storefront/polarisKeyListing.js";
import { getPortalProductSettings } from "./repo.js";

export type { StorefrontListing } from "../../../core/storefront/polarisKeyListing.js";

export async function storefrontListing(
  db: Db,
  product: string,
): Promise<StorefrontListing> {
  return resolveListing(await getPortalProductSettings(db, product));
}
