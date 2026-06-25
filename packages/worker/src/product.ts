// Product context — assembled from the `products` row + active schema version + the
// per-product signing key. The signing key is now KEK-custodied: it lives sealed in the
// `product_keys` table and is opened per request under `env.PLATFORM_KEK` (src/keyvault.ts),
// NOT resolved from a Worker secret by name. Fails closed if there is no active product key
// or it can't be decrypted: a product with no usable key can never sign config.

import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import {
  getActiveProductKey,
  getActiveSchema,
  getProduct,
  getProductSecret,
} from "./repo.js";
import { open } from "./keyvault.js";

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

export interface PublicSigningKey {
  kid: string;
  alg: string;
  publicKey: string;
}

/** Best-effort public signing-key lookup. This never opens private key material and returns
 *  null instead of throwing so admin/product discovery views can degrade safely. */
export async function loadPublicSigningKey(
  db: Db,
  slug: string,
): Promise<PublicSigningKey | null> {
  try {
    const keyRow = await getActiveProductKey(db, slug);
    if (!keyRow) return null;
    return {
      kid: keyRow.kid,
      alg: keyRow.alg,
      publicKey: keyRow.public_b64url,
    };
  } catch {
    return null;
  }
}

/** Load a product + its signing key from the sealed `product_keys` table. Returns null for
 *  an unknown product, a product with no active key, or one whose sealed key fails to open
 *  (fail-closed: no plaintext key ⇒ no Product ⇒ no signed config). */
export async function loadProduct(
  env: Env,
  db: Db,
  slug: string,
): Promise<Product | null> {
  const row = await getProduct(db, slug);
  if (!row) return null;
  const keyRow = await getActiveProductKey(db, slug);
  if (!keyRow) return null;
  let pem: string;
  try {
    pem = await open(env, keyRow.enc_private_json);
  } catch {
    return null;
  }
  const schema = await getActiveSchema(db, slug);
  return {
    slug: row.slug,
    name: row.name,
    signingKid: keyRow.kid,
    signingKeyPem: pem,
    signingPub: keyRow.public_b64url,
    compatMin: row.compat_min,
    compatMax: row.compat_max,
    defaultMaxOfflineDays: row.default_max_offline_days,
    defaultMachineLimit: row.default_machine_limit,
    adminGroup: row.admin_group,
    schemaVersion: schema?.catalog_version ?? 1,
  };
}

/** Open a sealed per-product secret by name. Returns undefined if the row is absent or the
 *  sealed value fails to decrypt (fail-closed — never a wrong/partial value). */
export async function openProductSecret(
  db: Db,
  env: Env,
  product: string,
  name: string,
): Promise<string | undefined> {
  const row = await getProductSecret(db, product, name);
  if (!row) return undefined;
  try {
    return await open(env, row.enc_value_json);
  } catch {
    return undefined;
  }
}
