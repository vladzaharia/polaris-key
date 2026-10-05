/// <reference types="@cloudflare/workers-types" />

/**
 * The Cloud Sync service descriptor (slug `sync`; plans/U-01.md §0, §6.4).
 *
 * Cloud Sync stores and syncs a signed-in person's user settings, collections and saves for one
 * product. It is its own service with its own toggle, off by default, and it requires Config (a
 * user setting is a catalog `config` key with a `user` block) and Identity (the Cloud Sync
 * principal is the account signed in on the device, as the product's pairwise subject; there is
 * no Cloud Sync without signing in). `validateServices` refuses the set otherwise
 * (`sync_requires_config`, `sync_requires_identity`), so the console's Services toggle cannot turn
 * Cloud Sync on without both, nor turn Identity or Config off while Cloud Sync is on.
 *
 * U-04 lands the slug, the descriptor and its discovery fragment only. The device routes under
 * `/<p>/sync`, the per-principal Durable Object and the D1 directory are U-05's (§2.2, §6.2);
 * saves are U-10's and collections U-09's. Until a route exists the descriptor answers no route
 * (`null` → Core's not-found), and the fragment advertises no endpoint: an SDK uses an endpoint
 * only when discovery names it (§2.5).
 */

import type {
  DiscoveryContext,
  ServiceDescriptor,
} from "../../core/registry.js";

export const syncService: ServiceDescriptor = {
  slug: "sync",
  handle: async () => null,
  /**
   * Cloud Sync's slice of `/.well-known/polaris.json` (plans/U-01.md §2.5). Each capability turns
   * true, and its endpoint appears, only when the package that serves it has shipped: `settings`
   * and `pull`/`push` with U-05, `collections` with U-09, `saves` with U-10. `limits` (the
   * product's licensed defaults, read through the settings resolver) arrive with U-05.
   */
  discoveryFragment: async (_ctx: DiscoveryContext) => ({
    enabled: true,
    settings: false,
    collections: false,
    saves: false,
    endpoints: { pull: null, push: null, saves: null },
  }),
};
