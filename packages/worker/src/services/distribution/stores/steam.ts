/**
 * Steam's delivery facet (P0-27.2). No connector and no flow runtime: its delivery code is the
 * storefront admin module (`storefronts/steam/`), named here as its runtime.
 */

import { handleSteamStorefrontAdmin } from "../storefronts/steam/admin.js";
import type { DeliveryFacet } from "./facet.js";

export const STEAM_DELIVERY: DeliveryFacet = {
  store: "steam",
  connector: null,
  flow: null,
  storefrontAdmin: handleSteamStorefrontAdmin,
};
