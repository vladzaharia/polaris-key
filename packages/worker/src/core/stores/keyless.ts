/**
 * The keyless and first-party channels' store adapter declarations (P0-27.1): no connector, no
 * flow runtime, no commerce facet, no identity and no requirements. They are declared so that
 * `requirements()` answers every channel the catalogue lists. `polaris-key` has no commerce
 * facet until CM-02 (Stripe).
 */

import { FLATHUB_ADAPTER } from "../storefront/stores/flathub.js";
import { HOMEBREW_ADAPTER } from "../storefront/stores/homebrew.js";
import { POLARIS_KEY_ADAPTER } from "../storefront/stores/polarisKey.js";
import { SCOOP_ADAPTER } from "../storefront/stores/scoop.js";
import { SNAP_ADAPTER } from "../storefront/stores/snap.js";
import { WINGET_ADAPTER } from "../storefront/stores/winget.js";
import type { StoreAdapter } from "./adapter.js";

function keyless(storefront: StoreAdapter["storefront"]): StoreAdapter {
  return {
    id: storefront.id,
    storefront,
    delivery: { connector: null, flow: false },
    commerce: null,
    identity: [],
    requirements: [],
  };
}

export const KEYLESS_STORES: readonly StoreAdapter[] = [
  keyless(WINGET_ADAPTER),
  keyless(HOMEBREW_ADAPTER),
  keyless(SCOOP_ADAPTER),
  keyless(SNAP_ADAPTER),
  keyless(FLATHUB_ADAPTER),
  keyless(POLARIS_KEY_ADAPTER),
];
