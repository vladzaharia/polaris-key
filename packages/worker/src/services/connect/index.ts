/// <reference types="@cloudflare/workers-types" />

/**
 * The Cloud Connect service descriptor (slug `connect`; plans/CC-01-cloud-connect.md §2.9).
 *
 * Cloud Connect links a signed-in person's devices and moves data between them directly (Direct
 * Transfer), over the LAN or a relay. It is its own service with its own toggle, off by default,
 * and it requires Identity (the ring is the account's devices as the product's pairwise subject).
 * `validateServices` refuses a set with Cloud Connect on and Identity off
 * (`connect_requires_identity`).
 *
 * CC-02.1 lands the row, the descriptor and the coherence code: no route serves data yet (the
 * table is empty). CC-02.2 adds its settings slice.
 */

import type { ServiceDescriptor } from "../../core/registry.js";
import { connectIntegration } from "./integration.js";
import { CONNECT_ROUTES } from "./routes.js";
import { CONNECT_SETTINGS_SLICE } from "./settings.js";

export const connectService: ServiceDescriptor = {
  slug: "connect",
  contributes: { integration: connectIntegration },
  handle: CONNECT_ROUTES.handle,
  surface: CONNECT_ROUTES.surface,
  /** CC-02.2: the manifest switches and the product ceiling; CC-07.3 reads them. */
  settings: CONNECT_SETTINGS_SLICE,
  /** `{"enabled": true}` and nothing else: no endpoint is served yet (CC-06.2 adds them). */
  discoveryFragment: async () => ({ enabled: true }),
};
