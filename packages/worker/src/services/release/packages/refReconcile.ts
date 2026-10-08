/**
 * SEC-DST-1: the self-healing half of migration `0107_package_file_ref_kind.sql`.
 *
 * `deploy.yml` applies migrations first and deploys the Worker second, so for a short window the
 * OLD Worker is live over the new schema and may write a package file's blob ref as `artifact`
 * (which the blob route serves as an app artifact). This pass makes the end state independent of
 * that window. It is idempotent and bounded:
 *
 *   1. an `artifact` ref whose `package-file` twin (same product, key, ref id) exists is deleted;
 *   2. an `artifact` ref whose release artifact row is a package's is re-kinded `package-file`
 *      (unless a twin appeared meanwhile: the primary key would conflict, step 1 takes it next run).
 *
 * Refs with NO release artifact row are deliberately left alone: deleting them could make bytes
 * collectable from data this pass cannot see.
 *
 * Every subquery is UNCORRELATED, so SQLite builds one ephemeral index per statement instead of
 * scanning `release_artifacts` per ref (`blob_refs` has no index on `ref_kind`; the single scan of
 * it is the whole cost). The cron path (`scope: "cron"`) only looks at products that have package
 * versions and handles at most `CRON_BATCH` refs per kind; the new Worker never writes `artifact`
 * refs for packages, so a tick normally finds nothing. The deploy hook (`scope: "all"`) is the full
 * pass, once.
 *
 * Returns the number of refs changed.
 */

import type { Db } from "../../../core/platform.js";
import { PACKAGE_FILE_REF } from "../../../core/blobs.js";

export const CRON_BATCH = 500;

const PACKAGE_REFS = `SELECT product, storage_key, ref_id FROM blob_refs WHERE ref_kind = '${PACKAGE_FILE_REF}'`;

function candidates(extra: string, scope: "cron" | "all"): string {
  return `SELECT r.rowid FROM blob_refs r
           WHERE r.ref_kind = 'artifact' ${extra}
             ${scope === "cron" ? "AND r.product IN (SELECT product FROM release_packages)" : ""}
           LIMIT ?`;
}

/** Statement text, exported so the test can read the query plan. */
export function reconcileSql(scope: "cron" | "all") {
  return {
    dropTwins: `DELETE FROM blob_refs WHERE rowid IN (${candidates(
      `AND (r.product, r.storage_key, r.ref_id) IN (${PACKAGE_REFS})`,
      scope,
    )})`,
    rekind: `UPDATE blob_refs SET ref_kind = '${PACKAGE_FILE_REF}' WHERE rowid IN (${candidates(
      `AND (r.product, r.ref_id) IN (SELECT product, release_id || '/' || artifact_id
                                        FROM release_artifacts WHERE kind = 'package')
             AND (r.product, r.storage_key, r.ref_id) NOT IN (${PACKAGE_REFS})`,
      scope,
    )})`,
  };
}

export async function reconcilePackageFileRefs(
  db: Db,
  scope: "cron" | "all" = "all",
): Promise<number> {
  const limit = scope === "cron" ? CRON_BATCH : -1;
  const sql = reconcileSql(scope);
  const dropped = await db.runChanges(sql.dropTwins, limit);
  const moved = await db.runChanges(sql.rekind, limit);
  return dropped + moved;
}
