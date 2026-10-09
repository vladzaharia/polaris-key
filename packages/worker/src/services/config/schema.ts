/// <reference types="@cloudflare/workers-types" />
import type { Db } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import { getActiveSchema } from "../../core/data.js";
import { errorResponse } from "../../core/errors.js";

/** Anonymous callers get the catalog without `default`/`examples` of secret entries. */
export function publicCatalogJson(json: string): string {
  try {
    const c = JSON.parse(json) as { entries?: unknown };
    if (!Array.isArray(c.entries)) return json;
    c.entries = c.entries.map((e) => {
      if (e === null || typeof e !== "object") return e;
      const r = e as Record<string, unknown>;
      if (r.kind !== "secret" && r.secret !== true) return e;
      const { default: _d, examples: _x, ...rest } = r;
      return rest;
    });
    return JSON.stringify(c);
  } catch {
    return json;
  }
}

/** GET /<product>/config/schema — the data-driven config catalog the SDKs + admin render from.
 *  Moved from `/<product>/schema` (§R1); the body is unchanged. */
export async function handleSchema(
  db: Db,
  product: Product,
): Promise<Response> {
  const row = await getActiveSchema(db, product.slug);
  if (!row)
    return errorResponse(404, "not_found", "no active schema for product");
  return new Response(publicCatalogJson(row.catalog_json), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
    },
  });
}
