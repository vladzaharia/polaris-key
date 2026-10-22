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
 * without signing in). `validateServices` refuses a set with Cloud Sync on and either requirement
 * off (`sync_requires_config`, `sync_requires_identity`), so the console's Services switch cannot
 * turn Cloud Sync on without both (nothing is pulled on with it), and turning Identity or Config
 * off turns Cloud Sync off in the same write (`applyRequirementRule`).
 *
 * U-04 landed the slug, the descriptor, its settings slice and its discovery fragment. U-05 serves
 * the device routes under `/<p>/sync` (pull and push) from the per-principal Durable Object, and
 * the fragment names them; records are U-09's and files on records U-10's, so those stay off. An
 * SDK uses an endpoint only when discovery names it (WIRE-CONTRACT-V4 §13.5).
 */

import type {
  DiscoveryContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import { SYNC_SETTINGS_SLICE } from "./settings.js";

import { syncIntegration } from "./integration.js";
import { syncProductDeletion, syncProductPurge } from "./productDeletion.js";
import { syncMaintenance } from "./maintenance.js";
import { SYNC_ROUTES } from "./routes.js";
import { syncScheduled } from "./scheduled.js";
import { CLOUD_SYNC_STORE, cloudSyncStore } from "./subjectStore.js";

/** The Durable Object class, re-exported for the Worker entry point (a composition module reads
 *  a service only through its index). */
export { CloudSyncDO } from "./do/cloudSyncDo.js";

export const syncService: ServiceDescriptor = {
  slug: "sync",
  contributes: {
    integration: syncIntegration,
    // U-05.3: the directory row joins Core's subject-store merge, delete and export.
    subjectStores: { [CLOUD_SYNC_STORE]: cloudSyncStore },
    // U-05.8: a deleted product's objects are erased (purge), then its rows (statements).
    productPurge: syncProductPurge,
    productDeletion: syncProductDeletion,
    // U-05.9: the daily counters keep 90 days.
    maintenance: syncMaintenance,
  },
  /** U-05.9: the 15-minute per-product aggregate (`sync_product_usage`), on the connector tick. */
  scheduled: syncScheduled,
  handle: SYNC_ROUTES.handle,
  surface: SYNC_ROUTES.surface,
  /** The operator's product ceiling (plans/U-01b.md D6); the quota is an entitlement (D5). */
  settings: SYNC_SETTINGS_SLICE,
  /**
   * Cloud Sync's slice of `/.well-known/polaris.json` (plans/U-01b.md D9). Each capability turns
   * true, and its endpoint appears, only when the package that serves it has shipped: `settings`
   * and `pull`/`push` with U-05, `collections` with U-09, `saves` and `files` (the files on
   * records) with U-10. Discovery carries no quota: it depends on the requesting device's
   * licence, so the pull carries it.
   */
  discoveryFragment: async ({ base }: DiscoveryContext) => ({
    enabled: true,
    settings: true,
    collections: false,
    saves: false,
    endpoints: { pull: `${base}/sync`, push: `${base}/sync/ops`, files: null },
  }),
};
