/**
 * Cloud Sync's per-device access answer (U-02, U-05.10; plans/U-01b.md D5; WIRE-CONTRACT-V4 §13.1).
 *
 * ── ONE MODULE FOR THE LICENCE QUESTION ──────────────────────────────────────────────────────
 *
 * Cloud Sync asks licence-shaped questions of a device: does it hold a usable anchor licence,
 * which flags does that licence grant (a store's `requiresFlag`), and how many bytes may the
 * person keep when writing from it. Licensing is under review (S-19, model OC): a device's
 * entitlements will be combined over all its contributing licences by `resolveDeviceEntitlements`
 * (LX-09). So every answer comes from here and nowhere else, and LX-09 swaps this function's
 * body without touching a caller. Until then the answer is the anchor licence's own merged
 * entitlement bucket, which is by definition `legacy` mode: one contributing licence.
 *
 * The quota is per device (D5), resolved on each request:
 *  - License service off: the platform default, `cloudSync.quota.defaultBytes` (its default is
 *    `SYNC_QUOTA_BYTES`), files allowed;
 *  - a usable anchor licence: its integer `pkey.cloudSync.bytes`, else the platform default,
 *    files allowed. A value that is not a non-negative safe integer is no value;
 *  - no usable licence: the Anonymous devices tier (LX-36; `ANONYMOUS_TIER_QUOTA`, `null` until
 *    it lands), else `CLOUD_SYNC_DEFAULTS.unlicensedQuotaBytes` with files refused.
 * The result is clamped to `CLOUD_SYNC_CEILINGS.perPerson.bytes`; `0` means reads only. Usage is
 * per person, so two devices of one person can get different quotas; a quota never deletes.
 *
 * ── NO OWNER FALLBACK ────────────────────────────────────────────────────────────────────────
 *
 * The subject is `resolveSyncPrincipal` (the device binding) and nothing else. Owning the
 * device's licence does not make an account the device's Cloud Sync principal; only signing in
 * on the device does (owner, 2026-10-04). Nothing here reads `licenses.account_id`, and no answer
 * carries an account id. The one licence-derived string returned is `tierId`, a product's own
 * tier name, never an account or licence identifier.
 */

import { CLOUD_SYNC_CEILINGS, CLOUD_SYNC_DEFAULTS } from "@polaris-key/catalog";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { platformSetting } from "../settings/platformRead.js";
import { type DeviceRow } from "../repo.js";
import { getLicense } from "../licensing/store.js";
import { resolveSyncPrincipal } from "./accountSubjects.js";
import { licenseUsable } from "../devices.js";
import {
  injectAdminPolicy,
  tighterMax,
  tighterMin,
} from "../licensing/entitlements.js";
import { resolveMergedPayload } from "../licensing/payload.js";
import { customerTierOf } from "../licensing/implicitTier.js";
import type { Product } from "../products.js";

/** The entitlement a tier, a licence override or an add-on sets (plans/U-01b.md D5). */
export const CLOUD_SYNC_BYTES_ENTITLEMENT = "pkey.cloudSync.bytes";

/** One device's Cloud Sync quota (§13.1). `files: false` refuses a file; `bytes: 0` is reads only. */
export interface SyncQuota {
  bytes: number;
  files: boolean;
}

/**
 * The Anonymous devices tier's quota (LX-36), read for a device with no usable licence. LX-36 is
 * todo, so this answers `null` and the 1 MiB, files-refused floor applies.
 */
function anonymousTierQuota(): SyncQuota | null {
  return null;
}

/** The longest `tierId` the Cloud Sync object accepts (`isName` in `do/cloudSyncDo.ts`). */
const TIER_ID_MAX = 256;

/** What a Cloud Sync mutation is checked against. `null` from `syncAccess` = no principal. */
export interface SyncAccess {
  /** The device's Cloud Sync principal: its pairwise subject, aliases already resolved. */
  subject: string;
  /** At least one usable contributing licence (in `legacy` mode: the anchor). */
  licensed: boolean;
  /** Flag → value, the grant the licence document carries. Empty without a usable licence. */
  entitlements: Record<string, unknown>;
  /** The requesting device's quota (D5), already clamped to the per-person ceiling. */
  quota: SyncQuota;
  /** The anchor licence's tier when usable (a string the object accepts), else `null`. */
  tierId: string | null;
}

const clampBytes = (n: number): number =>
  Math.min(Math.max(n, 0), CLOUD_SYNC_CEILINGS.perPerson.bytes);

/**
 * The access answer for a Cloud Sync mutation by `device` (the row `validateDeviceToken`
 * returned). `null` means the device has no Cloud Sync principal: answer `account_required`.
 */
export async function syncAccess(
  env: Env,
  db: Db,
  product: Pick<Product, "slug" | "services">,
  device: DeviceRow,
  now: number,
): Promise<SyncAccess | null> {
  const principal = await resolveSyncPrincipal(db, device);
  if (!principal || principal.product !== product.slug) return null;

  const licenseOff = !product.services.license.enabled;
  const anchor = device.license_id
    ? await getLicense(db, product.slug, device.license_id)
    : null;
  const licensed = licenseUsable(anchor, now);

  let entitlements: Record<string, unknown> = {};
  if (licensed) {
    const { payload, tier } = await resolveMergedPayload(
      db,
      product.slug,
      anchor,
      device,
      now,
      { entitlementsOnly: true },
    );
    injectAdminPolicy(payload, tier, anchor, tighterMin, tighterMax);
    entitlements = Object.fromEntries(
      Object.entries(payload.entitlements).map(([k, e]) => [k, e?.value]),
    );
  }

  let quota: SyncQuota;
  let tierId: string | null = null;
  if (licenseOff || licensed) {
    const grant =
      !licenseOff && licensed
        ? entitlements[CLOUD_SYNC_BYTES_ENTITLEMENT]
        : null;
    const bytes =
      Number.isSafeInteger(grant) && (grant as number) >= 0
        ? (grant as number)
        : await platformSetting(env, db, "cloudSync.quota.defaultBytes");
    quota = { bytes, files: true };
    const t = !licenseOff && licensed ? (anchor?.tier_id ?? null) : null;
    tierId = t !== null && t.length > 0 && t.length <= TIER_ID_MAX ? t : null;
  } else {
    quota = anonymousTierQuota() ?? {
      bytes: CLOUD_SYNC_DEFAULTS.unlicensedQuotaBytes,
      files: false,
    };
  }
  quota = { bytes: clampBytes(quota.bytes), files: quota.files };

  return { subject: principal.subject, licensed, entitlements, quota, tierId };
}
