/**
 * The shared listing model's storage (A-18b; notes/S-15 §7.1): the five `dist_listing*` tables
 * (`migrations/0063_dist_listing.sql`). Every write here is the caller's to validate first
 * (`core/storefront/listingModel.ts`) and to audit (`admin.ts`); this file only reads and writes.
 *
 * Ownership: all five are OPERATOR data (`source = 'admin'`) or an import's copy
 * (`source = 'import'`). No manifest ingest writes them, so a repo push never changes a listing;
 * `.pkey/distribution` reaches the model only through an explicit import (`import.ts`).
 */

import type { Db, DbStatement } from "../../../core/platform.js";
import type {
  ListingApp,
  ListingLocale,
  ListingModel,
  ListingOverride,
  ListingReleaseNotes,
  ListingSource,
  ModelField,
  PrecedenceSource,
} from "../../../core/storefront/listingModel.js";

export interface DistListingRow {
  product: string;
  default_locale: string;
  name: string | null;
  developer_name: string | null;
  category: string | null;
  content_descriptors_json: string | null;
  iarc_certificate_id: string | null;
  urls_json: string | null;
  contact_email: string | null;
  copyright: string | null;
  tint: string | null;
  tint_dark: string | null;
  precedence_json: string | null;
  source: ListingSource;
  created_at: number;
  modified_at: number;
  modified_by: string;
}

export interface DistListingLocaleRow {
  product: string;
  locale: string;
  name: string | null;
  subtitle: string | null;
  short_description: string | null;
  description: string | null;
  keywords_json: string | null;
  features_json: string | null;
  promotional_text: string | null;
  source: ListingSource;
  modified_at: number;
  modified_by: string;
}

export interface DistListingAssetRow {
  product: string;
  slot: string;
  locale: string;
  blob: string;
  sha256: string;
  width: number | null;
  height: number | null;
  alpha: number;
  derived_from: string | null;
  text_allowed: string;
  source: ListingSource;
  modified_at: number;
  modified_by: string;
}

export interface DistListingNotesRow {
  product: string;
  release_id: string;
  locale: string;
  text: string;
  short: string | null;
  source: ListingSource;
  modified_at: number;
  modified_by: string;
}

export interface DistListingOverrideRow {
  product: string;
  store: string;
  locale: string;
  field: string;
  value_json: string;
  source: ListingSource;
  modified_at: number;
  modified_by: string;
}

function json<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function strings(raw: string | null): string[] | undefined {
  const v = json<unknown>(raw);
  return Array.isArray(v) && v.every((s) => typeof s === "string")
    ? (v as string[])
    : undefined;
}

/** Drop absent members so the model's key set is exactly what is set. */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o))
    if (v !== undefined && v !== null) out[k] = v;
  return out as T;
}

export function appOf(row: DistListingRow): ListingApp {
  const urls = json<Record<string, string>>(row.urls_json);
  const cd = json<Record<string, unknown>>(row.content_descriptors_json);
  return compact({
    defaultLocale: row.default_locale,
    name: row.name ?? undefined,
    developerName: row.developer_name ?? undefined,
    category: row.category ?? undefined,
    contentDescriptors: cd && typeof cd === "object" ? cd : undefined,
    iarcCertificateId: row.iarc_certificate_id ?? undefined,
    urls: urls && Object.keys(urls).length ? urls : undefined,
    contactEmail: row.contact_email ?? undefined,
    copyright: row.copyright ?? undefined,
    tint: row.tint ?? undefined,
    tintDark: row.tint_dark ?? undefined,
  });
}

export function localeOf(row: DistListingLocaleRow): ListingLocale {
  return compact({
    name: row.name ?? undefined,
    subtitle: row.subtitle ?? undefined,
    shortDescription: row.short_description ?? undefined,
    description: row.description ?? undefined,
    keywords: strings(row.keywords_json),
    features: strings(row.features_json),
    promotionalText: row.promotional_text ?? undefined,
  });
}

export function overrideOf(row: DistListingOverrideRow): ListingOverride {
  return {
    store: row.store,
    locale: row.locale === "" ? null : row.locale,
    field: row.field as ModelField,
    value: json<string | string[]>(row.value_json) ?? "",
  };
}

