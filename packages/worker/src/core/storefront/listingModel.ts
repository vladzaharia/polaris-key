/**
 * THE SHARED LISTING MODEL (A-18b; notes/S-15 §7.1, §5.5): its shape, its own limits, its asset
 * slots, and the validators every writer runs (the console's admin API here; A-18c's imports and
 * A-18d's asset uploads later). Each product has ONE listing, from which every store's listing is
 * projected (`projection.ts`, against each store's column in `listingProfiles.ts`).
 *
 * Pure data and pure functions, like the rest of the declaration modules (`test/boundaries.test.ts`):
 * the model lives in Distribution's `dist_listing*` tables, and this file knows nothing about them.
 *
 * THE MODEL'S LIMITS are the tightest limit any store puts on a field it shares with others
 * (S-15 §7.1): a name of 30 fits Apple and Play, a short description of 78 fits Snap and so Play's
 * 80, a description of 4,000 fits Apple and Play. A store that allows more (Microsoft's 10,000,
 * Steam's longer short description) gets it through a per-store OVERRIDE, which bypasses the model's
 * limit but never the store's. A value over a limit is REFUSED with the field named; nothing is
 * ever cut to fit (conformance item 7, S-15 §6.6).
 *
 * Listing text is data: stored as typed and rendered escaped, never as HTML (S-15 §9 3(g)).
 */

// ── Shape ─────────────────────────────────────────────────────────────────────────────────────

/** Where a value came from: typed in the console, or copied by an import. */
export type ListingSource = "admin" | "import";
export const LISTING_SOURCES: readonly ListingSource[] = ["admin", "import"];

/** The listing's URLs (https only). */
export interface ListingUrls {
  website?: string;
  support?: string;
  privacy?: string;
  marketing?: string;
  eula?: string;
}
export const LISTING_URL_KEYS = [
  "website",
  "support",
  "privacy",
  "marketing",
  "eula",
] as const;

/** One locale's text. Every field is optional; `name` overrides the app-level name there. */
export interface ListingLocale {
  name?: string;
  subtitle?: string;
  shortDescription?: string;
  description?: string;
  keywords?: string[];
  features?: string[];
  promotionalText?: string;
}
export const LOCALE_TEXT_FIELDS = [
  "name",
  "subtitle",
  "shortDescription",
  "description",
  "promotionalText",
] as const;
export const LOCALE_LIST_FIELDS = ["keywords", "features"] as const;

/** The app-level fields (`dist_listings`). */
export interface ListingApp {
  defaultLocale: string;
  name?: string;
  developerName?: string;
  category?: string;
  contentDescriptors?: Record<string, unknown>;
  iarcCertificateId?: string;
  urls?: ListingUrls;
  contactEmail?: string;
  copyright?: string;
  tint?: string;
  tintDark?: string;
}

/** One per-store replacement of a model field. `locale` null: every locale. */
export interface ListingOverride {
  store: string;
  locale: string | null;
  field: ModelField;
  value: string | string[];
}

/** One release's store notes in one locale. */
export interface ListingReleaseNotes {
  text: string;
  /** ≤ 500, for Play and F-Droid; null when none is stored (the fit report proposes one). */
  short: string | null;
}

/** The whole model as the projection reads it. */
export interface ListingModel {
  app: ListingApp;
  locales: Readonly<Record<string, ListingLocale>>;
  overrides: readonly ListingOverride[];
}

/**
 * The model fields a store column maps from. `releaseNotes` and `releaseNotesShort` come from
 * `dist_listing_release_notes` for the release being projected; the URL fields from `urls`.
 */
export const MODEL_FIELDS = [
  "name",
  "subtitle",
  "shortDescription",
  "description",
  "keywords",
  "features",
  "promotionalText",
  "releaseNotes",
  "releaseNotesShort",
  "developerName",
  "category",
  "copyright",
  "contactEmail",
  "website",
  "supportUrl",
  "privacyUrl",
  "marketingUrl",
  "eulaUrl",
] as const;
export type ModelField = (typeof MODEL_FIELDS)[number];

/** List-valued model fields (JSON arrays of strings). */
export const LIST_MODEL_FIELDS: readonly ModelField[] = [
  "keywords",
  "features",
];

// ── Limits ────────────────────────────────────────────────────────────────────────────────────

