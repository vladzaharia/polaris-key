/**
 * The product's resolved listing (A-27.1): the one read behind `delivery().listing()`.
 *
 * It composes the shared listing model's app row and default-locale row (`dist_listings*`) into
 * the `ManifestListing` shape the portal, discovery's `core.presentation` and the Discover pages
 * already read, so no call site changes. Phase 1 of A-27 is a dual read: the model wins per
 * field, and the old root-listing blob (`dist_listing`, `getListing`) fills every field the model
 * has no value for. A product with no model rows reads exactly what `getListing` returns.
 *
 * The model stores no art URLs (assets are blobs, A-18d), so `icon`, `header`, `screenshots` and
 * a pre-HA-04 row's `iconUrl` and `headerUrl` come from the blob only.
 *
 * Field mapping (the one place it is written; `feed.ts` reuses it): `urls.website` to `website`,
 * `urls.support` to `supportUrl`, `contact_email` to `supportEmail`, `tint` to `tintColor`, the
 * locale's `name` over the app's.
 */

import { parseJsonColumn } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import type { ManifestListing } from "@polaris-key/manifest";
import { getListing } from "../outlets.js";

/** The columns the mapping reads, from `dist_listings` joined to its default locale. */
export interface ModelListingRow {
  name: string | null;
  developer_name: string | null;
  category: string | null;
  urls_json: string | null;
  contact_email: string | null;
  tint: string | null;
  locale_name: string | null;
  subtitle: string | null;
  description: string | null;
}

/** The SELECT list for a `ModelListingRow` (`l` = `dist_listings`, `loc` = its default locale). */
export const MODEL_LISTING_COLUMNS = `l.name, l.developer_name, l.category, l.urls_json,
            l.contact_email, l.tint,
            loc.name AS locale_name, loc.subtitle, loc.description`;

/** The text fields the model can supply (no art). */
export type ModelListingFields = Pick<
  ManifestListing,
  | "name"
  | "subtitle"
  | "description"
  | "category"
  | "website"
  | "developerName"
  | "supportUrl"
  | "supportEmail"
  | "tintColor"
>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** A model row's fields in the manifest listing's names (unset members dropped). */
export function modelListingFields(row: ModelListingRow): ModelListingFields {
  const urls = parseJsonColumn<Record<string, unknown>>(row.urls_json);
  const out: ModelListingFields = {};
  const set = <K extends keyof ModelListingFields>(
    k: K,
    v: ModelListingFields[K] | undefined,
  ) => {
    if (v !== undefined) out[k] = v;
  };
  set("name", str(row.locale_name) ?? str(row.name));
  set("subtitle", str(row.subtitle));
  set("description", str(row.description));
  set("category", str(row.category));
  set("website", str(urls?.website));
  set("developerName", str(row.developer_name));
  set("supportUrl", str(urls?.support));
  set("supportEmail", str(row.contact_email));
  set("tintColor", str(row.tint));
  return out;
}

/**
 * The product's listing: the model over the stored root-listing blob, field by field, or `null`
 * when neither holds anything.
 */
export async function resolvedListing(
  db: Db,
  product: string,
): Promise<ManifestListing | null> {
  const [blob, row] = await Promise.all([
    getListing(db, product),
    db.first<ModelListingRow>(
      `SELECT ${MODEL_LISTING_COLUMNS}
         FROM dist_listings l
         LEFT JOIN dist_listing_locales loc
           ON loc.product = l.product AND loc.locale = l.default_locale
        WHERE l.product = ?`,
      product,
    ),
  ]);
  if (!row) return blob;
  const model = modelListingFields(row);
  if (Object.keys(model).length === 0) return blob;
  return { ...(blob ?? {}), ...model };
}
