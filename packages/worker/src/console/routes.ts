/**
 * The admin route table (ST-29; ST-28 plan §2.7): every `/manage/api` route the console serves,
 * with the area `can()` checks, the level, and whether it needs a console step-up. The
 * dispatcher (`./api.ts`) walks it deny-by-default: a request no row matches is a 404, a matching
 * path without the method is a 405 with `Allow`, and no handler runs before the principal passes
 * `can()` for the row's area.
 *
 * Scope. A path under `/products/:slug` is product scope: the dispatcher loads the product once
 * (404) and checks the area on it (the system product is evaluated as the platform, `can()` rule
 * 4). Every other row is platform scope, and its area says what it needs: `console` for what
 * every member may use, `platform` for the instance.
 *
 * Granularity. A row names a handler module's entry point; the handler still routes its own
 * sub-paths, so a row ending in `/**` covers a handler that owns a subtree (a service's
 * `adminHandle`, the feeds, the store connections). Its methods are the ones that subtree serves.
 *
 * Drift. `test/fixtures/rbac-route-areas.json` pins every row's `METHOD path → area`; a new or
 * removed row updates it in the same change, and a changed area needs an `AREA_MOVES` entry
 * (`core/rbac/areas.ts`). The sidebar is never an input. `test/rbacRouteMatrix.test.ts` drives
 * every row with eight principals against a hand-written oracle.
 */

import type { Db } from "../db/types.js";
import type { Env } from "../platform/env.js";
import { SERVICE_SLUGS, type ServiceSlug } from "../core/services.js";
import { SERVICE_AREA } from "../core/rbac/areas.js";
import type { ProductRow } from "../core/repo.js";
import type { AdminSession } from "../core/console/session.js";
import { adminJson, err, notFound } from "../core/console/respond.js";
import { revokeAdminSessions } from "../core/console/sessionRevocation.js";
import { buildClearCookie } from "../core/console/session.js";
import type { Method, RouteDecl } from "./routeMatch.js";
import { handleMe } from "./handlers/me.js";
import { handleSummary } from "./handlers/summary.js";
import { handleAccessAdmins } from "./handlers/access.js";
import { handleGithub } from "./handlers/github.js";
import { handlePlatformStoreConnections } from "./handlers/platformStoreConnections.js";
import { handlePlatform } from "./handlers/platform.js";
import { handleProducts } from "./handlers/products.js";
import { handleProductScoped } from "./productScoped.js";

/** What every handler receives once the dispatcher has authorized the request. */
export interface AdminCtx {
  req: Request;
  env: Env;
  db: Db;
  /** The verified session, with `principal` set by the dispatcher. */
  session: AdminSession;
  now: number;
  /** The path under `/manage/api`, split (empty segments dropped). */
  segments: readonly string[];
  params: Readonly<Record<string, string>>;
  /** The segments a trailing `/**` covered. */
  rest: readonly string[];
  /** The product, loaded once for a `/products/:slug` route; `null` elsewhere. */
  product: ProductRow | null;
}

export type AdminHandler = (ctx: AdminCtx) => Promise<Response>;
export type AdminRoute = RouteDecl<AdminHandler>;

// ── Handlers the dispatcher owns outright ────────────────────────────────────────────────────

/**
 * `POST /logout`. R1-03: logout clears the session, so it is a mutation and goes through the CSRF
 * check (as a GET it skipped the gate, and only `SameSite=Strict` stood between it and a
 * cross-site request). Sign-out also voids the cookie server-side, for every browser this
 * operator holds; a replay of the old cookie is a 401.
 */
async function logout(c: AdminCtx): Promise<Response> {
  let revoked = true;
  try {
    await revokeAdminSessions(c.env, c.session.sub, c.now);
  } catch {
    revoked = false;
  }
  return adminJson({ ok: true, revoked }, 200, {
    "set-cookie": buildClearCookie(),
  });
}

const me: AdminHandler = (c) => handleMe(c.env, c.db, c.session);
const summary: AdminHandler = (c) =>
  handleSummary(c.req, c.env, c.db, c.session, [], c.now);
const github: AdminHandler = (c) =>
  handleGithub(c.req, c.env, c.db, c.session, c.segments.slice(1), c.now);
const platform: AdminHandler = (c) =>
  handlePlatform(c.req, c.env, c.db, c.session, c.segments.slice(1), c.now);
const storeConnections: AdminHandler = (c) =>
  handlePlatformStoreConnections(
    c.req,
    c.env,
    c.db,
    c.session,
    c.segments.slice(2),
    c.now,
  );
const registry: AdminHandler = (c) =>
  handleProducts(c.req, c.env, c.db, c.session, c.segments.slice(1), c.now);
