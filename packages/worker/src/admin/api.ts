/**
 * The admin JSON API dispatcher: `handleAdminApi(req, env, db, path, now)` where `path` is
 * everything AFTER `/admin` (e.g. `/api/me`, `/api/products/djdl/licenses`). Two route
 * families:
 *
 *   /api/me                                  — the signed-in identity + CSRF + grants
 *   /api/products                            — PLATFORM registry CRUD (platform admins only)
 *   /api/products/<slug>/...                 — per-product admin (product admins + platform)
 *
 * Security posture, enforced on EVERY request (never trusting the SPA):
 *   - **Session-gated**: a valid signed cookie session is required (401 otherwise).
 *   - **Group-gated**: platform routes need `PLATFORM_ADMIN_GROUP`; product routes need the
 *     product's `admin_group` (platform admins pass too). 403 otherwise.
 *   - **CSRF**: mutations must echo `X-PKey-CSRF`; mismatch ⇒ 403.
 *   - **Product-scoped D1**: every per-product query carries the slug — no cross-tenant read.
 *   - **Catalog-validated**: config/secret/flag values validate against the active catalog
 *     before any write (422 on failure).
 *   - **Secrets are write-only**: responses NEVER echo a stored secret value.
 *   - **Audited**: every mutation appends an audit row with the verified actor.
 *
 * This module is intentionally thin: session/CSRF gating plus top-level routing to the
 * focused handler modules under ./handlers. Shared helpers live under ./lib.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { getProduct } from "../repo.js";
import { canAdminProduct } from "./authz.js";
import {
  buildClearCookie,
  CSRF_HEADER,
  sessionFromRequest,
  type AdminSession,
} from "./session.js";
import { adminJson, forbidden, isMutation, notFound, unauthorized } from "./lib/respond.js";
import { handleMe } from "./handlers/me.js";
import { handleProducts } from "./handlers/products.js";
import { handleSchema } from "./handlers/schema.js";
import { handleLicenses } from "./handlers/licenses.js";
import { handleProfiles } from "./handlers/profiles.js";
import { handleTiers } from "./handlers/tiers.js";
import { handleActivity } from "./handlers/activity.js";

// ── per-product routing ────────────────────────────────────────────────────────
async function handleProductScoped(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  const product = await getProduct(db, slug);
  if (!product) return notFound();
  if (!canAdminProduct(env, session, product)) return forbidden("not an admin of this product");

  const [resource, id, sub, subId, action] = rest;

  if (resource === "schema") {
    return handleSchema(req, db, session, slug, now);
  }

  if (resource === "licenses") {
    return handleLicenses(req, env, db, session, slug, [id, sub, subId, action].filter((s): s is string => s != null), now);
  }

  if (resource === "profiles") {
    return handleProfiles(req, db, session, slug, id, now);
  }

  if (resource === "tiers") {
    return handleTiers(req, db, session, slug, id, now);
  }

  if (resource === "activity") {
    return handleActivity(req, db, slug);
  }

  return notFound();
}

/**
 * Admin API dispatcher. `path` is everything AFTER `/admin` (so it begins with `/api`).
 * Verifies the session, CSRF-checks mutations, then routes. Returns 401/403 cleanly.
 */
export async function handleAdminApi(req: Request, env: Env, db: Db, path: string, now: number): Promise<Response> {
  const session = await sessionFromRequest(env, req, now);
  if (!session) return unauthorized();

  // Strip the `/api` prefix; tolerate trailing slash.
  let p = path.startsWith("/api") ? path.slice(4) : path;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const segments = p.split("/").filter(Boolean);

  // CSRF on every mutation (double-submit; SameSite=Strict is the primary defense).
  if (isMutation(req.method)) {
    const presented = req.headers.get(CSRF_HEADER);
    if (!presented || presented !== session.csrf) return forbidden("csrf");
  }

  const [head, ...rest] = segments;

  if (head === "me") return handleMe(env, db, session);
  if (head === "logout") {
    return adminJson({ ok: true }, 200, { "set-cookie": buildClearCookie() });
  }
  if (head === "products") {
    // /products  or  /products/<slug>/...
    if (rest.length <= 1) return handleProducts(req, env, db, session, rest, now);
    const [slug, ...productRest] = rest;
    return handleProductScoped(req, env, db, session, slug!, productRest, now);
  }

  return notFound();
}
