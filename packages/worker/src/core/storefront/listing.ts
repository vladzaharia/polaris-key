/**
 * The listing-profile slot of a storefront adapter (A-18a; notes/S-15 §7.3). A-18b builds the
 * shared listing model on it; A-18a fixes the shape and the one rule every store shares: a value
 * over a store's limit is a VALIDATION ISSUE, never a silent truncation (conformance item 7).
 *
 * A profile declares, per store, the text fields it takes (their character limits, whether they
 * are per locale, whether the store requires them) and its image slots (accepted types, the byte
 * cap, how many). Pure data: the declaration is JSON-serialisable, so the CLI's generated copy
 * (A-18h) is a straight serialise.
 */

export interface ListingField {
  /** The most characters the store accepts (counted as JavaScript string length). */
  readonly maxChars: number;
  /** One value per locale (a description), or one for the app (a primary category). */
  readonly perLocale: boolean;
  /** The store refuses a submission without it. */
  readonly required?: boolean;
}

export interface ListingImageSlot {
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
  readonly min: number;
  readonly max: number;
  /** The width-to-height ratio the slot needs, when it has one (`[16, 9]`). */
  readonly aspect?: readonly [number, number];
}

export interface ListingProfile {
  readonly fields: Readonly<Record<string, ListingField>>;
  readonly images: Readonly<Record<string, ListingImageSlot>>;
}

/** One value that does not fit, with what would be needed for it to. */
export interface ListingIssue {
  readonly field: string;
  /** The locale of a per-locale field; null for an app-level one. */
  readonly locale: string | null;
  readonly issue: "too_long" | "missing" | "unknown_field";
  readonly limit: number | null;
  readonly actual: number | null;
}

/** Listing text by locale (`null` key: app-level fields). */
export type ListingText = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/**
 * Fit listing text to a profile. Answers every issue; never changes a value. A field the profile
 * does not declare is an issue too, so a typo cannot be dropped silently either.
 */
export function fitListing(
  profile: ListingProfile,
  text: ListingText,
): ListingIssue[] {
  const issues: ListingIssue[] = [];
  const locales = Object.keys(text);
  for (const locale of locales) {
    const values = text[locale]!;
    for (const [field, value] of Object.entries(values)) {
      if (!Object.hasOwn(profile.fields, field)) {
        issues.push({
          field,
          locale,
          issue: "unknown_field",
          limit: null,
          actual: null,
        });
        continue;
      }
      const spec = profile.fields[field]!;
      if (value.length > spec.maxChars)
        issues.push({
          field,
          locale,
          issue: "too_long",
          limit: spec.maxChars,
          actual: value.length,
        });
    }
    for (const [field, spec] of Object.entries(profile.fields))
      if (
        spec.required &&
        spec.perLocale &&
        (values[field] === undefined || values[field] === "")
      )
        issues.push({
          field,
          locale,
          issue: "missing",
          limit: null,
          actual: null,
        });
  }
  return issues;
}
