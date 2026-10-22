/** The Microsoft Store's delivery facet (P0-27.2): the msstore connector and its flow runtime. */

import { msStoreConnector } from "../connectors/msstore/index.js";
import { MICROSOFT_STORE_FLOW } from "../storefronts/microsoftStore.js";
import type { DeliveryFacet } from "./facet.js";

export const MICROSOFT_STORE_DELIVERY: DeliveryFacet = {
  store: "microsoft-store",
  connector: msStoreConnector,
  flow: MICROSOFT_STORE_FLOW,
  storefrontAdmin: null,
};
