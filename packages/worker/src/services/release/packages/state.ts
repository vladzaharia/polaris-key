/**
 * A package version's feed state (F-03, plans/F-01.md §6.3): `release_packages.state` is `live`,
 * `yanked` or `deprecated`, with `state_message` the PEP 592 yank reason or the npm deprecation
 * message. Release's yank and unyank write it in the same batch as `release_yanks`; deprecate is
 * package-only. Every change enqueues a render of the package's feeds in that batch. Nothing here
 * deletes a row: a version is unique forever.
 */

import type { Db, DbStatement } from "../../../core/platform.js";
import { stmtEnqueuePackageRender } from "../../../core/registryQueue.js";

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
 * `releaseId` is not a package version. A yank overrides a deprecation; an unyank returns the
 * version to `live`; deprecate applies only to a live version and undeprecate only to a
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
  const [state, from] =
    op === "yank"
      ? (["yanked", ["live", "deprecated", "yanked"]] as const)
      : op === "unyank"
        ? (["live", ["yanked"]] as const)
        : op === "deprecate"
          ? (["deprecated", ["live", "deprecated"]] as const)
          : (["live", ["deprecated"]] as const);
  return [
    {
      sql: `UPDATE release_packages SET state = ?, state_message = ?
             WHERE product = ? AND release_id = ?
               AND state IN (SELECT value FROM json_each(?))`,
      params: [
        state,
        state === "live" ? null : message,
        product,
        releaseId,
        JSON.stringify(from),
      ],
    },
    stmtEnqueuePackageRender(product, pkg.deliverableId, op, now),
  ];
}
