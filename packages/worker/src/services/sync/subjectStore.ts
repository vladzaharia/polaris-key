/**
 * Cloud Sync's directory row as a store of account × product data (U-05.3; plans/U-05-slices.md
 * §3), registered with Core's subject-store registry (`core/accounts/subjectHooks.ts`) so an
 * account merge, a deletion and an export reach it without Sync importing Identity (rule 6).
 *
 * This is the D1 half. It claims `sync_directory`, the one table here keyed by a pairwise
 * subject. The per-person Durable Object (U-05.7) joins the same store as `durableObjects` when it
 * lands; until then no object exists to re-key.
 *
 *   merge   the absorbed subject's counters are added to the survivor's (the survivor row is made
 *           if absent), the quota is the larger of the two, the platform and tier follow whichever
 *           side was active last, and the absorbed row goes, all in ONE batch, so a retry finds no
 *           absorbed row and does nothing.
 *   delete  the subject's row.
 *   export  the subject's directory counters (no content: the data itself is the object's).
 *   size    `bytes + revision_bytes`, what the person's data takes on the Users page (I-12).
 */

import type { SubjectStore } from "../../core/accounts/subjectHooks.js";

/** The registry name (stable: the export document is keyed by it). */
export const CLOUD_SYNC_STORE = "sync.cloudSync";

interface DirectoryRow {
  bytes: number;
  settings: number;
  records: number;
  files: number;
  revision_bytes: number;
  quota_bytes: number;
  tier_id: string | null;
  platform: string | null;
  last_active_at: number;
  updated_at: number;
}

export const cloudSyncStore: SubjectStore = {
  tables: ["sync_directory"],

  async merge({ db, now }, { product, from, to }) {
    const absorbed = await db.first<DirectoryRow>(
      "SELECT * FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      from,
    );
    if (!absorbed || from === to) return;
    const survivor = await db.first<DirectoryRow>(
      "SELECT * FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      to,
    );
    const a = absorbed;
    const s = survivor;
    const aLater = !s || a.last_active_at > s.last_active_at;
    await db.batch([
      {
        sql: `INSERT INTO sync_directory
                (product, subject, bytes, settings, records, files, revision_bytes, quota_bytes,
                 tier_id, platform, last_active_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (product, subject) DO UPDATE SET
                bytes = excluded.bytes, settings = excluded.settings, records = excluded.records,
                files = excluded.files, revision_bytes = excluded.revision_bytes,
                quota_bytes = excluded.quota_bytes, tier_id = excluded.tier_id,
                platform = excluded.platform, last_active_at = excluded.last_active_at,
                updated_at = excluded.updated_at`,
        params: [
          product,
          to,
          a.bytes + (s?.bytes ?? 0),
          a.settings + (s?.settings ?? 0),
          a.records + (s?.records ?? 0),
          a.files + (s?.files ?? 0),
          a.revision_bytes + (s?.revision_bytes ?? 0),
          Math.max(a.quota_bytes, s?.quota_bytes ?? 0),
          aLater
            ? (a.tier_id ?? s?.tier_id ?? null)
            : (s!.tier_id ?? a.tier_id),
          aLater
            ? (a.platform ?? s?.platform ?? null)
            : (s!.platform ?? a.platform),
          Math.max(a.last_active_at, s?.last_active_at ?? 0),
          now,
        ],
      },
      {
        sql: "DELETE FROM sync_directory WHERE product = ? AND subject = ?",
        params: [product, from],
      },
    ]);
  },

  async delete({ db }, { product, subject }) {
    await db.run(
      "DELETE FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      subject,
    );
  },

  async export({ db }, { product, subject }) {
    const r = await db.first<DirectoryRow>(
      "SELECT * FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      subject,
    );
    return {
      directory: r
        ? {
            bytes: r.bytes,
            settings: r.settings,
            records: r.records,
            files: r.files,
            revisionBytes: r.revision_bytes,
            quotaBytes: r.quota_bytes,
            tierId: r.tier_id,
            platform: r.platform,
            lastActiveAt: r.last_active_at,
            updatedAt: r.updated_at,
          }
        : null,
    };
  },

  async size({ db }, { product, subject }) {
    const r = await db.first<{ n: number }>(
      "SELECT bytes + revision_bytes AS n FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      subject,
    );
    return Number(r?.n ?? 0);
  },
};
