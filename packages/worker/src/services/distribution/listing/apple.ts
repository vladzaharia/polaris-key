/**
 * How A-17d's Distribute flow consumes the shared listing model (A-18b; notes/S-15 §7.5, §11):
 *
 *   - `distribute/version-localization` given a `releaseId` defaults `whatsNew` from that
 *     release's store notes in the locale (`dist_listing_release_notes`, or the default derived
 *     from its release notes) and `promotionalText` from the model's locale, each only when the
 *     request does not carry it. A value over Apple's limit is refused with the limit and the
 *     length, never cut;
 *   - the preflight shows the model's Apple fit report (advisory: App Store Connect's own listing
 *     is what review sees until A-18m pushes the model).
 *
 * No gate change: the fields are the ones A-17a's rule table already allows.
 */

import type { Db } from "../../../core/platform.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import { STORE_LISTING_COLUMNS } from "../../../core/storefront/listingProfiles.js";
import {
  fitReport,
  resolveValue,
  type FitReportRow,
  type ProjectionInput,
} from "../../../core/storefront/projection.js";
import { notesForProjection, releaseNotesView } from "./notes.js";
import { readListing } from "./store.js";

export type AppleListingInput =
  | { ok: true; input: ProjectionInput | null }
  | { ok: false; reason: "unknown_release" };

/**
 * The projection input for Apple: the model (null when the product has none) and, with a
 * `releaseId`, that release's store notes. A release that does not exist is `unknown_release`.
 */
export async function appleListingInput(
  db: Db,
  hooks: ServiceHooks,
  product: string,
  releaseId: string | null,
): Promise<AppleListingInput> {
  const stored = await readListing(db, product);
  let releaseNotes = null;
  if (releaseId !== null) {
    const catalog = hooks.releaseCatalog();
    const view = catalog
      ? await releaseNotesView(
          db,
          catalog,
          product,
          releaseId,
          stored?.row.default_locale ?? "en-US",
        )
      : null;
    if (!view) return { ok: false, reason: "unknown_release" };
    releaseNotes = notesForProjection(view);
  }
  if (!stored && !releaseNotes) return { ok: true, input: null };
  return {
    ok: true,
    input: {
      model: stored?.model ?? {
        app: { defaultLocale: "en-US" },
        locales: {},
        overrides: [],
      },
      releaseNotes,
    },
  };
}

/**
 * The model's value of one Apple version-localization field in `locale`, checked against Apple's
 * column: `{value}`, `{}` when the model has none, or `{tooLong}` (refused, never cut).
 */
export function appleLocalizationDefault(
  input: ProjectionInput,
  locale: string,
  field: "whatsNew" | "promotionalText",
): { value?: string; tooLong?: { limit: number; actual: number } } {
  const spec = STORE_LISTING_COLUMNS["app-store"].fields[field]!;
  const v = resolveValue(input, "app-store", locale, spec.from);
  if (v === undefined) return {};
  const text = Array.isArray(v) ? v.join(", ") : v;
  const limit = spec.kind === "text" ? spec.maxChars : undefined;
  if (limit !== undefined && text.length > limit)
    return { tooLong: { limit, actual: text.length } };
  return { value: text };
}

/** The model's Apple fit report row. */
export function appleFit(input: ProjectionInput): FitReportRow {
  return fitReport(input, ["app-store"])[0]!;
}
