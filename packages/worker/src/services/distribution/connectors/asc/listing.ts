/**
 * The Apple adapter's `readListing` (A-18c; notes/S-15 §7.2, §7.5 "Import"): the App Store
 * listing as App Store Connect holds it, read through A-17's client and A-17a's gate. Every call
 * is a GET, which the gate admits (reads are free except personal data and team membership), so
 * the import needs no rule-table change and can never write:
 *
 *     GET /v1/apps/{id}                                         the primary locale
 *     GET /v1/apps/{id}/appInfos?include=primaryCategory        the live app info and category
 *     GET /v1/appInfos/{id}/appInfoLocalizations                name, subtitle, privacy policy URL
 *     GET /v1/appInfos/{id}/ageRatingDeclaration                the content descriptors
 *     GET /v1/apps/{id}/appStoreVersions                        the live version and its copyright
 *     GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations   description, keywords, URLs,
 *                                                                  promotional text
 *     GET /v1/appStoreVersionLocalizations/{id}/appScreenshotSets?include=appScreenshots
 *                                                                  the primary locale's screenshots
 *
 * "The store that is live wins" (S-15 §7.2): the app info and the version read are the ones on
 * sale when there are such, else the newest, since only a live listing has passed a review.
 * Screenshots are REPORTED (their URL, size and slot), never stored: listing assets are uploaded
 * blobs, made by A-18d's derivation, which runs each one through the target store's fit check
 * before any other store sees it (S-15 §5.6).
 */

import {
  ascPath,
  attr,
  numAttr,
  relId,
  single,
  type AscResource,
} from "../../../../core/asc/client.js";
import {
  canonicalCategory,
  emptySnapshot,
  normaliseLocale,
  splitNames,
  textOf,
  type ListingSnapshot,
  type SnapshotAsset,
} from "../../../../core/storefront/listingImport.js";
import type { AscRun } from "./apply.js";

/** App info states that mean "on the store" (`state`, and the deprecated `appStoreState`). */
const LIVE_INFO = new Set([
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_SALE",
  "ACCEPTED",
]);
/** Version states that mean "on the store". */
const LIVE_VERSION = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);

/** Apple's screenshot display types → the model's screenshot classes (S-15 §7.1). */
export function screenshotClassOf(displayType: string): string | null {
  if (displayType.startsWith("APP_IPHONE_")) return "phone-portrait";
  if (displayType.startsWith("APP_IPAD_")) return "tablet";
  if (displayType === "APP_DESKTOP") return "desktop-16x10";
  if (displayType === "APP_APPLE_TV") return "tv";
  if (displayType.startsWith("APP_WATCH_")) return "wear";
  if (displayType === "APP_APPLE_VISION_PRO") return "xr";
  return null;
}

/** Apple's frequency answers → the canonical frequency. */
const FREQUENCY: Readonly<Record<string, string>> = {
  NONE: "none",
  INFREQUENT_OR_MILD: "infrequent",
  INFREQUENT: "infrequent",
  FREQUENT_OR_INTENSE: "frequent",
  FREQUENT: "frequent",
};

/** The age-rating answers read, by Apple attribute → the canonical descriptor (S-15 §5.2). */
const RATING_FREQUENCIES: Readonly<Record<string, string>> = {
  alcoholTobaccoOrDrugUseOrReferences: "alcohol-tobacco-drugs",
  contests: "contests",
  gamblingSimulated: "simulated-gambling",
  gunsOrOtherWeapons: "weapons",
  horrorOrFearThemes: "horror-fear",
  matureOrSuggestiveThemes: "mature-suggestive",
  medicalOrTreatmentInformation: "medical-information",
  profanityOrCrudeHumor: "profanity-crude-humor",
  sexualContentGraphicAndNudity: "sexual-content-graphic-nudity",
  sexualContentOrNudity: "sexual-content-nudity",
  violenceCartoonOrFantasy: "violence-cartoon-fantasy",
  violenceRealistic: "violence-realistic",
  violenceRealisticProlongedGraphicOrSadistic: "violence-realistic-graphic",
};
const RATING_FLAGS: Readonly<Record<string, string>> = {
  advertising: "ads",
  ageAssurance: "age-assurance",
  gambling: "gambling",
  healthOrWellnessTopics: "health-wellness",
  lootBox: "loot-boxes",
  messagingAndChat: "chat",
  parentalControls: "parental-controls",
  unrestrictedWebAccess: "unrestricted-web",
  userGeneratedContent: "user-generated-content",
};

