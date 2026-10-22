/** The Microsoft Store's store adapter declaration (P0-27.1). See `../adapter.ts`. */

import { MICROSOFT_STORE_ADAPTER } from "../../storefront/stores/microsoftStore.js";
import type { StoreAdapter } from "../adapter.js";

export const MICROSOFT_STORE: StoreAdapter = {
  id: "microsoft-store",
  storefront: MICROSOFT_STORE_ADAPTER,
  delivery: { connector: "ms-store", flow: true },
  commerce: null,
  identity: ["productId"],
  requirements: [
    {
      kind: "credential",
      facet: "delivery",
      slot: "microsoft-store.partner-center",
      ownKind: "ms-partner-center",
    },
  ],
};
