/**
 * IMPORT FROM `.pkey/distribution` `listing` (A-18b; notes/S-15 §7.2). The manifest's listing is
 * one import source of the shared model (the stores and the Godot project are A-18c's). An import
 * is an explicit operator action, never a manifest ingest: a repo push does not change the model.
 *
 * What it reads is the listing an outlet shows, as Distribution stores it on every ingest
 * (`dist_outlets.listing_json`: the document's listing with that outlet's override merged over
 * it). The operator names the outlet, or the first live outlet with a listing is used.
 *
 * The mapping: `name`, `developerName`, `category`, `website` and `tintColor` go to the app-level
 * fields (`urls.website`, `tint`); `subtitle` and `description` to the default locale. The asset
 * URLs (`iconUrl`, `headerUrl`, `screenshots`) are NOT imported: assets are blobs with a digest,
 * made by A-18d's derivation, and the feeds keep reading those URLs from the manifest.
 *
 * Rules:
 *   - a value over the model's limit is REFUSED and reported, never cut (`refused`);
 *   - a non-empty value in a row an operator wrote (`source = 'admin'`) is KEPT unless
 *     `overwrite` is set (`kept`); an import fills the gaps;
 *   - a row an import creates is `source = 'import'`; a row an operator owns stays `admin`.
 */

import type { Db } from "../../../core/platform.js";
import {
  appProblems,
  localeProblem,
  localeTextProblems,
  type ModelProblem,
} from "../../../core/storefront/listingModel.js";
import { listOutlets, parseJsonColumn } from "../outlets.js";
import {
  readListing,
  stmtUpsertListing,
  stmtUpsertLocale,
  type StoredListing,
} from "./store.js";

export interface ImportResult {
  /** The outlet whose listing was read. */
  outlet: string;
  imported: string[];
  kept: string[];
  refused: ModelProblem[];
  skipped: { field: string; reason: string }[];
}

export type ImportOutcome =
  | { ok: true; result: ImportResult }
  | { ok: false; status: 404 | 422; reason: string; message: string };

const ASSET_FIELDS = ["iconUrl", "headerUrl", "screenshots"] as const;

/** The listing the manifest gives `outletId` (or the first live outlet with one). */
async function manifestListing(
  db: Db,
  product: string,
  outletId: string | null,
): Promise<{ outlet: string; listing: Record<string, unknown> } | null> {
  const live = (await listOutlets(db, product))
    .filter((o) => o.removed_at === null)
    .sort((a, b) => (a.outlet_id < b.outlet_id ? -1 : 1));
  for (const o of live) {
    if (outletId !== null && o.outlet_id !== outletId) continue;
    const l = parseJsonColumn(o.listing_json);
    if (l && typeof l === "object" && !Array.isArray(l))
      return { outlet: o.outlet_id, listing: l as Record<string, unknown> };
    if (outletId !== null) return null;
  }
  return null;
}

/** Import the manifest's listing into the model. See the file comment. */
export async function importManifestListing(
  db: Db,
  product: string,
  opts: {
    outlet: string | null;
    locale: string | null;
    overwrite: boolean;
    actor: string;
    now: number;
  },
): Promise<ImportOutcome> {
  if (opts.locale !== null && localeProblem(opts.locale))
    return {
      ok: false,
      status: 422,
      reason: "invalid_locale",
      message: "locale must be a code such as en-US",
    };
  const src = await manifestListing(db, product, opts.outlet);
  if (!src)
    return {
      ok: false,
      status: 404,
      reason: "no_manifest_listing",
      message:
        opts.outlet === null
          ? "no live outlet has a .pkey/distribution listing"
          : `outlet ${opts.outlet} has no .pkey/distribution listing`,
    };
  const existing: StoredListing | null = await readListing(db, product);
  const defaultLocale = existing?.row.default_locale ?? opts.locale ?? "en-US";
  const locale = opts.locale ?? defaultLocale;
  const l = src.listing;
  const result: ImportResult = {
    outlet: src.outlet,
    imported: [],
    kept: [],
    refused: [],
    skipped: [],
  };
  for (const f of ASSET_FIELDS)
    if (l[f] !== undefined)
      result.skipped.push({
        field: f,
        reason:
          "asset URLs are not imported: listing assets are uploaded blobs (pkey listing assets)",
      });

  const adminRow = existing?.row.source === "admin";
  const localeRow = existing?.locales.find((r) => r.locale === locale) ?? null;
  const adminLocale = localeRow?.source === "admin";
  const appPatch: Record<string, unknown> = {};
  const localePatch: Record<string, unknown> = {};

  const offer = (
    field: string,
    value: unknown,
    current: unknown,
    owned: boolean,
    put: () => void,
    check: () => ModelProblem[],
  ) => {
    if (typeof value !== "string" || value === "") return;
    if (current === value) return;
    if (owned && current !== null && current !== undefined && !opts.overwrite) {
      result.kept.push(field);
      return;
    }
    const problems = check();
    if (problems.length) {
      result.refused.push(...problems);
      return;
    }
    put();
    result.imported.push(field);
  };

  const row = existing?.row;
  offer(
    "name",
    l.name,
    row?.name,
    adminRow,
    () => (appPatch.name = l.name),
    () => appProblems({ name: l.name }),
  );
  offer(
    "developerName",
    l.developerName,
    row?.developer_name,
    adminRow,
    () => (appPatch.developerName = l.developerName),
    () => appProblems({ developerName: l.developerName }),
  );
  offer(
    "category",
    l.category,
    row?.category,
    adminRow,
    () => (appPatch.category = l.category),
    () => appProblems({ category: l.category }),
  );
  offer(
    "tint",
    l.tintColor,
    row?.tint,
    adminRow,
    () => (appPatch.tint = l.tintColor),
    () => appProblems({ tint: l.tintColor }),
  );
  const urls = (() => {
    try {
      return row?.urls_json
        ? (JSON.parse(row.urls_json) as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  })();
  offer(
    "urls.website",
    l.website,
    urls.website,
    adminRow,
    () => (appPatch.urls = { ...urls, website: l.website }),
    () => appProblems({ urls: { website: l.website } }),
  );
  offer(
    `locales.${locale}.subtitle`,
    l.subtitle,
    localeRow?.subtitle,
    adminLocale,
    () => (localePatch.subtitle = l.subtitle),
    () => localeTextProblems(locale, { subtitle: l.subtitle }),
  );
  offer(
    `locales.${locale}.description`,
    l.description,
    localeRow?.description,
    adminLocale,
    () => (localePatch.description = l.description),
    () => localeTextProblems(locale, { description: l.description }),
  );

  const stmts = [];
  // The listing row exists before any locale does (the model reads from it).
  if (
    Object.keys(appPatch).length ||
    (!existing && Object.keys(localePatch).length)
  )
    stmts.push(
      stmtUpsertListing(
        product,
        appPatch,
        undefined,
        adminRow ? "admin" : "import",
        opts.actor,
        opts.now,
        defaultLocale,
      ),
    );
  if (Object.keys(localePatch).length)
    stmts.push(
      stmtUpsertLocale(
        product,
        locale,
        localePatch,
        adminLocale ? "admin" : "import",
        opts.actor,
        opts.now,
      ),
    );
  if (stmts.length) await db.batch(stmts);
  return { ok: true, result };
}
