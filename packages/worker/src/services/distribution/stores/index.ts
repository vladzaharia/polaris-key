/**
 * THE DELIVERY FACET REGISTRY (P0-27.2): one line per store that has delivery code. The connector
 * list and the flow-runtime list are derived from it, in today's order (connectors asc, play,
 * ms-store; flows app-store, google-play, microsoft-store). Adding a store's runtime is its facet
 * module plus one line here.
 */

import type { DistributionConnector } from "../connectors/index.js";
import type { FlowRuntime } from "../storefronts/runtime.js";
import { APPLE_DELIVERY } from "./apple.js";
import type { DeliveryFacet } from "./facet.js";
import { ITCH_DELIVERY } from "./itch.js";
import { MICROSOFT_STORE_DELIVERY } from "./microsoftStore.js";
import { PLAY_DELIVERY } from "./play.js";
import { STEAM_DELIVERY } from "./steam.js";

export const DELIVERY_FACETS: readonly DeliveryFacet[] = [
  APPLE_DELIVERY,
  PLAY_DELIVERY,
  MICROSOFT_STORE_DELIVERY,
  STEAM_DELIVERY,
  ITCH_DELIVERY,
];

export const FACET_CONNECTORS: readonly DistributionConnector[] =
  DELIVERY_FACETS.flatMap((f) => (f.connector ? [f.connector] : []));

export const FACET_FLOW_RUNTIMES: readonly FlowRuntime[] =
  DELIVERY_FACETS.flatMap((f) => (f.flow ? [f.flow] : []));

export type { DeliveryFacet } from "./facet.js";
