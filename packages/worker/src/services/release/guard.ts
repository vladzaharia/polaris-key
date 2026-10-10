/**
 * Write-time guards for the release truth store (P2-04).
 *
 * The truth-store sync and the descriptor ingest both PLAN from a read and APPLY later, in a
 * batch. Anything another writer commits in between is invisible to the plan, so a statement
 * whose correctness depends on what the plan read must re-check it when it runs — inside the
 * batch, against the row as it is at that moment. These are the checks, and the one helper that
 * attaches a check to a statement built elsewhere (`model.ts`, `core/blobs.ts`).
 */

import type { DbParam, DbStatement } from "../../db/types.js";

/**
 * True when the release has an ingested descriptor. Params: product, release id. A described
 * release's builds and classification belong to its descriptor, so a sync that planned the
 * release as undescribed must leave them alone if a descriptor landed in the meantime.
 */
export const RELEASE_DESCRIBED_SQL = `EXISTS (
  SELECT 1 FROM release_metadata
   WHERE product = ? AND release_id = ?
     AND json_extract(metadata_json, '$.descriptor.status') = 'ingested')`;

/**
 * True when the release's ingested descriptor is the one with this hash. Params: product,
 * release id, descriptor sha256. The rows of a descriptor ingest are written only while its own
 * marker is the one on the release: if a different descriptor was ingested between the plan and
 * the batch, the ingest's head writes nothing, so this is false for every row that follows.
 */
export const RELEASE_DESCRIBED_BY_SQL = `EXISTS (
  SELECT 1 FROM release_metadata
   WHERE product = ? AND release_id = ?
     AND json_extract(metadata_json, '$.descriptor.status') = 'ingested'
     AND json_extract(metadata_json, '$.descriptor.sha256') = ?)`;

/**
 * True unless the release id is held by a NON-app deliverable (a pack, P4-02). Params: product,
 * release id. A pack release id is `<packId>@<version>` and git allows `@` in a tag, so a GitHub
 * release can carry the same id as a pack release. The truth-store sync skips such a release
 * (`sync.ts`), and every row it writes for a release is also guarded with this, so a pack
 * ingested between the sync's read and its batch is never overwritten either. A release with no
 * row yet passes: the sync's own metadata insert creates it as an `app` release.
 */
export const RELEASE_NOT_FOREIGN_DELIVERABLE_SQL = `NOT EXISTS (
  SELECT 1 FROM release_metadata
   WHERE product = ? AND release_id = ? AND deliverable_id <> 'app')`;

function placeholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

/**
 * The same statement, applied only when `predicate` holds at the moment it runs.
 *
 * Two shapes are understood, and anything else throws (a programming error, caught by the
 * tests that build these statements):
 *
 *   INSERT INTO t (cols) VALUES (…) [ON CONFLICT …]   → INSERT INTO t (cols) SELECT … WHERE p …
 *   UPDATE … WHERE … / DELETE FROM … WHERE …          → … WHERE … AND p   (no OR allowed)
 *
 * A guarded INSERT that does not run does not reach its ON CONFLICT clause either: the whole
 * upsert is skipped.
 */
export function guardStatement(
  stmt: DbStatement,
  predicate: string,
  predicateParams: readonly DbParam[],
): DbStatement {
  const sql = stmt.sql;
  if (placeholders(sql) !== stmt.params.length)
    throw new Error("guardStatement: placeholder count does not match params");
  if (/^\s*INSERT\b/i.test(sql)) {
    const m = /\bVALUES\s*\(/i.exec(sql);
    if (!m) throw new Error("guardStatement: INSERT without VALUES");
    // The VALUES list, up to its balancing parenthesis.
    let depth = 1;
    let end = m.index + m[0].length;
    for (; end < sql.length && depth > 0; end++) {
      if (sql[end] === "(") depth++;
      else if (sql[end] === ")") depth--;
    }
    if (depth !== 0) throw new Error("guardStatement: unbalanced VALUES");
    const head = sql.slice(0, m.index);
    const inner = sql.slice(m.index + m[0].length, end - 1);
    const rest = sql.slice(end);
    if (placeholders(head) !== 0)
      throw new Error("guardStatement: parameters before VALUES");
    const k = placeholders(inner);
    return {
      sql: `${head}SELECT ${inner} WHERE ${predicate}${rest}`,
      params: [
        ...stmt.params.slice(0, k),
        ...predicateParams,
        ...stmt.params.slice(k),
      ],
    };
  }
  if (/^\s*(UPDATE|DELETE)\b/i.test(sql)) {
    // An appended `AND` binds to the whole WHERE only when it has no top-level OR; none of the
    // statements guarded here has an OR at all, and one that does is refused rather than
    // mis-guarded.
    if (
      !/\bWHERE\b/i.test(sql) ||
      /\b(OR|RETURNING|LIMIT|ORDER\s+BY)\b/i.test(sql)
    )
      throw new Error("guardStatement: unsupported UPDATE/DELETE shape");
    return {
      sql: `${sql.trimEnd()}\n   AND ${predicate}`,
      params: [...stmt.params, ...predicateParams],
    };
  }
  throw new Error("guardStatement: unsupported statement");
}