export function precedenceOf(
  row: DistListingRow | null,
): Record<string, PrecedenceSource[]> {
  const v = row
    ? json<Record<string, PrecedenceSource[]>>(row.precedence_json)
    : undefined;
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export interface StoredListing {
  row: DistListingRow;
  locales: DistListingLocaleRow[];
  overrides: DistListingOverrideRow[];
  model: ListingModel;
}

export async function getListingRow(
  db: Db,
  product: string,
): Promise<DistListingRow | null> {
  return db.first<DistListingRow>(
    "SELECT * FROM dist_listings WHERE product = ?",
    product,
  );
}

/** The product's listing, or null when it has none (three reads). */
export async function readListing(
  db: Db,
  product: string,
): Promise<StoredListing | null> {
  const row = await getListingRow(db, product);
  if (!row) return null;
  const locales = await db.all<DistListingLocaleRow>(
    "SELECT * FROM dist_listing_locales WHERE product = ? ORDER BY locale",
    product,
  );
  const overrides = await db.all<DistListingOverrideRow>(
    "SELECT * FROM dist_listing_overrides WHERE product = ? ORDER BY store, locale, field",
    product,
  );
  return {
    row,
    locales,
    overrides,
    model: {
      app: appOf(row),
      locales: Object.fromEntries(locales.map((l) => [l.locale, localeOf(l)])),
      overrides: overrides.map(overrideOf),
    },
  };
}

export async function listAssets(
  db: Db,
  product: string,
): Promise<DistListingAssetRow[]> {
  return db.all<DistListingAssetRow>(
    "SELECT * FROM dist_listing_assets WHERE product = ? ORDER BY slot, locale",
    product,
  );
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────

const APP_COLUMNS: Record<string, string> = {
  defaultLocale: "default_locale",
  name: "name",
  developerName: "developer_name",
  category: "category",
  contentDescriptors: "content_descriptors_json",
  iarcCertificateId: "iarc_certificate_id",
  urls: "urls_json",
  contactEmail: "contact_email",
  copyright: "copyright",
  tint: "tint",
  tintDark: "tint_dark",
};
const JSON_APP = new Set(["contentDescriptors", "urls"]);

const LOCALE_COLUMNS: Record<string, string> = {
  name: "name",
  subtitle: "subtitle",
  shortDescription: "short_description",
  description: "description",
  keywords: "keywords_json",
  features: "features_json",
  promotionalText: "promotional_text",
};
const JSON_LOCALE = new Set(["keywords", "features"]);

function column(value: unknown, asJson: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (asJson) {
    if (Array.isArray(value) && value.length === 0) return null;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0
    )
      return null;
    return JSON.stringify(value);
  }
  return value === "" ? null : (value as string);
}

/**
 * The statement that creates the listing row if absent (with `defaultLocale`) and sets the given
 * app fields (validated). `precedence` undefined leaves it; null resets it to the default.
 */
export function stmtUpsertListing(
  product: string,
  patch: Record<string, unknown>,
  precedence: Record<string, unknown> | null | undefined,
  source: ListingSource,
  actor: string,
  now: number,
  defaultLocale: string,
): DbStatement {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const cols = [
    "product",
    "default_locale",
    "source",
    "created_at",
    "modified_at",
    "modified_by",
  ];
  const vals: (string | number | null)[] = [
    product,
    defaultLocale,
    source,
    now,
    now,
    actor,
  ];
  for (const [k, c] of Object.entries(APP_COLUMNS)) {
    if (k === "defaultLocale" || patch[k] === undefined) continue;
    const v = column(patch[k], JSON_APP.has(k));
    cols.push(c);
    vals.push(v);
    sets.push(`${c} = excluded.${c}`);
  }
  if (patch.defaultLocale !== undefined)
    sets.push("default_locale = excluded.default_locale");
  if (precedence !== undefined) {
    cols.push("precedence_json");
    vals.push(precedence === null ? null : JSON.stringify(precedence));
    sets.push("precedence_json = excluded.precedence_json");
  }
  sets.push(
    "source = excluded.source",
    "modified_at = excluded.modified_at",
    "modified_by = excluded.modified_by",
  );
  params.push(...vals);
  return {
    sql: `INSERT INTO dist_listings (${cols.join(", ")})
          VALUES (${cols.map(() => "?").join(", ")})
          ON CONFLICT (product) DO UPDATE SET ${sets.join(", ")}`,
    params,
  };
}

/** Upsert one locale's fields (validated); `null` clears a field. */
export function stmtUpsertLocale(
  product: string,
  locale: string,
  patch: Record<string, unknown>,
  source: ListingSource,
  actor: string,
  now: number,
): DbStatement {
  const cols = ["product", "locale", "source", "modified_at", "modified_by"];
  const vals: (string | number | null)[] = [
    product,
    locale,
    source,
    now,
    actor,
  ];
  const sets: string[] = [];
  for (const [k, c] of Object.entries(LOCALE_COLUMNS)) {
    if (patch[k] === undefined) continue;
    cols.push(c);
    vals.push(column(patch[k], JSON_LOCALE.has(k)));
    sets.push(`${c} = excluded.${c}`);
  }
  sets.push(
    "source = excluded.source",
    "modified_at = excluded.modified_at",
    "modified_by = excluded.modified_by",
  );
  return {
    sql: `INSERT INTO dist_listing_locales (${cols.join(", ")})
          VALUES (${cols.map(() => "?").join(", ")})
          ON CONFLICT (product, locale) DO UPDATE SET ${sets.join(", ")}`,
    params: vals,
  };
}

export function stmtDeleteLocale(product: string, locale: string): DbStatement {
  return {
    sql: "DELETE FROM dist_listing_locales WHERE product = ? AND locale = ?",
    params: [product, locale],
  };
}

export async function upsertOverride(
  db: Db,
  product: string,
  o: {
    store: string;
    locale: string | null;
    field: string;
    value: string | string[];
  },
  source: ListingSource,
  actor: string,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_listing_overrides
       (product, store, locale, field, value_json, source, modified_at, modified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product, store, locale, field) DO UPDATE SET
       value_json = excluded.value_json, source = excluded.source,
       modified_at = excluded.modified_at, modified_by = excluded.modified_by`,
    product,
    o.store,
    o.locale ?? "",
    o.field,
    JSON.stringify(o.value),
    source,
    now,
    actor,
  );
}

/** Remove one override; answers whether one existed. */
export async function deleteOverride(
  db: Db,
  product: string,
  o: { store: string; locale: string | null; field: string },
): Promise<boolean> {
  return (
    (await db.runChanges(
      `DELETE FROM dist_listing_overrides
        WHERE product = ? AND store = ? AND locale = ? AND field = ?`,
      product,
      o.store,
      o.locale ?? "",
      o.field,
    )) > 0
  );
}

export async function countOverrides(db: Db, product: string): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM dist_listing_overrides WHERE product = ?",
    product,
  );
  return r?.n ?? 0;
}

// ── Release notes ─────────────────────────────────────────────────────────────────────────────

export async function listReleaseNotes(
  db: Db,
  product: string,
  releaseId: string,
): Promise<DistListingNotesRow[]> {
  return db.all<DistListingNotesRow>(
    `SELECT * FROM dist_listing_release_notes
      WHERE product = ? AND release_id = ? ORDER BY locale`,
    product,
    releaseId,
  );
}

export function notesOf(row: DistListingNotesRow): ListingReleaseNotes {
  return { text: row.text, short: row.short };
}

export async function upsertReleaseNotes(
  db: Db,
  product: string,
  releaseId: string,
  locale: string,
  notes: ListingReleaseNotes,
  source: ListingSource,
  actor: string,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_listing_release_notes
       (product, release_id, locale, text, short, source, modified_at, modified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product, release_id, locale) DO UPDATE SET
       text = excluded.text, short = excluded.short, source = excluded.source,
       modified_at = excluded.modified_at, modified_by = excluded.modified_by`,
    product,
    releaseId,
    locale,
    notes.text,
    notes.short,
    source,
    now,
    actor,
  );
}

export async function deleteReleaseNotes(
  db: Db,
  product: string,
  releaseId: string,
  locale: string,
): Promise<boolean> {
  return (
    (await db.runChanges(
      `DELETE FROM dist_listing_release_notes
        WHERE product = ? AND release_id = ? AND locale = ?`,
      product,
      releaseId,
      locale,
    )) > 0
  );
}
