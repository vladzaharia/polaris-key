// Mark rules shared by the React components and the framework-free string renderers: optical-cut
// selection, when the K's terminal bit may show, and what colour it takes.

import { SERVICE_ACCENTS } from "../generated/tokens.js";
import {
  BRAND,
  OPTICAL,
  POWERED_BY,
  type BadgeLayout,
  type MarkKind,
  type OpticalCut,
} from "../tokens/primitives.js";
import { SERVICE_IDS, type ServiceId } from "../tokens/source.js";

/** Mark colour themes, as in the kit's React component: dark/light grounds, or one ink. */
export type MarkTheme = "dark" | "light" | "mono";

/**
 * Which optical cut a mark DISPLAYED at `size` CSS px uses (kit README "Three optical sizes"):
 * below 24 the 16-grid favicon cut, 24–32 the service cut, above 32 the display master. Device
 * pixel ratio never enters: a 16 px mark on a 2× screen still draws the favicon geometry.
 */
export function opticalCut(size: number): OpticalCut {
  if (size < OPTICAL.faviconBelow) return "favicon";
  if (size <= OPTICAL.serviceMax) return "service";
  return "display";
}

/**
 * The colour of the K's terminal bit.
 *   "gold"      the kit gold for the ground (the signing bit).
 *   ServiceId   the section bit: that section's accent; "core" is the kit gold.
 *   "section"   the live section from tokens.css (`var(--pk-section-bit)`), which follows the
 *               nearest data-service ancestor and eases between sections.
 *   string      any other CSS colour: a hex, `var(--name)`, or an rgb()/hsl()/oklch() literal.
 */
export type BitColor = "gold" | "section" | ServiceId | (string & {});

const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+(,\s*#[0-9a-f]{3,8})?\)|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9a-z.%,/\s-]+\)|currentColor)$/i;

/** True when `id` is a section id. */
export function isServiceId(id: string): id is ServiceId {
  return (SERVICE_IDS as readonly string[]).includes(id);
}

/**
 * Resolve a bit colour to a fill value. Mono artwork uses a single ink for every part, the bit
 * included (kit README), so under `mono` every request answers `currentColor`. Throws on a string
 * that is not a recognisable CSS colour, so a renderer never writes arbitrary text into markup.
 */
export function resolveBitFill(bit: BitColor, theme: MarkTheme): string {
  if (theme === "mono") return "currentColor";
  const gold = BRAND.gold[theme];
  if (bit === "gold") return gold;
  if (bit === "section") return `var(--pk-section-bit, ${gold})`;
  if (isServiceId(bit)) return SERVICE_ACCENTS[theme][bit].bit;
  if (!SAFE_COLOR.test(bit))
    throw new Error(`not a CSS colour for the bit: ${bit}`);
  return bit;
}

/**
 * Whether the K's terminal bit may be drawn: the Pinned K only (the Update mark has no bit), the
 * display cut only, and only when the rendered glyph is at least 48 CSS px.
 */
export function bitVisible(kind: MarkKind, size: number): boolean {
  return (
    kind === "key" &&
    opticalCut(size) === "display" &&
    size >= OPTICAL.goldMinimumGlyphSize
  );
}

/**
 * The size a "Powered by Polaris Key" badge renders at: the requested width, never below the
 * layout's minimum, with the kit's aspect ratio. Badges are never cropped or shrunk past the kit
 * minimum (horizontal 376×144, compact 232×88, stacked 288×336).
 */
export function badgeSize(
  layout: BadgeLayout,
  width?: number,
): { width: number; height: number } {
  const min = POWERED_BY.minimum[layout];
  const w =
    width === undefined || !Number.isFinite(width)
      ? min.width
      : Math.max(width, min.width);
  return {
    width: w,
    height: Math.round(((w * min.height) / min.width) * 100) / 100,
  };
}

/** Clear space to leave around a standalone mark or lockup: a quarter of the glyph height. */
export function clearSpace(glyphHeight: number): number {
  return glyphHeight / 4;
}
