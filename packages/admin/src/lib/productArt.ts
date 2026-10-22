/**
 * Two helpers the portal's product art and the console's `ProductLogo` share: the monogram
 * letter and the icon shape test. Shared, so a product's letter and its icon's corner mask are
 * the same in both apps. The portal's tint palette is deliberately NOT shared: the console's
 * monogram uses the brand's neutral tokens until HA-12 gives products an accent.
 */

/** The first letter or digit of a name, upper-cased; `?` when it has none. */
export function letterOf(name: string): string {
  const m = name.match(/[\p{L}\p{N}]/u);
  return (m?.[0] ?? "?").toUpperCase();
}

export type IconShape = "shaped" | "square";

/**
 * `square` when the icon's top-left corner pixel is opaque (a full-bleed square, as iOS and
 * Android icons are authored), else `shaped` (transparent corners: the developer's own shape is
 * the frame). Where the pixels can't be read (no canvas, or an image without CORS), the icon is
 * left exactly as the developer drew it.
 */
export function iconShape(img: HTMLImageElement): IconShape {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "shaped";
    ctx.drawImage(img, 0, 0, 32, 32);
    return ctx.getImageData(0, 0, 1, 1).data[3]! >= 250 ? "square" : "shaped";
  } catch {
    return "shaped";
  }
}

/**
 * The band behind a console product card that has no header art and no accent of its own: one of
 * eight quiet tints (the dark ones sit close to the page), picked from the slug so a product keeps its colour everywhere and a row of
 * cards is never grey. Dark tints carry white text at 4.5:1 or better, light tints carry near-black
 * text the same way (`productArt.test.ts` holds both).
 */
export const FALLBACK_TINTS = {
  dark: [
    "#25233f",
    "#1c2f45",
    "#16363a",
    "#233826",
    "#3d3220",
    "#40262a",
    "#3a2336",
    "#272e3a",
  ],
  light: [
    "#dcd8f5",
    "#d3e4f5",
    "#cfeaea",
    "#d9ecd2",
    "#f1e4c4",
    "#f3d6d6",
    "#efd5e8",
    "#dde2ea",
  ],
} as const;

/** The same slug always lands on the same tint (FNV-1a over its code units). */
export function fallbackTint(slug: string, theme: "dark" | "light"): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const list = FALLBACK_TINTS[theme];
  return list[h % list.length]!;
}
