/**
 * `requireLicensedDevice` — the license-side half of the device-token check.
 *
 * ── WHAT MOVED, AND WHY ─────────────────────────────────────────────────────────────────────
 *
 * Core's `validateDeviceToken` used to answer two questions at once: does this token name a
 * live device row, AND is the licence behind that device usable. Wire v3 forces them apart,
 * because a product may run Config with License disabled (D-08): its devices are registered and
 * hold real tokens but have no licence, and a Core that refuses them could never serve
 * `GET /<p>/config/document`.
 *
 * So Core answers the first question and this file answers the second, in exactly the position
 * the fused version applied it — after the device row, the token-hash binding and the
 * device/licence agreement have all been checked, and before anything is returned. Same
 * predicate (`core.licenseUsable`), same single failure code, same ordering, so every 401 this
 * produces is the same 401 for the same reason it was before the split.
 *
 * ── WHO CALLS IT ────────────────────────────────────────────────────────────────────────────
 *
 * Every surface that was licence-gated before still is:
 *
 *   - inside the service: `/license/{token,deauthorize,document}`
 *   - outside it, through the compat export on `services/license/index.ts`: identity's
 *     `/session` (`browserSession.ts`) and, via its own local guard, the config service's
 *     edge-mint confused-deputy check
 *
 * The ONLY surface that takes Core's answer unqualified is `GET /<p>/config/document`, which is
 * the whole point (§2.2).
 */

import type { Env, Db } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import {
  licenseUsable,
  validateDeviceToken,
  type LicensedDeviceToken,
} from "../../core/devices.js";

export type { LicensedDeviceToken };

/**
 * Validate a device token AND require the licence behind it to be usable.
 *
 * Returns the same `{ error: "unauthorized" }` for a bad token and for a dead licence: telling
 * them apart would let an unauthenticated caller probe licence state with a stolen token.
 */
export async function requireLicensedDevice(
  env: Env,
  db: Db,
  product: Product,
  token: string | null,
  now: number,
  opts: { deviceId?: string | null } = {},
): Promise<LicensedDeviceToken | { error: "unauthorized" }> {
  const valid = await validateDeviceToken(env, db, product, token, now, opts);
  if ("error" in valid) return valid;
  if (!licenseUsable(valid.license, now)) return { error: "unauthorized" };
  return {
    tokenHash: valid.tokenHash,
    license: valid.license,
    device: valid.device,
  };
}
