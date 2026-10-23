/**
 * itch.io's store adapter declaration (P0-27.1). A declaration only: itch.io has no client, no
 * credential and no events in this build (its code is the CI-plane declaration), and no commerce
 * facet until CM-27 spikes it.
 */

import { ITCH_ADAPTER } from "../../storefront/stores/itch.js";
import type { StoreAdapter } from "../adapter.js";

export const ITCH_STORE: StoreAdapter = {
  id: "itch",
  storefront: ITCH_ADAPTER,
  delivery: { connector: null, flow: false },
  commerce: null,
  identity: [],
  requirements: [],
};
