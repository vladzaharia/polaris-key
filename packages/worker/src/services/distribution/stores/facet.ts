/**
 * THE DELIVERY FACET (P0-27.2): Distribution's half of a store adapter.
 *
 * `core/stores/adapter.ts` declares each store once, as data. This is the service half: the
 * runtimes that already exist for the store, registered by storefront id. Rule 6 forbids a module
 * holding both this and Commerce's facet, so `test/surfaces/storeAdapters.test.ts` binds the two by id.
 * The facet modules import the connector and flow files where they are (decision P3: no moves).
 */

import type { StorefrontId } from "../../../core/storefront/adapter.js";
import type { DistributionConnector } from "../connectors/index.js";
import type { FlowRuntime } from "../storefronts/runtime.js";
import type { handleSteamStorefrontAdmin } from "../storefronts/steam/admin.js";

/** A store's storefront admin module, where it has one in place of a flow runtime (Steam). */
export type StorefrontAdminRuntime = typeof handleSteamStorefrontAdmin;

export interface DeliveryFacet {
  /** The storefront id, equal to the `StoreAdapter` it implements. */
  readonly store: StorefrontId;
  readonly connector: DistributionConnector | null;
  readonly flow: FlowRuntime | null;
  readonly storefrontAdmin: StorefrontAdminRuntime | null;
}
