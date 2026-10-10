/**
 * The console's one authorization predicate (ST-28 plan §2.2, built by ST-29).
 *
 * `can(principal, scope, area, level)` is pure: no I/O, no HTTP, no `Env`. It denies unless one
 * of the rules below allows. Every admin route reaches it through the deny-by-default dispatcher
 * (`console/routes.ts`), the docs site through `docs.ts`, and every console settings write
 * through `writeSettings()`; the console SPA's `useCan` reads the result of the same function
 * from `/me.permissions`, so the UI never decides anything the server does not.
 *
 * Core returns booleans and data only: every 401 and 403 is the console layer's (§2.2 "Errors").
 */

import { PRODUCT_AREAS, type AreaId } from "./areas.js";

export type Level = "view" | "edit";

/** The owner's four roles. Roles are summed; there are no deny rules and no custom roles. */
export type Role =
  | "superadmin"
  | "platform_admin"
  | "product_admin"
  | "console_access";

export const ROLES: readonly Role[] = [
  "superadmin",
  "platform_admin",
  "product_admin",
  "console_access",
];

/** What a check is about: the platform, or one product (`system` is the platform's own product). */
export type Scope =
  | { kind: "platform" }
  | { kind: "product"; slug: string; system: boolean };

export const PLATFORM: Scope = { kind: "platform" };

/** Where a grant applies. */
export type GrantScope = "platform" | "products:*" | `product:${string}`;

export interface Grant {
  role: Role;
  scope: GrantScope;
  /** `null` = every area. Only a `product_admin` grant may narrow. */
  areas: readonly AreaId[] | null;
  /**
   * Where it came from. ST-29 knows only `root` (`PLATFORM_ADMIN_GROUP` at the console IdP,
   * computed from the session and never stored); ST-30 to ST-32 add the rest.
   */
  source: "root" | "rule" | "grant" | "invite" | "creator" | "breakglass";
}

export interface Principal {
  /** The audit actor and limiter key. Never an account id (`accountIdBoundary.test.ts`). */
  memberId: string;
  grants: readonly Grant[];
}

/**
 * True when `p` may act on `area` in `scope` at `level`.
 *
 *   1. A `null` principal is denied.
 *   2. `console` is allowed to any member: a principal with at least one grant.
 *   3. Superadmin is allowed everything.
 *   4. A product scope whose `system` is true is evaluated as the platform, with area `platform`
 *      (the system product is a platform resource, unreachable through `products:*`).
 *   5. Platform scope: Platform admin is allowed `platform`, `members` and `docs`.
 *   6. Product scope: a `product_admin` grant on `product:<slug>` or `products:*` allows a
 *      product area when its `areas` is `null` or lists it.
 *
 * `level` is unused by the four built-in roles, which all grant view and edit. It exists so that
 * a Product viewer, if one is ever added, is a rule here rather than a change at every call site.
 */
export function can(
  p: Principal | null | undefined,
  scope: Scope,
  area: AreaId,
  level: Level,
): boolean {
  void level;
  if (!p) return false;
  if (p.grants.length === 0) return false;
  if (area === "console") return true;
  if (p.grants.some((g) => g.role === "superadmin" && g.scope === "platform"))
    return true;

  const effective: Scope =
    scope.kind === "product" && scope.system ? PLATFORM : scope;
  const effectiveArea: AreaId =
    scope.kind === "product" && scope.system ? "platform" : area;

  if (effective.kind === "platform") {
    if (
      effectiveArea !== "platform" &&
      effectiveArea !== "members" &&
      effectiveArea !== "docs"
    )
      return false;
    return p.grants.some(
      (g) => g.role === "platform_admin" && g.scope === "platform",
    );
  }

  if (!PRODUCT_AREAS.includes(effectiveArea)) return false;
  return p.grants.some(
    (g) =>
      g.role === "product_admin" &&
      (g.scope === "products:*" || g.scope === `product:${effective.slug}`) &&
      (g.areas === null || g.areas.includes(effectiveArea)),
  );
}

/** True when the principal holds Superadmin. */
export function isSuperadmin(p: Principal | null | undefined): boolean {
  return !!p?.grants.some(
    (g) => g.role === "superadmin" && g.scope === "platform",
  );
}
