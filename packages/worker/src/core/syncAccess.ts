/**
 * Cloud Sync's per-mutation access answer (U-02; plans/U-01.md §2.1, §6.1; S-19 §8 U-01 row).
 *
 * ── ONE MODULE FOR THE LICENCE QUESTION ──────────────────────────────────────────────────────
 *
 * Cloud Sync asks three licence-shaped questions on a write: is the device's anchor licence
 * usable (`cloudSync.writes.requireLicense`), does the device hold a flag (a store's
 * `requiresFlag`), and which tier counts for `byTier` quotas. Licensing is under review (S-19,
 * model OC): a device's entitlements will be combined over all its contributing licences by
 * `resolveDeviceEntitlements` (LX-09). So every one of those answers comes from here and nowhere
 * else, and LX-09 swaps this function's body without touching a caller.
 *
 * Until LX-09 lands, the answer is the anchor licence's own merged entitlement bucket and tier,
 * which is by definition `legacy` mode: one contributing licence, the anchor.
 *
 * ── NO OWNER FALLBACK ────────────────────────────────────────────────────────────────────────
 *
 * The subject is `resolveSyncPrincipal` (the device binding) and nothing else. Owning the
 * device's licence does not make an account the device's Cloud Sync principal; only signing in
 * on the device does (owner, 2026-10-04). Nothing here reads `licenses.account_id`, and no answer
 * carries an account id.
 */

import type { Db } from "../db/types.js";
import { getLicense, type DeviceRow } from "../repo.js";
import { resolveSyncPrincipal } from "./accountSubjects.js";
import { licenseUsable } from "./devices.js";
import { injectAdminPolicy, tighterMax, tighterMin } from "./entitlements.js";
import { resolveMergedPayload } from "./payload.js";
import type { Product } from "./products.js";

/** What a Cloud Sync mutation is checked against. `null` from `syncAccess` = no principal. */
export interface SyncAccess {
  /** The device's Cloud Sync principal: its pairwise subject, aliases already resolved. */
  subject: string;
  /** `cloudSync.writes.requireLicense`: the anchor licence is usable, scoped as Core's own
   *  device surfaces scope it (true when the product does not run the License service). */
  anchorUsable: boolean;
  /** At least one usable contributing licence (in `legacy` mode: the anchor). */
  licensed: boolean;
  /** Flag → value, the grant the licence document carries. Empty without a usable licence. */
  entitlements: Record<string, unknown>;
  /** The tier `byTier` quotas use (in `legacy` mode: the anchor's), or `null`. */
  topTier: string | null;
}

/**
 * The access answer for a Cloud Sync mutation by `device` (the row `validateDeviceToken`
 * returned). `null` means the device has no Cloud Sync principal: answer `account_required`.
 */
export async function syncAccess(
  db: Db,
  product: Pick<Product, "slug" | "services">,
  device: DeviceRow,
  now: number,
): Promise<SyncAccess | null> {
  const principal = await resolveSyncPrincipal(db, device);
  if (!principal || principal.product !== product.slug) return null;

  const anchor = device.license_id
    ? await getLicense(db, product.slug, device.license_id)
    : null;
  const licensed = licenseUsable(anchor, now);
  const anchorUsable = !product.services.license.enabled || licensed;

  let entitlements: Record<string, unknown> = {};
  let topTier: string | null = null;
  if (licensed) {
    const { payload, tier } = await resolveMergedPayload(
      db,
      product.slug,
      anchor,
      device,
      now,
    );
    injectAdminPolicy(payload, tier, anchor, tighterMin, tighterMax);
    entitlements = Object.fromEntries(
      Object.entries(payload.entitlements).map(([k, e]) => [k, e?.value]),
    );
    topTier = anchor.tier_id ?? null;
  }
  return {
    subject: principal.subject,
    anchorUsable,
    licensed,
    entitlements,
    topTier,
  };
}
