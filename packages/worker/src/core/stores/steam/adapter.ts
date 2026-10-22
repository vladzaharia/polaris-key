/** Steam's store adapter declaration (P0-27.1). See `../adapter.ts`. */

import { STEAM_ADAPTER } from "../../storefront/stores/steam.js";
import type { StoreAdapter } from "../adapter.js";

// Steam has no connector and no flow runtime: its delivery code is the storefront's own
// admin/checklist/setup modules over `core/stores/steam/`.
export const STEAM_STORE: StoreAdapter = {
  id: "steam",
  storefront: STEAM_ADAPTER,
  delivery: { connector: null, flow: false },
  commerce: {
    store: "steam",
    verification: "steam.publisher-key",
    notification: "steam-microtxn",
    sku: "steam-package",
  },
  identity: ["appId"],
  requirements: [
    {
      kind: "credential",
      facet: "delivery",
      slot: "steam.publisher-key",
      ownKind: "steam-publisher-key",
    },
    {
      kind: "credential",
      facet: "commerce",
      slot: "steam.publisher-key",
      ownKind: "steam-publisher-key",
    },
  ],
};
