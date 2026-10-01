/**
 * Delivery access — who may download a deliverable (P2b-04, README §3.5 and §3.8 `dist_access`).
 *
 * The successor to Release's `release_config.artifacts_access`, per deliverable instead of per
 * product: "today's Release access modes move here as distribution's delivery access". The four
 * modes are the same ladder (`public` < `authenticated` = `licensed` < `entitled`) with the same
 * meaning everywhere, because every surface that hands out bytes reads THIS answer through
 * `delivery.accessMode()`: Distribution's byte routes, Update's appcasts, and the customer
 * portal's download mint. Before, the feed and the download read access separately, so the feed
 * could offer what the download refused (notes/A1 §1.6–§1.7).
 *
 * Ownership follows P0-01's rule. The `app` row is MANIFEST-owned by default: `.pkey/release`
 * `access.artifacts` reaches it through Distribution's `manifestIngest` on every link and
 * resync. An operator who sets a mode (`PUT …/distribution/access`) claims the row
 * (`source = 'admin'`) and the ingest skips it until `POST …/distribution/access/revert` hands it
 * back. `entitled` has no manifest spelling, so without the claim the next push would downgrade
 * it. A pack row has no manifest spelling at all; it is operator-owned from the start.
 *
 * Resolution: the deliverable's own row, else the `app` row, else `public` — the default the
 * column it replaces always had. So a pack inherits the product's posture until an operator says
 * otherwise, exactly as it shared the product-wide mode before.
 */

import { APP_DELIVERABLE_ID, type ParsedManifest } from "@polaris-key/manifest";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Db, DbStatement } from "../../core/platform.js";

/** The four modes, loosest first. */
export const ACCESS_MODES: readonly ReleaseAccess[] = [
  "public",
  "authenticated",
  "licensed",
  "entitled",
];

export function isAccessMode(value: unknown): value is ReleaseAccess {
  return (
    typeof value === "string" &&
    (ACCESS_MODES as readonly string[]).includes(value)
  );
}

/** How strict a mode is; `authenticated` and `licensed` enforce the same check today. */
const STRICTNESS: Record<ReleaseAccess, number> = {
  public: 0,
  authenticated: 1,
  licensed: 1,
  entitled: 2,
};

/** The stricter of two modes (the first on a tie). */
export function stricter(a: ReleaseAccess, b: ReleaseAccess): ReleaseAccess {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

export interface DistAccessRow {
  product: string;
  deliverable_id: string;
  mode: string;
  entitlement: string | null;
  source: string;
  modified_at: number;
}

export async function listAccess(
  db: Db,
  product: string,
): Promise<DistAccessRow[]> {
  return db.all<DistAccessRow>(
    `SELECT * FROM dist_access WHERE product = ?
      ORDER BY CASE deliverable_id WHEN 'app' THEN 0 ELSE 1 END, deliverable_id ASC`,
    product,
  );
}

/** A stored mode, read fail-closed: a value outside the CHECK cannot exist, but if one ever did
 *  it reads as `entitled`, never as `public`. */
function readMode(value: string): ReleaseAccess {
  return isAccessMode(value) ? value : "entitled";
}

/** The mode in force for one deliverable (its row, else the `app` row, else `public`). */
export async function accessModeOf(
  db: Db,
  product: string,
  deliverable: string,
): Promise<ReleaseAccess> {
  const rows = await db.all<Pick<DistAccessRow, "deliverable_id" | "mode">>(
    `SELECT deliverable_id, mode FROM dist_access
      WHERE product = ? AND deliverable_id IN (?, ?)`,
    product,
    deliverable,
    APP_DELIVERABLE_ID,
  );
  const own = rows.find((r) => r.deliverable_id === deliverable);
  if (own) return readMode(own.mode);
  const app = rows.find((r) => r.deliverable_id === APP_DELIVERABLE_ID);
  return app ? readMode(app.mode) : "public";
}

/** Set (and claim for the operator) one deliverable's mode. `entitlement` undefined = keep. */
export async function setAccess(
  db: Db,
  product: string,
  deliverable: string,
  mode: ReleaseAccess,
  entitlement: string | null | undefined,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES (?, ?, ?, ?, 'admin', ?)
     ON CONFLICT (product, deliverable_id) DO UPDATE SET
       mode = excluded.mode,
       entitlement = CASE WHEN ? THEN excluded.entitlement ELSE dist_access.entitlement END,
       source = 'admin',
       modified_at = excluded.modified_at`,
    product,
    deliverable,
    mode,
    entitlement ?? null,
    now,
    entitlement === undefined ? 0 : 1,
  );
}

/**
 * Hand a row back to the manifest. Only the owner flips; the mode stays as the operator left it
 * until the next resync re-applies `.pkey/release` (the `revertReleaseAccessToManifest` contract:
 * reverting never reaches out to GitHub on the spot). Only the `app` row has a manifest spelling,
 * so a pack row cannot be reverted. Returns false when there is nothing to revert.
 */
export async function revertAccess(
  db: Db,
  product: string,
  deliverable: string,
  now: number,
): Promise<boolean> {
  if (deliverable !== APP_DELIVERABLE_ID) return false;
  const changed = await db.runChanges(
    `UPDATE dist_access SET source = 'manifest', modified_at = ?
      WHERE product = ? AND deliverable_id = ? AND source = 'admin'`,
    now,
    product,
    deliverable,
  );
  return changed > 0;
}

/**
 * The ingest statement for the `app` row: the manifest's `release.access.artifacts`, upserted
 * unless an operator owns the row. A manifest with no release block says nothing about access
 * and writes nothing. Idempotent: the row moves only when the mode actually changes.
 */
export function accessIngestStatements(
  parsed: ParsedManifest,
  product: string,
  now: number,
): DbStatement[] {
  const mode = parsed.release?.access.artifacts;
  if (!mode || !isAccessMode(mode)) return [];
  return [
    {
      sql: `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
            VALUES (?, ?, ?, NULL, 'manifest', ?)
            ON CONFLICT (product, deliverable_id) DO UPDATE SET
              mode = excluded.mode,
              modified_at = excluded.modified_at
            WHERE dist_access.source = 'manifest' AND dist_access.mode IS NOT excluded.mode`,
      params: [product, APP_DELIVERABLE_ID, mode, now],
    },
  ];
}
