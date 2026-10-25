/**
 * THE COMMERCE FACET REGISTRY (P0-27.4): one facet per store that has in-app purchases, keyed by
 * the channel adapter id (decision P10). `polaris-key` has none until CM-02 (Stripe). A test binds
 * these to `core/stores/` `STORE_ADAPTERS[].commerce`, in both directions.
 */

import type { Store } from "../../../core/licensing/storeGrants.js";
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

/** The facet serving a wire store id, or `undefined` for an unknown one (the caller fails closed). */
export function commerceFacetFor(
  store: Store,
): CommerceFacet<any, any, any, any> | undefined {
  for (const f of Object.values(COMMERCE_FACETS))
    if (f?.store === store) return f;
  return undefined;
}
