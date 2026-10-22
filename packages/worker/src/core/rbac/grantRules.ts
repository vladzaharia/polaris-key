/**
 * The grant rules G1 to G4 and SM-6 eligibility (ST-28 plan §2.3 and §2.5; ST-31 slice 3).
 *
 * Pure: no I/O, no HTTP, no `Env`. The grant handlers (slices 5 to 7) call these before they
 * write anything, and the Members UI calls the same functions' results through `/me`-style
 * flags, so the console never offers what the server would refuse. Every function fails closed:
 * a granter that is `null`, a target that does not validate, or a scope the function does not
 * understand is refused.
 *
 * These rules are written out independently of `can()`: `can()` answers "may this member act
 * on this area", these answer "may this member hand out (or take back) that role".
 */

import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { PRODUCT_AREAS, type AreaId } from "./areas.js";
import { normalizeAreas } from "./bindings.js";
import {
  isSuperadmin,
  ROLES,
  type Grant,
  type GrantScope,
  type Principal,
  type Role,
} from "./can.js";

/** A role, scope and area list as a grant handler reads them from a request. */
export interface GrantSpec {
  role: Role;
  scope: GrantScope;
  /** `null` = every area, chosen explicitly. A missing field is never `null`. */
  areas: readonly AreaId[] | null;
}

export type GrantCheck =
  | { ok: true; grant: GrantSpec }
  | { ok: false; reason: string };

/** `product:<slug>`, exactly lower case. The slug is letters, digits and hyphens. */
const PRODUCT_SCOPE = /^product:([a-z0-9][a-z0-9-]*)$/;

/** The slug of a `product:<slug>` scope, or `null` for the other two scopes. */
export function productSlugOf(scope: string): string | null {
  const m = PRODUCT_SCOPE.exec(scope);
  return m ? m[1]! : null;
}

const refuse = (reason: string): GrantCheck => ({ ok: false, reason });

/**
 * Checks a request's shape and returns the grant in its stored form: areas deduplicated and in
 * `AREAS` order.
 *
 *   - `role` is one of the four; `scope` is exactly `platform`, `products:*` or lower-case
 *     `product:<slug>` (`PRODUCT:alpha` and `product:Alpha` are refused, not folded).
 *   - A Product admin takes a product scope and a Superadmin, Platform admin or Console access
 *     takes `platform`.
 *   - `areas` must be present: `null` is the explicit "every area", `undefined` is refused.
 *     Only a Product admin may carry a list, and then it is non-empty and within the product areas.
 *   - `product:<system>` is refused: the system product is a platform resource.
 */
export function validateGrant(input: unknown): GrantCheck {
  if (typeof input !== "object" || input === null) return refuse("shape");
  const o = input as Record<string, unknown>;
  const { role, scope } = o;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role))
    return refuse("role");
  if (typeof scope !== "string") return refuse("scope");
  const slug = productSlugOf(scope);
  if (scope !== "platform" && scope !== "products:*" && slug === null)
    return refuse("scope");
  if (slug === SYSTEM_PRODUCT_SLUG) return refuse("system_product");
  if (role === "product_admin" ? scope === "platform" : scope !== "platform")
    return refuse("role_scope");
  if (!("areas" in o) || o.areas === undefined) return refuse("areas_missing");
  if (o.areas === null)
    return {
      ok: true,
      grant: { role: role as Role, scope: scope as GrantScope, areas: null },
    };
  if (role !== "product_admin") return refuse("areas_role");
  if (!Array.isArray(o.areas)) return refuse("areas");
  let areas: AreaId[];
  try {
    areas = normalizeAreas(o.areas as string[]);
  } catch {
    return refuse("areas");
  }
  return {
    ok: true,
    grant: { role: "product_admin", scope: scope as GrantScope, areas },
  };
}

/** The product admin grants of `granter` that reach `scope` (`products:*` reaches every product). */
function reaching(granter: Principal, scope: GrantScope): readonly Grant[] {
  return granter.grants.filter(
    (g) =>
      g.role === "product_admin" &&
      (g.scope === scope ||
        (scope !== "products:*" && g.scope === "products:*")),
  );
}

/** What those grants add up to: `"all"`, or the union of their area lists (roles are summed). */
function coverage(grants: readonly Grant[]): "all" | ReadonlySet<AreaId> {
  const set = new Set<AreaId>();
  for (const g of grants) {
    if (g.areas === null) return "all";
    for (const a of g.areas) set.add(a);
  }
  return set;
}

const covers = (c: "all" | ReadonlySet<AreaId>, a: AreaId) =>
  c === "all" || c.has(a);

/**
 * G1 for a product admin at `scope` with `areas`: the granter holds `members` edit there and
 * Product admin there with areas that include every one asked for. NULL (every area) is covered
 * only by a granter whose own coverage there is every area.
 */
