/**
 * `GET /manage/api/products/<slug>/sync/usage` (U-05.19): the Usage page's facts in one read.
 *
 *   - `usage`: the product's `sync_product_usage` row (the 15-minute aggregate; `computedAt`
 *     says how old it is) with its breakdown;
 *   - `today`: today's UTC `sync_product_daily` counters;
 *   - `tiers` / `defaultBytes`: tier labels and limits, through Core (`syncTierLimits`).
 *
 * Counts and bytes only: no person, subject, device id or email appears in the answer, and the
 * console computes nothing from it. A product with Cloud Sync off answers `{ enabled: false }`.
 */

import { adminJson } from "../../../core/console/respond.js";
import { syncTierLimits } from "../../../core/accounts/syncTierLimits.js";
import type { UsageBreakdown } from "../scheduled.js";
import type { SyncAdminContext } from "./index.js";

const n = (v: unknown): number => (v == null ? 0 : Number(v));

export async function handleUsage(ctx: SyncAdminContext): Promise<Response> {
  const { env, db, product, now } = ctx;
  if (!product.services.sync.enabled) return adminJson({ enabled: false });
  const slug = product.slug;
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const [row, daily, limits] = await Promise.all([
    db.first<{
      bytes: number;
      users: number;
      settings_bytes: number;
      record_bytes: number;
      file_bytes: number;
      revision_bytes: number;
      breakdown_json: string;
      computed_at: number;
    }>("SELECT * FROM sync_product_usage WHERE product = ?", slug),
    db.first<{ syncs: number; conflicts: number }>(
      "SELECT syncs, conflicts FROM sync_product_daily WHERE product = ? AND day = ?",
      slug,
      day,
    ),
    syncTierLimits(env, db, slug, now),
  ]);
  let breakdown: UsageBreakdown = {
    byTier: [],
    byKind: { settings: 0, records: 0, files: 0, revisions: 0 },
    byPlatform: [],
  };
  try {
    if (row) breakdown = JSON.parse(row.breakdown_json) as UsageBreakdown;
  } catch {
    // a malformed breakdown shows as empty; the totals still read
  }
  return adminJson({
    enabled: true,
    usage: {
      bytes: n(row?.bytes),
      people: n(row?.users),
      settingsBytes: n(row?.settings_bytes),
      recordBytes: n(row?.record_bytes),
      fileBytes: n(row?.file_bytes),
      revisionBytes: n(row?.revision_bytes),
      computedAt: n(row?.computed_at),
      breakdown,
    },
    today: { day, syncs: n(daily?.syncs), conflicts: n(daily?.conflicts) },
    tiers: limits.tiers,
    defaultBytes: limits.defaultBytes,
  });
}
