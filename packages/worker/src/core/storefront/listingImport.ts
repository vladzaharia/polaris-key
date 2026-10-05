/**
 * LISTING IMPORT: precedence and the field-by-field diff (A-18c; notes/S-15 §7.2). Pure data and
 * pure functions, like the model it fills (`listingModel.ts`): the snapshots come from the import
 * sources (each store's `readListing`, the Godot project the CLI reads, `.pkey/distribution`,
 * `.pkey/product`), the current model and its per-field provenance from Distribution's tables, and
 * this file only decides.
 *
 * WHAT AN IMPORT IS. Every source answers a `ListingSnapshot`: the listing text it holds, in the
 * model's own shape, plus what it found that the model does not store as text (the assets it
 * points at, the version and bundle ids it declares). `planImport` lines the snapshots up against
 * the model and answers one `ImportChange` per field a source has a value for:
 *
 *   - `add`: the model has nothing there;
 *   - `replace`: the model's value came from an import that this source outranks (or from this
 *     same source, now changed), or the operator asked to overwrite;
 *   - `keep`: the model's value stays, and `reason` says why (an operator typed it; a source that
 *     outranks this one wrote it).
 *
 * A field whose winning value is already the model's is not a change at all. Nothing is applied
 * here: the admin API shows the plan, and applies it only on the operator's confirmation.
 *
 * PRECEDENCE (S-15 §7.2) is "the store that is live wins": an App Store listing has passed a
 * review, so among the sources of ONE import the highest-ranked value wins every field, and an
 * import never replaces a value a higher-ranked source wrote earlier. The default order is
 * `DEFAULT_PRECEDENCE`; the operator may reorder it per field (`dist_listings.precedence_json`). A
 * source the operator left out of a field's order ranks last: it fills a gap, nothing more.
 *
 * WHAT IS NEVER DONE. A value over the model's limit is refused and reported, never cut
 * (conformance item 7). A value an operator typed is kept unless `overwrite`. Imported text is
 * data: validated here as text, stored as typed and rendered escaped (S-15 §9 3(g)).
 */

import {
  appProblems,
  DEFAULT_PRECEDENCE,
  LISTING_LIMITS,
  LISTING_URL_KEYS,
  localeProblem,
  localeTextProblems,
  type ListingLocale,
  type ListingUrls,
  type ModelProblem,
  type PrecedenceSource,
} from "./listingModel.js";

/** An import source: one of the precedence sources. */
export type ImportSource = PrecedenceSource;

/** Where a model value came from: an import source, or typed by an operator. */
export type ValueOrigin = ImportSource | "admin";

/** The app-level text fields an import can fill (the URLs are `urls.<key>`). */
export const IMPORT_APP_FIELDS = [
  "name",
  "developerName",
  "category",
  "contentDescriptors",
  "contactEmail",
  "copyright",
  "tint",
] as const;
export type ImportAppField = (typeof IMPORT_APP_FIELDS)[number];

/** The per-locale fields an import can fill. */
export const IMPORT_LOCALE_FIELDS = [
  "name",
  "subtitle",
  "shortDescription",
  "description",
  "keywords",
  "features",
  "promotionalText",
] as const;
export type ImportLocaleField = (typeof IMPORT_LOCALE_FIELDS)[number];

/** The app-level fields of a snapshot (the model's, minus the default locale). */
export interface SnapshotApp {
  name?: string;
  developerName?: string;
  category?: string;
  contentDescriptors?: Record<string, unknown>;
  contactEmail?: string;
  copyright?: string;
  tint?: string;
  urls?: ListingUrls;
}

/**
 * An asset a source points at. The model stores assets as uploaded blobs with a digest (A-18d's
 * `pkey listing assets`), so an import REPORTS these, never writes them: `ref` is the store's
 * image URL or the project's file path, for the operator and for the derivation to start from.
 */
export interface SnapshotAsset {
  /** A `LISTING_ASSET_SLOTS` key: `icon-master`, `icon-adaptive-fg`, `screenshot:tablet`, … */
  slot: string;
  locale: string | null;
  ref: string;
  width: number | null;
  height: number | null;
  sha256: string | null;
  /** The store's own name for the slot (`APP_IPHONE_67`, `phoneScreenshots`), when it has one. */
  vendorSlot: string | null;
}

/** A version or bundle id a source declares: shown beside the outlets' identities, not stored. */
export interface SnapshotIdentifier {
  kind: "version" | "bundleId";
  /** The platform or preset it belongs to (`project`, `ios`, `android`, `macos`, `windows`). */
  platform: string;
  value: string;
}

