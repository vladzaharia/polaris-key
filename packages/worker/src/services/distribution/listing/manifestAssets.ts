/**
 * The manifest's art as store-facing listing rows (HA-07; notes/S-20 §6.2, §8): Polaris Key's
 * hosted copies (`hosted_assets`, HA-01 and HA-05) of `.pkey/distribution` `listing.icon`,
 * `listing.header` and `listing.screenshots[]` become `dist_listing_assets` rows with
 * `source = 'manifest'`, so the storefront pushers (A-18d, A-18e) and the console's slot board can
 * use art a manifest declares, not only art made by `pkey listing assets` in CI.
 *
 * ── WHICH SLOT ──────────────────────────────────────────────────────────────────────────────
 *
 *   listing.icon              → icon-master   (the manifest's icon, else `presentation.icon`'s)
 *   listing.header            → key-art       (the header and hero art)
 *   listing.screenshot:<n>    → screenshot:<class>, the class read from the copy's dimensions
 *                               (`screenshotClass`); the first screenshot of a class, in the
 *                               manifest's order, is that class's master. A screenshot whose
 *                               dimensions are unknown or fit no class makes no row.
 *
 * Each row is every-locale (`''`), names the copy's blob (`blobs/sha256/<hex>`), and holds a
 * `listing-asset` ref (`<slot>@`) like every listing row, so the collector keeps the bytes while
 * the row exists. The product already proved it holds them: ingest read and hashed every byte
 * (THREAT-MODEL §3, "Possession").
 *
 * ── PRECEDENCE ──────────────────────────────────────────────────────────────────────────────
 *
 * A manifest row never replaces an `admin` row (an operator's upload, A-18j/HA-06) or an `import`
 * row (A-18d's store-exact CI derivation, which S-20 §6.6 keeps as THE tool for store art). It
 * fills a slot nobody else holds and keeps its own rows current; a CI register then replaces a
 * manifest row like any non-admin row (`assets.ts`), and the sync leaves that slot alone from then
 * on, so the two never flip a slot back and forth. Every write is guarded in SQL by the row's
 * source, so a register racing the sync still wins.
 *
 * ── WHEN ────────────────────────────────────────────────────────────────────────────────────
 *
 * Idempotent, so it runs wherever the copies may have changed: after a pull lands (the queue
 * consumer, `src/assetQueue.ts`) and on Distribution's connector cron (`index.ts` `scheduled`,
 * every 15 minutes), which also catches a slot the manifest stopped declaring (HA-05's planner
 * drops it at resync, inside Release's flow, which cannot call Distribution). A row whose copy is
 * gone is deleted with its ref. Only for a product with Distribution on: the cron's own gate, and
 * the consumer checks it. Acceptance is unchanged (A-18j): a manifest row is pushed only once an
 * operator accepts its bytes, as a CI row is.
 *
 * Not behind the hosting kill switch (`core/assetHosting.ts`): rows name blobs, not URLs, and
 * serve nothing.
 */

import type { Db, DbStatement } from "../../../core/platform.js";
import { randomId } from "../../../core/platform.js";
import { appendAudit } from "../../../core/data.js";
import { blobKey } from "../../../core/blobs.js";
import { HOSTED_ASSET_REF } from "../../../core/hostedAssets.js";
import { IMG_HOST_TYPES } from "../../../core/imgHost.js";
import { listingScreenshotSlots } from "../../../core/hostedImages.js";
import {
  listingAssetRule,
  SCREENSHOT_CLASSES,
} from "../../../core/storefront/listingModel.js";
import { LISTING_ASSET_REF } from "./assets.js";

/** Who wrote a manifest row (`modified_by`, the audit's actor). */
export const MANIFEST_LISTING_ACTOR = "manifest";

type ScreenshotClass = (typeof SCREENSHOT_CLASSES)[number];

/**
 * The screenshot class of an image `width` × `height` px, or `null`:
 *
 *   portrait, at least 1.6 times as tall as wide    phone-portrait (phones are 2.0 to 2.2)
 *   portrait or landscape, 1.2 to 1.6 (1.45 wide)   tablet (an iPad is 1.33)
 *   landscape 16:9 (within 2 %)                     desktop-16x9
 *   landscape 16:10 (within 2 %)                    desktop-16x10
 *
 * `tv`, `wear` and `xr` are never inferred: a TV or XR capture is 16:9 like a desktop one, and a
 * square image says nothing. Those masters come from CI or an operator's upload.
 */
