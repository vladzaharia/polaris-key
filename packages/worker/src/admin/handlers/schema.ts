/**
 * Per-product catalog schema (`/api/products/<slug>/schema`): GET the active catalog JSON,
 * or PUT a new one. A publish compiles every fragment up front (so malformed schema is
 * rejected here, not at request time), bumps the version, and flips active.
 */

import { Catalog } from "@plrs/catalog";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { getActiveSchema, insertSchema } from "../../repo.js";
import { deactivateSchemas, nextSchemaVersion } from "../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";

export async function handleSchema(
  req: Request,
  db: Db,
  session: AdminSession,
  slug: string,
  now: number,
): Promise<Response> {
  if (req.method === "GET") {
    const row = await getActiveSchema(db, slug);
    if (!row) return notFound();
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
