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
