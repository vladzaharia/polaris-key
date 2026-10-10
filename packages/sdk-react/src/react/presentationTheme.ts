// Discovery's presentation as the React kit's defaults (HA-13, UI-KITS.md §1.2, §3.3). The
// integrator's theme always wins: the presentation fills only what it leaves unset.
//
//   name     `copy.productName`, when the integrator set none, wrapped in FSI…PDI so a
//            right-to-left or mixed name never reorders the sentence around it (HA-12 Q5)
//   accent   the integrator's (`tokens`, `lightTokens` or `darkTokens`), else the product's
//            (`accent`, or `accentDark` in the dark scheme), else the colour derived from the
//            icon (`@polaris-key/brand` `deriveAccent`), else ink (both brandings default to ink;
//            the violet is Polaris Key's own, never a product's). The kit's accent resolver
//            (`resolveProductAccent`, `resolveAccent` underneath) then makes it contrast-safe.
//   icon     the verified icon's `blob:` URL as `theme.productIcon`, unless `theme.logo` is set
//
// The kit never fetches discovery or the icon itself: both come from the adapter's
// `presentationSource()`.

import { deriveAccent } from "@polaris-key/brand/accent";
import type { ProductPresentation } from "@polaris-key/client-core/presentation";
import type { PartialTheme } from "../components/theme.js";

/** First strong isolate … pop directional isolate. */
const FSI = "\u2068";
const PDI = "\u2069";

/** `name` as a bidi-isolated run. */
export function isolate(name: string): string {
  return `${FSI}${name}${PDI}`;
}

/** `partial` with the presentation filled in where the integrator left a gap. */
export function withPresentation(
  partial: PartialTheme | undefined,
  p: ProductPresentation | null,
  derivedAccent: string | null = null,
): PartialTheme | undefined {
  if (!p && !derivedAccent) return partial;
  const out: PartialTheme = { ...partial };
  if (p && partial?.copy?.productName === undefined)
    out.copy = { ...partial?.copy, productName: isolate(p.name) };
  const integratorAccent =
    partial?.tokens?.accent !== undefined ||
    partial?.lightTokens?.accent !== undefined ||
    partial?.darkTokens?.accent !== undefined;
  if (integratorAccent) return out;
  const light = p?.accent ?? p?.accentDark;
  const dark = p?.accentDark ?? p?.accent;
  if (light && dark) {
    out.lightTokens = { ...partial?.lightTokens, accent: light };
    out.darkTokens = { ...partial?.darkTokens, accent: dark };
  } else if (derivedAccent) {
    out.tokens = { ...partial?.tokens, accent: derivedAccent };
  }
  return out;
}

/** The side of the canvas the icon is drawn on to derive its accent: enough pixels to find the
 *  dominant hue, few enough to stay cheap. */
const SAMPLE = 64;

/**
 * The accent `deriveAccent` finds in the icon at `url` (a `blob:` URL of verified bytes), or null
 * where the page cannot decode it (no canvas, a decode failure). Never throws.
 */
export async function iconAccent(url: string): Promise<string | null> {
  try {
    if (typeof document === "undefined" || typeof Image === "undefined")
      return null;
    const img = new Image();
    img.src = url;
    if (typeof img.decode !== "function") return null;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    return deriveAccent(g.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    return null;
  }
}
