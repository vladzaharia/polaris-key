// Framework-free SVG renderers for consumers without React: the Worker's HTML pages and emails,
// the docs site, a static landing page, build scripts. Every function returns a complete SVG
// string. `markSvg`, `lockupSvg` and `poweredBySvg` produce exactly the markup the React
// components render (test/marks.test.tsx compares them); the `kit*` functions reproduce the kit's
// own files byte for byte (test/kit-fidelity.test.ts).
//
// External <img src="…svg"> does not inherit currentColor; inline these strings when a mark must
// follow the surrounding text colour.

import { GEOMETRY, KIT_PALETTES, SPRITE } from "../generated/geometry.js";
import {
  BADGE_TEMPLATES,
  LOCKUP_GLYPHS,
  LOCKUP_TEMPLATES,
} from "../generated/layouts.js";
import {
  ALT,
  BRAND,
  CUT_GRID,
  OPTICAL,
  type BadgeLayout,
  type LockupKind,
  type MarkKind,
  type OpticalCut,
} from "../tokens/primitives.js";
import {
  badgeSize,
  bitVisible,
  opticalCut,
  resolveBitFill,
  type BitColor,
  type MarkTheme,
} from "./core.js";
import type { KitPalette, KitRole, KitTemplate } from "./types.js";

export { SPRITE };

