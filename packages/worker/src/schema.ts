/// <reference types="@cloudflare/workers-types" />
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { getActiveSchema } from "./repo.js";
import { errorResponse } from "./http.js";

/** GET /<product>/schema — the data-driven config catalog the SDKs + admin render from. */
export async function handleSchema(
  db: Db,
  product: Product,
): Promise<Response> {
  const row = await getActiveSchema(db, product.slug);
  if (!row)
    return errorResponse(404, "not_found", "no active schema for product");
  return new Response(row.catalog_json, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
    },
  });
}
