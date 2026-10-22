/**
 * `distribution.listing-truth` (A-27.6, D2 and D9): move the root listing's text from the manifest
 * blob (`dist_listing`) into the listing model (`dist_listings*`), so the model is the one place
 * the portal, discovery and the stores read.
 *
 * This file is the DRY RUN and its report. One unit per product with a `dist_listing` row. A unit's
 * plan is `planManifestSync` (the same plan the ingest runs, A-27.3) over the stored model and the
 * blob mapped through `manifestListingSnapshot`, and nothing is read through the write paths:
 * the dry run reads and writes nothing.
 *
 * The report's fields, per unit (`UnitPlan.detail`) and summed in `changes`:
 *
 *   equal            mapped fields where the model already holds the blob's value
 *   typedDiffers     fields an operator typed or a store import wrote that differ from the blob;
 *                    the model keeps them (the plan SKIPs them)
 *   missing          fields the blob holds and the model lacks or holds as a stale manifest value;
 *                    the apply writes them
 *   refused          blob values the model refuses (over a limit, not a URL), never cut; with the
 *                    field and the limit
 *   artWithoutSource art URLs the blob names whose slot has no `hosted_assets` URL source, so the
 *                    media proxy (A-27.2) still depends on the blob for them
 *   clears           manifest-owned model fields the blob dropped; the apply clears them
 *
 * `missing` and `refused` are the contract gate: the blob is retired (phase 2) once a production
 * dry run reports 0 of each, or the lead accepts each listed field. `changes` is the number of
 * model writes (`missing` plus `clears`); a fresh dry run after an apply shows 0.
 *
 * APPLY (A-27.7), one batch per product, so a unit is all or nothing: first the ledger rows
 * (`dist_listing_truth_moves`, one per field the plan writes, with what it held and what the apply
 * writes), then the ingest's own guarded statements (`manifestModelStatements`, A-27.4), which
 * write a field only while it is empty or owned by `manifest`. Ledger rows are `INSERT OR IGNORE`,
 * so a re-run never replaces the first, true prior state. A unit with no writes is a no-op (the
 * contract's idempotence), so a call killed after its batch is simply re-planned to nothing.
 *
 * DOWN, one batch per product: for each ledgered field, put the prior value and provenance back
 * ONLY where the field still holds exactly what the apply wrote (the check is in the UPDATE's
 * WHERE, so an edit landing between the read and the write wins); then delete the product's ledger
 * rows. A field an operator or an import has changed since is left as it is. Down does not delete
 * the model or locale row the apply may have created; it leaves them with the fields empty.
 *
 * Report details name fields and limits only, never a stored value.
 */

import { listingImageUrl, listingScreenshotUrls } from "@polaris-key/manifest";
import type {
  MigrationContext,
  MigrationJob,
  UnitPlan,
} from "../../core/migrate/job.js";
import { manifestListingSnapshot } from "../../core/storefront/listingImport.js";
import { getListing } from "./outlets.js";
import { currentOf } from "./listing/import.js";
import {
  MANIFEST_APP_PATHS,
  INGEST_MAPPING_LOCALE,
  MANIFEST_LOCALE_FIELDS,
  manifestModelStatements,
  planManifestSync,
} from "./listing/manifestSync.js";
import { readListing } from "./listing/store.js";
import type { DbStatement } from "../../db/types.js";

const FALLBACK_LOCALE = "en-US";

/** A unit's counts, the shape of `UnitPlan.detail`. */
export interface ListingTruthDetail {
  equal: number;
  typedDiffers: number;
  missing: number;
  refused: number;
  artWithoutSource: number;
  clears: number;
  /** Field names (never values) behind `missing` and `refused`, for the operator. */
  missingFields: string[];
  refusedFields: { field: string; limit?: number }[];
  artSlots: string[];
}

/** The slots of the blob's art URLs that no `hosted_assets` `url` row names. */
async function artWithoutSource(
  ctx: MigrationContext,
  product: string,
  blob: Record<string, unknown>,
): Promise<string[]> {
  const wanted: string[] = [];
  if (listingImageUrl(blob, "icon")) wanted.push("listing.icon");
  if (listingImageUrl(blob, "header")) wanted.push("listing.header");
  const shots = Array.isArray(blob.screenshots) ? blob.screenshots : [];
  shots.slice(0, 16).forEach((shot, i) => {
    if (listingScreenshotUrls({ screenshots: [shot] }).length > 0)
      wanted.push(`listing.screenshot:${i + 1}`);
  });
  if (wanted.length === 0) return [];
  const rows = await ctx.db.all<{ slot: string }>(
    `SELECT slot FROM hosted_assets
      WHERE product = ? AND locale = '' AND source_kind = 'url' AND source_ref IS NOT NULL
        AND slot IN (${wanted.map(() => "?").join(", ")})`,
    product,
    ...wanted,
  );
  const have = new Set(rows.map((r) => r.slot));
  return wanted.filter((s) => !have.has(s));
}

