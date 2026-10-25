import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { loadProductPublic } from "./products.js";
import { buildHooks } from "./hooks.js";
import { bound } from "./contributions.js";

/**
 * Distribution's delivery access (`dist_access`) for one deliverable, for a caller that holds no
 * service hooks (ST-25.2: Release's truth-store snapshot). Core builds the product's hooks from
 * the bound registry, gated on that product's enablement, so Distribution's code runs only while
 * the product has it on, and nothing here imports a service. `null`: the product or Distribution
 * is off, or the read failed. The caller treats `null` as the strictest mode, never as open.
 */
export async function deliveryAccessMode(
  env: Env,
  db: Db,
  slug: string,
  deliverable: string,
  now: number,
): Promise<ReleaseAccess | null> {
  try {
    const product = await loadProductPublic(db, slug);
    if (!product) return null;
    const delivery = buildHooks(bound(), product.services, {
      env,
      db,
      product,
      now,
    }).delivery();
    return delivery ? await delivery.accessMode(deliverable) : null;
  } catch {
    return null;
  }
}
