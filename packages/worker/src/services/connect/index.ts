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
 * CC-02.1 landed the row, the descriptor and the coherence code, CC-02.2 the settings slice.
 * CC-06.1 serves the identity and devices routes (the roster, the certificate and K_disc) and
 * keeps the roster epoch in `connect_rings`; the relay routes are CC-07.3's.
 */

import type {
  DiscoveryContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import { connectIntegration } from "./integration.js";
import { connectProductDeletion } from "./productDeletion.js";
import { CONNECT_ROUTES } from "./routes.js";
import { CONNECT_RINGS_STORE, connectRingsStore } from "./subjectStore.js";
import { CONNECT_SETTINGS_SLICE } from "./settings.js";

export const connectService: ServiceDescriptor = {
  slug: "connect",
  contributes: {
    integration: connectIntegration,
    subjectStores: { [CONNECT_RINGS_STORE]: connectRingsStore },
    productDeletion: connectProductDeletion,
  },
  handle: CONNECT_ROUTES.handle,
  surface: CONNECT_ROUTES.surface,
  /** CC-02.2: the manifest switches and the product ceiling; CC-07.3 reads them. */
  settings: CONNECT_SETTINGS_SLICE,
  /**
   * `lan` is true: the LAN needs no Worker. `relay` and `interAccount` stay false until the relay
   * (CC-07.3) and inter-account links (CC-18) ship. An endpoint is `null` until its route is served
   * (WIRE-CONTRACT-V5 §15.9).
   */
  discoveryFragment: async ({ base }: DiscoveryContext) => ({
    enabled: true,
    lan: true,
    relay: false,
    interAccount: false,
    endpoints: {
      identity: `${base}/connect/identity`,
      devices: `${base}/connect/devices`,
      ticket: null,
    },
  }),
};
