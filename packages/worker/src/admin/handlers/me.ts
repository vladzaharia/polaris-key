/**
 * `/api/me` — the signed-in identity plus the CSRF token and the set of products this
 * session may administer (with each product's active catalog version).
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { listProducts, getActiveSchema } from "../../repo.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import { adminJson } from "../lib/respond.js";

export async function handleMe(env: Env, db: Db, session: AdminSession): Promise<Response> {
  const products = await listProducts(db);
  const platform = isPlatformAdmin(env, session);
  const visible = products.filter(
    (p) => platform || (p.admin_group != null && session.groups.includes(p.admin_group)),
  );
  const adminProducts = await Promise.all(
    visible.map(async (p) => {
      const schema = await getActiveSchema(db, p.slug);
      return { slug: p.slug, name: p.name, schemaVersion: schema?.catalog_version ?? 0 };
    }),
  );
  return adminJson({
    sub: session.sub,
    name: session.name,
    email: session.email,
    csrf: session.csrf,
    platformAdmin: platform,
    products: adminProducts,
  });
}
