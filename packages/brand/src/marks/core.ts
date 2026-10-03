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
 * The K's terminal bit. The default Polaris Key mark has no bit at all: on core/platform pages
 * nothing is drawn where the bit would be (owner decision 2026-10-03, docs/design/BRAND.md §6).
 *   "none"      no bit: the path is left out of the markup (the default when `bit` is omitted
 *               and the mark is not `signed`).
 *   "core"      the platform section, which has no bit: the same as "none".
 *   ServiceId   the section bit: that section's accent (License, Config, Release, ...).
 *   "section"   the live section from tokens.css: the bit takes `--pk-section-bit` from the
 *               nearest data-service ancestor, eases between sections, and is not displayed at
 *               all under a core (or absent) data-service (`--pk-section-bit-display: none`).
 *   "gold"      the kit gold for the ground (the kit's signing bit; never the default mark).
 *   string      any other CSS colour: a hex, `var(--name)`, or an rgb()/hsl()/oklch() literal.
 */
export type BitColor = "none" | "gold" | "section" | ServiceId | (string & {});

const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+(,\s*#[0-9a-f]{3,8})?\)|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9a-z.%,/\s-]+\)|currentColor)$/i;

/** True when `id` is a section id. */
export function isServiceId(id: string): id is ServiceId {
  return (SERVICE_IDS as readonly string[]).includes(id);
}

/** True when `bit` asks for no bit at all: "none", or the core (platform) section. */
export function isNoBit(bit: BitColor | undefined): boolean {
  return bit === "none" || bit === "core";
}

/**
 * Resolve a bit colour to a fill value, or `null` when the request is for no bit ("none" or
 * "core"). Mono artwork uses a single ink for every part, the bit included (kit README), so
 * under `mono` every drawn bit answers `currentColor`. "section" answers the live custom
 * property. Throws on a string that is not a recognisable CSS colour, so a renderer never writes
 * arbitrary text into markup.
 */
export function resolveBitFill(bit: BitColor, theme: MarkTheme): string | null {
  if (isNoBit(bit)) return null;
  if (theme === "mono") return "currentColor";
  if (bit === "gold") return BRAND.gold[theme];
  if (bit === "section") return "var(--pk-section-bit)";
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