const product: AdminHandler = (c) =>
  c.product ? handleProductScoped(c) : Promise.resolve(notFound());

// ── The table ────────────────────────────────────────────────────────────────────────────────

type Opts = Pick<AdminRoute, "level" | "stepUp">;

function rows(
  methods: readonly Method[],
  path: string,
  area: AdminRoute["area"],
  handler: AdminHandler,
  opts: Opts = {},
): AdminRoute[] {
  return methods.map((method) => ({ method, path, area, handler, ...opts }));
}

const P = "/products/:slug";
const ALL: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** A service's admin surface, by prefix, with the service's fixed area (§2.7). */
function serviceRows(slug: ServiceSlug): AdminRoute[] {
  return rows(ALL, `${P}/${slug}/**`, SERVICE_AREA[slug], product);
}

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  // ── Membership: what every console member may use ─────────────────────────────────────────
  ...rows(["GET"], "/me", "console", me),
  ...rows(["POST"], "/logout", "console", logout),
  // Home's product cards, filtered to the products the principal can see.
  ...rows(["GET"], "/summary", "console", summary),
  // The product list, filtered the same way.
  ...rows(["GET"], "/products", "console", registry),
  // NoAccessPage: who can give the caller access to a scope and area.
  ...rows(["GET"], "/access/admins", "console", handleAccessAdmins),

  // ── Platform ──────────────────────────────────────────────────────────────────────────────
  ...rows(["GET"], "/github/repositories", "platform", github),
  ...rows(["POST"], "/products", "platform", registry),
  ...rows(["GET"], "/products/slug-check", "platform", registry),
  ...rows(["GET"], "/products/kek", "platform", registry),
  ...rows(["POST"], "/products/kek", "platform", registry, { stepUp: true }),
  ...rows(["POST"], "/products/link-repo", "platform", registry),
  ...rows(["GET"], "/platform/version", "platform", platform),
  ...rows(["GET"], "/platform/deployment", "platform", platform),
  ...rows(["GET"], "/platform/operations", "platform", platform),
  ...rows(["GET"], "/platform/activity", "platform", platform),
  ...rows(["GET"], "/platform/identity-migration", "platform", platform),
  ...rows(["GET"], "/platform/reserved-names", "platform", platform),
  ...rows(["GET"], "/platform/settings", "platform", platform),
  ...rows(["PATCH", "DELETE"], "/platform/settings/:key", "platform", platform),
  ...rows(["GET", "POST"], "/platform/settings/backfill", "platform", platform),
  ...rows(["GET"], "/platform/override-migration", "platform", platform),
  ...rows(
    ["PUT"],
    "/platform/override-migration/prerequisites",
    "platform",
    platform,
  ),
  ...rows(
    ["POST", "DELETE"],
    "/platform/override-migration/notice",
    "platform",
    platform,
  ),
  ...rows(
    ["POST"],
    "/platform/override-migration/dry-run",
    "platform",
    platform,
  ),
  ...rows(["POST"], "/platform/override-migration/run", "platform", platform, {
    stepUp: true,
  }),
  ...rows(["GET"], "/platform/override-migration/report", "platform", platform),
  ...rows(["POST"], "/platform/feeds/bootstrap", "platform", platform),
  ...rows(["GET", "PUT", "POST"], "/platform/feeds/**", "platform", platform),
  ...rows(
    ["GET", "PUT", "POST", "DELETE"],
    "/platform/store-connections/**",
    "platform",
    storeConnections,
  ),

  // ── One product: the record ───────────────────────────────────────────────────────────────
  ...rows(["GET", "PATCH"], P, "core", registry),
  ...rows(["DELETE"], P, "settings", registry, { stepUp: true }),

  // ── One product: the services, by prefix ──────────────────────────────────────────────────
  ...SERVICE_SLUGS.flatMap(serviceRows),
  // Commerce's surface is `commerce` ahead of Distribution's prefix (CM-29 moves the path, not
  // the area); the Feeds admin is Ship builds, composed in the console layer.
  ...rows(
    ["GET", "PUT", "DELETE"],
    `${P}/distribution/commerce/**`,
    "commerce",
    product,
  ),
  ...rows(
    ["GET", "PUT", "POST"],
    `${P}/distribution/feeds/**`,
    "ship",
    product,
  ),

  // ── One product: Core's resources ─────────────────────────────────────────────────────────
  // Every row-backed key; the handler lists only the keys whose area the caller holds.
  ...rows(["GET"], `${P}/settings/effective`, "core", product),
  ...rows(["PATCH", "DELETE"], `${P}/settings/:key`, "byKey", product),
  ...rows(["GET", "POST"], `${P}/settings/backfill`, "settings", product),
  ...rows(["GET"], `${P}/settings/backfill/:reportId`, "settings", product),
  ...rows(["DELETE"], `${P}/claims/:key`, "byKey", product),
  ...rows(["GET", "PATCH"], `${P}/services`, "core", product),
  ...rows(["POST"], `${P}/services/revert`, "core", product),
  ...rows(["GET"], `${P}/activity`, "core", product),
  ...rows(["GET"], `${P}/refusals`, "core", product),
  ...rows(["GET"], `${P}/blob-gc`, "core", product),
  ...rows(["GET"], `${P}/blob-gc/bundles`, "core", product),
  ...rows(["GET"], `${P}/assets`, "core", product),
  ...rows(["GET"], `${P}/assets/usage`, "core", product),
  ...rows(["POST"], `${P}/assets/mirror`, "core", product),
  ...rows(["PATCH", "DELETE"], `${P}/assets/settings/:key`, "core", product),
  ...rows(["POST", "DELETE"], `${P}/assets/:slot`, "core", product),
  ...rows(["GET"], `${P}/devices`, "core", product),
  ...rows(["GET"], `${P}/devices/summary`, "core", product),
  ...rows(["GET"], `${P}/devices/:id`, "core", product),
  ...rows(["POST"], `${P}/devices/:id/deauthorize`, "core", product),
  ...rows(["POST"], `${P}/devices/:id/fingerprint/reset`, "core", product),
  ...rows(["GET"], `${P}/users`, "core", product),
  ...rows(["GET"], `${P}/users/events`, "core", product),
  ...rows(["GET"], `${P}/users/:subject`, "core", product),
  ...rows(["GET"], `${P}/users/:subject/export`, "core", product, {
    stepUp: true,
  }),
  ...rows(["POST"], `${P}/users/:subject/data/delete`, "core", product, {
    stepUp: true,
  }),
  ...rows(
    ["POST"],
    `${P}/users/:subject/licenses/:id/detach`,
    "core",
    product,
    {
      stepUp: true,
    },
  ),
  ...rows(
    ["POST"],
    `${P}/users/:subject/licenses/:id/relink`,
    "core",
    product,
    {
      stepUp: true,
    },
  ),
  ...rows(["GET"], `${P}/users/licenses/:id/relinks`, "core", product),
  ...rows(["POST"], `${P}/users/licenses/:id/make-floating`, "core", product, {
    stepUp: true,
  }),
  ...rows(["POST"], `${P}/users/licenses/:id/reassign`, "core", product, {
    stepUp: true,
  }),
  ...rows(["POST"], `${P}/users/relinks/:id/undo`, "core", product, {
    stepUp: true,
  }),
  // An account's per-licence overrides are Managed config's.
  ...rows(["GET", "PUT"], `${P}/users/:subject/overrides`, "config", product),
  // Offline activation bundles carry the licence (and config) document.
  ...rows(["POST"], `${P}/bundles`, "license", product),
  // The Polaris Key storefront's panel (PS-06) is Commerce's surface (CM-29 §10).
  ...rows(["GET"], `${P}/storefronts/:store`, "commerce", product),
  ...rows(["POST"], `${P}/storefronts/:store/preview`, "commerce", product),
  ...rows(["GET"], `${P}/storefronts/:store/analytics`, "commerce", product),

  // ── One product: Keys & secrets (credentials and trust anchors) ───────────────────────────
  ...rows(["GET"], `${P}/secrets`, "keys", product),
  ...rows(["PUT"], `${P}/secrets/:name`, "keys", product),
  ...rows(["GET"], `${P}/keys`, "keys", product),
  ...rows(["POST"], `${P}/keys/:action`, "keys", product),
  ...rows(["GET"], `${P}/outlet-credentials`, "keys", product),
  ...rows(["PUT", "DELETE"], `${P}/outlet-credentials/:id`, "keys", product),
  ...rows(["GET", "PUT"], `${P}/ci-publisher`, "keys", product),
  ...rows(["GET", "POST"], `${P}/ci-tokens`, "keys", product),
  ...rows(["DELETE"], `${P}/ci-tokens/:id`, "keys", product),
  ...rows(["GET", "PUT", "DELETE"], `${P}/trust-policy`, "keys", product),
];

/** True for a row under `/products/:slug` (product scope). */
export function isProductRoute(route: { path: string }): boolean {
  return route.path === P || route.path.startsWith(`${P}/`);
}

/** A 405 with the methods the path allows. */
export function methodNotAllowed(allow: readonly Method[]): Response {
  const res = err(405, "method_not_allowed", "method not allowed");
  res.headers.set("allow", allow.join(", "));
  return res;
}
