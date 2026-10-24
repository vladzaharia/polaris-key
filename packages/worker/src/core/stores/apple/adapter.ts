/** The App Store's store adapter declaration (P0-27.1). See `../adapter.ts`. */

import { APP_STORE_ADAPTER } from "../../storefront/stores/appStore.js";
import type { StoreAdapter } from "../adapter.js";

export const APPLE_STORE: StoreAdapter = {
  id: "app-store",
  storefront: APP_STORE_ADAPTER,
  delivery: { connector: "asc", flow: true },
  commerce: {
    store: "app-store",
    verification: "app-store.in-app-purchase-key",
    notification: "app-store-server",
    sku: "app-store-product",
  },
  identity: ["appleId", "bundleId"],
  requirements: [
    {
      kind: "credential",
      facet: "delivery",
      slot: "app-store.api-key",
      ownKind: "asc-api-key",
    },
    {
      kind: "credential",
      facet: "commerce",
      slot: "app-store.in-app-purchase-key",
      ownKind: "app-store-server-key",
    },
    { kind: "app", facet: "commerce", field: "bundleId" },
  ],
};
