/**
 * Commerce's public surface for the console (`test/boundaries.test.ts`): the one module under
 * `services/commerce/` that `console/` may import.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { setupOf } from "./admin.js";
import { effectiveCommerceSettings } from "./identity.js";

/** The stores that can sell now: their settings are saved and the credential resolves. The same
 *  answer as the Commerce overview's per-store status (`setupOf`). */
export async function readyStorefronts(
  env: Env,
  db: Db,
  slug: string,
): Promise<number> {
  const setup = await setupOf(
    { env, db, product: { slug } },
    await effectiveCommerceSettings(db, slug),
  );
  return Object.values(setup).filter((s) => s.configured).length;
}

export interface StorefrontIdentityMismatch {
  store: "app-store" | "play" | "steam";
  /** The identity typed in the commerce settings (the one in force). */
  typed: string;
  /** The app the product is assigned on that store. */
  assigned: string;
}

/** The stores whose typed identity differs from the assigned app (A-28.3). Read-only. */
export async function storefrontIdentityMismatches(
  db: Db,
  slug: string,
): Promise<StorefrontIdentityMismatch[]> {
  const { identity } = await effectiveCommerceSettings(db, slug);
  const out: StorefrontIdentityMismatch[] = [];
  for (const store of ["app-store", "play", "steam"] as const) {
    const i = identity[store];
    if (i.mismatch && i.value !== null && i.assigned !== null)
      out.push({ store, typed: i.value, assigned: i.assigned });
  }
  return out;
}
