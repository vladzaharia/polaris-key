/**
 * Two facts the console's Home reads from Distribution (ST-44), so no console file touches the
 * credential store: a product's store credentials that expire soon (`listOutletCredentials`, the
 * audited accessor: metadata only, never a value), and the stores a product ships to that the
 * platform has no account for. Read-only.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { listOutletCredentials } from "../../core/outletCredentials.js";
import {
  platformCredentialStatus,
  primaryPlatformCredential,
} from "../../core/platformCredentials.js";
import { PLATFORM_STORES } from "../../core/platformStoreSettings.js";

export interface ExpiringCredential {
  id: string;
  kind: string;
  expiresAt: number;
}

/** A product's active credentials whose expiry is at or before `before`, soonest first. */
export async function expiringCredentials(
  db: Db,
  product: string,
  before: number,
): Promise<ExpiringCredential[]> {
  return (await listOutletCredentials(db, product))
    .filter(
      (c) =>
        c.status === "active" && c.expiresAt !== null && c.expiresAt <= before,
    )
    .map((c) => ({ id: c.id, kind: c.kind, expiresAt: c.expiresAt! }))
    .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
}

/** Outlet kinds that need a platform store account, by store. */
const STORE_OUTLETS: Readonly<Record<string, string>> = {
  "app-store": "app-store",
  "google-play": "google-play",
  "microsoft-store": "ms-store",
  steam: "steam",
};

export interface MissingStoreAccount {
  store: string;
  /** Product slugs with a live outlet for the store, sorted. */
  products: string[];
}

/** The stores some product has a live outlet for and the platform has no account for. */
export async function storesMissingAccount(
  env: Env,
  db: Db,
): Promise<MissingStoreAccount[]> {
  const rows = await db.all<{ product: string; kind: string }>(
    "SELECT DISTINCT product, kind FROM dist_outlets WHERE removed_at IS NULL",
  );
  const missing: MissingStoreAccount[] = [];
  for (const store of PLATFORM_STORES) {
    const products = rows
      .filter((r) => r.kind === STORE_OUTLETS[store])
      .map((r) => r.product)
      .sort();
    if (products.length === 0) continue;
    const status = await platformCredentialStatus(
      env,
      db,
      primaryPlatformCredential(store),
    );
    if (!status.configured) missing.push({ store, products });
  }
  return missing;
}
