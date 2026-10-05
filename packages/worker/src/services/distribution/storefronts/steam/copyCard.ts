/**
 * Steam's store-page COPY CARD (A-18g; notes/S-15 §4.3, §7.3): every text field of Steam's listing
 * column (`STORE_LISTING_COLUMNS.steam`, all `copy` plane) pre-filled from the shared listing model
 * per locale, for the operator to paste into Steamworks' store admin. Pure: no I/O.
 *
 * Values resolve exactly as the projection resolves them (a Steam override in the locale, else
 * the override for every locale, else the model), and the issues are the projection's own
 * (`projectListing(…, "steam")`): a required value missing is red, a short description over
 * Steam's recommended 300 characters amber. Nothing is cut: the card shows the value whole, as the
 * operator will paste it. The values are DATA: the console renders them escaped (THREAT-MODEL
 * control (g)).
 */

import {
  STORE_LISTING_COLUMNS,
  type ListingPlane,
} from "../../../../core/storefront/listingProfiles.js";
import {
  projectedLocales,
  projectListing,
  resolveValue,
  type FitStatus,
  type ProjectedValue,
  type ProjectionInput,
  type ProjectionIssue,
} from "../../../../core/storefront/projection.js";

export interface CopyCardField {
  /** Steam's field (`name`, `shortDescription`, `description`, `tags`). */
  field: string;
  /** The model field it comes from. */
  from: string;
  plane: ListingPlane;
  value: ProjectedValue | null;
  status: FitStatus;
  issues: ProjectionIssue[];
}

export interface CopyCard {
  status: FitStatus;
  defaultLocale: string;
  locales: Array<{ locale: string; fields: CopyCardField[] }>;
}

const worst = (a: FitStatus, b: FitStatus): FitStatus =>
  a === "red" || b === "red" ? "red" : a === "amber" || b === "amber" ? "amber" : "green";

/** The copy card for the model (one locale entry per projected locale, the default first). */
export function steamCopyCard(input: ProjectionInput): CopyCard {
  const column = STORE_LISTING_COLUMNS.steam;
  const projection = projectListing(input, "steam");
  let status: FitStatus = "green";
  const locales = projectedLocales(input.model).map((locale) => ({
    locale,
    fields: Object.entries(column.fields).map(([field, f]) => {
      const at = f.perLocale ? locale : null;
      const issues = projection.issues.filter(
        (i) => i.field === field && i.locale === at,
      );
      const cell = projection.cells.find(
        (c) => c.field === field && c.locale === at,
      );
      const s: FitStatus = cell?.status ?? "green";
      status = worst(status, s);
      return {
        field,
        from: f.from,
        plane: f.plane,
        value: resolveValue(input, "steam", at, f.from) ?? null,
        status: s,
        issues,
      };
    }),
  }));
  return { status, defaultLocale: input.model.app.defaultLocale, locales };
}
