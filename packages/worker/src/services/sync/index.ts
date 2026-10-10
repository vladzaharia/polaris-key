/// <reference types="@cloudflare/workers-types" />

/**
 * The Cloud Sync service descriptor (slug `sync`; plans/U-01.md §0, amended by plans/U-01b.md).
 *
 * Cloud Sync keeps a signed-in person's data for one product in two stores: synced settings
 * (every Editable catalog `config` key, plus undeclared open settings, on the shipped `config.*`
 * API) and records in declared collections, any of which may carry one file (`saves` is a record
 * template). It is its own service with its own toggle, off by default, and it requires Config
 * (a synced setting is a catalog `config` key) and Identity (the Cloud Sync principal is the
 * account signed in on the device, as the product's pairwise subject; there is no Cloud Sync
 * without signing in). `validateServices` refuses the set otherwise (`sync_requires_config`,
 * `sync_requires_identity`), so the console's Services toggle cannot turn Cloud Sync on without
 * both, nor turn Identity or Config off while Cloud Sync is on.
 *
 * U-04 landed the slug, the descriptor, its settings slice and its discovery fragment. The device
 * routes under `/<p>/sync` and the per-principal Durable Object are U-05's; records are U-09's and
 * files on records U-10's. Until a route exists the descriptor answers no route (`null` → Core's
 * not-found), and the fragment advertises no endpoint: an SDK uses an endpoint only when
 * discovery names it (WIRE-CONTRACT-V4 §13.5).
 */

import type {
  DiscoveryContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import { SYNC_SETTINGS_SLICE } from "./settings.js";

export const syncService: ServiceDescriptor = {
  slug: "sync",
  handle: async () => null,
  /** The operator's product ceiling (plans/U-01b.md D6); the quota is an entitlement (D5). */
  settings: SYNC_SETTINGS_SLICE,
  /**
   * Cloud Sync's slice of `/.well-known/polaris.json` (plans/U-01b.md D9). Each capability turns
   * true, and its endpoint appears, only when the package that serves it has shipped: `settings`
   * and `pull`/`push` with U-05, `collections` with U-09, `saves` and `files` (the files on
   * records) with U-10. Discovery carries no quota: it depends on the requesting device's
   * licence, so the pull carries it.
   */
  discoveryFragment: async (_ctx: DiscoveryContext) => ({
    enabled: true,
    settings: false,
    collections: false,
    saves: false,
    endpoints: { pull: null, push: null, files: null },
  }),
};
