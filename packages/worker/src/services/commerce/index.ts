/// <reference types="@cloudflare/workers-types" />

/**
 * The Commerce service descriptor (slug `commerce`; plans/CM-29.md): store purchases that grant
 * licences and add-ons. It requires License (`commerce_requires_license`, ST-38's requirement
 * rule): a purchase becomes a licence flag through Core's `applyStoreGrant`, never an import.
 *
 * P6-01 built the bridge inside Distribution; CM-29 moved it here:
 *
 *   - `handle` (`bridge.ts`): the device routes `GET /<p>/commerce/binding` and
 *     `POST /<p>/commerce/claim`, and the two store notification hooks. The hooks keep their
 *     canonical URLs under `/<p>/distribution/hooks/{app-store,play-rtdn}` (`core/stores/hooks.ts`):
 *     the router matches them to this service and sets `storeHook`, and `/<p>/commerce/hooks/*`
 *     answers the registry's not-found.
 *   - `adminHandle` (`admin.ts`): `/manage/api/products/<slug>/commerce/…`, the store-product map
 *     and the per-store settings. Admin routes are dispatched without an enablement check, so the
 *     `409 commerce_requires_license` guard there is what refuses a write while License is off.
 *   - `scheduled` (`recheck.ts`): the acknowledgement retries, the Play voided-purchase poll and
 *     the Steam ownership re-check. It runs only while Commerce is on.
 *   - `storeProducts` (hook): the store-product map, read-only, for Distribution's catalog flows.
 *   - `licenseMerge`, `licenseDelete`, `licensingReconcile`: LICENCE-side contributions Core
 *     collects for every registered service WHATEVER its enablement, so a merge or a delete while
 *     Commerce is off still moves or removes the purchases.
 *
 * The store clients, credentials and events are Core's (`core/stores/`, P0-27a): this directory
 * imports only `core/`, `platform/`, `db/` and itself.
 */

import type {
  DiscoveryContext,
  ScheduledServiceContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import type { HookContext, StoreProducts } from "../../core/hooks.js";
import { handleCommerceAdmin } from "./admin.js";
import { COMMERCE_ROUTES } from "./routes.js";
import { commerceIntegration } from "./integration.js";
import { runCommerceTick, type CommerceTick } from "./recheck.js";
import { COMMERCE_SETTINGS_SLICE } from "./settingsSlice.js";
import {
  commerceDeleteContribution,
  commerceLicensingReconcile,
  commerceMergeStatements,
  getStoreProduct,
  listStoreProducts,
  type StoreProductRow,
} from "./state.js";

const mapping = (r: StoreProductRow) => ({
  store: r.store,
  storeProductId: r.store_product_id,
  deliverableId: r.deliverable_id,
  flag: r.flag,
});

/** `core/hooks.ts` `storeProducts`: the product's store-product map, read-only. */
function storeProducts(ctx: HookContext): StoreProducts {
  const product = ctx.product.slug;
  return {
    async list(store) {
      return (await listStoreProducts(ctx.db, product))
        .filter((r) => r.store === store)
        .map(mapping);
    },
    async get(store, storeProductId) {
      const row = await getStoreProduct(ctx.db, product, store, storeProductId);
      return row ? mapping(row) : null;
    },
  };
}

/** The commerce cron: fault-isolated, and a no-op for a product without a store set up. */
async function scheduled(
  ctx: ScheduledServiceContext,
): Promise<Record<string, unknown>> {
  let commerce: CommerceTick | { error: string };
  try {
    commerce = await runCommerceTick(ctx);
  } catch (e) {
    commerce = {
      error: `commerce: ${e instanceof Error ? e.message : "tick failed"}`,
    };
  }
  if ("error" in commerce) throw new Error(commerce.error);
  if (commerce.errors.length)
    throw new Error(commerce.errors.map((e) => `commerce ${e}`).join("; "));
  return { commerce };
}

export const commerceService: ServiceDescriptor = {
  slug: "commerce",
  contributes: { integration: commerceIntegration },
  settings: COMMERCE_SETTINGS_SLICE,
  handle: COMMERCE_ROUTES.handle,
  /**
   * The canonical surface. The two hooks stay under `/distribution/hooks/` (D1): they are
   * Commerce's routes at the stores' URLs, listed here so `routeCoverage` pins them to Commerce.
   */
  surface: COMMERCE_ROUTES.surface,
  /**
   * `{"enabled":true,"endpoints":{binding,claim}}` and nothing else: discovery never names a
   * store, a product id or a count (plans/CM-29.md §2).
   */
  discoveryFragment: async ({ base }: DiscoveryContext) => ({
    enabled: true,
    endpoints: {
      binding: `${base}/commerce/binding`,
      claim: `${base}/commerce/claim`,
    },
  }),
  storeProducts,
  licenseMerge: commerceMergeStatements,
  licenseDelete: commerceDeleteContribution,
  licensingReconcile: commerceLicensingReconcile,
  adminHandle: handleCommerceAdmin,
  scheduled,
};

export { APP_STORE_EVENTS, PLAY_EVENTS } from "./bridge.js";
