/**
 * THE PROJECTION AND THE FIT REPORT (A-18b; notes/S-15 §7.3). `projectListing(input, store)` maps
 * the shared listing model onto one store's column (`listingProfiles.ts`) and answers either a
 * payload or issues of the form `{field, locale, limit, actual}`; `fitReport` runs it for every
 * store and grades each cell green, amber (a warning: Flathub's name over 15) or red (it blocks
 * that store).
 *
 * THE RULE (conformance item 7, S-15 §6.6): never a silent truncation. A value over a limit is a
 * red issue and the store gets no payload. The two places something is left out are both shown:
 *
 *   - KEYWORD PACKING picks the terms that fit a store (Apple comma-joins under 100 bytes,
 *     Microsoft takes at most 7 terms of at most 30 characters within 21 words, winget at most 16
 *     tags of 40), and every term left out is an amber issue naming the count;
 *   - a release's SHORT NOTES, when none is stored and the notes are longer than the store's 500,
 *     are red with a PROPOSED sentence-boundary cut (`proposeCut`) attached, for the operator to
 *     accept or edit. The proposal is never sent unseen: it is not in any payload.
 *
 * Values resolve per store: the store's override in that locale, else its override for every
 * locale, else the model (a locale's `name` falls back to the app's). Pure: no I/O.
 */

import type {
  ListingModel,
  ListingReleaseNotes,
  ModelField,
} from "./listingModel.js";
import {
  LISTING_STORES,
  STORE_LISTING_COLUMNS,
  type ListStoreField,
  type ListingPlane,
  type ListingStore,
  type StoreField,
  type TextStoreField,
} from "./listingProfiles.js";

export type FitStatus = "green" | "amber" | "red";

export type ProjectionIssueKind =
  /** Over the store's limit: red. */
  | "too_long"
  /** Over the store's recommendation (`warnChars`): amber. */
  | "over_recommended"
  /** The store requires it and the model has none: red. */
  | "missing"
  /** An unpacked list with more entries than the store takes: red. */
  | "too_many"
  /** One list entry over the store's per-entry limit: red, or amber (and left out) when packed. */
  | "item_too_long"
  /** Packing left terms out: amber. */
  | "packed";

export interface ProjectionIssue {
  store: ListingStore;
  /** The store's field name. */
  field: string;
  /** The model field it is projected from. */
  from: ModelField;
  /** The locale of a per-locale field; null for an app-level one. */
  locale: string | null;
  issue: ProjectionIssueKind;
  severity: "warn" | "block";
  limit: number | null;
  actual: number | null;
  unit: "chars" | "bytes" | "items" | null;
  /** `too_long` short notes only: a sentence-boundary cut to the limit, for edit. */
  proposal?: string;
}

/** One cell of the fit report: one store field in one locale (or the app). */
export interface FitCell {
  field: string;
  from: ModelField;
  locale: string | null;
  plane: ListingPlane;
  status: FitStatus;
  /** The model (or an override) has a value for it. */
  present: boolean;
}

export type ProjectedValue = string | string[];

export interface ListingPayload {
  app: Record<string, ProjectedValue>;
  locales: Record<string, Record<string, ProjectedValue>>;
}

export interface StoreProjection {
  store: ListingStore;
  /** Null when any issue blocks the store. Never carries a proposal or a cut value. */
  payload: ListingPayload | null;
  issues: ProjectionIssue[];
  cells: FitCell[];
}

