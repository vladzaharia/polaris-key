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
 * `access.artifacts` reaches it through Distribution's `manifestIngestAlways`
 * on every link and resync, WHATEVER Distribution's enablement: switching Distribution on runs
 * no ingest, so the row must already be the manifest's answer by then. A manifest with no release
 * block only seeds a missing row as `public` (the value `release_config` took on link) and
 * never rewrites an existing one. An operator who sets a mode (`PUT …/distribution/access`) claims the row
 * (`source = 'admin'`) and the ingest skips it until `POST …/distribution/access/revert` hands it
 * back. `entitled` has no manifest spelling, so without the claim the next push would downgrade
 * it. A pack row has no manifest spelling at all; it is operator-owned from the start.
 *
 * Resolution: the deliverable's own row, else the `app` row, else `entitled` — FAIL-CLOSED. So a
 * pack inherits the product's posture until an operator says otherwise, exactly as it shared the
 * product-wide mode before. Every product with a release configuration has an `app` row (0038
 * backfilled them, and every link or resync writes it), so the fallback is reached only by a
 * product no ingest has touched since; it refuses rather than serving a `licensed` product's
 * bytes to anyone.
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

/**
 * The strictest delivery mode of `deliverables`, the `app` mode when there are none. This is the
 * blob route's rule (`bytes.ts`): an object is as protected as the strictest deliverable whose
 * releases carry it. The F-Droid relay applies the same rule before serving a registered file.
 */
export async function strictestAccess(
  delivery: { accessMode(deliverable: string): Promise<ReleaseAccess> },
  deliverables: Iterable<string>,
): Promise<ReleaseAccess> {
  const ids = new Set(deliverables);
  if (ids.size === 0) ids.add(APP_DELIVERABLE_ID);
  let mode: ReleaseAccess = "public";
  for (const d of ids) mode = stricter(mode, await delivery.accessMode(d));
  return mode;
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

/** The mode in force for one deliverable (its row, else the `app` row, else `entitled`). */
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
  // No row at all: fail closed, never `public` (see the file comment).
  return app ? readMode(app.mode) : "entitled";
}

/**
 * The delivery gate of one deliverable (P4-02, plans/P4-01.md decision 35): the `entitlement` of
 * its OWN row, never the `app` row's, or `null` when it has no row or no flag. A pack's gate is
 * operator-owned: `.pkey/release` may only assert it, and Release refuses a publish that differs.
 */
export async function entitlementOf(
  db: Db,
  product: string,
  deliverable: string,
): Promise<string | null> {
  const row = await db.first<Pick<DistAccessRow, "entitlement">>(
    "SELECT entitlement FROM dist_access WHERE product = ? AND deliverable_id = ?",
    product,
    deliverable,
  );
  return row?.entitlement ?? null;
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
 * The ingest statement for the `app` row. With a release block: the manifest's
 * `release.access.artifacts`, upserted unless an operator owns the row; idempotent, the row
 * moves only when the mode actually changes. Without one: a SEED only — `public` for a product
 * that has no row yet (the default `release_config.artifacts_access` took on link), and nothing
 * at all for one that has. Dropping `.pkey/release` never rewrites an existing row, exactly as
 * resync never touched `artifacts_access` without a release block: an upsert there would turn a
 * `licensed` product public on the next push (and, while Release is off, the moment an operator
 * turns it back on). A value outside the four modes cannot pass the manifest validator; if one
 * ever did, it is written as `entitled`, never skipped (a skipped write would leave a looser row
 * in force).
 */
export function accessIngestStatements(
  parsed: ParsedManifest,
  product: string,
  now: number,
): DbStatement[] {
  if (!parsed.release) {
    return [
      {
        sql: `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
              VALUES (?, ?, 'public', NULL, 'manifest', ?)
              ON CONFLICT (product, deliverable_id) DO NOTHING`,
        params: [product, APP_DELIVERABLE_ID, now],
      },
    ];
  }
  const declared: unknown = parsed.release.access.artifacts;
  const mode: ReleaseAccess = isAccessMode(declared) ? declared : "entitled";
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
