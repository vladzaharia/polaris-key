/** itch.io's delivery facet (P0-27.2): a declaration only, with no runtime in this build. */

import type { DeliveryFacet } from "./facet.js";

export const ITCH_DELIVERY: DeliveryFacet = {
  store: "itch",
  connector: null,
  flow: null,
  storefrontAdmin: null,
};