/** An `ageRatingDeclarations` resource → canonical content descriptors (unknown answers skipped). */
export function contentDescriptorsOf(
  r: AscResource | null,
): Record<string, string | boolean> | null {
  const a = r?.attributes;
  if (!a) return null;
  const out: Record<string, string | boolean> = {};
  for (const [k, key] of Object.entries(RATING_FREQUENCIES)) {
    const v = a[k];
    if (typeof v === "string" && Object.hasOwn(FREQUENCY, v))
      out[key] = FREQUENCY[v]!;
  }
  for (const [k, key] of Object.entries(RATING_FLAGS))
    if (typeof a[k] === "boolean") out[key] = a[k] as boolean;
  return Object.keys(out).length ? out : null;
}

const stateOf = (r: AscResource, ...names: string[]) =>
  names.map((n) => attr(r, n)).find((s) => s !== null) ?? null;

/** The live resource (by `names` state attributes in `live`), else the first. */
function pickLive(
  rows: readonly AscResource[],
  live: ReadonlySet<string>,
  ...names: string[]
): AscResource | null {
  return (
    rows.find((r) => {
      const s = stateOf(r, ...names);
      return s !== null && live.has(s);
    }) ??
    rows[0] ??
    null
  );
}

/** A screenshot's image URL from its `imageAsset` template. */
function imageUrl(r: AscResource): {
  url: string;
  width: number | null;
  height: number | null;
} | null {
  const asset = r.attributes?.imageAsset as
    | { templateUrl?: unknown; width?: unknown; height?: unknown }
    | undefined;
  if (!asset || typeof asset.templateUrl !== "string") return null;
  const width = typeof asset.width === "number" ? asset.width : null;
  const height = typeof asset.height === "number" ? asset.height : null;
  const url = asset.templateUrl
    .replace("{w}", String(width ?? 0))
    .replace("{h}", String(height ?? 0))
    .replace("{f}", "png");
  return url.startsWith("https://") ? { url, width, height } : null;
}

