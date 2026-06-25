// Authorization helpers for the admin surface. Two privilege levels:
//   - PLATFORM admin: a member of `env.PLATFORM_ADMIN_GROUP` — may manage the product
//     registry itself (create/delete products) and may administer ANY product.
//   - PRODUCT admin: reserved metadata for a future RBAC pass. In v1, product groups do
//     not grant write access; only platform admins administer products.
//
// All gating reads `groups` from the verified session, never from a request field.

import type { Env } from "../env.js";
import type { AdminSession } from "./session.js";
import type { ProductRow } from "../repo.js";

/** True if the session belongs to a platform-wide administrator. */
export function isPlatformAdmin(env: Env, session: AdminSession): boolean {
  const group = env.PLATFORM_ADMIN_GROUP;
  if (!group) return false;
  return session.groups.includes(group);
}

/** True if the session may administer the given product (platform OR product admin). */
export function canAdminProduct(
  env: Env,
  session: AdminSession,
  _product: ProductRow,
): boolean {
  return isPlatformAdmin(env, session);
}

/** True if the identity's groups grant ANY admin access at all (used at login). */
export function hasAnyAdminGrant(
  env: Env,
  groups: string[],
  _products: ProductRow[],
): boolean {
  if (env.PLATFORM_ADMIN_GROUP && groups.includes(env.PLATFORM_ADMIN_GROUP))
    return true;
  return false;
}