export async function planListingTruth(
  ctx: MigrationContext,
  product: string,
): Promise<UnitPlan> {
  const root = await getListing(ctx.db, product);
  if (!root) return { changes: 0 };
  const blob = root as unknown as Record<string, unknown>;
  const stored = await readListing(ctx.db, product);
  const locale = stored?.row.default_locale ?? FALLBACK_LOCALE;
  const snapshot = manifestListingSnapshot(blob, "root", locale);
  const plan = planManifestSync(currentOf(stored), snapshot, locale);

  // The fields the blob maps to, as the plan names them.
  const proposed = new Set<string>();
  for (const path of MANIFEST_APP_PATHS) {
    const v = path.startsWith("urls.")
      ? snapshot.app.urls?.[path.slice(5) as "website" | "support"]
      : (snapshot.app as Record<string, unknown>)[path];
    if (typeof v === "string" && v !== "") proposed.add(path);
  }
  for (const f of MANIFEST_LOCALE_FIELDS) {
    const v = (
      snapshot.locales[locale] as Record<string, unknown> | undefined
    )?.[f];
    if (typeof v === "string" && v !== "")
      proposed.add(`locales.${locale}.${f}`);
  }

  const sets = plan.writes.filter((w) => w.action === "set");
  const clears = plan.writes.filter((w) => w.action === "clear");
  const differing = plan.skipped.filter((s) => proposed.has(s.field));
  const refusedFields = [
    ...new Map(plan.refused.map((r) => [r.field, r])).values(),
  ];
  const equal = [...proposed].filter(
    (f) =>
      !sets.some((w) => w.field === f) &&
      !differing.some((s) => s.field === f) &&
      !refusedFields.some((r) => r.field === f),
  ).length;
  const art = await artWithoutSource(ctx, product, blob);

  const detail: ListingTruthDetail = {
    equal,
    typedDiffers: differing.length,
    missing: sets.length,
    refused: refusedFields.length,
    artWithoutSource: art.length,
    clears: clears.length,
    missingFields: sets.map((w) => w.field),
    refusedFields: refusedFields.map((r) => ({
      field: r.field,
      ...(r.limit !== undefined ? { limit: r.limit } : {}),
    })),
    artSlots: art,
  };
  return { changes: sets.length + clears.length, detail };
}

/** Where each field lives, for the ledger's restore SQL (mirrors `manifestModelStatements`). */
const APP_STORE: Readonly<Record<string, { column: string; urlKey?: string }>> =
  {
    name: { column: "name" },
    developerName: { column: "developer_name" },
    category: { column: "category" },
    tint: { column: "tint" },
    contactEmail: { column: "contact_email" },
    "urls.website": { column: "urls_json", urlKey: "website" },
    "urls.support": { column: "urls_json", urlKey: "support" },
  };
const LOCALE_STORE: Readonly<Record<string, string>> = {
  subtitle: "subtitle",
  description: "description",
};
const ACTOR = "listing-truth";
const pk = (k: string) => `$."${k}"`;

interface Moved {
  /** `''` for an app-level field, else the locale. */
  locale: string;
  /** `name`, `urls.website`, `subtitle`. */
  field: string;
  prior: string | null;
  priorProvenance: string | null;
  applied: string | null;
}

/** What the apply would move, with each field's prior state (reads only). */
async function movesOf(
  ctx: MigrationContext,
  product: string,
): Promise<{ moves: Moved[]; statements: DbStatement[] } | null> {
  const root = await getListing(ctx.db, product);
  if (!root) return null;
  const blob = root as unknown as Record<string, unknown>;
  const stored = await readListing(ctx.db, product);
  const locale = stored?.row.default_locale ?? FALLBACK_LOCALE;
  const current = currentOf(stored);
  const plan = planManifestSync(
    current,
    manifestListingSnapshot(blob, "root", locale),
    locale,
  );
  const moves: Moved[] = plan.writes.map((w) => {
    const field = w.locale === null ? w.field : w.field.split(".").pop()!;
    const prior =
      w.locale === null
        ? field.startsWith("urls.")
          ? current.app.urls?.[field.slice(5) as "website" | "support"]
          : (current.app as Record<string, unknown>)[field]
        : (current.locales[w.locale] as Record<string, unknown> | undefined)?.[
            field
          ];
    const priorProvenance =
      w.locale === null
        ? current.appProvenance[field]
        : current.localeProvenance[w.locale]?.[field];
    return {
      locale: w.locale ?? "",
      field,
      prior: typeof prior === "string" && prior !== "" ? prior : null,
      priorProvenance: priorProvenance ?? null,
      applied: w.action === "set" ? (w.value ?? null) : null,
    };
  });
  const { statements } = manifestModelStatements(
    manifestListingSnapshot(blob, "root", INGEST_MAPPING_LOCALE),
    product,
    ctx.now,
  );
  return { moves, statements };
}

