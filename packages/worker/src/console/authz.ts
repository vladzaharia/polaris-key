// Authorization for the admin surface. There is exactly ONE privilege level:
//
//   PLATFORM admin — a member of `env.PLATFORM_ADMIN_GROUP`. May manage the product registry
//   itself (create/delete products) and may administer EVERY product.
//
// Per-product admin does not exist and is not planned. It previously survived as scaffolding
// — a `_product` parameter that was ignored, a `_products` parameter that was ignored, and
// doc comments describing a product-group gate — which made the model look more granular than
// it is. That scaffolding is gone: the parameters were removable precisely because nothing
// read them, and a signature that accepts an argument it ignores invites callers to believe a
// check is happening. Anything that needs per-product authority must add a real gate here.
//
// All gating reads `groups` from the verified session, never from a request field.

import type { Env } from "../platform/env.js";
import type { AdminSession } from "../core/console/session.js";

/** True if the session belongs to a platform-wide administrator. */
export function isPlatformAdmin(env: Env, session: AdminSession): boolean {
  const group = env.PLATFORM_ADMIN_GROUP;
  if (!group) return false;
  return session.groups.includes(group);
}

/**
 * True if the session may administer a product. Platform-only: every product is administered
 * by the same group, so this takes no product argument.
 */
export function canAdminProduct(env: Env, session: AdminSession): boolean {
  return isPlatformAdmin(env, session);
}

/**
 * True if the identity's groups grant ANY admin access at all (the login gate).
 *
 * This is deliberately the SAME predicate as `isPlatformAdmin` — it is not a weaker "can you
 * sign in" check. Keeping the two identical is what makes the audited cross-product 403 in
 * `api.ts` unreachable for any session the OIDC callback can mint (R1-04).
 */
export function hasAnyAdminGrant(env: Env, groups: string[]): boolean {
  const group = env.PLATFORM_ADMIN_GROUP;
  if (!group) return false;
  return groups.includes(group);
}
