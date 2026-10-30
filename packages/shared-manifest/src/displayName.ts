/**
 * Display names an app shows on the sign-in card (plans/PX-W13.md §3; PORTAL.md §4.7, G28).
 *
 * "<App> wants you to sign in" is only trustworthy if a product cannot call itself "Polaris Key",
 * "Steam" or "Google Play". This module is the ONE place that decides whether a display name is
 * acceptable. The manifest validator (`product.name`, `.pkey/distribution` `listing.name` and
 * `listing.developerName`), the Worker's console listing claims and the render-time re-check of the
 * sign-in client record all call {@link checkDisplayName}.
 *
 * Two rules, two severities:
 *
 * - `invalid_display_text` (always an error): the name holds a code point of the refused set
 *   ({@link DISPLAY_NAME_REFUSED}: controls, format and invisible characters, bidi controls, line
 *   and paragraph separators, fillers, U+2800), starts with a kept code point
 *   ({@link DISPLAY_NAME_KEPT}: a selector or tag modifies the code point before it), or starts or
 *   ends with whitespace. It rejects code points, not names, so it is never relaxed.
 * - `reserved_display_name`: after NFKD with marks dropped (a superset of the plan's NFKC: it
 *   also folds accents), lowercasing, the confusable map and splitting on
 *   anything that is not a letter or digit, the name contains a reserved term as whole words, or
 *   one of its words is a multi-word term written as one word ("PolarisKey", "GooglePlay"). It
 *   is reported with the platform setting `identity.reservedDisplayNames` (`warn` by default,
 *   then `error` once the S-19 decision-15 window has passed). The system product is exempt.
 *
 * The confusable map is a heuristic (plans/PX-W13.md §8 risks): the render-time re-check, which
 * falls back to the neutral frame, bounds what slips through.
 */

/**
 * DISPLAY-NAME-INVISIBLE D-2: the code points a display name may not hold, as inclusive
 * `[first, last]` ranges frozen at Unicode 16.0 (Cc, Cf, Cs, Zl, Zp, Default_Ignorable_Code_Point
 * and U+2800, minus {@link DISPLAY_NAME_KEPT}). Explicit ranges read the same on every runtime
 * and are what the JSON Schemas copy: the schemas carry the Basic Multilingual Plane part, the
 * validator all of it. U+200C and U+200D (the joiners) stay refused (D-4).
 */
export const DISPLAY_NAME_REFUSED: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe001f],
  [0xe0080, 0xe00ff],
  [0xe01f0, 0xe0fff],
];

/**
 * DISPLAY-NAME-INVISIBLE D-2/D-3: the sequence formers a name keeps. They modify the code point
 * before them (Mongolian free variation selectors, VS1-16, emoji tag sequences, VS17-256), so they
 * are valid anywhere except as the first code point. Inclusive ranges, Unicode 16.0.
 */
export const DISPLAY_NAME_KEPT: readonly (readonly [number, number])[] = [
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0xfe00, 0xfe0f],
  [0xe0020, 0xe007f],
  [0xe0100, 0xe01ef],
];

const inRanges = (
  cp: number,
  ranges: readonly (readonly [number, number])[],
): boolean => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** The severity a reserved display name is reported with (`identity.reservedDisplayNames`). */
export const RESERVED_DISPLAY_NAMES_MODES = ["warn", "error"] as const;
export type ReservedDisplayNamesMode =
  (typeof RESERVED_DISPLAY_NAMES_MODES)[number];
/** The mode during the S-19 decision-15 window, and wherever the setting cannot be read. */
export const DEFAULT_RESERVED_DISPLAY_NAMES_MODE: ReservedDisplayNamesMode =
  "warn";

/** The system product, which may call itself Polaris Key. */
export const DISPLAY_NAME_EXEMPT_SLUG = "polaris-key";

/**
 * The floor of reserved terms (plans/PX-W13.md §3). The platform can add terms later through the
 * registry list `identity.reservedDisplayTerms`; it can never remove these.
 */
export const RESERVED_DISPLAY_TERMS: readonly string[] = [
  "polaris",
  "polaris key",
  "plrs",
  "apple",
  "app store",
  "google",
  "google play",
  "steam",
  "valve",
  "epic games",
  "microsoft",
  "xbox",
  "playstation",
  "nintendo",
  "itch io",
];