/** Read the pinned app's listing (GETs only). Throws `AscError` on a failed read. */
export async function readAppStoreListing(
  run: AscRun,
): Promise<ListingSnapshot> {
  const appleId = run.setup.appleId;
  const snap = emptySnapshot("app-store", appleId);
  const c = run.client;

  const app = single(await c.get(ascPath("apps", appleId)));
  const primary = normaliseLocale(attr(app, "primaryLocale") ?? "") ?? null;
  snap.defaultLocale = primary;

  // The app info: name, subtitle, privacy URL, category, age rating.
  const infos = await c.getAll(
    ascPath("apps", appleId, "appInfos"),
    { include: "primaryCategory", limit: "10" },
    1,
  );
  const info = pickLive(infos.data, LIVE_INFO, "state", "appStoreState");
  if (info) {
    const category = relId(info, "primaryCategory");
    const canonical = category ? canonicalCategory(category) : null;
    if (canonical) snap.app.category = canonical;
    const locs = await c.getAll(
      ascPath("appInfos", info.id, "appInfoLocalizations"),
      { limit: "50" },
      2,
    );
    const names: Record<string, string> = {};
    for (const l of locs.data) {
      const locale = normaliseLocale(attr(l, "locale") ?? "");
      if (!locale) continue;
      const name = textOf(attr(l, "name"));
      if (name) names[locale] = name;
      const subtitle = textOf(attr(l, "subtitle"));
      if (subtitle) (snap.locales[locale] ??= {}).subtitle = subtitle;
      const privacy = textOf(attr(l, "privacyPolicyUrl"));
      if (privacy && (locale === primary || !snap.app.urls?.privacy))
        snap.app.urls = { ...snap.app.urls, privacy };
    }
    splitNames(snap, primary, names);
    const rating = await c.getOrNull(
      ascPath("appInfos", info.id, "ageRatingDeclaration"),
    );
    const descriptors = contentDescriptorsOf(single(rating));
    if (descriptors) snap.app.contentDescriptors = descriptors;
  }

  // The version on sale (else the newest): copyright, text, URLs, screenshots.
  const versions = await c.getAll(
    ascPath("apps", appleId, "appStoreVersions"),
    { limit: "10" },
    1,
  );
  const version = pickLive(
    versions.data,
    LIVE_VERSION,
    "appStoreState",
    "appVersionState",
  );
  if (version) {
    const copyright = textOf(attr(version, "copyright"));
    if (copyright) snap.app.copyright = copyright;
    const vlocs = await c.getAll(
      ascPath("appStoreVersions", version.id, "appStoreVersionLocalizations"),
      { limit: "50" },
      2,
    );
    let primaryLoc: AscResource | null = null;
    for (const l of vlocs.data) {
      const locale = normaliseLocale(attr(l, "locale") ?? "");
      if (!locale) continue;
      if (locale === primary) primaryLoc = l;
      const t = (snap.locales[locale] ??= {});
      const description = textOf(attr(l, "description"));
      if (description) t.description = description;
      const promo = textOf(attr(l, "promotionalText"));
      if (promo) t.promotionalText = promo;
      const keywords = (attr(l, "keywords") ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (keywords.length) t.keywords = keywords;
      for (const [k, key] of [
        ["supportUrl", "support"],
        ["marketingUrl", "marketing"],
      ] as const) {
        const u = textOf(attr(l, k));
        if (u && (locale === primary || !snap.app.urls?.[key]))
          snap.app.urls = { ...snap.app.urls, [key]: u };
      }
      if (textOf(attr(l, "whatsNew")))
        snap.skipped.push({
          field: `locales.${locale}.whatsNew`,
          reason:
            "release notes belong to a release: they are edited per release, not imported",
        });
    }
    primaryLoc ??= vlocs.data[0] ?? null;
    if (primaryLoc) snap.assets.push(...(await screenshots(run, primaryLoc)));
    if (vlocs.data.length > 1)
      snap.skipped.push({
        field: "screenshots",
        reason:
          "screenshots are read for the primary locale only; the other locales' sets stay in App Store Connect",
      });
  }
  return snap;
}

async function screenshots(
  run: AscRun,
  loc: AscResource,
): Promise<SnapshotAsset[]> {
  const locale = normaliseLocale(attr(loc, "locale") ?? "");
  const sets = await run.client.getAll(
    ascPath("appStoreVersionLocalizations", loc.id, "appScreenshotSets"),
    { include: "appScreenshots", limit: "50" },
    1,
  );
  const out: SnapshotAsset[] = [];
  for (const set of sets.data) {
    const type = attr(set, "screenshotDisplayType");
    const cls = type ? screenshotClassOf(type) : null;
    if (!type || !cls) continue;
    const ids = set.relationships?.appScreenshots?.data;
    for (const ident of Array.isArray(ids) ? ids : []) {
      const shot = sets.included.find(
        (r) => r.type === "appScreenshots" && r.id === ident.id,
      );
      const img = shot ? imageUrl(shot) : null;
      if (!shot || !img) continue;
      out.push({
        slot: `screenshot:${cls}`,
        locale,
        ref: img.url,
        width: img.width ?? numAttr(shot, "width"),
        height: img.height ?? numAttr(shot, "height"),
        sha256: null,
        vendorSlot: type,
      });
    }
  }
  return out;
}
