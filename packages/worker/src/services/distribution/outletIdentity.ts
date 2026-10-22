/**
 * A store outlet's declared identity checked against the product's store-app binding (A-28.4).
 *
 * The manifest's `identity` on an app-store / play / ms-store / steam outlet names the app it
 * ships; `storeAppBindings` (Core) says which app the product is ASSIGNED on that store. When both
 * name a field and the values differ, the outlet is declared against another app than the one the
 * product holds, and the operator should know. A field either side leaves empty is not a mismatch,
 * nor is an ambiguous binding (the assignment itself is unsettled).
 *
 * Read-only metadata: `dist_outlets` (this product's live rows: kind, id, `identity_json`) and
 * `storeAppBinding` (credential metadata and pins; no sealed value, no store call, no audit row).
 * Values come back so the console can name both; they are app identifiers the operator typed in
 * the manifest or assigned, never credentials.
 */

import type { Db } from "../../db/types.js";
import {
  type StoreAppBinding,
  type StoreAppField,
  storeAppBindings,
} from "../../core/platformCredentials.js";
import type { StorefrontId } from "../../core/storefront/adapter.js";
import { storeAdapter } from "../../core/stores/adapters.js";
import { parseJsonColumn } from "../../platform/json.js";
import { listOutlets } from "./outlets.js";

/**
 * The store outlet kinds and the store each belongs to. The identity fields a store compares are
 * its adapter's `identity` declaration (`core/stores/`, P0-27.6), never a table here.
 */
const OUTLET_STORES: Readonly<Record<string, StorefrontId>> = {
  "app-store": "app-store",
  play: "google-play",
  "google-play": "google-play",
  "ms-store": "microsoft-store",
  steam: "steam",
};

export interface OutletIdentityMismatch {
  /** The outlet kind (`app-store`, `play`, `ms-store`, `steam`). */
  kind: string;
  outletId: string;
  field: StoreAppField;
  /** What the outlet declares. */
  declared: string;
  /** What the product is assigned on the store. */
  assigned: string;
}

/** Live store outlets whose declared identity differs from the assigned app, in outlet order. */
export async function outletIdentityMismatches(
  db: Db,
  product: string,
): Promise<OutletIdentityMismatch[]> {
  const outlets = (await listOutlets(db, product)).filter(
    (o) => o.removed_at === null && o.kind in OUTLET_STORES,
  );
  if (outlets.length === 0) return [];
  const byStore = new Map<string, StoreAppBinding>(
    (await storeAppBindings(db, product)).map((b) => [b.store, b]),
  );
  const out: OutletIdentityMismatch[] = [];
  for (const o of outlets) {
    const store = OUTLET_STORES[o.kind]!;
    const fields = storeAdapter(store)?.identity ?? [];
    const binding = byStore.get(store);
    const identity = parseJsonColumn(o.identity_json);
    if (!binding || !identity || typeof identity !== "object") continue;
    for (const field of fields) {
      const declared = (identity as Record<string, unknown>)[field];
      const assigned = binding.fields[field]?.value;
      if (
        typeof declared === "string" &&
        declared !== "" &&
        assigned !== undefined &&
        !binding.ambiguous.includes(field) &&
        declared !== assigned
      )
        out.push({
          kind: o.kind,
          outletId: o.outlet_id,
          field,
          declared,
          assigned,
        });
    }
  }
  return out;
}
