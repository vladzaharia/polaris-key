/// <reference types="@cloudflare/workers-types" />

/**
 * The product's tiers as Cloud Sync's console shows them (U-05.19; plans/U-05-slices.md L18):
 * each tier's label and the per-person byte limit its profile grants, read for a service that
 * may not read `tiers` itself (License owns the table; `tableCrossings`).
 *
 * `bytes` is the integer `pkey.cloudSync.bytes` the tier's baseline profile (over the catalog
 * defaults) sets, or `null` when the tier does not set one: it uses the platform default, which
 * `defaultBytes` carries. Read-only, and no per-person data.
 */

import { CLOUD_SYNC_CEILINGS } from "@polaris-key/catalog";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { platformSetting } from "../settings/platformRead.js";
import { getProfile, listTiers } from "../licensing/store.js";
import { catalogDefaultPayload } from "../licensing/payload.js";
import { mergePayloads } from "../licensing/merge.js";
import { CLOUD_SYNC_BYTES_ENTITLEMENT } from "./syncAccess.js";

export interface SyncTierLimit {
  id: string;
  label: string;
  /** The tier's own per-person limit, or `null` when it uses the platform default. */
  bytes: number | null;
}

export interface SyncTierLimits {
  tiers: SyncTierLimit[];
  /** The platform default per-person quota (`cloudSync.quota.defaultBytes`), clamped. */
  defaultBytes: number;
}

export async function syncTierLimits(
  env: Env,
  db: Db,
  product: string,
  now: number,
): Promise<SyncTierLimits> {
  const [rows, base, def] = await Promise.all([
    listTiers(db, product),
    catalogDefaultPayload(db, product, now),
    platformSetting(env, db, "cloudSync.quota.defaultBytes"),
  ]);
  const tiers: SyncTierLimit[] = [];
  for (const t of rows) {
    const profile = t.profile_id
      ? await getProfile(db, product, t.profile_id)
      : null;
    const grant = mergePayloads(base, profile?.payload_json ?? null)
      .entitlements[CLOUD_SYNC_BYTES_ENTITLEMENT]?.value;
    const bytes =
      Number.isSafeInteger(grant) && (grant as number) >= 0
        ? Math.min(grant as number, CLOUD_SYNC_CEILINGS.perPerson.bytes)
        : null;
    tiers.push({ id: t.id, label: t.label, bytes });
  }
  return {
    tiers,
    defaultBytes: Math.min(
      Math.max(def, 0),
      CLOUD_SYNC_CEILINGS.perPerson.bytes,
    ),
  };
}
