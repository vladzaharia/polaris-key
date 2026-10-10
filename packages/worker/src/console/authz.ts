// Authorization for the admin surface (ST-29; ST-28 plan §2.2).
//
// There is one predicate, `can(principal, scope, area, level)`, and it lives in Core
// (`core/rbac/can.ts`) so the settings write path and the docs gate use the same function as
// every admin route. This module re-exports it for the console layer. The three platform-admin predicates
// that used to live here (`isPlatformAdmin`, `canAdminProduct`, `hasAnyAdminGrant`) were one
// predicate under three names; each call site now asks `can()` for the area it needs, and the
// route table (`./routes.ts`) asks it once per request before any handler runs.
//
// The principal comes from the verified session, never from a request field: the dispatcher
// resolves it (`resolveConsoleCaller`) and hands it to the handler on `session.principal`.

import { can, type Principal, type Scope } from "../core/rbac/can.js";
import { PRODUCT_AREAS } from "../core/rbac/areas.js";

export {
  can,
  isSuperadmin,
  PLATFORM,
  ROLES,
  type Grant,
  type GrantScope,
  type Level,
  type Principal,
  type Role,
  type Scope,
} from "../core/rbac/can.js";
export {
  AREAS,
  areaName,
  isAreaId,
  PRODUCT_AREAS,
  type AreaId,
} from "../core/rbac/areas.js";
export { resolvePrincipal } from "../core/rbac/principal.js";

/** The `can()` scope of a product row: the system product is the platform's own. */
export function productScope(product: {
  slug: string;
  system?: number | null;
}): Scope {
  return { kind: "product", slug: product.slug, system: product.system === 1 };
}

/**
 * True when the principal holds any area of the product: what the product list, Home's summary
 * and `/me` show. A product the principal holds nothing of is absent, not disabled.
 */
export function canSeeProduct(
  p: Principal | null | undefined,
  product: { slug: string; system?: number | null },
): boolean {
  const scope = productScope(product);
  return PRODUCT_AREAS.some((area) => can(p, scope, area, "view"));
}