/** Single code points that read as a Latin letter, after NFKC and lowercasing. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "l",
  // Cyrillic
  "\u0430": "a",
  "\u0432": "b",
  "\u0435": "e",
  "\u0456": "i",
  "\u0458": "j",
  "\u043a": "k",
  "\u043c": "m",
  "\u043d": "h",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0455": "s",
  "\u0442": "t",
  "\u0443": "y",
  "\u0445": "x",
  "\u0501": "d",
  "\u04bb": "h",
  "\u0475": "v",
  "\u051b": "q",
  "\u051d": "w",
  // Greek
  "\u03b1": "a",
  "\u03b2": "b",
  "\u03b5": "e",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bd": "v",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u03b3": "y",
};

/**
 * The words of a display name's skeleton (§3). Per code point: a refused or kept code point is
 * deleted first (D-5), so an invisible character neither glues words together nor splits one
 * ("Ste" + tag + "am" is still `steam`); a combining mark is dropped, a
 * letter or digit is NFKD-folded (compatibility forms, width, accents) and lowercased, and
 * anything else separates words, so a symbol whose compatibility form is letters (\u2122 is "TM")
 * cannot glue two words together. Then the confusable map, then `rn` and `vv`.
 */
export function displayNameSkeleton(text: string): string[] {
  let s = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (inRanges(cp, DISPLAY_NAME_REFUSED) || inRanges(cp, DISPLAY_NAME_KEPT))
      continue;
    if (/\p{M}/u.test(ch)) continue;
    if (!/[\p{L}\p{N}]/u.test(ch)) {
      s += " ";
      continue;
    }
    for (const c of ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase())
      s += CONFUSABLES[c] ?? c;
  }
  // Multi-letter look-alikes, after the single ones so `rn` built from Cyrillic letters folds too.
  s = s.replace(/rn/g, "m").replace(/vv/g, "w");
  return s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

const TERM_WORDS: readonly (readonly string[])[] = RESERVED_DISPLAY_TERMS.map(
  (t) => displayNameSkeleton(t),
);

/** Longest terms first, so "Google Play" is reported as `google play`, not `google`. */
function byLength<T extends { w: readonly string[] }>(terms: T[]): T[] {
  return terms.sort((a, b) => b.w.length - a.w.length);
}

/** The reserved term `text` contains, or `null`. Extra terms extend the floor, never replace it. */
export function reservedDisplayTerm(
  text: string,
  extraTerms: readonly string[] = [],
): string | null {
  const words = displayNameSkeleton(text);
  const terms = byLength([
    ...RESERVED_DISPLAY_TERMS.map((term, i) => ({ term, w: TERM_WORDS[i]! })),
    ...extraTerms.map((term) => ({ term, w: displayNameSkeleton(term) })),
  ]);
  for (const { term, w } of terms) {
    if (w.length === 0) continue;
    const joined = w.join("");
    for (let i = 0; i < words.length; i++) {
      // A multi-word term written as one word: "PolarisKey", "GooglePlay", "itchio".
      if (words[i] === joined) return term;
      if (i + w.length > words.length) continue;
      let all = true;
      for (let j = 0; j < w.length && all; j++) all = words[i + j] === w[j];
      if (all) return term;
    }
  }
  return null;
}

/**
 * True when `text` holds a {@link DISPLAY_NAME_REFUSED} code point, starts with a
 * {@link DISPLAY_NAME_KEPT} one, or starts or ends with whitespace.
 */
export function invalidDisplayText(text: string): boolean {
  if (/^\s|\s$/u.test(text)) return true;
  let first = true;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (inRanges(cp, DISPLAY_NAME_REFUSED)) return true;
    if (first && inRanges(cp, DISPLAY_NAME_KEPT)) return true;
    first = false;
  }
  return false;
}

/**
 * `null` when `text` may be shown as an app or developer name, `"invalid"` for
 * `invalid_display_text`, `"reserved"` for `reserved_display_name`. `slug` exempts the system
 * product from the reserved check (never from the text check).
 */
export function checkDisplayName(
  text: string,
  opts: {
    slug?: string;
    extraTerms?: readonly string[];
    /**
     * The operator approved this product's name (`identity.displayNameApproved`): clears
     * `reserved` for it, never `invalid`.
     */
    approved?: boolean;
  } = {},
): null | "reserved" | "invalid" {
  if (invalidDisplayText(text)) return "invalid";
  if (opts.slug === DISPLAY_NAME_EXEMPT_SLUG || opts.approved === true)
    return null;
  return reservedDisplayTerm(text, opts.extraTerms) ? "reserved" : null;
}
