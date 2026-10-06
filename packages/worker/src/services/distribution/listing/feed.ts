/**
 * The listing the AltStore and Obtainium feeds show (A-18b; notes/S-15 §7.2): the shared model's
 * default locale, with that feed's overrides, FALLING BACK field by field to the outlet's
 * `.pkey/distribution` listing. A product with no model (no `dist_listings` row) renders exactly
 * the manifest listing it always did, so its feed bytes, ETag and golden files do not move.
 *
 * The model has no asset URLs (assets are blobs, A-18d), so the art (`icon`, `header` and
 * `screenshots`, or a pre-HA-04 row's `iconUrl` and `headerUrl`) always comes from the manifest.
 *
 * One D1 read: the listing row, the default locale and the feed's overrides together.
 */

import type { Db } from "../../../core/platform.js";
import type { RenderListing } from "../feeds/render.js";

/** The feeds that read the model, as override store ids. */
export const FEED_LISTING_STORES = ["altstore", "obtainium"] as const;
export type FeedListingStore = (typeof FEED_LISTING_STORES)[number];

interface Row {
  name: string | null;
  developer_name: string | null;
  category: string | null;
  urls_json: string | null;
  tint: string | null;
  locale_name: string | null;
  subtitle: string | null;
  description: string | null;
  overrides: string | null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

function parse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The model's fields for a feed (undefined members dropped), or null when the product has no
 * model. Exported for tests.
 */
export async function modelFeedListing(
  db: Db,
  product: string,
  store: FeedListingStore,
): Promise<RenderListing | null> {
  const row = await db.first<Row>(
    `SELECT l.name, l.developer_name, l.category, l.urls_json, l.tint,
            loc.name AS locale_name, loc.subtitle, loc.description,
            (SELECT json_group_array(json_object('locale', o.locale, 'field', o.field,
                                                 'value', json(o.value_json)))
               FROM dist_listing_overrides o
              WHERE o.product = l.product AND o.store = ?
                AND (o.locale = '' OR o.locale = l.default_locale)) AS overrides
       FROM dist_listings l
       LEFT JOIN dist_listing_locales loc
         ON loc.product = l.product AND loc.locale = l.default_locale
      WHERE l.product = ?`,
    store,
    product,
  );
  if (!row) return null;
  const ov = new Map<string, unknown>();
  const list = parse(row.overrides);
  if (Array.isArray(list)) {
    // A locale's override beats the every-locale one: every-locale first, then the locale's.
    const entries = list as { locale: string; field: string; value: unknown }[];
    for (const everyLocale of [true, false])
      for (const o of entries)
        if ((o.locale === "") === everyLocale) ov.set(o.field, o.value);
  }
  const urls = parse(row.urls_json) as Record<string, unknown> | null;
  const pick = (field: string, model: unknown) =>
    str(ov.get(field)) ?? str(model);
  const out: RenderListing = {};
  const set = <K extends keyof RenderListing>(
    k: K,
    v: RenderListing[K] | undefined,
  ) => {
    if (v !== undefined) out[k] = v;
  };
  set("name", pick("name", row.locale_name ?? row.name));
  set("subtitle", pick("subtitle", row.subtitle));
  set("description", pick("description", row.description));
  set("category", pick("category", row.category));
  set("website", pick("website", urls?.website));
  set("developerName", pick("developerName", row.developer_name));
  set("tintColor", str(row.tint));
  return out;
}

/** The feed's listing: the model over the manifest, field by field (see the file comment). */
export async function feedListing(
  db: Db,
  product: string,
  store: FeedListingStore,
  manifest: RenderListing | null,
): Promise<RenderListing | null> {
  const model = await modelFeedListing(db, product, store);
  if (!model) return manifest;
  const merged: RenderListing = { ...(manifest ?? {}), ...model };
  return Object.keys(merged).length ? merged : null;
}
