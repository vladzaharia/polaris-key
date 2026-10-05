/**
 * Platform → Settings → Licensing: the reserved entitlement-name report (S-19 §7.4, LX-05).
 *
 *   GET /api/platform/reserved-names — the platform's severity (`LICENSING_RESERVED_NAMES`), the
 *                                      reserved keys with the rule the Worker applies to each,
 *                                      the reserved prefixes, and every registered product whose
 *                                      active catalog declares a reserved name, each declaration
 *                                      marked compatible or not (with the reason).
 *
 * Read-only. It is the list an operator checks before switching the setting to `error` (LX-05b):
 * a product with an incompatible declaration would then fail its next resync. Reached through
 * `handlePlatform`, so platform-admin only. Admin routes are narrative-only under AGENTS.md rule 10
 * (`adminApi` in routeCoverage's NARRATIVE_ONLY): no OpenAPI entry.
 */

import {
  RESERVED_ENTITLEMENT_KEYS,
  RESERVED_ENTITLEMENT_PREFIXES,
  reservedNameDeclarations,
  type ReservedNameDeclaration,
} from "@polaris-key/manifest";
import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { reservedNamesMode } from "../../core/reservedNames.js";
import { adminJson, err } from "../lib/respond.js";

export interface ReservedNamesProduct {
  slug: string;
  name: string;
  catalogVersion: number;
  declarations: Omit<ReservedNameDeclaration, "index">[];
}

/** Every registered product whose active catalog declares a reserved name (exported for tests). */
export async function reservedNameProducts(
  db: Db,
): Promise<ReservedNamesProduct[]> {
  const rows = await db.all<{
    slug: string;
    name: string;
    catalog_version: number;
    catalog_json: string;
  }>(
    `SELECT p.slug, p.name, s.catalog_version, s.catalog_json
       FROM products p
       JOIN product_schema s ON s.product = p.slug AND s.active = 1
      ORDER BY p.slug, s.catalog_version DESC`,
  );
  const out: ReservedNamesProduct[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // One active row per product is the invariant; the newest wins if it ever slips.
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    let catalog: unknown;
    try {
      catalog = JSON.parse(r.catalog_json) as unknown;
    } catch {
      continue;
    }
    const declarations = reservedNameDeclarations(catalog).map(
      ({ key, compatible, problem }) => ({ key, compatible, problem }),
    );
    if (declarations.length === 0) continue;
    out.push({
      slug: r.slug,
      name: r.name,
      catalogVersion: r.catalog_version,
      declarations,
    });
  }
  return out;
}

export async function handleReservedNames(
  req: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  if (req.method !== "GET")
    return err(405, "method_not_allowed", "method not allowed");
  return adminJson({
    mode: await reservedNamesMode(env, db),
    keys: RESERVED_ENTITLEMENT_KEYS,
    prefixes: RESERVED_ENTITLEMENT_PREFIXES,
    products: await reservedNameProducts(db),
  });
}
