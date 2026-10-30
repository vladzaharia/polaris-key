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
import { CONNECT_RING_LISTENER, connectRingListener } from "./ringListener.js";
import { launchGateOn } from "../../core/settings/platformRead.js";
import { handleConnectAdmin } from "./admin/index.js";
import { connectIntegration } from "./integration.js";
import { connectProductDeletion } from "./productDeletion.js";
import { CONNECT_ROUTES } from "./routes.js";
import { CONNECT_RINGS_STORE, connectRingsStore } from "./subjectStore.js";
import { CONNECT_SETTINGS_SLICE } from "./settings.js";

import type { Env } from "../../platform/env.js";
import { pokeRelayRoom } from "./do/client.js";
import { setRelayPokePort } from "./relayPoke.js";

/**
 * CC-07.4: point the ring's poke port at the relay for this deployment. The entry point calls it
 * on every request and scheduled run (cheap, idempotent), because the port holds the bindings.
 */
export function installRelayPoke(env: Env): void {
  setRelayPokePort((poke) => pokeRelayRoom(env, poke));
}

/** The relay room class, re-exported for the Worker entry point. */
export { ConnectRelayDO } from "./do/relayDo.js";

export const connectService: ServiceDescriptor = {
  slug: "connect",
  contributes: {
    integration: connectIntegration,
    subjectStores: { [CONNECT_RINGS_STORE]: connectRingsStore },
    productDeletion: connectProductDeletion,
    /** CC-06.3: the primary path that moves the roster epoch. */
    onDeviceChange: { [CONNECT_RING_LISTENER]: connectRingListener },
  },
  // LG-1: with the launch gate off the routes do not exist (the registry's not-found).
  handle: async (ctx) =>
    (await launchGateOn(ctx.env, ctx.db, "launch.connect"))
      ? CONNECT_ROUTES.handle(ctx)
      : null,
  surface: CONNECT_ROUTES.surface,
  /** CC-16.W: `/manage/api/products/<slug>/connect/{people,usage}`, read-only. */
  adminHandle: handleConnectAdmin,
  /** CC-02.2: the manifest switches and the product ceiling; CC-07.3 reads them. */
  settings: CONNECT_SETTINGS_SLICE,
  /**
   * `lan` is true: the LAN needs no Worker. `relay` is true while `launch.relay` is on and the room
   * is bound (CC-07.3); `interAccount` stays false until inter-account links (CC-19) ship. An endpoint is `null` until its route is served
   * (WIRE-CONTRACT-V5 §15.9).
   */
  discoveryFragment: async ({ base, env, db }: DiscoveryContext) => {
    // LG-1: gate off reads as the service off (V5 §15.9: `{"enabled":false}`), the one shape
    // every SDK already treats as "do not try".
    if (!(await launchGateOn(env, db, "launch.connect")))
      return { enabled: false };
    // The relay is offered only while `launch.relay` is on and the room is bound (CC-07.3).
    const relay =
      env.CONNECT_RELAY !== undefined &&
      (await launchGateOn(env, db, "launch.relay"));
    return {
      enabled: true,
      lan: true,
      relay,
      interAccount: false,
      endpoints: {
        identity: `${base}/connect/identity`,
        devices: `${base}/connect/devices`,
        ticket: relay ? `${base}/connect/relay/ticket` : null,
      },
    };
  },
};
