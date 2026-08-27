/**
 * The product catalog — `GET|PUT /manage/api/products/<slug>/config/catalog` (§R1).
 *
 * GET returns the active catalog JSON; PUT publishes a new one. A publish compiles every schema
 * fragment up front, so malformed schema is rejected here rather than at request time, then
 * bumps the version and flips active.
 *
 * ── WHY IT IS SPELLED `catalog`, NOT `schema` ───────────────────────────────────────────────
 *
 * Config already serves `GET /<product>/config/schema` on the public wire — the same document,
 * read by devices. Naming the admin resource `schema` too would have put a read-only wire route
 * and an operator-writable admin route one namespace apart under the same noun. `catalog` is
 * what the thing is called everywhere else in the codebase (`@plrs/catalog`, `catalog_json`,
 * `ProductCatalog`), so the admin surface now says so.
 */

import { Catalog } from "@plrs/catalog";
import { ErrorCode } from "../../../core/errors.js";
import { getActiveSchema, insertSchema } from "../../../core/data.js";
import {
  adminJson,
  adminNotFound,
  audit,
  deactivateSchemas,
  err,
  nextSchemaVersion,
  readBody,
} from "../../../core/adminApi.js";
import type { ConfigAdminContext } from "./index.js";

export async function handleCatalog(
  ctx: ConfigAdminContext,
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;
  if (req.method === "GET") {
    const row = await getActiveSchema(db, slug);
    if (!row) return adminNotFound();
    return new Response(row.catalog_json, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }
  if (req.method === "PUT") {
    const body = await readBody(req);
    const catalogJson = body.catalog ?? body;
    let catalog: Catalog;
    try {
      catalog = new Catalog(catalogJson as never);
      catalog.compileAll(); // surfaces malformed schema fragments here, not at request time
    } catch (e) {
      return err(422, ErrorCode.BadRequest, "invalid catalog", {
        fields: [e instanceof Error ? e.message : "invalid catalog"],
      });
    }
    const version = await nextSchemaVersion(db, slug);
    await deactivateSchemas(db, slug);
    await insertSchema(db, {
      product: slug,
      catalog_version: version,
      catalog_json: JSON.stringify({
        schemaVersion: version,
        entries: catalog.entries,
      }),
      active: 1,
      created_at: now,
    });
    await audit(
      db,
      slug,
      session,
      now,
      "schema.publish",
      { kind: "schema", id: String(version) },
      `Published catalog v${version}`,
    );
    return adminJson({ ok: true, schemaVersion: version });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}
