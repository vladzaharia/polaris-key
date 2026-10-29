/**
 * Cloud Sync's product aggregate (U-05.9; L6), on the existing 15-minute connector-poll tick
 * (`ServiceDescriptor.scheduled`, run per product with Cloud Sync enabled).
 *
 * It recomputes one `sync_product_usage` row from `sync_directory`, breakdown included, so the
 * console reads one row and never scans the directory. Bounded: five aggregate statements per
 * product, no per-person work. `users` counts people holding data (`bytes > 0`).
 *
 * The directory keeps record bytes (U-09.9) and a total; settings bytes are the total less the
 * records'. It keeps a file count but no file bytes yet (U-10 adds them), so until then every byte
 * that is not a record's is a settings byte.
 */

import type { ScheduledServiceContext } from "../../core/registry.js";

const WEEK_SECONDS = 7 * 86_400;

export interface UsageBreakdown {
  /** People holding data, by tier (`tierId: null` is a person with no tier recorded). */
  byTier: {
    tierId: string | null;
    people: number;
    bytes: number;
    medianBytes: number;
    over80: number;
  }[];
  /** Bytes by kind. */
  byKind: {
    settings: number;
    records: number;
    files: number;
    revisions: number;
  };
  /** Platform of each person's last sync: people active this week, and the newest sync. */
  byPlatform: {
    platform: string | null;
    peopleThisWeek: number;
    lastSyncAt: number;
  }[];
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));

export async function computeSyncUsage(
  ctx: Pick<ScheduledServiceContext, "db" | "now">,
  product: string,
): Promise<{ users: number; bytes: number; breakdown: UsageBreakdown }> {
  const { db, now } = ctx;
  const week = now - WEEK_SECONDS;
  const total = await db.first<{
    users: number;
    bytes: number;
    records: number;
    revisions: number;
  }>(
    `SELECT COUNT(*) AS users, COALESCE(SUM(bytes), 0) AS bytes,
            COALESCE(SUM(MIN(record_bytes, bytes)), 0) AS records,
            COALESCE(SUM(revision_bytes), 0) AS revisions
       FROM sync_directory WHERE product = ? AND bytes > 0`,
    product,
  );
  const tiers = await db.all<{
    tier_id: string | null;
    people: number;
    bytes: number;
    over80: number;
  }>(
    `SELECT tier_id, COUNT(*) AS people, SUM(bytes) AS bytes,
            SUM(CASE WHEN quota_bytes > 0 AND bytes * 10 >= quota_bytes * 8 THEN 1 ELSE 0 END) AS over80
       FROM sync_directory WHERE product = ? AND bytes > 0 GROUP BY tier_id ORDER BY tier_id`,
    product,
  );
  // The median per tier: the one or two middle rows of each tier's bytes, ranked.
  const mids = await db.all<{ tier_id: string | null; bytes: number }>(
    `SELECT tier_id, bytes FROM (
       SELECT tier_id, bytes,
              ROW_NUMBER() OVER (PARTITION BY tier_id ORDER BY bytes, subject) AS rn,
              COUNT(*) OVER (PARTITION BY tier_id) AS c
         FROM sync_directory WHERE product = ? AND bytes > 0)
      WHERE rn IN ((c + 1) / 2, (c + 2) / 2)`,
    product,
  );
  const platforms = await db.all<{
    platform: string | null;
    people: number;
    last: number;
  }>(
    `SELECT platform,
            SUM(CASE WHEN last_active_at >= ? THEN 1 ELSE 0 END) AS people,
            MAX(last_active_at) AS last
       FROM sync_directory WHERE product = ? GROUP BY platform ORDER BY platform`,
    week,
    product,
  );
  const medianOf = (tier: string | null): number => {
    const rows = mids.filter((m) => m.tier_id === tier);
    return rows.length
      ? Math.round(rows.reduce((a, r) => a + n(r.bytes), 0) / rows.length)
      : 0;
  };
  const bytes = n(total?.bytes);
  const recordBytes = n(total?.records);
  return {
    users: n(total?.users),
    bytes,
    breakdown: {
      byTier: tiers.map((t) => ({
        tierId: t.tier_id,
        people: n(t.people),
        bytes: n(t.bytes),
        medianBytes: medianOf(t.tier_id),
        over80: n(t.over80),
      })),
      byKind: {
        settings: bytes - recordBytes,
        records: recordBytes,
        files: 0,
        revisions: n(total?.revisions),
      },
      byPlatform: platforms.map((p) => ({
        platform: p.platform,
        peopleThisWeek: n(p.people),
        lastSyncAt: n(p.last),
      })),
    },
  };
}

/** Writes the product's `sync_product_usage` row. Returns a summary for the cron report. */
export async function syncScheduled(
  ctx: ScheduledServiceContext,
): Promise<Record<string, unknown>> {
  const product = ctx.product.slug;
  const u = await computeSyncUsage(ctx, product);
  await ctx.db.run(
    `INSERT INTO sync_product_usage
       (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes,
        breakdown_json, computed_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT (product) DO UPDATE SET
       bytes = excluded.bytes, users = excluded.users, settings_bytes = excluded.settings_bytes,
       record_bytes = excluded.record_bytes, file_bytes = excluded.file_bytes,
       revision_bytes = excluded.revision_bytes, breakdown_json = excluded.breakdown_json,
       computed_at = excluded.computed_at`,
    product,
    u.bytes,
    u.users,
    u.breakdown.byKind.settings,
    u.breakdown.byKind.records,
    u.breakdown.byKind.revisions,
    JSON.stringify(u.breakdown),
    ctx.now,
  );
  return { users: u.users, bytes: u.bytes };
}