/** The model's own limits (S-15 §7.1, the A-18b brief). Characters are JavaScript string length. */
export const LISTING_LIMITS = {
  name: 30,
  subtitle: 30,
  shortDescription: 78,
  description: 4000,
  promotionalText: 170,
  keywords: { maxItems: 50, maxItemChars: 40 },
  features: { maxItems: 20, maxItemChars: 200 },
  developerName: 100,
  category: 64,
  copyright: 200,
  contactEmail: 254,
  url: 2048,
  iarcCertificateId: 64,
  /** The serialised content descriptors. */
  contentDescriptorsBytes: 8192,
  /** winget's ReleaseNotes, the largest store limit. */
  releaseNotes: 10000,
  /** Play's and F-Droid's. */
  releaseNotesShort: 500,
  /** An override's value: generous, since it exists to exceed the model (each store still checks). */
  override: 10000,
  locales: 50,
  overrides: 400,
} as const;

/** BCP 47-shaped: `en`, `en-US`, `zh-Hans-CN`, `pt-BR`. */
export const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IARC_RE = /^[A-Za-z0-9-]{1,64}$/;
const TINT_RE = /^#[0-9A-Fa-f]{6}$/;
const EMAIL_RE =
  /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;
const HTTPS_RE = /^https:\/\/[^\s\u0000-\u001f\u007f]+$/;
/** One line: no control characters at all. */
const LINE_RE = /^[^\u0000-\u001f\u007f]*$/;
/** Prose: no control characters but tab, newline and carriage return. */
const PROSE_RE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

// ── Asset slots ───────────────────────────────────────────────────────────────────────────────

/**
 * What text an image in a slot may carry (S-15 §7.4): `none` (Steam's library hero, Microsoft's
 * super hero: key art only), `title` (the game name and an official subtitle, nothing else:
 * capsules, the poster, the feature graphic), `free` (icons, screenshots).
 */
export type TextAllowed = "none" | "title" | "free";
export const TEXT_ALLOWED: readonly TextAllowed[] = ["none", "title", "free"];

/** The screenshot size classes (`screenshot:<class>`). */
export const SCREENSHOT_CLASSES = [
  "phone-portrait",
  "tablet",
  "desktop-16x9",
  "desktop-16x10",
  "tv",
  "wear",
  "xr",
] as const;

/**
 * Every slot of `dist_listing_assets`, with its text rule: the masters a person makes (or an
 * import finds), then every derived per-store slot (S-15 §7.4), which A-18d's derivation fills
 * from them. A slot not in this table is refused.
 */
export const LISTING_ASSET_SLOTS: Readonly<Record<string, TextAllowed>> = {
  "icon-master": "free",
  "icon-adaptive-fg": "free",
  "icon-adaptive-bg": "none",
  "icon-adaptive-mono": "free",
  wordmark: "title",
  "key-art": "none",
  "key-art-portrait": "none",
  ...Object.fromEntries(
    SCREENSHOT_CLASSES.map((c) => [`screenshot:${c}`, "free" as const]),
  ),
  "trailer-master": "free",
  "youtube-url": "free",
  // Derived per store (S-15 §7.4).
  "play:icon": "free",
  "play:feature-graphic": "title",
  "ms-store:tile": "free",
  "ms-store:super-hero": "none",
  "ms-store:poster": "title",
  "ms-store:box-art": "title",
  "steam:header-capsule": "title",
  "steam:main-capsule": "title",
  "steam:vertical-capsule": "title",
  "steam:small-capsule": "title",
  "steam:library-capsule": "title",
  "steam:library-header": "title",
  "steam:library-hero": "none",
  "steam:library-logo": "title",
  "steam:page-background": "none",
  "steam:community-icon": "free",
  "steam:shortcut-icon": "free",
  "itch:cover": "title",
  "snap:banner": "title",
  "snap:icon": "free",
  "flathub:icon": "free",
  "winget:icon": "free",
  "fdroid:icon": "free",
  "fdroid:feature-graphic": "title",
  // A-18d: each store's downloadable asset pack (a ZIP of that store's outputs and its fit
  // report; Steam has no listing API, so A-18g offers its pack for a manual upload).
  ...Object.fromEntries(
    [
      "play",
      "ms-store",
      "steam",
      "itch",
      "snap",
      "flathub",
      "winget",
      "fdroid",
    ].map((store) => [`pack:${store}`, "free" as const]),
  ),
};

/**
 * The stores a screenshot is fitted for (A-18d; S-15 §5.6): `pkey listing assets` checks every
 * `screenshot:<class>` master against each store's rule and stores the accepted output as
 * `<store>:screenshot:<class>:<n>`, numbered from 1 in the order the store shows them.
 */
export const SCREENSHOT_STORES = [
  "app-store",
  "play",
  "ms-store",
  "steam",
] as const;
/** The most screenshots one store slot holds per class (`.pkey/distribution` `listing.screenshots` is ≤ 16). */
export const MAX_STORE_SCREENSHOTS = 16;

