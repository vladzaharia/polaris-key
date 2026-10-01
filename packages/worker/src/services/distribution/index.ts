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
 * P2b-01 shipped the SKELETON every later package builds on; P2b-02 gave it outlets:
 *
 *   - `handle` matches no route (an empty route table), so every `/<p>/distribution/…` request
 *     gets Core's single not-found answer — the same one a disabled service gets.
 *   - its discovery fragment says "on, not configured, nothing to call yet" (no device-facing
 *     route exists until P2b-03/P2b-04).
 *   - `manifestIngest` (P2b-02, `outlets.ts`) applies `.pkey/distribution` — outlets with their
 *     identities and listings, and the resolved transport per deliverable per outlet — into
 *     `dist_outlets` / `dist_transports` on link and resync, through Core's ingest pipeline.
 *   - it implements two of Core's descriptor hooks (`core/hooks.ts`): `delivery` (the default
 *     transport `pkey-cdn` and empty availability until P2b-03/P2b-04) and `outletCapabilities`
 *     (P2b-02: the kind's default narrowed by any operator override, `capabilities.ts`; `null`
 *     for an outlet the product does not declare, or no longer declares).
 *   - its admin surface (`admin.ts`) lists the outlets and lets an operator narrow, never widen,
 *     an outlet's capabilities.
 *
 * It reads Release only through `ctx.hooks.releaseCatalog()` — never by import. The boundary
 * test allows exactly one cross-service edge (`update → release`) and this service is not it.
 */

import type { HookContext, OutletCapabilities } from "../../core/hooks.js";
import type {
  DiscoveryContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import { handleDistributionAdmin } from "./admin.js";
import { defaultCapabilities, effectiveCapabilities } from "./capabilities.js";
import { defaultDelivery } from "./delivery.js";
import {
  getOutlet,
  manifestIngestStatements,
  parseJsonColumn,
} from "./outlets.js";

/**
 * `core/hooks.ts` `outletCapabilities`: the capabilities in force for one of this product's live
 * outlets — its kind's default, narrowed by an operator's override. `null` for an outlet the
 * product does not declare (or has removed), and for a kind this build does not know: an unknown
 * outlet must never read as a permissive one.
 */
async function outletCapabilities(
  ctx: HookContext,
  outletId: string,
): Promise<OutletCapabilities | null> {
  const row = await getOutlet(ctx.db, ctx.product.slug, outletId);
  if (!row || row.removed_at !== null) return null;
  const defaults = defaultCapabilities(row.kind);
  if (!defaults) return null;
  const override =
    row.capabilities_source === "admin"
      ? parseJsonColumn(row.capabilities_json)
      : null;
  return { outletId, ...effectiveCapabilities(defaults, override) };
}

export const distributionService: ServiceDescriptor = {
  slug: "distribution",
  /** No routes yet: P2b-03 and P2b-04 add the first. `null` = Core's not-found answer. */
  handle: async () => null,
  /**
   * Distribution's slice of `/.well-known/polaris.json`. `configured: false` until the first
   * device-facing distribution route exists (P2b-03/P2b-04): a client must be able to tell "on but
   * nothing to call" from "on and serving". Declared outlets alone give a device nothing to call.
   */
  discoveryFragment: async (_ctx: DiscoveryContext) => ({
    enabled: true,
    configured: false,
    endpoints: {},
  }),
  /** `core/hooks.ts` `Delivery`: P2b-03 and P2b-04 fill it in. */
  delivery: defaultDelivery,
  /** `core/hooks.ts` `OutletCapabilities` (P2b-02). */
  outletCapabilities,
  /** `.pkey/distribution` → `dist_outlets` / `dist_transports` (P2b-02, `outlets.ts`). */
  manifestIngest: manifestIngestStatements,
  /** `/manage/api/products/<slug>/distribution/…` (P2b-02, `admin.ts`). */
  adminHandle: handleDistributionAdmin,
};
