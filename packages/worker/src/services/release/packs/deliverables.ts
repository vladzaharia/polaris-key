/**
 * The declared pack deliverables (P4-02, plans/P4-01.md §6): the `kind = 'pack'` rows of
 * `release_deliverables` that manifest sync writes (`../deliverables.ts`), read back. Keyed by
 * deliverable, never by "is this product's pack X" (README §11 guardrails, AGENTS rule 5).
 */

import {
  parseManifestPackDeliverable,
  type ManifestPackDeliverable,
} from "@polaris-key/manifest";
import type { Db } from "../../../core/platform.js";

/** The declared pack ids, by id: the validator context's `release.packs` (decision 37). */
export async function readPackDeliverableIds(
  db: Db,
  product: string,
): Promise<string[]> {
  const rows = await db.all<{ deliverable_id: string }>(
    `SELECT deliverable_id FROM release_deliverables
      WHERE product = ? AND kind = 'pack' ORDER BY deliverable_id`,
    product,
  );
  return rows.map((r) => r.deliverable_id);
}

/** Every declared pack with its persisted declaration, by id. A row whose `def_json` does not
 *  read back is skipped (it cannot be published to until a resync rewrites it). */
export async function readPackDeliverables(
  db: Db,
  product: string,
): Promise<ManifestPackDeliverable[]> {
  const rows = await db.all<{ def_json: string | null }>(
    `SELECT def_json FROM release_deliverables
      WHERE product = ? AND kind = 'pack' ORDER BY deliverable_id`,
    product,
  );
  const out: ManifestPackDeliverable[] = [];
  for (const r of rows) {
    const p = parseManifestPackDeliverable(r.def_json);
    if (p) out.push(p);
  }
  return out;
}

/** One declared pack, or null when `deliverable` is not one. */
export async function readPackDeliverable(
  db: Db,
  product: string,
  deliverable: string,
): Promise<ManifestPackDeliverable | null> {
  const row = await db.first<{ def_json: string | null }>(
    `SELECT def_json FROM release_deliverables
      WHERE product = ? AND deliverable_id = ? AND kind = 'pack'`,
    product,
    deliverable,
  );
  if (!row) return null;
  const p = parseManifestPackDeliverable(row.def_json);
  return p && p.id === deliverable ? p : null;
}
