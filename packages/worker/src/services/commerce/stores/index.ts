/**
 * THE COMMERCE FACET REGISTRY (P0-27.4): one facet per store that has in-app purchases, keyed by
 * the channel adapter id (decision P10). `polaris-key` has none until CM-02 (Stripe). A test binds
 * these to `core/stores/` `STORE_ADAPTERS[].commerce`, in both directions.
 */

import type { StorefrontId } from "../../../core/storefront/adapter.js";
import type { CommerceFacet } from "./facet.js";
import { APPLE_COMMERCE } from "./apple/facet.js";
import { PLAY_COMMERCE } from "./play/facet.js";
import { STEAM_COMMERCE } from "./steam/facet.js";

export type { CommerceFacet } from "./facet.js";

export const COMMERCE_FACETS: Readonly<
  Partial<Record<StorefrontId, CommerceFacet<any, any, any, any>>>
> = {
  "app-store": APPLE_COMMERCE,
  "google-play": PLAY_COMMERCE,
  steam: STEAM_COMMERCE,
};
