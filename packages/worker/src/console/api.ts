/**
 * The admin JSON API dispatcher: `handleAdminApi(req, env, db, path, now)`, where `path` is
 * everything AFTER `/manage` (e.g. `/api/me`, `/api/products/djdl/license/licenses`).
 *
 * Deny by default (ST-29; ST-28 plan §2.7). Every route is a row of the one route table
 * (`./routes.ts`), and this module walks it in a fixed order, never trusting the SPA:
 *
 *   1. **Session, then principal.** A valid signed cookie session is required (401). The
 *      principal is resolved from it (`resolveConsoleCaller`: today the root rule, the platform
 *      admin group) and set on `session.principal` for the handler. This is the ONLY module that
 *      reads the session cookie (`sessionFromRequest`); the docs gate uses the same resolver. A
 *      principal with no grant is no member, and every route answers it 403 (after the limiter).
 *   2. **Rate limit.** A per-member budget on the whole surface (R1-04).
 *   3. **CSRF.** Mutations must echo `X-PKey-CSRF`; a mismatch is a 403 (double-submit;
 *      `SameSite=Strict` is the primary defense). Logout is a POST so it goes through it (R1-03).
 *   4. **Match.** No row: 404. A row for the path but not the method: 405 with `Allow`.
 *   5. **One product load** for a `/products/:slug` row (404).
 *   6. **`can()`** on the row's area and level: a 403 `{error: {code: "forbidden", reason:
 *      "no_access", scope, area}}`, with a budgeted `access.denied` row on a product (a few per
 *      member and product per window: the burst is the signal, and an unbudgeted write per 403
 *      is a D1 amplifier).
 *   7. **Step-up** for a row that needs it: a 403 `step_up_required` (`./stepUp.ts`).
 *   8. **The handler**, with a malformed body answered as its 4xx (P0-16).
 *
 * The handlers keep the rest of the posture: product-scoped D1 (every per-product query carries
 * the slug), catalog validation before writes, write-only secrets, an audit row per mutation with
 * the verified actor, and `writeSettings()`'s own area check on every key it writes.
 */

import { constantTimeEqual } from "../platform/compare.js";
import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { getProduct } from "../core/repo.js";
import { rateLimitOk } from "../core/rateLimit.js";
import { audit } from "../core/console/audit.js";
import {
  CSRF_HEADER,
  sessionFromRequest,
  type AdminSession,
} from "../core/console/session.js";
import {
  AdminBodyError,
  err,
  isMutation,
  notFound,
  unauthorized,
} from "../core/console/respond.js";
import {
  can,
  PLATFORM,
  PRODUCT_AREAS,
  productScope,
  resolvePrincipal,
  type AreaId,
  type Principal,
  type Scope,
} from "./authz.js";
import { findRoute, levelOf } from "./routeMatch.js";
import {
  ADMIN_ROUTES,
  isProductRoute,
  methodNotAllowed,
  type AdminRoute,
} from "./routes.js";
import { requireStepUp } from "./stepUp.js";
import { SETTINGS } from "../mount.js";

/** Admin limiter shard. One global Durable Object for the whole platform — see the note in
 *  rateLimitDo.ts; sub-sharding it is tracked as R10-04a. */
const ADMIN_RL_SHARD = "_admin";

/** A verified console caller: the session and the principal resolved for it. */
export interface ConsoleCaller {
  session: AdminSession;
  principal: Principal;
}

/**
 * The console's one session reader (ST-29): verify the cookie, then resolve the principal. `null`
 * when there is no valid, unrevoked session. The admin API (below) and the docs gate (`docs.ts`)
 * both come through here, so they cannot disagree about who is asking; a grep test keeps
 * `sessionFromRequest` to this module.
 */
export async function resolveConsoleCaller(
  env: Env,
  db: Db | null,
  req: Request,
  now: number,
): Promise<ConsoleCaller | null> {
  const session = await sessionFromRequest(env, req, now);
  if (!session) return null;
  const principal = await resolvePrincipal(
    env,
    db,
    { sub: session.sub, groups: session.groups },
    now,
  );
  return { session: { ...session, principal }, principal };
}

/** The scope string a 403 names: `platform`, or `product:<slug>`. */
function scopeName(scope: Scope): string {
  return scope.kind === "product" ? `product:${scope.slug}` : "platform";
}

/**
 * The area a row needs. `byKey` (`settings/:key`, `claims/:key`) takes the registry key's
 * `rbacArea`; a key the registry does not know needs `settings`, and its handler answers 404.
 * `anyArea` is any one of the product's areas; a refusal names `core`, the record's own.
 */
export function areaFor(
  route: AdminRoute,
  params: Record<string, string>,
): AreaId {
  if (route.area === "anyArea") return "core";
  if (route.area !== "byKey") return route.area;
  const key = params.key ?? "";
  return SETTINGS.get(key, "product")?.rbacArea ?? "settings";
}

