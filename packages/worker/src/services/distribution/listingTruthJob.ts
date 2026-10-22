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
 * Apply and down are A-27.7; the job is `delegatedTo` that until it lands, so the runner reports
 * but refuses both. The ledger table `dist_listing_truth_moves` (migration 0129) is the apply's undo
 * record (D9).
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
  MANIFEST_LOCALE_FIELDS,
  planManifestSync,
} from "./listing/manifestSync.js";
import { readListing } from "./listing/store.js";

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

export const listingTruthJob: MigrationJob = {
  id: "distribution.listing-truth",
  summary:
    "Copy each product's root listing text from the manifest blob into the listing model",
  delegatedTo: "the listing-truth apply (A-27.7), not yet available",
  async units(ctx) {
    const rows = await ctx.db.all<{ product: string }>(
      "SELECT product FROM dist_listing ORDER BY product",
    );
    return rows.map((r) => r.product);
  },
  plan: planListingTruth,
  async apply() {
    throw new Error("distribution.listing-truth apply is A-27.7");
  },
  async down() {
    throw new Error("distribution.listing-truth down is A-27.7");
  },
};