const STORE_SCREENSHOT_RE = new RegExp(
  `^(${SCREENSHOT_STORES.join("|")}):screenshot:(${SCREENSHOT_CLASSES.join("|")}):([1-9][0-9]?)$`,
);

/**
 * The text rule of `slot`, or `undefined` when it is not a listing slot: the fixed slots of
 * `LISTING_ASSET_SLOTS`, plus the numbered per-store screenshots (`free`).
 */
export function listingAssetRule(slot: string): TextAllowed | undefined {
  if (Object.prototype.hasOwnProperty.call(LISTING_ASSET_SLOTS, slot))
    return LISTING_ASSET_SLOTS[slot];
  const m = STORE_SCREENSHOT_RE.exec(slot);
  return m && Number(m[3]) <= MAX_STORE_SCREENSHOTS ? "free" : undefined;
}

/**
 * Play's `aiGeneratedState` for a stored asset (S-15 §7.4; A-18e reads it when it uploads an
 * image): an output `pkey listing assets` derived or composed by template (`derivedFrom` set) is
 * `NotAiGenerated`. A master a person made says nothing, so the adapter leaves the field unset.
 */
export function aiGeneratedStateOf(asset: {
  derivedFrom?: string | null;
  derived_from?: string | null;
}): "NotAiGenerated" | null {
  return (asset.derivedFrom ?? asset.derived_from ?? null) !== null
    ? "NotAiGenerated"
    : null;
}

/** One `dist_listing_assets` row as a writer (A-18d) hands it in. */
export interface ListingAssetInput {
  slot: string;
  locale: string | null;
  blob: string;
  sha256: string;
  width: number | null;
  height: number | null;
  alpha: boolean;
  derivedFrom: string | null;
  textAllowed: TextAllowed;
}

// ── Precedence ────────────────────────────────────────────────────────────────────────────────

/** The import sources a field can come from (S-15 §7.2). */
export const PRECEDENCE_SOURCES = [
  "app-store",
  "play",
  "ms-store",
  "godot",
  "manifest",
  "product",
] as const;
export type PrecedenceSource = (typeof PRECEDENCE_SOURCES)[number];

/**
 * The default: "the store that is live wins" (S-15 §7.2). An App Store listing has already passed
 * a review, so its text is every other store's default; then Play, Microsoft, the Godot project,
 * `.pkey/distribution`, `.pkey/product`. The operator may reorder it per field; A-18c applies it.
 */
export const DEFAULT_PRECEDENCE: readonly PrecedenceSource[] =
  PRECEDENCE_SOURCES;

/** The fields whose precedence is stored (the model fields an import can fill). */
export const PRECEDENCE_FIELDS: readonly string[] = [
  ...MODEL_FIELDS.filter(
    (f) => f !== "releaseNotes" && f !== "releaseNotesShort",
  ),
  "contentDescriptors",
  "icon",
  "screenshots",
  "releaseNotes",
];

// ── Validation ────────────────────────────────────────────────────────────────────────────────

/** One refused value: the field path and why. */
export interface ModelProblem {
  field: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function text(
  out: ModelProblem[],
  field: string,
  v: unknown,
  max: number,
  prose = false,
): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "string") {
    out.push({ field, message: `${field} must be text` });
    return;
  }
  if (v.length > max)
    out.push({
      field,
      message: `${field} must be at most ${max} characters (it is ${v.length})`,
    });
  else if (!(prose ? PROSE_RE : LINE_RE).test(v))
    out.push({
      field,
      message: prose
        ? `${field} must have no control characters but tab and newline`
        : `${field} must be one line with no control characters`,
    });
}

function list(
  out: ModelProblem[],
  field: string,
  v: unknown,
  spec: { maxItems: number; maxItemChars: number },
): void {
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) {
    out.push({ field, message: `${field} must be a list of text` });
    return;
  }
  if (v.length > spec.maxItems)
    out.push({
      field,
      message: `${field} must have at most ${spec.maxItems} entries (it has ${v.length})`,
    });
  v.forEach((item, i) => {
    if (typeof item !== "string" || item.trim() === "")
      out.push({
        field: `${field}[${i}]`,
        message: `${field}[${i}] must be non-empty text`,
      });
    else text(out, `${field}[${i}]`, item, spec.maxItemChars);
  });
}

function pattern(
  out: ModelProblem[],
  field: string,
  v: unknown,
  re: RegExp,
  max: number,
  what: string,
): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "string" || v.length > max || !re.test(v))
    out.push({ field, message: `${field} must be ${what}` });
}