export function screenshotClass(
  width: number | null,
  height: number | null,
): ScreenshotClass | null {
  if (!width || !height || width < 1 || height < 1) return null;
  if (height > width) {
    const r = height / width;
    if (r >= 1.6) return "phone-portrait";
    if (r >= 1.2) return "tablet";
    return null;
  }
  const r = width / height;
  if (Math.abs(r - 16 / 9) <= (16 / 9) * 0.02) return "desktop-16x9";
  if (Math.abs(r - 16 / 10) <= (16 / 10) * 0.02) return "desktop-16x10";
  if (r >= 1.2 && r < 1.45) return "tablet";
  return null;
}

interface HostedRow {
  slot: string;
  sha256: string;
  content_type: string | null;
  width: number | null;
  height: number | null;
}

interface Wanted {
  slot: string;
  sha256: string;
  width: number | null;
  height: number | null;
  alpha: boolean;
}

/** The rows the manifest's copies call for, by listing slot (see the file comment). */
function wantedRows(hosted: readonly HostedRow[]): Map<string, Wanted> {
  const bySlot = new Map(hosted.map((h) => [h.slot, h]));
  const out = new Map<string, Wanted>();
  const put = (slot: string, h: HostedRow | undefined) => {
    if (!h || out.has(slot)) return;
    out.set(slot, {
      slot,
      sha256: h.sha256,
      width: h.width,
      height: h.height,
      // The Worker decodes no pixels: only a JPEG is known to have no alpha channel.
      alpha: h.content_type !== "image/jpeg",
    });
  };
  put("icon-master", bySlot.get("listing.icon"));
  put("key-art", bySlot.get("listing.header"));
  for (const slot of listingScreenshotSlots(16)) {
    const h = bySlot.get(slot);
    const cls = h ? screenshotClass(h.width, h.height) : null;
    if (cls) put(`screenshot:${cls}`, h);
  }
  return out;
}

const refId = (slot: string) => `${slot}@`;

/** Is the every-locale row of `slot` this product's manifest row holding `sha256`? (SQL) */
const OURS = `EXISTS (SELECT 1 FROM dist_listing_assets
                      WHERE product = ? AND slot = ? AND locale = ''
                        AND source = 'manifest' AND sha256 = ?)`;

/** Write (or refresh) one manifest row and its ref, each guarded by the row's source. */
function stmtsWrite(product: string, w: Wanted, now: number): DbStatement[] {
  const blob = blobKey(w.sha256);
  return [
    {
      sql: `INSERT INTO dist_listing_assets
              (product, slot, locale, blob, sha256, width, height, alpha, derived_from,
               text_allowed, source, modified_at, modified_by)
            VALUES (?, ?, '', ?, ?, ?, ?, ?, NULL, ?, 'manifest', ?, ?)
            ON CONFLICT (product, slot, locale) DO UPDATE SET
              blob = excluded.blob, sha256 = excluded.sha256, width = excluded.width,
              height = excluded.height, alpha = excluded.alpha,
              text_allowed = excluded.text_allowed, modified_at = excluded.modified_at,
              modified_by = excluded.modified_by
            WHERE dist_listing_assets.source = 'manifest'`,
      params: [
        product,
        w.slot,
        blob,
        w.sha256,
        w.width,
        w.height,
        w.alpha ? 1 : 0,
        listingAssetRule(w.slot)!,
        now,
        MANIFEST_LISTING_ACTOR,
      ],
    },
    // The previous copy's ref goes and this one's comes, only if the row is now ours.
    {
      sql: `DELETE FROM blob_refs
             WHERE product = ? AND ref_kind = ? AND ref_id = ? AND ${OURS}`,
      params: [
        product,
        LISTING_ASSET_REF,
        refId(w.slot),
        product,
        w.slot,
        w.sha256,
      ],
    },
    {
      sql: `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
            SELECT ?, ?, ?, ?, ? WHERE ${OURS}
            ON CONFLICT (product, storage_key, ref_kind, ref_id) DO NOTHING`,
      params: [
        product,
        blob,
        LISTING_ASSET_REF,
        refId(w.slot),
        now,
        product,
        w.slot,
        w.sha256,
      ],
    },
  ];
}