function holdsProductAdmin(
  granter: Principal,
  scope: GrantScope,
  areas: readonly AreaId[] | null,
): boolean {
  const c = coverage(reaching(granter, scope));
  if (!covers(c, "members")) return false;
  if (areas === null) return c === "all";
  return areas.every((a) => covers(c, a));
}

/** `members` edit at platform scope: only Platform admin (and Superadmin, handled by callers). */
function platformMembers(granter: Principal): boolean {
  return granter.grants.some(
    (g) => g.role === "platform_admin" && g.scope === "platform",
  );
}

/** `members` edit on at least one product. */
function someProductMembers(granter: Principal): boolean {
  return granter.grants.some(
    (g) =>
      g.role === "product_admin" &&
      (g.areas === null || g.areas.includes("members")),
  );
}

/**
 * G1, G2 and G3: may `granter` create this grant?
 *
 *   - **G2.** Superadmin, Platform admin and anything at `products:*` only by a Superadmin. A
 *     Platform admin granting Superadmin to itself is this rule.
 *   - **G3.** Console access by anyone with `members` edit at platform scope or on any product.
 *   - **G1.** A Product admin grant needs `members` edit at the scope and Product admin there
 *     with areas covering every area asked for; NULL needs a NULL-holding granter.
 *
 * An invalid target is refused (see `validateGrant`), a Superadmin included.
 */
export function mayGrant(
  granter: Principal | null | undefined,
  target: unknown,
): boolean {
  if (!granter) return false;
  const v = validateGrant(target);
  if (!v.ok) return false;
  const t = v.grant;
  if (isSuperadmin(granter)) return true;
  if (t.role === "superadmin" || t.role === "platform_admin") return false;
  if (t.scope === "products:*") return false;
  if (t.role === "console_access")
    return platformMembers(granter) || someProductMembers(granter);
  return holdsProductAdmin(granter, t.scope, t.areas);
}

/**
 * D-c: may `granter` revoke (or narrow) this stored binding? It needs `members` edit at the
 * binding's scope and areas covering the binding's, which is G1 applied to the thing taken away,
 * so no one removes a grant it could not have made. Superadmin and Platform admin bindings are
 * a Superadmin's alone (G2). A `products:*` binding is taken back by a `products:*` holder of
 * every area it carries, or a Superadmin. Console access is taken back by `members` edit at
 * platform scope, not by a product admin, so a product admin cannot remove someone from the
 * console. A binding that does not validate is a Superadmin's alone.
 */
export function mayRevoke(
  granter: Principal | null | undefined,
  binding: unknown,
): boolean {
  if (!granter) return false;
  if (isSuperadmin(granter)) return true;
  const v = validateGrant(binding);
  if (!v.ok) return false;
  const b = v.grant;
  if (b.role === "superadmin" || b.role === "platform_admin") return false;
  if (b.role === "console_access") return platformMembers(granter);
  return holdsProductAdmin(granter, b.scope, b.areas);
}

/** The areas a spec covers, `null` expanded to every product area. */
function expand(a: readonly AreaId[] | null): ReadonlySet<AreaId> {
  return new Set(a ?? PRODUCT_AREAS);
}

/**
 * G4: does this write widen access, and so need a step-up? `before` is `null` for a new binding
 * (always a widening). A different role or scope is a different grant, so also a widening.
 * Same role and scope: wider only when `after` covers an area `before` did not. An unreadable
 * `after` counts as widening and an unreadable `before` as nothing held.
 */
export function isWidening(before: unknown | null, after: unknown): boolean {
  const a = validateGrant(after);
  if (!a.ok) return true;
  if (before === null || before === undefined) return true;
  const b = validateGrant(before);
  if (!b.ok) return true;
  if (b.grant.role !== a.grant.role || b.grant.scope !== a.grant.scope)
    return true;
  // NULL also covers areas added later, so narrowing a list into NULL is a widening.
  if (a.grant.areas === null && b.grant.areas !== null) return true;
  const had = expand(b.grant.areas);
  for (const x of expand(a.grant.areas)) if (!had.has(x)) return true;
  return false;
}

export type ConfirmLevel = "L1" | "L2";

/** The step-up confirm for a widening write: L2 for Superadmin, Platform admin and `products:*`. */
export function confirmLevel(target: unknown): ConfirmLevel {
  const v = validateGrant(target);
  if (!v.ok) return "L2";
  const t = v.grant;
  return t.role === "superadmin" ||
    t.role === "platform_admin" ||
    t.scope === "products:*"
    ? "L2"
    : "L1";
}

/**
 * SM-6: may an invite for this grant bootstrap its first sign-in without a strong method? Only
 * Console access and a Product admin of one named product. Never Superadmin, Platform admin or
 * `products:*`.
 */
export function inviteBootstrapAllowed(target: unknown): boolean {
  const v = validateGrant(target);
  if (!v.ok) return false;
  const t = v.grant;
  return (
    t.role === "console_access" ||
    (t.role === "product_admin" && productSlugOf(t.scope) !== null)
  );
}
