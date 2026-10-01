/// <reference types="@cloudflare/workers-types" />

/**
 * The Distribution service descriptor — how releases REACH devices and outlets, and what state
 * they are in there (P2b-01, README §3.2 and §3.8).
 *
 * The chain is release ← distribution ← update: Release answers "what exists", Distribution
 * "how does it reach devices and outlets", Update "what should this installed copy do next".
 * Distribution will own outlets and transports, all byte delivery, availability per outlet,
 * outlet-scoped rollouts and halts, storefront feeds and the key inventory (P2b-02 to P2b-06,
 * P4-05, P4-14, P5-*).
 *
 * In P2b-01 it is the SKELETON every later package builds on:
 *
 *   - `handle` matches no route (an empty route table), so every `/<p>/distribution/…` request
 *     gets Core's single not-found answer — the same one a disabled service gets.
 *   - its discovery fragment says "on, not configured, nothing to call yet".
 *   - it implements two of Core's descriptor hooks (`core/hooks.ts`): `delivery` (no outlets
 *     yet: the default transport `pkey-cdn` and empty availability) and `outletCapabilities`
 *     (`null` for every outlet until P2b-02 declares outlets).
 *
 * It reads Release only through `ctx.hooks.releaseCatalog()` — never by import. The boundary
 * test allows exactly one cross-service edge (`update → release`) and this service is not it.
 */

import type {
  DiscoveryContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import { defaultDelivery } from "./delivery.js";

export const distributionService: ServiceDescriptor = {
  slug: "distribution",
  /** No routes yet: P2b-03 and P2b-04 add the first. `null` = Core's not-found answer. */
  handle: async () => null,
  /**
   * Distribution's slice of `/.well-known/polaris.json`. `configured: false` until outlets exist
   * (P2b-02): a client must be able to tell "on but nothing to call" from "on and serving".
   */
  discoveryFragment: async (_ctx: DiscoveryContext) => ({
    enabled: true,
    configured: false,
    endpoints: {},
  }),
  /** `core/hooks.ts` `Delivery`: P2b-03 and P2b-04 fill it in. */
  delivery: defaultDelivery,
  /** `core/hooks.ts` `OutletCapabilities`: there are no outlets until P2b-02. */
  outletCapabilities: async () => null,
};
