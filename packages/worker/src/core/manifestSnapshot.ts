/**
 * The manifest snapshot (ST-01a, notes/S-18 §4.3): the last `.pkey/` manifest applied to each
 * product, in `product_manifest_snapshot` (Core-owned, migration 0072).
 *
 * Every apply path puts `stmtUpsertManifestSnapshot` in the SAME `db.batch` as the apply, so the
 * row can never describe a manifest that did not land, nor miss one that did:
 *
 *   - `resync`      `services/release/resync.ts` `resyncRepo` (webhook or manual);
 *   - `link`        `services/release/linkRepo.ts` `linkRepo`;
 *   - `deploy-hook` `admin/systemProduct.ts` `linkSystemProduct` (the system product);
 *   - `backfill`    ST-01c, for products not applied since this table existed.
 *
 * One row per product, latest only (`ON CONFLICT(product) DO UPDATE`). Readers: Revert (ST-01b),
 * the backfill (ST-01c) and the drift view (ST-17).
 *
 * The snapshot never decides what is applied; it records what was. `applied_sha` is the commit the
 * documents were fetched AT, resolved by GitHub from the DB-configured repository's default branch
 * (`services/release/manifestFetch.ts`) or, for the deploy hook, the deploy's own `PKEY_GIT_SHA`.
 * Manifests carry secret NAMES only, so `manifest_json` holds no secret material.
 */

import type { Db, DbStatement } from "../db/types.js";
import { sha256Hex } from "../platform/hash.js";

/** Who wrote a snapshot row (the table's CHECK constraint, in the same order). */
export const SNAPSHOT_ORIGINS = [
  "resync",
  "link",
  "deploy-hook",
  "backfill",
] as const;
export type SnapshotOrigin = (typeof SNAPSHOT_ORIGINS)[number];

/** A stored snapshot row, as D1 returns it. */
export interface ManifestSnapshotRow {
  product: string;
  applied_sha: string | null;
  applied_at: number;
  origin: SnapshotOrigin;
  files_sha256: string;
  manifest_json: string;
}

/** A git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase as GitHub spells it. */
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `value` when it is a well-formed lowercase git commit id, otherwise `null`. */
export function gitShaOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && GIT_SHA.test(value) ? value : null;
}

/**
 * SHA-256 (lowercase hex) over the raw manifest documents, for change detection.
 *
 * Canonical encoding: the documents as `[name, text]` pairs sorted by name, JSON-encoded. JSON's
 * string escaping makes the boundary between a name and its text unambiguous, and sorting makes
 * the digest independent of the order the documents were read in. An absent document is simply
 * not in the list.
 */
export async function manifestFilesSha256(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const pairs = Object.keys(files)
    .sort()
    .map((name) => [name, files[name]]);
  return sha256Hex(JSON.stringify(pairs));
}

/** What an apply path hands to `stmtUpsertManifestSnapshot`. */
export interface ManifestSnapshotInput {
  product: string;
  appliedSha: string | null;
  appliedAt: number;
  origin: SnapshotOrigin;
  /** `manifestFilesSha256` over the documents that were parsed. */
  filesSha256: string;
  /** The normalised ParsedManifest that was applied (serialised with `JSON.stringify`). */
  manifest: unknown;
}

/** The upsert for one product's snapshot. Returned, not run: it belongs in the apply's batch. */
export function stmtUpsertManifestSnapshot(
  input: ManifestSnapshotInput,
): DbStatement {
  return {
    sql: `INSERT INTO product_manifest_snapshot
            (product, applied_sha, applied_at, origin, files_sha256, manifest_json)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(product) DO UPDATE SET
            applied_sha = excluded.applied_sha,
            applied_at = excluded.applied_at,
            origin = excluded.origin,
            files_sha256 = excluded.files_sha256,
            manifest_json = excluded.manifest_json`,
    params: [
      input.product,
      gitShaOrNull(input.appliedSha),
      input.appliedAt,
      input.origin,
      input.filesSha256,
      JSON.stringify(input.manifest),
    ],
  };
}

/** Build the snapshot statement straight from the raw documents and the parsed manifest. */
export async function manifestSnapshotStatement(
  product: string,
  origin: SnapshotOrigin,
  appliedSha: string | null,
  files: Readonly<Record<string, string>>,
  manifest: unknown,
  now: number,
): Promise<DbStatement> {
  return stmtUpsertManifestSnapshot({
    product,
    appliedSha,
    appliedAt: now,
    origin,
    filesSha256: await manifestFilesSha256(files),
    manifest,
  });
}

/** The product's last applied manifest, or `null` when none has been recorded yet. */
export function getManifestSnapshot(
  db: Db,
  product: string,
): Promise<ManifestSnapshotRow | null> {
  return db.first<ManifestSnapshotRow>(
    "SELECT * FROM product_manifest_snapshot WHERE product = ?",
    product,
  );
}