function url(out: ModelProblem[], field: string, v: unknown): void {
  if (v === undefined || v === null) return;
  let ok =
    typeof v === "string" && v.length <= LISTING_LIMITS.url && HTTPS_RE.test(v);
  if (ok)
    try {
      ok = new URL(v as string).protocol === "https:";
    } catch {
      ok = false;
    }
  if (!ok)
    out.push({
      field,
      message: `${field} must be an https URL of at most ${LISTING_LIMITS.url} characters`,
    });
}

/** Problems with a locale code, or none. */
export function localeProblem(locale: unknown): string | null {
  return typeof locale === "string" && LOCALE_RE.test(locale)
    ? null
    : "a locale must be a code such as en-US";
}

/**
 * The problems with a patch of the app-level fields (`null` clears a field). `defaultLocale` is
 * required only when `requireLocale` (the listing does not exist yet).
 */
export function appProblems(
  patch: Record<string, unknown>,
  requireLocale = false,
): ModelProblem[] {
  const out: ModelProblem[] = [];
  const known = new Set([
    "defaultLocale",
    "name",
    "developerName",
    "category",
    "contentDescriptors",
    "iarcCertificateId",
    "urls",
    "contactEmail",
    "copyright",
    "tint",
    "tintDark",
  ]);
  for (const k of Object.keys(patch))
    if (!known.has(k))
      out.push({ field: k, message: `${k} is not a listing field` });
  if (patch.defaultLocale !== undefined || requireLocale) {
    if (localeProblem(patch.defaultLocale))
      out.push({
        field: "defaultLocale",
        message: "defaultLocale must be a locale code such as en-US",
      });
  }
  text(out, "name", patch.name, LISTING_LIMITS.name);
  text(out, "developerName", patch.developerName, LISTING_LIMITS.developerName);
  pattern(
    out,
    "category",
    patch.category,
    CATEGORY_RE,
    LISTING_LIMITS.category,
    "a category id (lower-case letters, digits and hyphens)",
  );
  pattern(
    out,
    "iarcCertificateId",
    patch.iarcCertificateId,
    IARC_RE,
    LISTING_LIMITS.iarcCertificateId,
    "an IARC certificate id",
  );
  pattern(
    out,
    "contactEmail",
    patch.contactEmail,
    EMAIL_RE,
    LISTING_LIMITS.contactEmail,
    "an email address",
  );
  text(out, "copyright", patch.copyright, LISTING_LIMITS.copyright);
  pattern(out, "tint", patch.tint, TINT_RE, 7, "a #rrggbb colour");
  pattern(out, "tintDark", patch.tintDark, TINT_RE, 7, "a #rrggbb colour");
  const cd = patch.contentDescriptors;
  if (cd !== undefined && cd !== null) {
    if (!isRecord(cd))
      out.push({
        field: "contentDescriptors",
        message: "contentDescriptors must be an object",
      });
    else if (
      new TextEncoder().encode(JSON.stringify(cd)).length >
      LISTING_LIMITS.contentDescriptorsBytes
    )
      out.push({
        field: "contentDescriptors",
        message: `contentDescriptors must serialise to at most ${LISTING_LIMITS.contentDescriptorsBytes} bytes`,
      });
  }
  const urls = patch.urls;
  if (urls !== undefined && urls !== null) {
    if (!isRecord(urls))
      out.push({ field: "urls", message: "urls must be an object" });
    else
      for (const [k, v] of Object.entries(urls)) {
        if (!(LISTING_URL_KEYS as readonly string[]).includes(k))
          out.push({
            field: `urls.${k}`,
            message: `urls.${k} is not a listing URL`,
          });
        else url(out, `urls.${k}`, v);
      }
  }
  return out;
}

/** The problems with one locale's patch (`null` clears a field). */
export function localeTextProblems(
  locale: string,
  patch: Record<string, unknown>,
): ModelProblem[] {
  const out: ModelProblem[] = [];
  const at = (f: string) => `locales.${locale}.${f}`;
  const known = new Set<string>([...LOCALE_TEXT_FIELDS, ...LOCALE_LIST_FIELDS]);
  for (const k of Object.keys(patch))
    if (!known.has(k))
      out.push({ field: at(k), message: `${k} is not a locale field` });
  text(out, at("name"), patch.name, LISTING_LIMITS.name);
  text(out, at("subtitle"), patch.subtitle, LISTING_LIMITS.subtitle);
  text(
    out,
    at("shortDescription"),
    patch.shortDescription,
    LISTING_LIMITS.shortDescription,
  );
  text(
    out,
    at("description"),
    patch.description,
    LISTING_LIMITS.description,
    true,
  );
  text(
    out,
    at("promotionalText"),
    patch.promotionalText,
    LISTING_LIMITS.promotionalText,
    true,
  );
  list(out, at("keywords"), patch.keywords, LISTING_LIMITS.keywords);
  list(out, at("features"), patch.features, LISTING_LIMITS.features);
  return out;
}

