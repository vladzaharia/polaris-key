/** The App Store's delivery facet (P0-27.2): the ASC connector and the App Store flow runtime. */

import { ascConnector } from "../connectors/asc/index.js";
import { APP_STORE_FLOW } from "../storefronts/appStore.js";
import type { DeliveryFacet } from "./facet.js";

export const APPLE_DELIVERY: DeliveryFacet = {
  store: "app-store",
  connector: ascConnector,
  flow: APP_STORE_FLOW,
  storefrontAdmin: null,
};
