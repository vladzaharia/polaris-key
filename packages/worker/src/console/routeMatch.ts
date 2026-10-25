/**
 * The admin route table's shape and its matcher (ST-29; ST-28 plan §2.7). Pure: no session, no
 * I/O. `./routes.ts` declares the table; `./api.ts` is the dispatcher that walks it.
 *
 * A path is written under `/manage/api`, with `:name` for one segment and a trailing `/**` for
 * any remaining segments (zero or more), e.g. `/products/:slug/ci-tokens/:id` or
 * `/products/:slug/license/**`. When several patterns match a request, the most specific wins:
 * at the first segment where they differ, a literal beats a parameter and a parameter beats `**`.
 */

import type { AreaId } from "../core/rbac/areas.js";
import type { Level } from "../core/rbac/can.js";
import type { AdminApiScope } from "./apiTokens.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const METHODS: readonly Method[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

import {
  compareSpecificity,
  matchPath,
  type MatchedPath,
} from "../core/http/pathMatch.js";

export { compareSpecificity, matchPath, type MatchedPath };

/** One declared route. `H` is the handler type, kept generic so this module stays pure. */
export interface RouteDecl<H> {
  method: Method;
  path: string;
  /**
   * The area `can()` checks. `byKey`: `settings/:key` and `claims/:key` take the registry key's
   * `rbacArea` (a security-widening key is `keys` or `settings`, never its service's area).
   * `anyArea`: the product's own record, which every holder of any of its areas reads (the shell
   * needs its name and services to draw anything).
   */
  area: AreaId | "byKey" | "anyArea";
  /** Default: `view` for GET, else `edit`. */
  level?: Level;
  /** A console step-up (a proven sign-in within 5 minutes) is required. */
  stepUp?: true;
  /**
   * The scope an admin API token (`./apiTokens.ts`) must hold to call this row. A row without one
   * refuses every token: default deny, so a new route is unreachable by token until somebody
   * decides which scope it belongs to. Never set on a row that needs a step-up: a token has none.
   */
  tokenScope?: AdminApiScope;
  /**
   * ST-34.3: an admin-scope personal token (`Bearer pkeyp_`, `pkey login`) reaches this row. Default
   * deny, like `tokenScope`: a row without it refuses every personal token, and a row that needs a
   * step-up never carries it (the token has none). The holder's own principal still has to pass
   * `can()` for the row's area, read from the stored roles on every request.
   */
  personalToken?: true;
  /**
   * ST-34.4: only a personal token may call this row (`DELETE /me/personal-tokens/current`). A
   * session is refused. Always together with `personalToken: true`.
   */
  personalOnly?: true;
  handler: H;
}

/** The level a route needs. */
export function levelOf(route: { method: Method; level?: Level }): Level {
  return route.level ?? (route.method === "GET" ? "view" : "edit");
}

/** `METHOD /path`, the key `test/fixtures/rbac-route-areas.json` uses. */
export function routeKey(route: { method: Method; path: string }): string {
  return `${route.method} ${route.path}`;
}

export type RouteMatch<H> =
  | { kind: "route"; route: RouteDecl<H>; match: MatchedPath }
  | { kind: "method"; allow: readonly Method[] }
  | { kind: "none" };

/**
 * Find the route for a request: the most specific matching path, then the method. A path that
 * matches with no route for the method is a 405 listing what it does allow.
 */
export function findRoute<H>(
  table: readonly RouteDecl<H>[],
  method: string,
  segments: readonly string[],
): RouteMatch<H> {
  let bestPath: string | null = null;
  for (const r of table) {
    if (!matchPath(r.path, segments)) continue;
    if (bestPath === null || compareSpecificity(r.path, bestPath) < 0)
      bestPath = r.path;
  }
  if (bestPath === null) return { kind: "none" };
  const same = table.filter((r) => r.path === bestPath);
  const route = same.find((r) => r.method === method);
  if (route)
    return { kind: "route", route, match: matchPath(route.path, segments)! };
  return {
    kind: "method",
    allow: METHODS.filter((m) => same.some((r) => r.method === m)),
  };
}
