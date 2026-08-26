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

export async function handleMe(
  env: Env,
  db: Db,
  session: AdminSession,
): Promise<Response> {
  const products = await listProducts(db);
  const platform = isPlatformAdmin(env, session);
  // Admin authority is platform-wide: `hasAnyAdminGrant` (the login gate) and
  // `isPlatformAdmin` (the product gate) are the SAME predicate, so a session that exists at
  // all administers every product. The old `p.admin_group != null && groups.includes(...)`
  // arm was unreachable dead code — it made `/api/me` look like it reported a per-product
  // grant that no longer exists anywhere in the system. A non-platform session sees nothing.
  const visible = platform ? products : [];
  const adminProducts = await Promise.all(
    visible.map(async (p) => {
      const schema = await getActiveSchema(db, p.slug);
      return {
        slug: p.slug,
        name: p.name,
        schemaVersion: schema?.catalog_version ?? 0,
      };
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
