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
 * CC-02.1 lands the row, the descriptor and the coherence code only: no route serves data yet
 * (the table is empty) and the service contributes nothing.
 */

import type { ServiceDescriptor } from "../../core/registry.js";
import { connectIntegration } from "./integration.js";
import { CONNECT_ROUTES } from "./routes.js";

export const connectService: ServiceDescriptor = {
  slug: "connect",
  contributes: { integration: connectIntegration },
  handle: CONNECT_ROUTES.handle,
  surface: CONNECT_ROUTES.surface,
  /** `{"enabled": true}` and nothing else: no endpoint is served yet (CC-06.2 adds them). */
  discoveryFragment: async () => ({ enabled: true }),
};
