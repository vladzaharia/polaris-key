/**
 * Cloud Sync's answer to Core's `keyring` contribution (U-36.2; WIRE-CONTRACT-V5 §13.2, §13.11):
 * the key ring is wanted while the product's catalog is in end-to-end mode. The mode is
 * `cloudSync.encryption`, `"e2e"` when absent (the default) and `"server"` otherwise. The caller
 * has already checked that Cloud Sync is enabled for the product.
 */

import type { KeyringContributor } from "../../core/contributions.js";
import { getActiveSchema } from "../../core/products/store.js";

export const syncKeyring: KeyringContributor = async ({ db, product }) => {
  const row = await getActiveSchema(db, product);
  if (!row) return true;
  let catalog: unknown;
  try {
    catalog = JSON.parse(row.catalog_json);
  } catch {
    return false;
  }
  if (typeof catalog !== "object" || catalog === null) return false;
  const cs = (catalog as { cloudSync?: unknown }).cloudSync;
  if (cs === undefined || cs === null) return true;
  if (typeof cs !== "object" || Array.isArray(cs)) return false;
  const mode = (cs as { encryption?: unknown }).encryption;
  return mode === undefined || mode === "e2e";
};
