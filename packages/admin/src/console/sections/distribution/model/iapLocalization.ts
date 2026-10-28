import type { AscIapProductDto } from "../../../../api.js";

/** Apple's limits (A-17e): reference name 64, display name 35, description 55, ≤ 10 locales. */
export const REFERENCE_MAX = 64;
export const NAME_MAX = 35;
export const DESCRIPTION_MAX = 55;
export const MAX_LOCALES = 10;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

/** One locale of an In-App Purchase: its display name and description in the store. */
export interface IapLocalization {
  locale: string;
  name: string;
  description: string;
}

/**
 * The starting localizations of a new In-App Purchase.
 *
 * THE SEAM FOR A-18b (notes/S-15 §7.5): App Store products default their display name and
 * description from the shared listing model's locales. Until A-18b lands there is no model to read,
 * so a new purchase starts with one empty row in the app's primary language.
 */
export function iapLocalizationSeed(
  _product: AscIapProductDto,
): IapLocalization[] {
  return [{ locale: "en-US", name: "", description: "" }];
}

/** Why a set of localizations cannot be sent, or `null`. */
export function localizationsError(locs: IapLocalization[]): string | null {
  if (locs.length === 0) return "Add at least one locale.";
  if (locs.length > MAX_LOCALES) return `Use at most ${MAX_LOCALES} locales.`;
  const seen = new Set<string>();
  for (const l of locs) {
    const locale = l.locale.trim();
    if (!LOCALE.test(locale))
      return `"${l.locale}" isn't a locale code such as en-US.`;
    if (seen.has(locale)) return `${locale} appears twice.`;
    seen.add(locale);
    if (l.name.trim() === "") return `Name the purchase in ${locale}.`;
    if (l.name.trim().length > NAME_MAX)
      return `The ${locale} name is longer than ${NAME_MAX} characters.`;
    if (l.description.trim().length > DESCRIPTION_MAX)
      return `The ${locale} description is longer than ${DESCRIPTION_MAX} characters.`;
  }
  return null;
}
