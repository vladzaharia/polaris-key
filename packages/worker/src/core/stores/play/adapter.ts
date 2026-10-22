/** Google Play's store adapter declaration (P0-27.1). See `../adapter.ts`. */

import { GOOGLE_PLAY_ADAPTER } from "../../storefront/stores/googlePlay.js";
import type { StoreAdapter } from "../adapter.js";

export const PLAY_STORE: StoreAdapter = {
  id: "google-play",
  storefront: GOOGLE_PLAY_ADAPTER,
  delivery: { connector: "play", flow: true },
  // The wire store id is `play`; the storefront id is `google-play` (the adapter maps the two).
  commerce: {
    store: "play",
    verification: "google-play.service-account",
    notification: "play-rtdn",
    sku: "play-product",
  },
  identity: ["packageName"],
  requirements: [
    {
      kind: "credential",
      facet: "delivery",
      slot: "google-play.service-account",
      ownKind: "google-service-account",
    },
    {
      kind: "credential",
      facet: "commerce",
      slot: "google-play.service-account",
      ownKind: "google-service-account",
    },
  ],
};