/** Escape text and attribute values the way React's server renderer does. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The accessible head of an SVG: role + label + <title>, or aria-hidden when decorative. */
function a11y(title: string | undefined): { attrs: string; title: string } {
  return title
    ? {
        attrs: ` role="img" aria-label="${escapeHtml(title)}"`,
        title: `<title>${escapeHtml(title)}</title>`,
      }
    : { attrs: ` aria-hidden="true"`, title: "" };
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

// ── The mark ────────────────────────────────────────────────────────────────────────────────

export interface MarkOptions {
  /** Pinned K (the platform) or the Star Cut (the Polaris Key Delivery service). Default "key". */
  kind?: MarkKind;
  /** Displayed size in CSS px; selects the optical cut. Default 24. */
  size?: number;
  /** Ground the mark sits on, or "mono" for one inherited ink (currentColor). Default "dark". */
  theme?: MarkTheme;
  /** Show the kit-gold terminal bit (key, display cut, >= 48 px only). */
  signed?: boolean;
  /**
   * Colour the terminal bit (implies showing it, under the same size rule): "gold", a section id
   * (the section bit; "core" is gold), "section" for the live tokens.css section, or a CSS colour.
   */
  bit?: BitColor;
  /** Accessible name. Omit (or "") when an adjacent visible label already names it. */
  title?: string;
}

export interface MarkPart {
  role: "body" | "star" | "gold";
  d: string;
  fill: string;
  /** Inline style (the live section bit uses `fill: var(--pk-section-bit)`). */
  style?: string;
  className?: string;
}

/** The resolved drawing of a mark: what both renderers emit. */
export function markParts(opts: MarkOptions = {}): {
  size: number;
  grid: number;
  cut: OpticalCut;
  parts: MarkPart[];
} {
  const { kind = "key", size = 24, theme = "dark", signed = false, bit } = opts;
  const cut = opticalCut(size);
  const grid = CUT_GRID[cut];
  const ink = theme === "mono" ? "currentColor" : BRAND.violet[theme];
  const star = theme === "mono" ? "currentColor" : BRAND.star[theme];
  const showBit = (signed || bit !== undefined) && bitVisible(kind, size);
  const parts: MarkPart[] = [];
  for (const [role, d] of GEOMETRY[kind][cut][1] as readonly (readonly [
    string,
    string,
  ])[]) {
    if (role === "gold") {
      if (!showBit) continue;
      const requested: BitColor = bit ?? "gold";
      if (requested === "section" && theme !== "mono") {
        const gold = BRAND.gold[theme];
        parts.push({
          role: "gold",
          d,
          fill: gold,
          style: `fill:var(--pk-section-bit, ${gold})`,
          className: "polaris-section-bit",
        });
      } else {
        parts.push({ role: "gold", d, fill: resolveBitFill(requested, theme) });
      }
      continue;
    }
    parts.push({
      role: role as "body" | "star",
      d,
      fill: role === "star" ? star : ink,
    });
  }
  return { size, grid, cut, parts };
}

/** A mark as an SVG string; the same markup `<PolarisMark>` renders. */
export function markSvg(opts: MarkOptions = {}): string {
  const { size, grid, parts } = markParts(opts);
  const head = a11y(opts.title);
  const paths = parts
    .map(
      (p) =>
        `<path d="${p.d}" fill="${escapeHtml(p.fill)}"${p.style ? ` style="${escapeHtml(p.style)}"` : ""}${p.className ? ` class="${p.className}"` : ""}></path>`,
    )
    .join("");
  return `<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="0 0 ${grid} ${grid}"${head.attrs}>${head.title}${paths}</svg>`;
}

export type KitVariant =
  | "dark"
  | "light"
  | "mono-black"
  | "mono-white"
  | "currentColor";

/**
 * One of the kit's own mark files (kit/01-marks/<kind>/svg/<kind>-<cut>[-signed]-<variant>.svg,
 * and the 16 px cuts in kit/06-games), byte for byte.
 */
export function kitMarkSvg(
  kind: MarkKind,
  cut: OpticalCut,
  variant: KitVariant,
  signed = false,
): string {
  const grid = CUT_GRID[cut];
  const p: KitPalette = KIT_PALETTES[variant];
  const alt = ALT[kind];
  const withBit = signed && kind === "key" && cut === "display";
  const paths = (
    GEOMETRY[kind][cut][1] as readonly (readonly [string, string])[]
  )
    .filter(([role]) => role !== "gold" || withBit)
    .map(([role, d]) => `<path fill="${p[role as KitRole]}" d="${d}"/>`)
    .join("");
  return `<svg xmlns="${SVG_NS}" width="${grid}" height="${grid}" viewBox="0 0 ${grid} ${grid}" role="img" aria-label="${alt}"><title>${alt}</title><desc>${cut} cut; ${variant}; gold terminal bit ${withBit ? "included" : "omitted"}.</desc><g transform="translate(0 0) scale(1.0)">${paths}</g></svg>`;
}

// ── Lockups ─────────────────────────────────────────────────────────────────────────────────

export type LockupLayout = "horizontal" | "stacked" | "compact";
export type LayoutTheme =
  | "dark"
  | "light"
  | "mono"
  | "mono-black"
  | "mono-white";

const paletteFor = (theme: LayoutTheme): KitPalette =>
  KIT_PALETTES[theme === "mono" ? "currentColor" : theme];

const groundOf = (theme: LayoutTheme): MarkTheme =>
  theme === "dark" || theme === "light" ? theme : "mono";

function fill(template: KitTemplate, palette: KitPalette): string {
  return template.body.replace(/\{(\w+)\}/g, (_, r: KitRole) => palette[r]);
}

/** A kit layout file, byte for byte (the kit's own <title> and <desc> included). */
function kitLayout(t: KitTemplate, palette: KitPalette): string {
  return `<svg xmlns="${SVG_NS}" width="${t.width}" height="${t.height}" viewBox="0 0 ${t.width} ${t.height}" role="img" aria-label="${t.title}"><title>${t.title}</title><desc>${t.desc}</desc>${fill(t, palette)}</svg>`;
}

export interface LockupOptions {
  /**
   * "key" (Polaris Key), "delivery" (Polaris Key Delivery, the Star Cut lockup for our surfaces)
   * or "update" (the kit's original "Polaris Key Update" lockup). Default "key".
   */
  kind?: LockupKind;
  layout?: LockupLayout;
  /** dark / light grounds, "mono" for currentColor, or the kit's mono-black / mono-white ink. */
  theme?: LayoutTheme;
  /** Rendered height in CSS px. Default: the kit's natural size. Width follows the aspect ratio. */
  height?: number;
  /**
   * Show the terminal bit. The kit's horizontal and stacked K lockups carry it, so this defaults
   * to true; it still disappears whenever the glyph renders below 48 px.
   */
  signed?: boolean;
  /** Colour the bit (see MarkOptions.bit). */
  bit?: BitColor;
  /** Accessible name; defaults to the lockup's alt text. "" marks it decorative. */
  title?: string;
}

/** The lockup's geometry at a given height: size, the glyph's rendered edge and whether the bit shows. */
export function lockupMetrics(opts: LockupOptions = {}) {
  const { kind = "key", layout = "horizontal" } = opts;
  const t = LOCKUP_TEMPLATES[kind][layout];
  const height = opts.height ?? t.height;
  const width = (t.width * height) / t.height;
  const glyph = LOCKUP_GLYPHS[kind][layout];
  const glyphPx = (glyph.size * height) / t.height;
  const bit =
    kind === "key" &&
    glyph.cut === "display" &&
    glyphPx >= OPTICAL.goldMinimumGlyphSize &&
    ((opts.signed ?? true) || opts.bit !== undefined);
  return { template: t, width, height, glyphPx, cut: glyph.cut, bit };
}

/** The inner markup a lockup renders (shared by `lockupSvg` and `<PolarisLockup>`). */
export function lockupInner(opts: LockupOptions = {}): string {
  const theme = opts.theme ?? "dark";
  const m = lockupMetrics(opts);
  const palette = paletteFor(theme);
  let body: string = m.template.body;
  const goldPath = /<path fill="\{gold\}" (d="[^"]+")\/>/;
  if (!m.bit) body = body.replace(goldPath, "");
  else if (opts.bit !== undefined) {
    const ground = groundOf(theme);
    if (opts.bit === "section" && ground !== "mono") {
      const gold = BRAND.gold[ground];
      body = body.replace(
        goldPath,
        `<path fill="${gold}" style="fill:var(--pk-section-bit, ${gold})" class="polaris-section-bit" $1/>`,
      );
    } else {
      const ink =
        ground === "mono" ? palette.gold : resolveBitFill(opts.bit, ground);
      body = body.replace(goldPath, `<path fill="${escapeHtml(ink)}" $1/>`);
    }
  }
  const title = opts.title ?? m.template.title;
  return `${title ? `<title>${escapeHtml(title)}</title>` : ""}${body.replace(/\{(\w+)\}/g, (_, r: KitRole) => palette[r])}`;
}

/** A lockup as an SVG string; the same markup `<PolarisLockup>` renders. */
export function lockupSvg(opts: LockupOptions = {}): string {
  const m = lockupMetrics(opts);
  const title = opts.title ?? m.template.title;
  const head = a11y(title);
  return `<svg xmlns="${SVG_NS}" width="${fmt(m.width)}" height="${fmt(m.height)}" viewBox="0 0 ${m.template.width} ${m.template.height}"${head.attrs}>${lockupInner(opts)}</svg>`;
}

/** One of the kit's lockup files (kit/02-lockups), byte for byte. */
export function kitLockupSvg(
  kind: MarkKind,
  layout: LockupLayout,
  variant: KitVariant,
): string {
  return kitLayout(LOCKUP_TEMPLATES[kind][layout], KIT_PALETTES[variant]);
}

/**
 * One of the generated "Polaris Key Delivery" lockup files (lockups/delivery), byte for byte:
 * the kit's colour variants applied to the Delivery template.
 */
export function deliveryLockupSvg(
  layout: LockupLayout,
  variant: KitVariant,
): string {
  return kitLayout(LOCKUP_TEMPLATES.delivery[layout], KIT_PALETTES[variant]);
}

// ── "Powered by Polaris Key" ────────────────────────────────────────────────────────────────

export type BadgeTreatment = "transparent" | "sticker" | "outline";
export type BadgeTheme = "dark" | "light" | "mono-black" | "mono-white";

export interface BadgeOptions {
  layout?: BadgeLayout;
  /** transparent (on a clean matching ground), sticker (carries its own plate), outline. */
  treatment?: BadgeTreatment;
  /** Which ground it is FOR (dark / light), or single-ink mono-black / mono-white. */
  theme?: BadgeTheme;
  /** Rendered width in CSS px; clamped up to the layout's minimum. */
  width?: number;
  /** Accessible name; defaults to "Powered by Polaris Key". "" marks it decorative. */
  title?: string;
}

export function poweredByInner(opts: BadgeOptions = {}): string {
  const {
    layout = "compact",
    treatment = "transparent",
    theme = "dark",
  } = opts;
  const t = BADGE_TEMPLATES[treatment][layout];
  const title = opts.title ?? ALT.poweredBy;
  return `${title ? `<title>${escapeHtml(title)}</title>` : ""}${fill(t, KIT_PALETTES[theme])}`;
}

/** A badge as an SVG string; the same markup `<PoweredByBadge>` renders. */
export function poweredBySvg(opts: BadgeOptions = {}): string {
  const { layout = "compact", treatment = "transparent" } = opts;
  const t = BADGE_TEMPLATES[treatment][layout];
  const size = badgeSize(layout, opts.width);
  const head = a11y(opts.title ?? ALT.poweredBy);
  return `<svg xmlns="${SVG_NS}" width="${fmt(size.width)}" height="${fmt(size.height)}" viewBox="0 0 ${t.width} ${t.height}"${head.attrs}>${poweredByInner(opts)}</svg>`;
}

/** One of the kit's badge files (kit/03-powered-by), byte for byte. */
export function kitPoweredBySvg(
  treatment: BadgeTreatment,
  layout: BadgeLayout,
  variant: BadgeTheme,
): string {
  return kitLayout(BADGE_TEMPLATES[treatment][layout], KIT_PALETTES[variant]);
}
