/**
 * The writes behind the console's package-feed settings and platform policy (P0-19): the SQL on
 * `dist_registry_feeds` and `dist_registry_policy` lives in Distribution, which owns the tables
 * (`db/owners.ts`); `console/handlers/feeds.ts` validates, calls these through `public.ts` and
 * audits. Each answers the rows it changed, so the caller reports a version conflict on 0.
 */

import type { Db } from "../../../db/types.js";

/** One feed's settings write, optimistic on `expected` (0 = the feed has no row yet). */
export interface FeedSettingsWrite {
  owner: string;
  ecosystem: string;
  expected: number;
  enabled: boolean;
  /** The access mode a new row starts with. */
  accessMode: string;
  /** The access mode an existing row takes (the row's own when the caller sent none). */
  updateAccessMode: string;
  namespace: unknown;
  maxPackageBytes: number;
  ext: unknown;
  now: number;
  by: string;
}

export async function writeFeedSettings(
  db: Db,
  w: FeedSettingsWrite,
): Promise<number> {
  if (w.expected === 0)
    return db.runChanges(
      `INSERT INTO dist_registry_feeds
         (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes,
          upstream, claims_json, ext_json, version, updated_at, updated_by)
       SELECT ?, ?, ?, ?, ?, ?, 'none', '[]', ?, 1, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM dist_registry_feeds
                           WHERE product = ? AND ecosystem = ?)`,
      w.owner,
      w.ecosystem,
      w.enabled ? 1 : 0,
      w.accessMode,
      JSON.stringify(w.namespace),
      w.maxPackageBytes,
      JSON.stringify(w.ext),
      w.now,
      w.by,
      w.owner,
      w.ecosystem,
    );
  return db.runChanges(
    `UPDATE dist_registry_feeds
        SET enabled = ?, access_mode = ?, namespace_json = ?, max_package_bytes = ?,
            ext_json = ?, version = version + 1, updated_at = ?, updated_by = ?
      WHERE product = ? AND ecosystem = ? AND version = ?`,
    w.enabled ? 1 : 0,
    w.updateAccessMode,
    JSON.stringify(w.namespace),
    w.maxPackageBytes,
    JSON.stringify(w.ext),
    w.now,
    w.by,
    w.owner,
    w.ecosystem,
    w.expected,
  );
}

/** The platform policy write for one ecosystem, optimistic on `expectedVersion`. */
export async function writePlatformPolicy(
  db: Db,
  w: {
    ecosystem: string;
    enabled: boolean;
    ceiling: number;
    expectedVersion: number;
    now: number;
    by: string;
  },
): Promise<number> {
  return db.runChanges(
    `UPDATE dist_registry_policy
        SET enabled = ?, max_package_bytes_ceiling = ?, version = version + 1, updated_at = ?,
            updated_by = ?
      WHERE ecosystem = ? AND version = ?`,
    w.enabled ? 1 : 0,
    w.ceiling,
    w.now,
    w.by,
    w.ecosystem,
    w.expectedVersion,
  );
}
