/**
 * Cloud Sync's directory row as a store of account × product data (U-05.3; plans/U-05-slices.md
 * §3), registered with Core's subject-store registry (`core/accounts/subjectHooks.ts`) so an
 * account merge, a deletion and an export reach it without Sync importing Identity (rule 6).
 *
 * It claims `sync_directory`, the one table here keyed by a pairwise subject, and the per-person
 * Durable Object `CloudSyncDO` (U-05.7), named by `(product, subject)` through `do/client.ts`.
 *
 *   merge   (U-05.8) the survivor's object ABSORBS the absorbed subject's (`engine/absorb.ts`:
 *           every row joined by stamp, nothing refused or dropped for budget or quota: L8), then
 *           the absorbed object is deleted, then the directory rows are merged. Retry-safe at any
 *           crash point, because each step is idempotent and the data leaves the absorbed object
 *           only after the survivor holds it:
 *             1. export `from`                read-only
 *             2. absorb into `to`             one transaction, convergent join, a repeat writes nothing
 *             3. delete `from` if still at the exported sequence (else go back to 1)
 *             4. directory rows, ONE batch    a retry finds no absorbed row and does nothing
 *           The absorbed object is left with a marker (not empty): it refuses every later push with
           `410 absorbed`, so a write racing the merge fails instead of becoming an orphan.
           Residuals (THREAT-MODEL, Cloud Sync merge): the hook runs before Identity's D1 batch, and
           the join passes no catalog policies yet (U-05.13), so `max`/`min` keys join by lastWrite.
           A crash after 1 or 2 re-runs from 1 (the join of the same or a fresher export is the
 *           same state); after 3, the export is empty and only 4 runs. Called only by Identity's
 *           account merge, through Core's `runSubjectMerge`.
 *           The directory part adds the counters (the survivor row is made if absent), takes the
 *           larger quota, and the platform and tier of whichever side was active last.
 *   delete  the object (its alarm, then its storage), then the subject's row.
 *   export  the subject's directory counters and the object's full dump (live rows, tombstones,
 *           dormant platform rows, member cells, client bindings).
 *   size    the directory's `bytes + revision_bytes`, what the person's data takes on the Users
 *           page (I-12); until the directory has the row (its first write has not been flushed),
 *           the object's own total.
 */

import type { SubjectStore } from "../../core/accounts/subjectHooks.js";
import {
  absorbCloudSync,
  callCloudSync,
  deleteCloudSync,
  deleteCloudSyncIfUnchanged,
  exportCloudSync,
} from "./do/client.js";

/** How many times a merge re-exports an absorbed object that kept changing under it. */
const ABSORB_ROUNDS = 3;

/**
 * Move one subject's object into another's: absorb, then delete the source, while the source
 * stays the one that was absorbed (same `seq` and write count: a client binding moves only the
 * latter). The deleted source keeps a marker that refuses later writes (`410 absorbed`). Throws when it will not settle, and the merge is retried.
 */
async function absorbObject(
  env: Parameters<typeof exportCloudSync>[0],
  product: string,
  from: string,
  to: string,
): Promise<number> {
  for (let round = 0; round < ABSORB_ROUNDS; round++) {
    const doc = await exportCloudSync(env, { product, subject: from });
    if (!doc) return 0;
    const { skipped } = await absorbCloudSync(
      env,
      { product, subject: to },
      doc,
    );
    if (
      await deleteCloudSyncIfUnchanged(
        env,
        { product, subject: from },
        { seq: doc.seq, writes: doc.writes },
        to,
      )
    )
      return skipped;
  }
  throw new Error("cloud sync: the absorbed object kept changing; retry");
}

/** The registry name (stable: the export document is keyed by it). */
export const CLOUD_SYNC_STORE = "sync.cloudSync";

interface DirectoryRow {
  bytes: number;
  settings: number;
  records: number;
  record_bytes: number;
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
    if (from === to) return;
    // The rows the join left out (a sealed row against a legacy plaintext one): a count, for the
    // merge's audit row.
    const skipped = await absorbObject(env, product, from, to);
    const report = skipped > 0 ? { skipped } : undefined;
    const absorbed = await db.first<DirectoryRow>(
      "SELECT * FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      from,
    );
    if (!absorbed) return report;
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
                (product, subject, bytes, settings, records, record_bytes, files, revision_bytes,
                 quota_bytes, tier_id, platform, last_active_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (product, subject) DO UPDATE SET
                bytes = excluded.bytes, settings = excluded.settings, records = excluded.records,
                record_bytes = excluded.record_bytes, files = excluded.files, revision_bytes = excluded.revision_bytes,
                quota_bytes = excluded.quota_bytes, tier_id = excluded.tier_id,
                platform = excluded.platform, last_active_at = excluded.last_active_at,
                updated_at = excluded.updated_at`,
        params: [
          product,
          to,
          a.bytes + (s?.bytes ?? 0),
          a.settings + (s?.settings ?? 0),
          a.records + (s?.records ?? 0),
          a.record_bytes + (s?.record_bytes ?? 0),
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
    return report;
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
            recordBytes: r.record_bytes,
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

  async size({ db, env }, { product, subject }) {
    const r = await db.first<{ n: number }>(
      "SELECT bytes + revision_bytes AS n FROM sync_directory WHERE product = ? AND subject = ?",
      product,
      subject,
    );
    if (r) return Number(r.n);
    // Not flushed to the directory yet: ask the object (a read, it creates nothing).
    const u = await callCloudSync<"usage">(
      env,
      { product, subject },
      { op: "usage" },
    );
    return u.usage.bytes;
  },
};
