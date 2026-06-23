// Product context — assembled from the `products` row + active schema version + the
// per-product signing key (resolved from a Worker secret by name). Fails closed if the
// signing key is missing: a product with no key can never sign config.

import { type Env, secret } from "./env.js";
import type { Db } from "./db/types.js";
import { getActiveSchema, getProduct } from "./repo.js";

export interface Product {
  slug: string;
  name: string;
  signingKid: string;
  signingKeyPem: string;
  signingPub: string | null;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultMachineLimit: number;
  adminGroup: string | null;
  schemaVersion: number;
}

/** Load a product + its signing key. Returns null for an unknown product or a product
 *  whose signing-key secret is absent (fail-closed). */
export async function loadProduct(env: Env, db: Db, slug: string): Promise<Product | null> {
  const row = await getProduct(db, slug);
  if (!row) return null;
  const pem = secret(env, row.signing_key_secret);
  if (!pem) return null;
  const schema = await getActiveSchema(db, slug);
  return {
    slug: row.slug,
    name: row.name,
    signingKid: row.signing_kid,
    signingKeyPem: pem,
    signingPub: row.signing_pub,
    compatMin: row.compat_min,
    compatMax: row.compat_max,
    defaultMaxOfflineDays: row.default_max_offline_days,
    defaultMachineLimit: row.default_machine_limit,
    adminGroup: row.admin_group,
    schemaVersion: schema?.catalog_version ?? 1,
  };
}