export interface ProjectionInput {
  model: ListingModel;
  /** One release's store notes by locale (stored rows, and the default for the default locale). */
  releaseNotes?: Readonly<Record<string, ListingReleaseNotes>> | null;
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;
const words = (s: string): number =>
  s.trim().split(/\s+/).filter(Boolean).length;

/**
 * A cut of `text` to at most `max` characters at the last sentence end (`.`, `!`, `?` or a line
 * break) in its second half, else at the last space there, else at `max`. Only ever a PROPOSAL.
 */
export function proposeCut(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const floor = Math.floor(max / 2);
  let cut = -1;
  for (let i = window.length - 1; i >= floor; i--) {
    const c = window[i]!;
    if (c === "\n") {
      cut = i;
      break;
    }
    if (
      (c === "." || c === "!" || c === "?") &&
      (i + 1 >= text.length || /\s/.test(text[i + 1]!))
    ) {
      cut = i + 1;
      break;
    }
  }
  if (cut < 0) {
    const space = window.lastIndexOf(" ");
    cut = space >= floor ? space : max;
  }
  return window.slice(0, cut).trimEnd();
}

/** The locales a store is projected in: the model's, the default first; else the default alone. */
export function projectedLocales(model: ListingModel): string[] {
  const def = model.app.defaultLocale;
  const rest = Object.keys(model.locales)
    .filter((l) => l !== def)
    .sort();
  return [def, ...rest];
}

function overrideOf(
  model: ListingModel,
  store: string,
  locale: string | null,
  field: ModelField,
): ProjectedValue | undefined {
  const at = (l: string | null) =>
    model.overrides.find(
      (o) => o.store === store && o.locale === l && o.field === field,
    )?.value;
  return (locale !== null ? at(locale) : undefined) ?? at(null);
}

const nonEmpty = (v: unknown): v is ProjectedValue =>
  (typeof v === "string" && v !== "") || (Array.isArray(v) && v.length > 0);

/**
 * The model's value of `from` for `store` in `locale` (null: app level), or undefined. Short
 * release notes resolve to the stored short form, else the full notes (the caller checks length).
 */
export function resolveValue(
  input: ProjectionInput,
  store: string,
  locale: string | null,
  from: ModelField,
): ProjectedValue | undefined {
  const o = overrideOf(input.model, store, locale, from);
  if (nonEmpty(o)) return o;
  const { app, locales } = input.model;
  const loc = locale !== null ? locales[locale] : undefined;
  const notes = locale !== null ? input.releaseNotes?.[locale] : undefined;
  const v: unknown = (() => {
    switch (from) {
      case "name":
        return loc?.name || app.name;
      case "subtitle":
      case "shortDescription":
      case "description":
      case "promotionalText":
      case "keywords":
      case "features":
        return loc?.[from];
      case "releaseNotes":
        return notes?.text;
      case "releaseNotesShort":
        return notes ? (notes.short ?? notes.text) : undefined;
      case "developerName":
      case "category":
      case "copyright":
      case "contactEmail":
        return app[from];
      case "website":
        return app.urls?.website;
      case "supportUrl":
        return app.urls?.support;
      case "privacyUrl":
        return app.urls?.privacy;
      case "marketingUrl":
        return app.urls?.marketing;
      case "eulaUrl":
        return app.urls?.eula;
    }
  })();
  return nonEmpty(v) ? v : undefined;
}

interface Checked {
  issues: ProjectionIssue[];
  value?: ProjectedValue;
}

function checkText(
  base: Omit<
    ProjectionIssue,
    "issue" | "severity" | "limit" | "actual" | "unit"
  >,
  f: TextStoreField,
  raw: ProjectedValue,
  shortFallback: boolean,
): Checked {
  const v = Array.isArray(raw) ? raw.join(", ") : raw;
  const unit = f.unit === "bytes" ? "bytes" : "chars";
  const n = unit === "bytes" ? utf8Length(v) : v.length;
  if (f.maxChars !== undefined && n > f.maxChars)
    return {
      issues: [
        {
          ...base,
          issue: "too_long",
          severity: "block",
          limit: f.maxChars,
          actual: n,
          unit,
          ...(shortFallback ? { proposal: proposeCut(v, f.maxChars) } : {}),
        },
      ],
    };
  if (f.warnChars !== undefined && n > f.warnChars)
    return {
      issues: [
        {
          ...base,
          issue: "over_recommended",
          severity: "warn",
          limit: f.warnChars,
          actual: n,
          unit,
        },
      ],
      value: v,
    };
  return { issues: [], value: v };
}

function checkList(
  base: Omit<
    ProjectionIssue,
    "issue" | "severity" | "limit" | "actual" | "unit"
  >,
  f: ListStoreField,
  raw: ProjectedValue,
): Checked {
  const items = (Array.isArray(raw) ? raw : raw.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const issues: ProjectionIssue[] = [];
  if (!f.pack) {
    items.forEach((item) => {
      if (f.maxItemChars !== undefined && item.length > f.maxItemChars)
        issues.push({
          ...base,
          issue: "item_too_long",
          severity: "block",
          limit: f.maxItemChars,
          actual: item.length,
          unit: "chars",
        });
    });
    if (f.maxItems !== undefined && items.length > f.maxItems)
      issues.push({
        ...base,
        issue: "too_many",
        severity: "block",
        limit: f.maxItems,
        actual: items.length,
        unit: "items",
      });
    return issues.length ? { issues } : { issues, value: items };
  }
  const kept: string[] = [];
  let wordCount = 0;
  for (const item of items) {
    if (f.maxItemChars !== undefined && item.length > f.maxItemChars) {
      issues.push({
        ...base,
        issue: "item_too_long",
        severity: "warn",
        limit: f.maxItemChars,
        actual: item.length,
        unit: "chars",
      });
      continue;
    }
    if (f.maxItems !== undefined && kept.length >= f.maxItems) continue;
    if (f.maxWords !== undefined && wordCount + words(item) > f.maxWords)
      continue;
    if (
      f.joinBytes !== undefined &&
      utf8Length([...kept, item].join(",")) > f.joinBytes
    )
      continue;
    kept.push(item);
    wordCount += words(item);
  }
  const fitting = items.filter(
    (i) => f.maxItemChars === undefined || i.length <= f.maxItemChars,
  ).length;
  if (kept.length < fitting)
    issues.push({
      ...base,
      issue: "packed",
      severity: "warn",
      limit: kept.length,
      actual: fitting,
      unit: "items",
    });
  if (kept.length === 0) return { issues };
  return {
    issues,
    value: f.joinBytes !== undefined ? kept.join(",") : kept,
  };
}

function statusOf(issues: readonly ProjectionIssue[]): FitStatus {
  if (issues.some((i) => i.severity === "block")) return "red";
  if (issues.length) return "amber";
  return "green";
}

/** Project the model onto one store's column. See the file comment. */
export function projectListing(
  input: ProjectionInput,
  store: ListingStore,
): StoreProjection {
  const column = STORE_LISTING_COLUMNS[store];
  const issues: ProjectionIssue[] = [];
  const cells: FitCell[] = [];
  const payload: ListingPayload = { app: {}, locales: {} };
  const locales = projectedLocales(input.model);

  const one = (field: string, f: StoreField, locale: string | null) => {
    const raw = resolveValue(input, store, locale, f.from);
    const base = { store, field, from: f.from, locale };
    let found: ProjectionIssue[] = [];
    let value: ProjectedValue | undefined;
    if (raw === undefined) {
      if (f.required && f.plane !== "manual")
        found = [
          {
            ...base,
            issue: "missing",
            severity: "block",
            limit: null,
            actual: null,
            unit: null,
          },
        ];
    } else if (f.plane === "manual") {
      // The store owns it: shown, never checked or sent.
    } else {
      const shortFallback =
        f.from === "releaseNotesShort" &&
        overrideOf(input.model, store, locale, f.from) === undefined &&
        locale !== null &&
        (input.releaseNotes?.[locale]?.short ?? null) === null;
      const r =
        f.kind === "text"
          ? checkText(base, f, raw, shortFallback)
          : checkList(base, f, raw);
      found = r.issues;
      value = r.value;
    }
    issues.push(...found);
    cells.push({
      field,
      from: f.from,
      locale,
      plane: f.plane,
      status: statusOf(found),
      present: raw !== undefined,
    });
    if (value !== undefined) {
      if (locale === null) payload.app[field] = value;
      else (payload.locales[locale] ??= {})[field] = value;
    }
  };

  for (const [field, f] of Object.entries(column.fields)) {
    if (f.perLocale) for (const l of locales) one(field, f, l);
    else one(field, f, null);
  }
  return {
    store,
    payload: issues.some((i) => i.severity === "block") ? null : payload,
    issues,
    cells,
  };
}

export interface FitReportRow extends StoreProjection {
  label: string;
  status: FitStatus;
}

/** The fit report: one row per store, one cell per field and locale (S-15 §7.3). */
export function fitReport(
  input: ProjectionInput,
  stores: readonly ListingStore[] = LISTING_STORES,
): FitReportRow[] {
  return stores.map((store) => {
    const p = projectListing(input, store);
    return {
      ...p,
      label: STORE_LISTING_COLUMNS[store].label,
      status: statusOf(p.issues),
    };
  });
}
