/**
 * Where each licence on the product page came from (PX-W6, docs/design/PORTAL.md §10.2 G8): the
 * License card's "Bought on Steam" or "Bought from <developer>".
 *
 * The facts are License's (`license_store_grants`, `licenses.origin`), so they are read through
 * License's `licenseProvenance` descriptor hook (`core/hooks.ts`) and never from its tables
 * (AGENTS.md rule 6). With License off, or no hooks, every licence's `purchase` is `null` and the
 * card keeps its "Bought from <developer>" fallback.
 *
 * What the customer is shown of a store grant: the store, its state and dates, and the flag it
 * grants ONLY when the developer marked that flag `userGrant` (the same rule the entitlement list
 * follows, `entitlements.ts`), with its customer-facing label. A hidden flag's grant still names
 * its store but carries `flag: null, label: null`, so a purchase never reveals a flag the
 * developer keeps out of the portal. No purchase key or hash is ever part of the answer.
 */

import type { ProductPublic } from "../../../core/products.js";
import type { Db } from "../../../db/types.js";
import type { PurchaseSourceKind } from "../../../core/hooks.js";
import type { PortalHooksFor } from "./api.js";
import { visibleCatalogFlags } from "./entitlements.js";

export interface PortalStoreGrant {
  store: string;
  state: "active" | "revoked";
  grantedAt: number;
  revokedAt: number | null;
  /** The flag's key, only when the developer shows it in the portal (`userGrant`). */
  flag: string | null;
  label: string | null;
}

export interface PortalPurchase {
  source: PurchaseSourceKind;
  /** For `store`: the store of the earliest active purchase. */
  store: string | null;
  stores: string[];
  grants: PortalStoreGrant[];
}

/**
 * Each licence's purchase source, keyed by licence id. Empty (so every licence reads `null`) when
 * License is off for the product or no hooks were provided.
 */
export async function purchasesFor(
  db: Db,
  product: ProductPublic,
  licenseIds: readonly string[],
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<Map<string, PortalPurchase>> {
  const out = new Map<string, PortalPurchase>();
  if (!hooksFor || licenseIds.length === 0) return out;
  const provenance = hooksFor(product, now).licenseProvenance();
  if (!provenance) return out;
  const sources = await provenance.purchaseSources(licenseIds);
  const visible = sources.some((s) => s.grants.length > 0)
    ? await visibleCatalogFlags(db, product.slug)
    : new Map();
  for (const s of sources) {
    out.set(s.licenseId, {
      source: s.kind,
      store: s.store,
      stores: s.stores,
      grants: s.grants.map((g) => {
        const entry = visible.get(g.flag);
        return {
          store: g.store,
          state: g.state,
          grantedAt: g.grantedAt,
          revokedAt: g.revokedAt,
          flag: entry ? g.flag : null,
          label: entry ? (entry.grantLabel ?? entry.label ?? g.flag) : null,
        };
      }),
    });
  }
  return out;
}
