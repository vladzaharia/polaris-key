/** Google Play's delivery facet (P0-27.2): the Play connector and the Google Play flow runtime. */

import { playConnector } from "../connectors/play/index.js";
import { GOOGLE_PLAY_FLOW } from "../storefronts/googlePlay.js";
import type { DeliveryFacet } from "./facet.js";

export const PLAY_DELIVERY: DeliveryFacet = {
  store: "google-play",
  connector: playConnector,
  flow: GOOGLE_PLAY_FLOW,
  storefrontAdmin: null,
};
