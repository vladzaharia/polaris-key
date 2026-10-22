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
