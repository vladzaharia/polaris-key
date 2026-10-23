/**
 * The manifest-to-model sync plan (A-27.3, pure): given the stored model with its per-field
 * provenance and the root `.pkey/distribution` listing as a snapshot (`manifestListingSnapshot`),
 * which fields an ingest may write. Nothing here reads or writes D1; A-27.4 runs the plan.
 *
 * Per field:
 *   - empty in the model: SET the manifest's value;
 *   - provenance `manifest`: SET it when the value changed, CLEAR it when the manifest dropped it;
 *   - typed by an operator (no provenance on a value) or imported from a store (`app-store`,
 *     `play`, `ms-store`, `product`, `godot`): SKIP, the manifest never overwrites it;
 *   - a manifest value the model refuses (over a limit, not a URL): REFUSED with the model's
 *     message and the limit when it has one, never cut. The stored value stays as it is.
 */

import type { DbStatement } from "../../../db/types.js";
import {
  candidateProblems,
  type CurrentListing,
  type ListingSnapshot,
} from "../../../core/storefront/listingImport.js";
import { LISTING_LIMITS } from "../../../core/storefront/listingModel.js";

/** The fields the manifest maps to (`manifestListingSnapshot`), as diff paths. */
export const MANIFEST_APP_PATHS = [
  "name",
  "developerName",
  "category",
  "tint",
  "contactEmail",
  "urls.website",
  "urls.support",
] as const;
export const MANIFEST_LOCALE_FIELDS = ["subtitle", "description"] as const;

export interface ManifestWrite {
  /** `name`, `urls.website`, `locales.en-US.subtitle`. */
  field: string;
  /** The locale of a per-locale field; null for an app-level one. */
  locale: string | null;
  action: "set" | "clear";
  /** The value to store (absent for `clear`). */
  value?: string;
}

export interface ManifestSkip {
  field: string;
  reason: "typed" | "imported";
  /** The import source that wrote the kept value, for `imported`. */
  source?: string;
}

export interface ManifestRefusal {
  field: string;
  message: string;
  /** The model's limit for the field, when it is a length. */
  limit?: number;
}

export interface ManifestSyncPlan {
  writes: ManifestWrite[];
  skipped: ManifestSkip[];
  refused: ManifestRefusal[];
}

const APP_LIMITS: Readonly<Record<string, number>> = {
  name: LISTING_LIMITS.name,
  developerName: LISTING_LIMITS.developerName,
  category: LISTING_LIMITS.category,
  contactEmail: LISTING_LIMITS.contactEmail,
  "urls.website": LISTING_LIMITS.url,
  "urls.support": LISTING_LIMITS.url,
};
const LOCALE_LIMITS: Readonly<Record<string, number>> = {
  subtitle: LISTING_LIMITS.subtitle,
  description: LISTING_LIMITS.description,
};

