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

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const METHODS: readonly Method[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

export interface MatchedPath {
  /** `:name` segments, by name. */
  params: Readonly<Record<string, string>>;
  /** The segments a trailing `/**` covered (empty when none, or when the pattern has none). */
  rest: readonly string[];
}

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

function patternSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Match one pattern against request segments, or `null`. */
export function matchPath(
  pattern: string,
  segments: readonly string[],
): MatchedPath | null {
  const pat = patternSegments(pattern);
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === "**") {
      if (i !== pat.length - 1) return null;
      return { params, rest: segments.slice(i) };
    }
    const s = segments[i];
    if (s === undefined) return null;
    if (p.startsWith(":")) params[p.slice(1)] = s;
    else if (p !== s) return null;
  }
  return segments.length === pat.length ? { params, rest: [] } : null;
}

/** Segment rank for specificity: literal 0, parameter 1, `**` 2, absent 3. */
function rank(seg: string | undefined): number {
  if (seg === undefined) return 3;
  if (seg === "**") return 2;
  return seg.startsWith(":") ? 1 : 0;
}

/** Negative when `a` is more specific than `b`. */
export function compareSpecificity(a: string, b: string): number {
  const pa = patternSegments(a);
  const pb = patternSegments(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = rank(pa[i]) - rank(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
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