const json = (v: string | null) => (v === null ? null : JSON.stringify(v));

async function applyListingTruth(
  ctx: MigrationContext,
  product: string,
): Promise<number> {
  const m = await movesOf(ctx, product);
  if (!m || m.moves.length === 0) return 0;
  const ledger: DbStatement[] = m.moves.map((mv) => ({
    sql: `INSERT OR IGNORE INTO dist_listing_truth_moves
            (product, locale, field, had_row, prior_value_json, prior_provenance, applied_value_json, moved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      product,
      mv.locale,
      mv.field,
      mv.prior === null ? 0 : 1,
      json(mv.prior),
      mv.priorProvenance,
      json(mv.applied),
      ctx.now,
    ],
  }));
  await ctx.db.batch([...ledger, ...m.statements]);
  return m.moves.length;
}

interface LedgerRow {
  locale: string;
  field: string;
  had_row: number;
  prior_value_json: string | null;
  prior_provenance: string | null;
  applied_value_json: string | null;
}

/** The statement that restores one ledgered field where it still holds `applied`. */
function restoreStatement(
  product: string,
  r: LedgerRow,
  now: number,
): DbStatement | null {
  const prior =
    r.had_row === 1 && r.prior_value_json !== null
      ? (JSON.parse(r.prior_value_json) as string)
      : null;
  const applied =
    r.applied_value_json === null
      ? null
      : (JSON.parse(r.applied_value_json) as string);
  const prov = r.prior_provenance;
  const provSet = (key: string) =>
    prov === null
      ? `json_remove(provenance_json, '${pk(key)}')`
      : `json_set(COALESCE(provenance_json, '{}'), '${pk(key)}', ?)`;
  const provParams = prov === null ? [] : [prov];
  if (r.locale === "") {
    const store = APP_STORE[r.field];
    if (!store) return null;
    const read = store.urlKey
      ? `json_extract(urls_json, '$.${store.urlKey}')`
      : store.column;
    const value = store.urlKey
      ? prior === null
        ? `NULLIF(json_remove(urls_json, '$.${store.urlKey}'), '{}')`
        : `json_set(COALESCE(urls_json, '{}'), '$.${store.urlKey}', ?)`
      : "?";
    return {
      sql: `UPDATE dist_listings
               SET ${store.column} = ${value}, provenance_json = ${provSet(r.field)},
                   modified_at = ?, modified_by = ?
             WHERE product = ? AND ${read} IS ?`,
      params: [
        ...(store.urlKey && prior === null ? [] : [prior]),
        ...provParams,
        now,
        ACTOR,
        product,
        applied,
      ],
    };
  }
  const column = LOCALE_STORE[r.field];
  if (!column) return null;
  return {
    sql: `UPDATE dist_listing_locales
             SET ${column} = ?, provenance_json = ${provSet(r.field)},
                 modified_at = ?, modified_by = ?
           WHERE product = ? AND locale = ? AND ${column} IS ?`,
    params: [prior, ...provParams, now, ACTOR, product, r.locale, applied],
  };
}

async function downListingTruth(
  ctx: MigrationContext,
  product: string,
): Promise<number> {
  const rows = await ctx.db.all<LedgerRow>(
    `SELECT locale, field, had_row, prior_value_json, prior_provenance, applied_value_json
       FROM dist_listing_truth_moves WHERE product = ? ORDER BY locale, field`,
    product,
  );
  let restored = 0;
  for (const r of rows) {
    const s = restoreStatement(product, r, ctx.now);
    // The WHERE holds the guard: a field that no longer equals what the apply wrote is left alone.
    if (s) restored += await ctx.db.runChanges(s.sql, ...s.params);
    // The move is over either way (restored, or superseded by a later edit).
    await ctx.db.run(
      "DELETE FROM dist_listing_truth_moves WHERE product = ? AND locale = ? AND field = ?",
      product,
      r.locale,
      r.field,
    );
  }
  return restored;
}

export const listingTruthJob: MigrationJob = {
  id: "distribution.listing-truth",
  summary:
    "Copy each product's root listing text from the manifest blob into the listing model",
  async units(ctx) {
    const rows = await ctx.db.all<{ product: string }>(
      "SELECT product FROM dist_listing ORDER BY product",
    );
    return rows.map((r) => r.product);
  },
  plan: planListingTruth,
  apply: applyListingTruth,
  down: downListingTruth,
};