function storedApp(stored: CurrentListing, path: string): string | undefined {
  const v = path.startsWith("urls.")
    ? stored.app.urls?.[path.slice(5) as "website" | "support"]
    : (stored.app as Record<string, unknown>)[path];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The writes an ingest of `root` makes to `stored`. `locale` is the locale the root's subtitle and
 * description were mapped into (the model's default locale).
 */
export function planManifestSync(
  stored: CurrentListing,
  root: ListingSnapshot,
  locale: string,
): ManifestSyncPlan {
  const plan: ManifestSyncPlan = { writes: [], skipped: [], refused: [] };

  const decide = (
    field: string,
    loc: string | null,
    path: string,
    current: string | undefined,
    origin: string | undefined,
    proposed: string | undefined,
    limit: number | undefined,
  ) => {
    if (current !== undefined && origin !== "manifest") {
      // A value with no provenance was typed; one with another source was imported.
      if (proposed !== current)
        plan.skipped.push(
          origin === undefined
            ? { field, reason: "typed" }
            : { field, reason: "imported", source: origin },
        );
      return;
    }
    if (proposed === undefined) {
      if (current !== undefined)
        plan.writes.push({ field, locale: loc, action: "clear" });
      return;
    }
    if (proposed === current) return;
    const problems = candidateProblems(path, loc, proposed);
    if (problems.length) {
      for (const p of problems)
        plan.refused.push({
          field,
          message: p.message,
          ...(limit !== undefined ? { limit } : {}),
        });
      return;
    }
    plan.writes.push({ field, locale: loc, action: "set", value: proposed });
  };

  for (const path of MANIFEST_APP_PATHS) {
    const proposed = path.startsWith("urls.")
      ? root.app.urls?.[path.slice(5) as "website" | "support"]
      : (root.app as Record<string, unknown>)[path];
    decide(
      path,
      null,
      path,
      storedApp(stored, path),
      stored.appProvenance[path],
      typeof proposed === "string" && proposed !== "" ? proposed : undefined,
      APP_LIMITS[path],
    );
  }
  const storedLocale = stored.locales[locale] as
    | Record<string, unknown>
    | undefined;
  for (const f of MANIFEST_LOCALE_FIELDS) {
    const cur = storedLocale?.[f];
    const prop = (
      root.locales[locale] as Record<string, unknown> | undefined
    )?.[f];
    decide(
      `locales.${locale}.${f}`,
      locale,
      `locales.${locale}.${f}`,
      typeof cur === "string" && cur !== "" ? cur : undefined,
      stored.localeProvenance[locale]?.[f],
      typeof prop === "string" && prop !== "" ? prop : undefined,
      LOCALE_LIMITS[f],
    );
  }
  return plan;
}

// ── The ingest's SQL form (A-27.4) ───────────────────────────────────────────────────────────

/** The locale `manifestListingSnapshot` maps the root's text into for the ingest. The SQL writes
 *  the row's own default locale (`en-US` only for a model the ingest creates, D5). */
export const INGEST_MAPPING_LOCALE = "en-US";
const INGEST_ACTOR = "ingest";

/** The app-level fields as storage sees them: a column, or a key inside `urls_json`. */
const APP_STORAGE: Readonly<
  Record<string, { column: string; urlKey?: string }>
> = {
  name: { column: "name" },
  developerName: { column: "developer_name" },
  category: { column: "category" },
  tint: { column: "tint" },
  contactEmail: { column: "contact_email" },
  "urls.website": { column: "urls_json", urlKey: "website" },
  "urls.support": { column: "urls_json", urlKey: "support" },
};
const LOCALE_STORAGE: Readonly<Record<string, string>> = {
  subtitle: "subtitle",
  description: "description",
};

/**
 * The fields of `root` the model refuses (over a limit, not a URL), each with the limit when it
 * has one. The ingest skips them: the stored value stays as it is.
 */
export function overLimitFields(root: ListingSnapshot): ManifestRefusal[] {
  const out: ManifestRefusal[] = [];
  const check = (
    field: string,
    loc: string | null,
    path: string,
    value: unknown,
    limit: number | undefined,
  ) => {
    if (typeof value !== "string" || value === "") return;
    for (const p of candidateProblems(path, loc, value))
      out.push({
        field,
        message: p.message,
        ...(limit !== undefined ? { limit } : {}),
      });
  };
  for (const path of MANIFEST_APP_PATHS)
    check(path, null, path, appValueOf(root, path), APP_LIMITS[path]);
  const l = root.locales[INGEST_MAPPING_LOCALE] as
    | Record<string, unknown>
    | undefined;
  for (const f of MANIFEST_LOCALE_FIELDS)
    check(
      `locales.${INGEST_MAPPING_LOCALE}.${f}`,
      INGEST_MAPPING_LOCALE,
      `locales.${INGEST_MAPPING_LOCALE}.${f}`,
      l?.[f],
      LOCALE_LIMITS[f],
    );
  return out;
}

function appValueOf(root: ListingSnapshot, path: string): unknown {
  return path.startsWith("urls.")
    ? root.app.urls?.[path.slice(5) as "website" | "support"]
    : (root.app as Record<string, unknown>)[path];
}

const provKey = (k: string) => `$."${k}"`;

/**
 * THE GUARD. A field is the manifest's to write only while it is empty or its provenance is
 * `manifest`; it is evaluated by D1 inside the UPDATE, so an operator's edit or an import landing
 * between the plan and the write is seen, not overwritten. A row with no provenance map at all
 * (written before 0069) is the operator's unless it is empty; an `import` row with no map is left
 * alone as well (its values may be an earlier manifest's, but the map that says so is missing).
 */
function owned(value: string, key: string): string {
  return `(provenance_json IS NOT NULL OR source = 'admin')
          AND (${value} IS NULL OR ${value} = ''
               OR json_extract(provenance_json, '${provKey(key)}') = 'manifest')`;
}

/**
 * The ingest's writes of the root listing into the shared model, as guarded SQL with no read
 * (D4). Per mapped field: a value the model accepts is SET where the manifest owns the field and
 * the stored value differs; a field the manifest dropped is CLEARED where the manifest owned it;
 * a value the model refuses is skipped (returned in `refused`) and its field left untouched.
 * Nothing changes a typed or store-imported value. An identical resync changes no row.
 */
export function manifestModelStatements(
  root: ListingSnapshot,
  product: string,
  now: number,
): { statements: DbStatement[]; refused: ManifestRefusal[] } {
  const refused = overLimitFields(root);
  const refusedFields = new Set(refused.map((r) => r.field));
  const statements: DbStatement[] = [];
  const hasApp = MANIFEST_APP_PATHS.some(
    (p) => appValueOf(root, p) !== undefined && !refusedFields.has(p),
  );
  const rootLocale = root.locales[INGEST_MAPPING_LOCALE] as
    | Record<string, unknown>
    | undefined;
  const hasLocale = MANIFEST_LOCALE_FIELDS.some(
    (f) =>
      rootLocale?.[f] !== undefined &&
      !refusedFields.has(`locales.${INGEST_MAPPING_LOCALE}.${f}`),
  );

  if (hasApp || hasLocale)
    statements.push({
      sql: `INSERT INTO dist_listings
              (product, default_locale, source, created_at, modified_at, modified_by, provenance_json)
            VALUES (?, ?, 'import', ?, ?, ?, '{}')
            ON CONFLICT (product) DO NOTHING`,
      params: [product, INGEST_MAPPING_LOCALE, now, now, INGEST_ACTOR],
    });
  if (hasLocale)
    statements.push({
      sql: `INSERT INTO dist_listing_locales
              (product, locale, source, modified_at, modified_by, provenance_json)
            SELECT product, default_locale, 'import', ?, ?, '{}'
              FROM dist_listings WHERE product = ?
            ON CONFLICT (product, locale) DO NOTHING`,
      params: [now, INGEST_ACTOR, product],
    });

  for (const path of MANIFEST_APP_PATHS) {
    if (refusedFields.has(path)) continue;
    const { column, urlKey } = APP_STORAGE[path]!;
    const read = urlKey ? `json_extract(urls_json, '$.${urlKey}')` : column;
    const value = appValueOf(root, path);
    if (typeof value === "string" && value !== "") {
      statements.push({
        sql: `UPDATE dist_listings
                 SET ${column} = ${
                   urlKey
                     ? `json_set(COALESCE(urls_json, '{}'), '$.${urlKey}', ?)`
                     : "?"
                 },
                     provenance_json = json_set(COALESCE(provenance_json, '{}'), '${provKey(path)}', 'manifest'),
                     modified_at = ?, modified_by = ?
               WHERE product = ? AND ${owned(read, path)} AND ${read} IS NOT ?`,
        params: [value, now, INGEST_ACTOR, product, value],
      });
    } else {
      statements.push({
        sql: `UPDATE dist_listings
                 SET ${column} = ${
                   urlKey
                     ? `NULLIF(json_remove(urls_json, '$.${urlKey}'), '{}')`
                     : "NULL"
                 },
                     provenance_json = json_remove(provenance_json, '${provKey(path)}'),
                     modified_at = ?, modified_by = ?
               WHERE product = ?
                 AND json_extract(provenance_json, '${provKey(path)}') = 'manifest'
                 AND ${read} IS NOT NULL`,
        params: [now, INGEST_ACTOR, product],
      });
    }
  }

  const defaultLocale = `(SELECT default_locale FROM dist_listings WHERE product = ?)`;
  for (const f of MANIFEST_LOCALE_FIELDS) {
    if (refusedFields.has(`locales.${INGEST_MAPPING_LOCALE}.${f}`)) continue;
    const column = LOCALE_STORAGE[f]!;
    const value = rootLocale?.[f];
    if (typeof value === "string" && value !== "") {
      statements.push({
        sql: `UPDATE dist_listing_locales
                 SET ${column} = ?,
                     provenance_json = json_set(COALESCE(provenance_json, '{}'), '${provKey(f)}', 'manifest'),
                     modified_at = ?, modified_by = ?
               WHERE product = ? AND locale = ${defaultLocale}
                 AND ${owned(column, f)} AND ${column} IS NOT ?`,
        params: [value, now, INGEST_ACTOR, product, product, value],
      });
    } else {
      statements.push({
        sql: `UPDATE dist_listing_locales
                 SET ${column} = NULL,
                     provenance_json = json_remove(provenance_json, '${provKey(f)}'),
                     modified_at = ?, modified_by = ?
               WHERE product = ? AND locale = ${defaultLocale}
                 AND json_extract(provenance_json, '${provKey(f)}') = 'manifest'
                 AND ${column} IS NOT NULL`,
        params: [now, INGEST_ACTOR, product, product],
      });
    }
  }
  return { statements, refused };
}
