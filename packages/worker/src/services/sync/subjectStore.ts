/**
 * Cloud Sync's directory row as a store of account × product data (U-05.3; plans/U-05-slices.md
 * §3), registered with Core's subject-store registry (`core/accounts/subjectHooks.ts`) so an
 * account merge, a deletion and an export reach it without Sync importing Identity (rule 6).
 *
 * It claims `sync_directory`, the one table here keyed by a pairwise subject, and the per-person
 * Durable Object `CloudSyncDO` (U-05.7), named by `(product, subject)` through `do/client.ts`.
 * Until U-05.8 `merge` refuses (throws) when the absorbed subject's object holds data, so a merge
 * never drops it silently; U-05.8 replaces that with the absorb.
 *
 *   merge   the absorbed subject's counters are added to the survivor's (the survivor row is made
 *           if absent), the quota is the larger of the two, the platform and tier follow whichever
 *           side was active last, and the absorbed row goes, all in ONE batch, so a retry finds no
 *           absorbed row and does nothing.
 *   delete  the object (its alarm, then its storage), then the subject's row.
 *   export  the subject's directory counters and the object's settings dump.
 *   size    `bytes + revision_bytes`, what the person's data takes on the Users page (I-12).
 */

import type { SubjectStore } from "../../core/accounts/subjectHooks.js";
import {
  cloudSyncHoldsData,
  deleteCloudSync,
  exportCloudSync,
} from "./do/client.js";

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
  durableObjects: ["CloudSyncDO"],

  async merge({ db, env, now }, { product, from, to }) {
    // U-05.8 absorbs the object; until then a merge that would drop data stops here, and the
    // retry (idempotent: nothing was written) finds the same state.
    if (
      from !== to &&
      (await cloudSyncHoldsData(env, { product, subject: from }))
    )
      throw new Error(
        "cloud sync: the absorbed subject holds synced data, and the absorb is not built yet (U-05.8)",
      );
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

  async delete({ db, env }, { product, subject }) {
    // The object first: a crash between the two leaves a directory row, which a retry removes.
    await deleteCloudSync(env, { product, subject });
    await db.run(
      "DELETE FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      subject,
    );
  },

  async export({ db, env }, { product, subject }) {
    const settings = await exportCloudSync(env, { product, subject });
    const r = await db.first<DirectoryRow>(
      "SELECT * FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      subject,
    );
    return {
      settings,
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
