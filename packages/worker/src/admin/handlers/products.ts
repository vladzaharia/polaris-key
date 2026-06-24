/**
 * Platform product-registry CRUD (`/api/products` and `/api/products/<slug>`). Platform
 * admins only — creating a product seeds an empty active schema so it's immediately usable.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { getProduct, insertProduct, insertSchema, listProducts } from "../../repo.js";
import { deleteProduct, updateProduct } from "../repo.js";
import { audit } from "../audit.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, forbidden, notFound, readBody } from "../lib/respond.js";
import { productView } from "../lib/shape.js";

export async function handleProducts(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  segments: string[],
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbidden("platform admin required");

  // /api/products
  if (segments.length === 0) {
    if (req.method === "GET") {
      const rows = await listProducts(db);
      return adminJson({ products: rows.map(productView) });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const slug = String(body.slug ?? "").trim();
      if (!/^[a-z0-9-]+$/.test(slug)) return err(422, ErrorCode.BadRequest, "invalid slug", { fields: ["slug"] });
      if (await getProduct(db, slug)) return err(409, ErrorCode.BadRequest, "product exists", { fields: ["slug"] });
      const signingKeySecret = `SIGNING_KEY__${slug.toUpperCase().replace(/-/g, "_")}`;
      await insertProduct(db, {
        slug,
        name: String(body.name ?? slug),
        signing_kid: String(body.signingKid ?? `${slug}-2026`),
        signing_key_secret: signingKeySecret,
        signing_pub: typeof body.signingPub === "string" ? body.signingPub : null,
        compat_min: String(body.compatMin ?? "0.0.0"),
        compat_max: String(body.compatMax ?? "99.0.0"),
        default_max_offline_days: Number(body.defaultMaxOfflineDays ?? 30),
        default_machine_limit: Number(body.defaultMachineLimit ?? 5),
        admin_group: typeof body.adminGroup === "string" ? body.adminGroup : null,
        branding_json: null,
        created_at: now,
        modified_at: now,
      });
      // Seed an empty active schema so the product is immediately usable.
      await insertSchema(db, {
        product: slug,
        catalog_version: 1,
        catalog_json: JSON.stringify({ schemaVersion: 1, entries: [] }),
        active: 1,
        created_at: now,
      });
      await audit(db, slug, session, now, "product.create", { kind: "product", id: slug }, `Created product ${slug}`);
      const row = await getProduct(db, slug);
      return adminJson({ ok: true, product: row ? productView(row) : null, signingKeySecret }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  // /api/products/<slug>
  const slug = segments[0]!;
  const row = await getProduct(db, slug);
  if (!row) return notFound();
  if (req.method === "GET") return adminJson({ product: productView(row) });
  if (req.method === "PATCH") {
    const body = await readBody(req);
    await updateProduct(
      db,
      slug,
      {
        name: typeof body.name === "string" ? body.name : undefined,
        compat_min: typeof body.compatMin === "string" ? body.compatMin : undefined,
        compat_max: typeof body.compatMax === "string" ? body.compatMax : undefined,
        default_max_offline_days:
          typeof body.defaultMaxOfflineDays === "number" ? body.defaultMaxOfflineDays : undefined,
        default_machine_limit:
          typeof body.defaultMachineLimit === "number" ? body.defaultMachineLimit : undefined,
        admin_group: typeof body.adminGroup === "string" ? body.adminGroup : undefined,
      },
      now,
    );
    await audit(db, slug, session, now, "product.update", { kind: "product", id: slug }, `Updated product ${slug}`);
    return adminJson({ ok: true, slug });
  }
  if (req.method === "DELETE") {
    await deleteProduct(db, slug);
    await audit(db, slug, session, now, "product.delete", { kind: "product", id: slug }, `Deleted product ${slug}`);
    return adminJson({ ok: true, slug });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}