/** The problems with one release's notes in one locale. */
export function releaseNotesProblems(
  body: Record<string, unknown>,
): ModelProblem[] {
  const out: ModelProblem[] = [];
  if (typeof body.text !== "string" || body.text.trim() === "")
    out.push({ field: "text", message: "text must be non-empty text" });
  else text(out, "text", body.text, LISTING_LIMITS.releaseNotes, true);
  if (body.short !== undefined && body.short !== null) {
    if (typeof body.short !== "string" || body.short.trim() === "")
      out.push({ field: "short", message: "short must be non-empty text" });
    else text(out, "short", body.short, LISTING_LIMITS.releaseNotesShort, true);
  }
  return out;
}

/** The problems with one override (`stores`: the store ids an override may name). */
export function overrideProblems(
  body: Record<string, unknown>,
  stores: readonly string[],
): ModelProblem[] {
  const out: ModelProblem[] = [];
  if (typeof body.store !== "string" || !stores.includes(body.store))
    out.push({
      field: "store",
      message: `store must be one of ${stores.join(", ")}`,
    });
  if (
    body.locale !== undefined &&
    body.locale !== null &&
    localeProblem(body.locale)
  )
    out.push({
      field: "locale",
      message: "locale must be a code such as en-US",
    });
  if (
    typeof body.field !== "string" ||
    !(MODEL_FIELDS as readonly string[]).includes(body.field)
  ) {
    out.push({
      field: "field",
      message: `field must be one of ${MODEL_FIELDS.join(", ")}`,
    });
    return out;
  }
  const v = body.value;
  if (v === null) return out; // removes the override
  if (LIST_MODEL_FIELDS.includes(body.field as ModelField))
    list(out, "value", v, {
      maxItems: 100,
      maxItemChars: LISTING_LIMITS.override,
    });
  else if (typeof v !== "string" || v === "")
    out.push({ field: "value", message: "value must be non-empty text" });
  else text(out, "value", v, LISTING_LIMITS.override, true);
  return out;
}

/** The problems with a precedence patch: `{field: [source, …]}` (`null`: back to the default). */
export function precedenceProblems(v: unknown): ModelProblem[] {
  const out: ModelProblem[] = [];
  if (v === null) return out;
  if (!isRecord(v))
    return [{ field: "precedence", message: "precedence must be an object" }];
  for (const [field, order] of Object.entries(v)) {
    const at = `precedence.${field}`;
    if (!PRECEDENCE_FIELDS.includes(field))
      out.push({ field: at, message: `${field} has no precedence` });
    else if (
      order !== null &&
      (!Array.isArray(order) ||
        order.length === 0 ||
        new Set(order).size !== order.length ||
        !order.every((s) =>
          (PRECEDENCE_SOURCES as readonly unknown[]).includes(s),
        ))
    )
      out.push({
        field: at,
        message: `${at} must list distinct sources of ${PRECEDENCE_SOURCES.join(", ")}`,
      });
  }
  return out;
}

/** The problems with one asset row (A-18d's writer). */
export function assetProblems(a: ListingAssetInput): ModelProblem[] {
  const out: ModelProblem[] = [];
  const rule = listingAssetRule(a.slot);
  if (rule === undefined)
    out.push({ field: "slot", message: `${a.slot} is not a listing slot` });
  else if (a.textAllowed !== rule)
    out.push({
      field: "textAllowed",
      message: `the ${a.slot} slot allows text "${rule}"`,
    });
  if (a.locale !== null && localeProblem(a.locale))
    out.push({
      field: "locale",
      message: "locale must be a code such as en-US",
    });
  if (!/^[0-9a-f]{64}$/.test(a.sha256))
    out.push({ field: "sha256", message: "sha256 must be 64 hex digits" });
  if (typeof a.blob !== "string" || a.blob === "" || a.blob.length > 512)
    out.push({ field: "blob", message: "blob must be a blob store key" });
  for (const k of ["width", "height"] as const) {
    const n = a[k];
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 16384))
      out.push({ field: k, message: `${k} must be 1 to 16384 pixels` });
  }
  if (a.derivedFrom !== null && listingAssetRule(a.derivedFrom) === undefined)
    out.push({
      field: "derivedFrom",
      message: `${a.derivedFrom} is not a listing slot`,
    });
  return out;
}