/** Does the principal hold what the row needs, in this scope? */
function allowedRoute(
  principal: Principal,
  scope: Scope,
  route: AdminRoute,
  params: Record<string, string>,
): boolean {
  const level = levelOf(route);
  if (route.area === "anyArea")
    return PRODUCT_AREAS.some((a) => can(principal, scope, a, level));
  return can(principal, scope, areaFor(route, params), level);
}

/** The 403 for a principal that lacks the area (P0-16's nested error shape). */
function forbiddenArea(scope: Scope, area: AreaId): Response {
  return err(403, "forbidden", "You don't have access to this.", {
    reason: "no_access",
    scope: scopeName(scope),
    area,
  });
}

/**
 * The budgeted `access.denied` row for an authenticated reach into a product (R1-04). One D1
 * write per denied request is an amplifier for anyone holding a session that fails the check, and
 * the denial needs no CSRF token on a GET: a few rows per member and product per window carry all
 * the signal, and beyond that the 403 is still returned, just not written. A platform-scope
 * denial writes nothing, as before the route table.
 */
async function auditDenied(
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  area: AreaId,
  now: number,
): Promise<void> {
  if (
    await rateLimitOk(
      env,
      ADMIN_RL_SHARD,
      {
        bucket: "adminAccessDenied",
        id: `${session.sub}:${slug}`,
        limit: 3,
        windowSec: 300,
      },
      now,
    )
  )
    await audit(
      db,
      slug,
      session,
      now,
      "access.denied",
      { kind: "product", id: slug },
      `Denied admin access to product ${slug} (${area})`,
    );
}

/**
 * The admin API dispatcher. `path` is everything AFTER `/manage` (so it begins with `/api`).
 */
export async function handleAdminApi(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  now: number,
): Promise<Response> {
  // 1. Session, then principal.
  const caller = await resolveConsoleCaller(env, db, req, now);
  if (!caller) return unauthorized();
  const { session, principal } = caller;

  // 2. R1-04: a budget keyed by the VERIFIED member, not the IP, so it follows the actor rather
  // than the network path, and generous enough that the SPA's normal fan-out never trips it.
  // Fails OPEN (see rateLimit.ts): a signed-in operator must not be locked out of the console by
  // a limiter outage, and the checks below are the real access control here.
  if (
    !(await rateLimitOk(
      env,
      ADMIN_RL_SHARD,
      {
        bucket: "adminApi",
        id: principal.memberId,
        limit: 600,
        windowSec: 60,
      },
      now,
    ))
  ) {
    return err(429, "rate_limited", "too many admin API requests");
  }

  // Strip the `/api` prefix; tolerate a trailing slash. HEAD reads as GET.
  let p = path.split(/[?#]/)[0]!;
  p = p.startsWith("/api") ? p.slice(4) : p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const segments = p.split("/").filter(Boolean);
  const method = req.method === "HEAD" ? "GET" : req.method;
  const found = findRoute(ADMIN_ROUTES, method, segments);

  // A verified session whose principal holds no grant is not a member: every route answers the
  // same 403, so it learns nothing about what exists. (The sign-in gate mints no such session; one
  // appears when the platform group changes under a live cookie.) A reach into an existing
  // product is still audited on that product.
  if (!can(principal, PLATFORM, "console", "view")) {
    if (found.kind === "route" && isProductRoute(found.route)) {
      const target = await getProduct(db, found.match.params.slug ?? "");
      if (target)
        await auditDenied(env, db, session, target.slug, "console", now);
    }
    return forbiddenArea(PLATFORM, "console");
  }

  // 3. CSRF on every mutation (double-submit; SameSite=Strict is the primary defense).
  if (isMutation(req.method)) {
    const presented = req.headers.get(CSRF_HEADER);
    if (!presented || !constantTimeEqual(presented, session.csrf))
      return err(403, "forbidden", "csrf");
  }

  // 4. Match.
  if (found.kind === "none") return notFound();
  if (found.kind === "method") return methodNotAllowed(found.allow);
  const { route, match } = found;

  // 5. One product load for a product-scoped row.
  let scope: Scope = PLATFORM;
  let product = null;
  if (isProductRoute(route)) {
    product = await getProduct(db, match.params.slug ?? "");
    if (!product) return notFound();
    scope = productScope(product);
  }

  // 6. The area.
  const area = areaFor(route, match.params);
  if (!allowedRoute(principal, scope, route, match.params)) {
    if (scope.kind === "product")
      await auditDenied(env, db, session, scope.slug, area, now);
    return forbiddenArea(scope, area);
  }

  // 7. Step-up.
  if (route.stepUp) {
    const refused = requireStepUp(session, now);
    if (refused) return refused;
  }

  // 8. The handler.
  try {
    return await route.handler({
      req,
      env,
      db,
      session,
      now,
      segments,
      params: match.params,
      rest: match.rest,
      product,
    });
  } catch (e) {
    if (e instanceof AdminBodyError)
      return err(e.status, e.code, e.message, e.extra);
    throw e;
  }
}
