/**
 * A package version's feed state (F-03, plans/F-01.md §6.3): `release_packages.state` is `live`,
 * `yanked` or `deprecated`, with `state_message` the PEP 592 yank reason or the npm deprecation
 * message. Release's yank and unyank write it in the same batch as `release_yanks`; deprecate is
 * package-only. Every change enqueues a render of the package's feeds in that batch. Nothing here
 * deletes a row: a version is unique forever.
 */

import type { Db, DbStatement } from "../../../db/types.js";
import { stmtEnqueuePackageRender } from "../../../core/registry/registryQueue.js";

/** The package row of a release, or null when the release is not a package version. */
export async function packageReleaseOf(
  db: Db,
  product: string,
  releaseId: string,
): Promise<{
  deliverableId: string;
  state: "live" | "yanked" | "deprecated";
} | null> {
  const row = await db.first<{
    deliverable_id: string;
    state: "live" | "yanked" | "deprecated";
  }>(
    "SELECT deliverable_id, state FROM release_packages WHERE product = ? AND release_id = ?",
    product,
    releaseId,
  );
  return row ? { deliverableId: row.deliverable_id, state: row.state } : null;
}

export type PackageStateOp = "yank" | "unyank" | "deprecate" | "undeprecate";

/**
 * The statements that move a package version's state for `op`, and enqueue its render; `[]` when
 * `releaseId` is not a package version. A yank overrides a deprecation (its text is kept in
 * `deprecation_message`); an unyank returns the version to what it was, `deprecated` again if it
 * was; deprecate applies only to a live version and undeprecate only to a
 * deprecated one (the caller refuses the others first).
 */
export async function packageStateStatements(
  db: Db,
  product: string,
  releaseId: string,
  op: PackageStateOp,
  message: string | null,
  now: number,
): Promise<DbStatement[]> {
  const pkg = await packageReleaseOf(db, product, releaseId);
  if (!pkg) return [];
  const where = `WHERE product = ? AND release_id = ?`;
  let update: DbStatement;
  if (op === "yank") {
    // A yank overrides a deprecation, and keeps its text aside for the unyank.
    update = {
      sql: `UPDATE release_packages
               SET deprecation_message = CASE WHEN state = 'deprecated' THEN state_message
                                              ELSE deprecation_message END,
                   state = 'yanked', state_message = ?
             ${where} AND state IN ('live', 'deprecated', 'yanked')`,
      params: [message, product, releaseId],
    };
  } else if (op === "unyank") {
    // An unyank returns to what the version was before: deprecated again when it was.
    update = {
      sql: `UPDATE release_packages
               SET state = CASE WHEN deprecation_message IS NULL THEN 'live' ELSE 'deprecated' END,
                   state_message = deprecation_message, deprecation_message = NULL
             ${where} AND state = 'yanked'`,
      params: [product, releaseId],
    };
  } else if (op === "deprecate") {
    update = {
      sql: `UPDATE release_packages SET state = 'deprecated', state_message = ?
             ${where} AND state IN ('live', 'deprecated')`,
      params: [message, product, releaseId],
    };
  } else {
    update = {
      sql: `UPDATE release_packages SET state = 'live', state_message = NULL
             ${where} AND state = 'deprecated'`,
      params: [product, releaseId],
    };
  }
  return [
    update,
    stmtEnqueuePackageRender(product, pkg.deliverableId, op, now),
  ];
}