/** Delete one manifest row whose copy is gone, and then its ref (only once the row is gone). */
function stmtsRemove(
  product: string,
  slot: string,
  sha256: string,
): DbStatement[] {
  return [
    {
      sql: `DELETE FROM dist_listing_assets
             WHERE product = ? AND slot = ? AND locale = '' AND source = 'manifest'
               AND sha256 = ?`,
      params: [product, slot, sha256],
    },
    {
      sql: `DELETE FROM blob_refs
             WHERE product = ? AND ref_kind = ? AND ref_id = ?
               AND NOT EXISTS (SELECT 1 FROM dist_listing_assets
                                WHERE product = ? AND slot = ? AND locale = '')`,
      params: [product, LISTING_ASSET_REF, refId(slot), product, slot],
    },
  ];
}

export interface ManifestListingSync {
  /** Manifest rows written or refreshed. */
  written: string[];
  /** Manifest rows removed (their copy is gone, or their class moved). */
  removed: string[];
  /** Slots the manifest has art for that an `admin` or `import` row holds. */
  kept: string[];
}

/** Bring the product's manifest listing rows in line with its hosted copies (file comment). */
export async function syncManifestListingAssets(
  db: Db,
  product: string,
  now: number,
): Promise<ManifestListingSync> {
  const slots = [
    "listing.icon",
    "listing.header",
    ...listingScreenshotSlots(16),
  ];
  const hosted = (
    await db.all<HostedRow>(
      `SELECT h.slot AS slot, h.sha256 AS sha256, h.content_type AS content_type,
              h.width AS width, h.height AS height
         FROM hosted_assets h
        WHERE h.product = ? AND h.locale = '' AND h.origin = 'manifest'
          AND h.sha256 IS NOT NULL
          AND h.slot IN (${slots.map(() => "?").join(", ")})
          AND EXISTS (SELECT 1 FROM blob_refs r
                       WHERE r.product = h.product AND r.ref_kind = ?
                         AND r.ref_id = h.slot || '@' || h.locale
                         AND r.storage_key = 'blobs/sha256/' || h.sha256)`,
      product,
      ...slots,
      HOSTED_ASSET_REF,
    )
  ).filter(
    (h) =>
      /^[0-9a-f]{64}$/.test(h.sha256) &&
      h.content_type !== null &&
      IMG_HOST_TYPES.has(h.content_type),
  );
  const wanted = wantedRows(hosted);
  const existing = new Map(
    (
      await db.all<{
        slot: string;
        source: string;
        sha256: string;
        width: number | null;
        height: number | null;
        alpha: number;
      }>(
        `SELECT slot, source, sha256, width, height, alpha FROM dist_listing_assets
          WHERE product = ? AND locale = ''`,
        product,
      )
    ).map((r) => [r.slot, r]),
  );

  const out: ManifestListingSync = { written: [], removed: [], kept: [] };
  const stmts: DbStatement[] = [];
  for (const w of wanted.values()) {
    const row = existing.get(w.slot);
    if (row && row.source !== "manifest") {
      out.kept.push(w.slot);
      continue;
    }
    if (
      row &&
      row.sha256 === w.sha256 &&
      row.width === w.width &&
      row.height === w.height &&
      row.alpha === (w.alpha ? 1 : 0)
    )
      continue;
    out.written.push(w.slot);
    stmts.push(...stmtsWrite(product, w, now));
  }
  for (const row of existing.values()) {
    if (row.source !== "manifest" || wanted.has(row.slot)) continue;
    out.removed.push(row.slot);
    stmts.push(...stmtsRemove(product, row.slot, row.sha256));
  }
  if (stmts.length === 0) return out;
  await db.batch(stmts);
  await appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: MANIFEST_LISTING_ACTOR,
    actor_name: "Polaris Key",
    actor_email: null,
    action: "distribution.listing.manifest",
    target_kind: "listing",
    target_id: product,
    parent_id: null,
    summary:
      `Listing art from the manifest's hosted copies` +
      (out.written.length ? `: wrote ${out.written.join(", ")}` : "") +
      (out.removed.length
        ? `${out.written.length ? ";" : ":"} removed ${out.removed.join(", ")}`
        : ""),
  });
  return out;
}
