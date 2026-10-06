/**
 * The listing model's side of a hosted upload (HA-06; notes/S-20 §6.3, §8 "A-18"): a console
 * upload or a CI push into one of the shared listing model's image slots (`icon-master`,
 * `play:feature-graphic`, `<store>:screenshot:<class>:<n>`, …) also writes that slot's
 * `dist_listing_assets` row, so A-18j's slot board and the store pushers read the same bytes the
 * image host serves. Core's `core/hostedAssetUploads.ts` owns the upload; this table is
 * Distribution's, so the composition root hands this writer to Core (`ListingSlotMirror`).
 *
 *   - A console upload writes `source = 'admin'`: the operator's own image, which counts as
 *     accepted on the slot board (A-18j) and which no CI register or push replaces.
 *   - A CI push writes `source = 'import'`, like A-18d's register, unless the row is `admin` or
 *     the slot is console-claimed (checked inside the batch): then it is `kept`.
 *   - Each row holds one `listing-asset` ref (`<slot>@<locale>`), replaced in the same batch, as
 *     A-18d's register does, so the collector reclaims bytes nothing references.
 *   - Delete-a-copy drops the row and its ref only while the row still holds those bytes: a row
 *     A-18d derived from other bytes is not the copy being deleted.
 *
 * Masters a person uploads have no `derivedFrom`; the text rule is the slot's own.
 */

import type { Db, DbStatement } from "../../../core/platform.js";
import { blobKey } from "../../../core/blobs.js";
import { listingAssetRule } from "../../../core/storefront/listingModel.js";
import type {
  ListingSlotCopy,
  ListingSlotMirror,
} from "../../../core/hostedAssetUploads.js";
import { LISTING_ASSET_REF } from "./assets.js";

const refIdOf = (slot: string, locale: string) => `${slot}@${locale}`;

/** An `import` writes only while no operator owns the slot (bind product, slot, locale twice). */
const IMPORT_GUARD = `NOT EXISTS (SELECT 1 FROM dist_listing_assets
    WHERE product = ? AND slot = ? AND locale = ? AND source = 'admin')
  AND NOT EXISTS (SELECT 1 FROM hosted_assets
    WHERE product = ? AND slot = ? AND locale = ? AND origin = 'console')`;

export const listingSlotMirror: ListingSlotMirror = {
  async write(db: Db, c: ListingSlotCopy): Promise<"written" | "kept"> {
    const rule = listingAssetRule(c.slot);
    if (rule === undefined) return "kept";
    const refId = refIdOf(c.slot, c.locale);
    const key = blobKey(c.sha256);
    const guarded = c.source === "import";
    const where = guarded ? ` WHERE ${IMPORT_GUARD}` : " WHERE 1";
    const guardParams = guarded
      ? [c.product, c.slot, c.locale, c.product, c.slot, c.locale]
      : [];
    // Every statement carries the guard and the row's upsert runs last, so they all read the
    // state before the batch: all apply, or none.
    const statements: DbStatement[] = [
      {
        sql: `DELETE FROM blob_refs WHERE product = ? AND ref_kind = ? AND ref_id = ?${guarded ? ` AND ${IMPORT_GUARD}` : ""}`,
        params: [c.product, LISTING_ASSET_REF, refId, ...guardParams],
      },
      {
        sql: `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
              SELECT ?, ?, ?, ?, ?${where}
              ON CONFLICT(product, storage_key, ref_kind, ref_id) DO UPDATE SET
                created_at = MAX(blob_refs.created_at, excluded.created_at)`,
        params: [
          c.product,
          key,
          LISTING_ASSET_REF,
          refId,
          c.now,
          ...guardParams,
        ],
      },
      {
        sql: `INSERT INTO dist_listing_assets
                (product, slot, locale, blob, sha256, width, height, alpha, derived_from,
                 text_allowed, source, modified_at, modified_by)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?${where}
              ON CONFLICT(product, slot, locale) DO UPDATE SET
                blob = excluded.blob, sha256 = excluded.sha256, width = excluded.width,
                height = excluded.height, alpha = excluded.alpha, derived_from = NULL,
                text_allowed = excluded.text_allowed, source = excluded.source,
                modified_at = excluded.modified_at, modified_by = excluded.modified_by`,
        params: [
          c.product,
          c.slot,
          c.locale,
          key,
          c.sha256,
          c.width,
          c.height,
          c.alpha ? 1 : 0,
          rule,
          c.source,
          c.now,
          c.by,
          ...guardParams,
        ],
      },
    ];
    if (db.batchChanges) {
      const changes = await db.batchChanges(statements);
      return (changes.at(-1) ?? 0) > 0 ? "written" : "kept";
    }
    await db.batch(statements);
    return "written";
  },

  async drop(db, at): Promise<void> {
    const guard = `EXISTS (SELECT 1 FROM dist_listing_assets
      WHERE product = ? AND slot = ? AND locale = ? AND sha256 = ?)`;
    const params = [at.product, at.slot, at.locale, at.sha256];
    await db.batch([
      {
        sql: `DELETE FROM blob_refs WHERE product = ? AND ref_kind = ? AND ref_id = ? AND ${guard}`,
        params: [
          at.product,
          LISTING_ASSET_REF,
          refIdOf(at.slot, at.locale),
          ...params,
        ],
      },
      {
        sql: `DELETE FROM dist_listing_assets
               WHERE product = ? AND slot = ? AND locale = ? AND sha256 = ?`,
        params,
      },
    ]);
  },

  async isAdmin(db, at): Promise<boolean> {
    const row = await db.first<{ source: string }>(
      "SELECT source FROM dist_listing_assets WHERE product = ? AND slot = ? AND locale = ?",
      at.product,
      at.slot,
      at.locale,
    );
    return row?.source === "admin";
  },
};
