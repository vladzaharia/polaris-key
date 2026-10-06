/**
 * The console's view of a product's presentation (owner request 2026-10-06: the product logo on
 * Home and in the Products table; docs/design/console-product-card/).
 *
 * Today that is the icon only: the hosted copy (`hosted_assets`, HA-01 and HA-05) of the
 * `presentation.icon` slot, else `listing.icon` (the order the image host's `/<p>/icon` alias
 * uses, `IMG_ALIASES.icon`), as image-host URLs (HA-02, `imgUrl`) with the 64 and 128 px WebP
 * variants (HA-03) for a `srcset`. The accent waits for HA-12, which stores `presentation_json`;
 * nothing here reads it until then.
 *
 * A copy counts when the image host serves it: a stored `sha256` of an image type the host
 * serves (`IMG_HOST_TYPES`). A first pull still in flight (`pending`) has none. A `failed` or
 * `stale` re-pull keeps the last good copy (`ingest` never drops it, `core/hostedAssets.ts`), and
 * the host keeps serving it, so the console keeps showing it rather than blanking the logo.
 *
 * The list reads every product's icon in ONE query (`productIcons(env, db)`), so `GET
 * /products` costs one statement more however many products there are.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { parseVariants } from "../../core/hostedAssets.js";
import { IMG_ALIASES, IMG_HOST_TYPES } from "../../core/imgHost.js";
import { imgOrigin, imgUrl } from "../../core/imgHostname.js";

/** The widths the console asks for: a 24 to 48 px tile at 1x and 2x. */
export const CONSOLE_ICON_WIDTHS = [64, 128] as const;

/** One product's icon as the console draws it. */
export interface ProductIconView {
  /** The original, content-addressed (`https://img…/<p>/a/<sha256>`). */
  url: string;
  /** The 64 px WebP variant, or `null` when the ladder has none (an original under 64 px). */
  w64: string | null;
  /** The 128 px WebP variant, or `null`. */
  w128: string | null;
}

/** `ProductDetail.presentation`. HA-12 adds `accent` and `accentDark`. */
export interface ProductPresentationView {
  icon: ProductIconView | null;
}

interface IconRow {
  product: string;
  slot: string;
  sha256: string | null;
  content_type: string | null;
  variants_json: string | null;
  status: string;
}

const ICON_SLOTS: readonly string[] = IMG_ALIASES.icon;

function iconView(env: Env, row: IconRow): ProductIconView | null {
  if (!row.sha256 || row.status === "pending") return null;
  if (row.content_type === null || !IMG_HOST_TYPES.has(row.content_type))
    return null;
  const url = imgUrl(env, row.product, row.sha256);
  if (url === null) return null;
  const widths = new Set(parseVariants(row.variants_json).map((v) => v.w));
  const at = (w: number) =>
    widths.has(w) ? imgUrl(env, row.product, row.sha256!, w) : null;
  return { url, w64: at(64), w128: at(128) };
}

/**
 * Icons by product slug: every product's (one query), or one product's. A product with no copy
 * the image host would serve, or an environment with no image host, has no entry.
 */
export async function productIcons(
  env: Env,
  db: Db,
  product?: string,
): Promise<Map<string, ProductIconView>> {
  const out = new Map<string, ProductIconView>();
  if (imgOrigin(env) === null) return out;
  const rows = await db.all<IconRow>(
    `SELECT product, slot, sha256, content_type, variants_json, status
       FROM hosted_assets
      WHERE locale = '' AND slot IN (${ICON_SLOTS.map(() => "?").join(", ")})
        AND sha256 IS NOT NULL${product === undefined ? "" : " AND product = ?"}`,
    ...ICON_SLOTS,
    ...(product === undefined ? [] : [product]),
  );
  // First slot wins: `presentation.icon`, then `listing.icon`.
  for (const slot of ICON_SLOTS) {
    for (const row of rows) {
      if (row.slot !== slot || out.has(row.product)) continue;
      const view = iconView(env, row);
      if (view) out.set(row.product, view);
    }
  }
  return out;
}
