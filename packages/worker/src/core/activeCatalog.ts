/**
 * A product's active catalog, compiled for value validation and redaction. Shared by the console
 * and every service's admin handlers (moved out of the console's `shape.ts` by P0-17, so Core
 * no longer reaches the console to load it).
 */

import { Catalog } from "@polaris-key/catalog";
import type { Db } from "../db/types.js";
import { getActiveSchema } from "../repo.js";

/** Load + compile a product's active catalog (for value validation). Null if none/invalid. */
export async function loadCatalog(
  db: Db,
  product: string,
): Promise<Catalog | null> {
  const active = await readActiveCatalog(db, product);
  return active.state === "ok" ? active.catalog : null;
}

/**
 * A product's active catalog, or why there is none: `missing` (no catalog published) or
 * `unreadable` (the stored JSON does not parse or compile). For a refusal that must say which
 * (P0-48, a commerce mapping's flag); `loadCatalog` folds both into `null`.
 */
export type ActiveCatalog =
  | { state: "ok"; catalog: Catalog }
  | { state: "missing" }
  | { state: "unreadable" };

export async function readActiveCatalog(
  db: Db,
  product: string,
): Promise<ActiveCatalog> {
  const row = await getActiveSchema(db, product);
  if (!row) return { state: "missing" };
  try {
    return { state: "ok", catalog: new Catalog(JSON.parse(row.catalog_json)) };
  } catch {
    return { state: "unreadable" };
  }
}
