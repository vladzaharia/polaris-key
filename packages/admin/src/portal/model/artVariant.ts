/**
 * Which hosted width a piece of art is fetched at (B4: hosted art, else the flat stored tint;
 * the canvas is never read). The Worker hands out one width per surface (`PRESENTATION_WIDTHS`);
 * the surface here knows how wide the art is actually drawn, so it asks for the narrowest rung of
 * the header ladder (HA-03: 640, 1280, 1920) that is at least drawn width times devicePixelRatio.
 * A tile-sized variant is never stretched into a banner; the widest rung is the most there is.
 */

/** The header slot's WebP width ladder (`VARIANT_LADDERS.header` in the Worker). */
export const HEADER_LADDER: readonly number[] = [640, 1280, 1920];

/** The narrowest rung at least `cssPx` × `dpr` wide, else the widest. 0 or unknown: no choice. */
export function rungFor(
  cssPx: number,
  dpr: number,
  ladder: readonly number[] = HEADER_LADDER,
): number | null {
  if (!(cssPx > 0) || ladder.length === 0) return null;
  const need = cssPx * (dpr > 0 ? dpr : 1);
  return ladder.find((w) => w >= need) ?? ladder[ladder.length - 1]!;
}

const VARIANT = /^(.*\/a\/[0-9a-f]{64}\/)(\d{3,4})(\.webp)$/;

/** The width a variant URL names, or null for an original or a proxy path. */
export function widthOf(src: string): number | null {
  const m = VARIANT.exec(src);
  return m ? Number(m[2]) : null;
}

/**
 * `src` at the rung for the drawn size. Only a ladder variant URL is rewritten; the original, a
 * `/media/…` proxy path and anything else come back as given. An already wider variant stays.
 */
export function variantUrl(src: string, cssPx: number, dpr: number): string {
  const m = VARIANT.exec(src);
  const rung = rungFor(cssPx, dpr);
  if (!m || rung === null || !HEADER_LADDER.includes(Number(m[2]))) return src;
  return `${m[1]}${rung}${m[3]}`;
}
