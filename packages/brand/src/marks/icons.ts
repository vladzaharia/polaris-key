// Framework-free renderers for the service icon set (BRAND.md §1.1, §7.8). `serviceIconSvg`
// and `serviceIconTileSvg` return the markup `<ServiceIcon>` renders; `serviceIconSprite` is the
// icons/services/sprite.svg file. No `style` attribute is ever emitted, so the markup is safe
// under a CSP without 'unsafe-inline' styles, innerHTML included.

import { THEME_TOKENS } from "../generated/tokens.js";
import {
  SERVICE_ICON_GRID,
  SERVICE_ICON_IDS,
  SERVICE_ICON_STROKE,
  SERVICE_ICON_TILE,
  SERVICE_ICONS,
  serviceIconStroke,
  type ServiceIconId,
  type ServiceIconTileSize,
} from "../tokens/icons.js";
import { LUCIDE_NODES, type LucideNode } from "../tokens/lucide.js";
import { SERVICE_ACCENTS } from "../generated/tokens.js";
import type { Theme } from "../tokens/source.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const num = (n: number) => String(Math.round(n * 100) / 100);

function nodes(id: ServiceIconId): readonly LucideNode[] {
  const n = LUCIDE_NODES[SERVICE_ICONS[id].glyph];
  if (!n) throw new Error(`service icon "${id}": no glyph data`);
  return n;
}

/** The glyph's elements, in lucide's drawing order. */
export function serviceIconBody(id: ServiceIconId): string {
  return nodes(id)
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${esc(v)}"`)
          .join(" ")}/>`,
    )
    .join("");
}

const strokeAttrs = (ink: string, width: number) =>
  `fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

export interface ServiceIconOptions {
  /** Displayed size in CSS px; selects the stroke (2 up to 20 px, 1.6 above). Default 24. */
  size?: number;
  /** Accessible name. Omit (or "") when the service's name sits beside the icon (the rule). */
  title?: string;
}

/** The accessible head of an icon: role + label + <title>, or aria-hidden when decorative. */
function head(title: string | undefined) {
  return title
    ? {
        attrs: ` role="img" aria-label="${esc(title)}"`,
        title: `<title>${esc(title)}</title>`,
      }
    : { attrs: ` aria-hidden="true"`, title: "" };
}

/** The inner markup of `serviceIconSvg` (shared with `<ServiceIcon>`). */
export function serviceIconInner(
  id: ServiceIconId,
  opts: ServiceIconOptions = {},
): string {
  return `${head(opts.title).title}${serviceIconBody(id)}`;
}

/** The icon's stroke width at a displayed size (see SERVICE_ICON_STROKE). */
export function serviceIconStrokeFor(opts: ServiceIconOptions = {}): number {
  return serviceIconStroke(opts.size ?? 24);
}

/** A service icon as an SVG string, in currentColor; the same markup `<ServiceIcon>` renders. */
export function serviceIconSvg(
  id: ServiceIconId,
  opts: ServiceIconOptions = {},
): string {
  const size = opts.size ?? 24;
  const h = head(opts.title);
  return `<svg xmlns="${SVG_NS}" width="${num(size)}" height="${num(size)}" viewBox="0 0 ${SERVICE_ICON_GRID} ${SERVICE_ICON_GRID}" ${strokeAttrs("currentColor", serviceIconStroke(size))}${h.attrs}>${serviceIconInner(id, opts)}</svg>`;
}

export interface ServiceIconTileOptions {
  /** 64, 48, 28 or 20 px. Default 48. */
  size?: ServiceIconTileSize;
  /** The ground the tile sits on. Default "dark". */
  theme?: Theme;
  title?: string;
}

/** The tile's resolved colours: fill, border and glyph ink. Packs (no accent) is neutral. */
export function serviceIconTileColors(id: ServiceIconId, theme: Theme) {
  const t = THEME_TOKENS[theme];
  const section = SERVICE_ICONS[id].accent;
  if (section === null)
    return {
      fill: t.surface.raised,
      border: t.border.strong,
      ink: t.text.strong,
    };
  const a = SERVICE_ACCENTS[theme][section];
  return {
    fill: t.surface.raised,
    border: theme === "dark" ? a.solid : a.fg,
    ink: a.fg,
  };
}

/** The inner markup of `serviceIconTileSvg` (shared with `<ServiceIcon tile>`). */
export function serviceIconTileInner(
  id: ServiceIconId,
  opts: ServiceIconTileOptions = {},
): string {
  const { size = 48, theme = "dark" } = opts;
  const c = serviceIconTileColors(id, theme);
  const radius = SERVICE_ICON_TILE.radius[size];
  const b = SERVICE_ICON_TILE.border;
  const glyph = size * SERVICE_ICON_TILE.glyphRatio;
  const offset = (size - glyph) / 2;
  return `${head(opts.title).title}<rect x="${b / 2}" y="${b / 2}" width="${size - b}" height="${size - b}" rx="${radius - b / 2}" fill="${c.fill}" stroke="${c.border}" stroke-width="${b}"/><svg x="${num(offset)}" y="${num(offset)}" width="${num(glyph)}" height="${num(glyph)}" viewBox="0 0 ${SERVICE_ICON_GRID} ${SERVICE_ICON_GRID}" ${strokeAttrs(c.ink, serviceIconStroke(glyph))}>${serviceIconBody(id)}</svg>`;
}

/** A service icon tile as an SVG string (BRAND.md §7.8). */
export function serviceIconTileSvg(
  id: ServiceIconId,
  opts: ServiceIconTileOptions = {},
): string {
  const size = opts.size ?? 48;
  return `<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"${head(opts.title).attrs}>${serviceIconTileInner(id, opts)}</svg>`;
}

/** The id of an icon's symbol in sprite.svg. */
export const serviceIconSymbolId = (id: ServiceIconId, compact = false) =>
  `pk-service-${id}${compact ? "-compact" : ""}`;

/**
 * icons/services/sprite.svg: one `<symbol>` per icon in each stroke (`pk-service-<id>` at 1.6,
 * `pk-service-<id>-compact` at 2). Use `<use href="sprite.svg#pk-service-license">` inside an
 * `<svg>` that sets `stroke="currentColor"`-compatible colour through `color`.
 */
export function serviceIconSprite(): string {
  const symbols = SERVICE_ICON_IDS.flatMap((id) =>
    [false, true].map(
      (compact) =>
        `<symbol id="${serviceIconSymbolId(id, compact)}" viewBox="0 0 ${SERVICE_ICON_GRID} ${SERVICE_ICON_GRID}"><title>${esc(SERVICE_ICONS[id].label)}</title><g ${strokeAttrs("currentColor", compact ? SERVICE_ICON_STROKE.compact : SERVICE_ICON_STROKE.regular)}>${serviceIconBody(id)}</g></symbol>`,
    ),
  ).join("");
  return `<svg xmlns="${SVG_NS}" width="0" height="0" aria-hidden="true">${symbols}</svg>`;
}

/** A single icon file (icons/services/<id>.svg at 1.6, <id>-compact.svg at 2), with its title. */
export function serviceIconFile(id: ServiceIconId, compact = false): string {
  return serviceIconSvg(id, {
    size: compact ? 16 : 24,
    title: SERVICE_ICONS[id].label,
  });
}