/** One source's listing, in the model's shape. */
export interface ListingSnapshot {
  source: ImportSource;
  /** What it was read from (an app id, a package name, an outlet, a project), for the console. */
  ref: string | null;
  /** The source's primary locale, when it has one. */
  defaultLocale: string | null;
  app: SnapshotApp;
  locales: Record<string, ListingLocale>;
  assets: SnapshotAsset[];
  identifiers: SnapshotIdentifier[];
  /** What the source holds that the import does not take, and why. */
  skipped: { field: string; reason: string }[];
}

/** An empty snapshot for `source`, to fill. */
export function emptySnapshot(
  source: ImportSource,
  ref: string | null,
): ListingSnapshot {
  return {
    source,
    ref,
    defaultLocale: null,
    app: {},
    locales: {},
    assets: [],
    identifiers: [],
    skipped: [],
  };
}

/** The model as an import sees it. */
export interface CurrentListing {
  exists: boolean;
  defaultLocale: string | null;
  app: SnapshotApp;
  locales: Readonly<Record<string, ListingLocale>>;
  /** Per app-level field path (`name`, `urls.website`), the import source that wrote it. */
  appProvenance: Readonly<Record<string, ImportSource>>;
  /** Per locale, per field, the import source that wrote it. */
  localeProvenance: Readonly<
    Record<string, Readonly<Record<string, ImportSource>>>
  >;
  /** The operator's per-field orders (`precedence_json`); absent fields use the default. */
  precedence: Readonly<Record<string, readonly PrecedenceSource[]>>;
}

export type ImportValue = string | string[] | Record<string, unknown>;

/** One field of the diff. */
export interface ImportChange {
  /** `name`, `urls.website`, `locales.de-DE.description`. */
  field: string;
  /** The locale of a per-locale field; null for an app-level one. */
  locale: string | null;
  action: "add" | "replace" | "keep";
  current: ImportValue | null;
  /** Who wrote the current value (null when there is none). */
  currentSource: ValueOrigin | null;
  /** The winning source's value. */
  proposed: ImportValue;
  proposedSource: ImportSource;
  /** Why a `keep` keeps; null otherwise. */
  reason: string | null;
  /** The other sources' values for the field, in precedence order (the ones that lost). */
  others: { source: ImportSource; value: ImportValue }[];
}

/** A source's value the model refuses (over a limit, not a URL, …). Never cut. */
export interface ImportRefusal extends ModelProblem {
  source: ImportSource;
}

