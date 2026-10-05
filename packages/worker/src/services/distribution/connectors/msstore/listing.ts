/**
 * The Microsoft Store adapter's `readListing` (A-18c; notes/S-15 §7.2): the listing of the app's
 * LAST PUBLISHED submission, through P5-04's GET-only client. P5-04 deliberately keeps listings
 * out of its parsed submission (`map.ts` `parseSubmission`); this module reads the same document
 * for the listing alone, so polling is unchanged and still GET-only:
 *
 *     GET /v1.0/my/applications/{id}                         its lastPublishedApplicationSubmission
 *     GET /v1.0/my/applications/{id}/submissions/{subId}     `listings` and `applicationCategory`
 *
 * The published submission is the one customers see, so it is the one that has passed
 * certification ("the store that is live wins", S-15 §7.2); a pending submission is never read
 * here. Per language (`baseListing`): title, description, short description, keywords, features,
 * copyright, and the developer name. Images are listed by file name only (they live in the
 * submission's ZIP), so there is nothing to point at; release notes belong to a release. The
 * classic fields `privacyPolicy` and `website` are obsolete ("it will be ignored"), so they are
 * not read either.
 */

import {
  canonicalCategory,
  emptySnapshot,
  normaliseLocale,
  splitNames,
  textOf,
  type ListingSnapshot,
  type SourceOutcome,
} from "../../../../core/storefront/listingImport.js";
import { MsStoreError, type MsStoreClient } from "./client.js";
import { parseApplication } from "./map.js";

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((s) => textOf(s))
    .filter((s): s is string => s !== undefined);
  return out.length ? out : undefined;
}

/** A published submission document → a snapshot (pure; exported for the tests). */
export function msStoreListingOf(
  productId: string,
  doc: Record<string, unknown>,
): ListingSnapshot {
  const snap = emptySnapshot("ms-store", productId);
  const category = textOf(doc.applicationCategory);
  if (category && category !== "NotSet") {
    const id = canonicalCategory(category);
    if (id) snap.app.category = id;
  }
  const listings = obj(doc.listings) ?? {};
  const names: Record<string, string> = {};
  let primary: string | null = null;
  let images = false;
  for (const [lang, raw] of Object.entries(listings)) {
    const locale = normaliseLocale(lang);
    const base = obj(obj(raw)?.baseListing);
    if (!locale || !base) continue;
    primary ??= locale;
    const title = textOf(base.title);
    if (title) names[locale] = title;
    const t = (snap.locales[locale] ??= {});
    const description = textOf(base.description);
    if (description) t.description = description;
    const short = textOf(base.shortDescription);
    if (short) t.shortDescription = short;
    const keywords = strings(base.keywords);
    if (keywords) t.keywords = keywords;
    const features = strings(base.features);
    if (features) t.features = features;
    if (Object.keys(t).length === 0) delete snap.locales[locale];
    const copyright = textOf(base.copyrightAndTrademarkInfo);
    if (copyright && !snap.app.copyright) snap.app.copyright = copyright;
    const dev = textOf(base.devStudio);
    if (dev && !snap.app.developerName) snap.app.developerName = dev;
    if (Array.isArray(base.images) && base.images.length) images = true;
  }
  splitNames(snap, primary, names);
  if (images)
    snap.skipped.push({
      field: "images",
      reason:
        "Microsoft lists a submission's images by file name only: upload them with pkey listing assets",
    });
  return snap;
}

/** Read the last published submission's listing (GETs only). */
export async function readMsStoreListing(
  client: MsStoreClient,
  productId: string,
): Promise<SourceOutcome> {
  const app = parseApplication(await client.application());
  if (!app || app.id !== productId) throw new MsStoreError(502, "application");
  if (!app.lastPublished)
    return {
      ok: false,
      status: 404,
      reason: "not_published",
      message:
        "the Microsoft Store app has no published submission yet, so it has no listing to import",
    };
  const doc = await client.submission(app.lastPublished.id);
  if (doc.id !== app.lastPublished.id)
    throw new MsStoreError(502, "submission");
  return { ok: true, snapshot: msStoreListingOf(productId, doc) };
}
