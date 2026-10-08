/**
 * SEC-DST-1: the self-healing half of migration `0107_package_file_ref_kind.sql`.
 *
 * `deploy.yml` applies migrations first and deploys the Worker second, so for a short window the
 * OLD Worker is live over the new schema: it still writes package files' blob refs as `artifact`
 * (which the blob route serves as app artifacts) and its prune, matching kind `artifact`, can no
 * longer find re-kinded rows, while still deleting the `release_artifacts` rows. This pass makes
 * the end state independent of that window. It is idempotent, bounded, and run from both cron
 * ticks and from the deploy hook once the new Worker is live:
 *
 *   1. an `artifact` ref whose `package-file` twin (same product, key, ref id) exists is deleted;
 *   2. an `artifact` ref whose release artifact row is a package's is re-kinded `package-file`;
 *   3. an `artifact` ref with NO release artifact row at all is deleted: production writes an
 *      app artifact's row and ref in one batch (`descriptor.ts`), so a ref without a row names a
 *      release that is gone (a package pruned by the old Worker) and is reachable by nothing but
 *      the blob route. Deleting it lets the collector reclaim the object. The ref id's shape is
 *      NOT used: `artifactIdFor` can produce `file:<name>` ids for app artifacts too.
 *
 * Returns the number of refs changed.
 */

import type { Db } from "../../../core/platform.js";
import { PACKAGE_FILE_REF } from "../../../core/blobs.js";

const ROW_ID = "a.release_id || '/' || a.artifact_id";

const TWIN = `EXISTS (SELECT 1 FROM blob_refs t
                      WHERE t.product = blob_refs.product AND t.storage_key = blob_refs.storage_key
                        AND t.ref_kind = '${PACKAGE_FILE_REF}' AND t.ref_id = blob_refs.ref_id)`;
const PACKAGE_ROW = `EXISTS (SELECT 1 FROM release_artifacts a
                              WHERE a.product = blob_refs.product AND a.kind = 'package'
                                AND ${ROW_ID} = blob_refs.ref_id)`;
const ANY_ROW = `EXISTS (SELECT 1 FROM release_artifacts a
                          WHERE a.product = blob_refs.product AND ${ROW_ID} = blob_refs.ref_id)`;

async function count(db: Db, where: string): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM blob_refs WHERE ref_kind = 'artifact' AND ${where}`,
  );
  return row?.n ?? 0;
}

export async function reconcilePackageFileRefs(db: Db): Promise<number> {
  const twins = await count(db, TWIN);
  if (twins)
    await db.run(
      `DELETE FROM blob_refs WHERE ref_kind = 'artifact' AND ${TWIN}`,
    );
  const moved = await count(db, PACKAGE_ROW);
  if (moved)
    await db.run(
      `UPDATE blob_refs SET ref_kind = '${PACKAGE_FILE_REF}'
        WHERE ref_kind = 'artifact' AND ${PACKAGE_ROW}`,
    );
  const orphans = await count(db, `NOT ${ANY_ROW}`);
  if (orphans)
    await db.run(
      `DELETE FROM blob_refs WHERE ref_kind = 'artifact' AND NOT ${ANY_ROW}`,
    );
  return twins + moved + orphans;
}