export interface ImportPlan {
  /** True when the product has no listing yet: applying creates it with `defaultLocale`. */
  createsListing: boolean;
  defaultLocale: string;
  changes: ImportChange[];
  refused: ImportRefusal[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function nonEmpty(v: unknown): v is ImportValue {
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.length > 0;
  return isRecord(v) && Object.keys(v).length > 0;
}

/** A canonical JSON (sorted keys), for comparing values and for the plan's digest. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isRecord(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** The app-level field paths, in diff order. */
export const IMPORT_APP_PATHS: readonly string[] = [
  ...IMPORT_APP_FIELDS,
  ...LISTING_URL_KEYS.map((k) => `urls.${k}`),
];

function appValue(app: SnapshotApp, path: string): unknown {
  if (path.startsWith("urls."))
    return app.urls?.[path.slice(5) as keyof ListingUrls];
  return app[path as ImportAppField];
}

const URL_PRECEDENCE: Readonly<Record<string, string>> = {
  "urls.website": "website",
  "urls.support": "supportUrl",
  "urls.privacy": "privacyUrl",
  "urls.marketing": "marketingUrl",
  "urls.eula": "eulaUrl",
};

/** The precedence field a diff path is ranked by (`PRECEDENCE_FIELDS`). */
export function precedenceFieldOf(path: string): string {
  const m = /^locales\.[^.]+\.(.+)$/.exec(path);
  if (m) return m[1]!;
  return URL_PRECEDENCE[path] ?? path;
}

/** A field's source order: the operator's, else the default. */
export function orderOf(
  precedence: CurrentListing["precedence"],
  path: string,
): readonly PrecedenceSource[] {
  const field = precedenceFieldOf(path);
  return Object.hasOwn(precedence, field)
    ? precedence[field]!
    : DEFAULT_PRECEDENCE;
}

function rankIn(order: readonly PrecedenceSource[], s: ImportSource): number {
  const i = order.indexOf(s);
  return i < 0 ? order.length : i;
}

/** The problems with one candidate value, as the model's validators name them. */
function candidateProblems(
  path: string,
  locale: string | null,
  value: unknown,
): ModelProblem[] {
  if (locale !== null) {
    const field = path.slice(`locales.${locale}.`.length);
    return localeTextProblems(locale, { [field]: value });
  }
  if (path.startsWith("urls."))
    return appProblems({ urls: { [path.slice(5)]: value } });
  return appProblems({ [path]: value });
}

interface Candidate {
  source: ImportSource;
  value: ImportValue;
}

/**
 * The diff of `snapshots` against `current`. `locale` is the default locale a NEW listing gets
 * (else the highest-ranked snapshot's, else `en-US`); `overwrite` turns every `keep` into a
 * `replace`. Pure: answers the plan, changes nothing.
 */
export function planImport(
  current: CurrentListing,
  snapshots: readonly ListingSnapshot[],
  opts: { overwrite: boolean; locale: string | null },
): ImportPlan {
  const refused: ImportRefusal[] = [];
  const changes: ImportChange[] = [];

  const byDefault = [...snapshots].sort(
    (a, b) =>
      rankIn(DEFAULT_PRECEDENCE, a.source) -
      rankIn(DEFAULT_PRECEDENCE, b.source),
  );
  const defaultLocale =
    current.defaultLocale ??
    opts.locale ??
    byDefault.find((s) => s.defaultLocale !== null)?.defaultLocale ??
    "en-US";

  const decide = (
    path: string,
    locale: string | null,
    cur: unknown,
    curSource: ImportSource | undefined,
    candidates: Candidate[],
  ) => {
    const valid: Candidate[] = [];
    for (const c of candidates) {
      const problems = candidateProblems(path, locale, c.value);
      if (problems.length)
        refused.push(...problems.map((p) => ({ ...p, source: c.source })));
      else valid.push(c);
    }
    if (!valid.length) return;
    const order = orderOf(current.precedence, path);
    valid.sort((a, b) => rankIn(order, a.source) - rankIn(order, b.source));
    const [win, ...rest] = valid as [Candidate, ...Candidate[]];
    const others = rest.map((c) => ({ source: c.source, value: c.value }));
    const hasCur = nonEmpty(cur);
    if (hasCur && same(cur, win.value)) return;
    const origin: ValueOrigin | null = hasCur ? (curSource ?? "admin") : null;
    let action: ImportChange["action"];
    let reason: string | null = null;
    if (origin === null) action = "add";
    else if (origin === "admin") {
      action = opts.overwrite ? "replace" : "keep";
      if (!opts.overwrite) reason = "typed by an operator";
    } else if (rankIn(order, win.source) <= rankIn(order, origin))
      action = "replace";
    else {
      action = opts.overwrite ? "replace" : "keep";
      if (!opts.overwrite)
        reason = `${origin} outranks ${win.source} for this field`;
    }
    changes.push({
      field: path,
      locale,
      action,
      current: hasCur ? (cur as ImportValue) : null,
      currentSource: origin,
      proposed: win.value,
      proposedSource: win.source,
      reason,
      others,
    });
  };

  // App-level fields.
  for (const path of IMPORT_APP_PATHS) {
    const candidates: Candidate[] = [];
    for (const s of snapshots) {
      const v = appValue(s.app, path);
      if (nonEmpty(v)) candidates.push({ source: s.source, value: v });
    }
    decide(
      path,
      null,
      appValue(current.app, path),
      current.appProvenance[path],
      candidates,
    );
  }

  // Per-locale fields: every locale any snapshot has, the bad codes refused.
  const locales = new Set<string>();
  for (const s of snapshots)
    for (const l of Object.keys(s.locales)) {
      if (localeProblem(l))
        refused.push({
          field: `locales.${l}`,
          message: `${l} is not a locale code such as en-US`,
          source: s.source,
        });
      else locales.add(l);
    }
  for (const locale of [...locales].sort()) {
    const cur = current.locales[locale] ?? {};
    const prov = current.localeProvenance[locale] ?? {};
    for (const field of IMPORT_LOCALE_FIELDS) {
      const candidates: Candidate[] = [];
      for (const s of snapshots) {
        const v = s.locales[locale]?.[field];
        if (nonEmpty(v)) candidates.push({ source: s.source, value: v });
      }
      decide(
        `locales.${locale}.${field}`,
        locale,
        cur[field],
        prov[field],
        candidates,
      );
    }
  }

  // The model's locale cap: a new locale past it is refused, whole.
  const existing = new Set(Object.keys(current.locales));
  const added = [
    ...new Set(
      changes
        .filter((c) => c.locale !== null && !existing.has(c.locale))
        .map((c) => c.locale!),
    ),
  ].sort();
  const room = Math.max(0, LISTING_LIMITS.locales - existing.size);
  const over = new Set(added.slice(room));
  if (over.size) {
    for (const l of over)
      refused.push({
        field: `locales.${l}`,
        message: `a listing has at most ${LISTING_LIMITS.locales} locales`,
        source: changes.find((c) => c.locale === l)!.proposedSource,
      });
    for (let i = changes.length - 1; i >= 0; i--)
      if (changes[i]!.locale !== null && over.has(changes[i]!.locale!))
        changes.splice(i, 1);
  }

  return {
    createsListing: !current.exists,
    defaultLocale,
    changes,
    refused,
  };
}

/** The changes an apply writes: every `add` and `replace`, or the named subset of them. */
export function selectChanges(
  plan: ImportPlan,
  fields: readonly string[] | null,
): { selected: ImportChange[]; unknown: string[] } {
  const applicable = plan.changes.filter((c) => c.action !== "keep");
  if (fields === null) return { selected: applicable, unknown: [] };
  const by = new Map(applicable.map((c) => [c.field, c]));
  const unknown = fields.filter((f) => !by.has(f));
  return {
    selected: [...new Set(fields)].flatMap((f) =>
      by.has(f) ? [by.get(f)!] : [],
    ),
    unknown,
  };
}

/** What applying `selected` writes: one app patch, one patch per locale, and the provenance. */
export interface ImportWrite {
  app: Record<string, unknown>;
  appProvenance: Record<string, ImportSource>;
  locales: Record<
    string,
    { patch: Record<string, unknown>; provenance: Record<string, ImportSource> }
  >;
}

/** Build the writes for `selected` changes over `current` (the URLs are written whole). */
export function importWrite(
  current: CurrentListing,
  selected: readonly ImportChange[],
): ImportWrite {
  const app: Record<string, unknown> = {};
  const appProvenance: Record<string, ImportSource> = {
    ...current.appProvenance,
  };
  const locales: ImportWrite["locales"] = {};
  let urls: Record<string, string> | null = null;
  for (const c of selected) {
    if (c.locale === null) {
      if (c.field.startsWith("urls.")) {
        urls ??= { ...(current.app.urls ?? {}) } as Record<string, string>;
        urls[c.field.slice(5)] = c.proposed as string;
      } else app[c.field] = c.proposed;
      appProvenance[c.field] = c.proposedSource;
      continue;
    }
    const field = c.field.slice(`locales.${c.locale}.`.length);
    const entry = (locales[c.locale] ??= {
      patch: {},
      provenance: { ...(current.localeProvenance[c.locale] ?? {}) },
    });
    entry.patch[field] = c.proposed;
    entry.provenance[field] = c.proposedSource;
  }
  if (urls) app.urls = urls;
  return { app, appProvenance, locales };
}

// ── Normalisers the source readers share ─────────────────────────────────────────────────────

/**
 * A store's or an engine's locale spelling as the model's BCP 47 shape: `en-us`, `en_US` →
 * `en-US`; `zh-hans` → `zh-Hans`; `pt_BR` → `pt-BR`. Null when it cannot be one.
 */
export function normaliseLocale(raw: string): string | null {
  const parts = raw.trim().split(/[-_]/);
  if (!parts[0] || !/^[A-Za-z]{2,3}$/.test(parts[0])) return null;
  const out = [parts[0].toLowerCase()];
  for (const p of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(p))
      out.push(p[0]!.toUpperCase() + p.slice(1).toLowerCase());
    else if (/^[A-Za-z]{2}$/.test(p)) out.push(p.toUpperCase());
    else if (/^[A-Za-z0-9]{2,8}$/.test(p)) out.push(p);
    else return null;
  }
  const v = out.join("-");
  return localeProblem(v) ? null : v;
}

/**
 * A store's or an engine's category as a canonical category id (lower-case words joined by
 * hyphens): `GAMES_PUZZLE` → `games-puzzle`, `BooksAndReference_EReader` →
 * `books-and-reference-e-reader`, `Puzzle-games` → `puzzle-games`. A HINT: the operator confirms
 * it in the diff, and each adapter maps the canonical id to its store's list. Null when nothing
 * usable remains.
 */
export function canonicalCategory(raw: string): string | null {
  const words = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const id = words.join("-").slice(0, LISTING_LIMITS.category);
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !id.endsWith("-") ? id : null;
}

/**
 * Split per-locale names into the app-level name (the primary locale's) and the locales whose
 * name differs from it, the way the model stores names (a locale's name overrides the app's).
 */
export function splitNames(
  snapshot: ListingSnapshot,
  primary: string | null,
  names: Readonly<Record<string, string>>,
): void {
  const appName =
    (primary !== null ? names[primary] : undefined) ?? Object.values(names)[0];
  if (appName) snapshot.app.name = appName;
  for (const [locale, name] of Object.entries(names))
    if (name && name !== appName) (snapshot.locales[locale] ??= {}).name = name;
}

/** Keep a string only if it is non-empty after trimming the ends (inner text is kept as typed). */
export function textOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** What reading one source came to: its snapshot, or why it could not be read. */
export type SourceOutcome =
  | { ok: true; snapshot: ListingSnapshot }
  | {
      ok: false;
      status: 404 | 409 | 422 | 502;
      reason: string;
      message: string;
    };
