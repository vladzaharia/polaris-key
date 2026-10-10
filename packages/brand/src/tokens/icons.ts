// The service icon set (docs/design/BRAND.md §1.1 and §7.8): which glyph names each service in
// navigation, diagrams and marketing menus. A service icon explains a capability; it is never a
// mark, never a recoloured mark, and always sits beside the service's name.
//
// The glyph is lucide's (src/tokens/lucide.ts), drawn on a 24 x 24 grid with a round-capped,
// round-joined stroke in currentColor. The stroke follows the rendered size: 2 up to 20 px,
// 1.6 above (test/icons.test.ts pins the table to tools/services.json `console.icon`).

import type { ServiceId } from "./source.js";

/** Ten icons: core, the seven services in tools/services.json, plus commerce and packs. */
export const SERVICE_ICON_IDS = [
  "core",
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
  "commerce",
  "packs",
] as const;

export type ServiceIconId = (typeof SERVICE_ICON_IDS)[number];

/**
 * One row per icon.
 *
 *   glyph        the lucide icon's PascalCase name, which for the seven services is
 *                tools/services.json `console.icon` (Distribution is Waypoints: a service icon is
 *                never the Star Cut, which stays the Polaris Key Delivery mark).
 *   label        the name that sits beside the icon.
 *   accent       the section whose accent colours the icon, or null: Commerce is drawn in the
 *                Distribution green family (no ninth family; its mark is the Pinned K, and it
 *                requires License); Packs has no section accent.
 *   dataService  whether a console surface may set `data-service` to this id. Update and Packs
 *                are marketing and docs identities only: the console's Ship builds group is one
 *                Release identity (Package glyph, Release chrome), and Cloud Sync is one nav row.
 */
export interface ServiceIconSpec {
  glyph: string;
  label: string;
  accent: ServiceId | null;
  dataService: boolean;
}

export const SERVICE_ICONS: Record<ServiceIconId, ServiceIconSpec> = {
  core: { glyph: "Box", label: "Core", accent: "core", dataService: true },
  license: {
    glyph: "KeyRound",
    label: "License",
    accent: "license",
    dataService: true,
  },
  config: {
    glyph: "SlidersHorizontal",
    label: "Config",
    accent: "config",
    dataService: true,
  },
  release: {
    glyph: "Package",
    label: "Release",
    accent: "release",
    dataService: true,
  },
  distribution: {
    glyph: "Waypoints",
    label: "Distribution",
    accent: "distribution",
    dataService: true,
  },
  update: {
    glyph: "CircleArrowUp",
    label: "Update",
    accent: "update",
    dataService: false,
  },
  identity: {
    glyph: "UserRound",
    label: "Identity",
    accent: "identity",
    dataService: true,
  },
  sync: {
    glyph: "Cloud",
    label: "Cloud Sync",
    accent: "sync",
    dataService: true,
  },
  commerce: {
    glyph: "ShoppingBag",
    label: "Commerce",
    accent: "distribution",
    dataService: true,
  },
  packs: { glyph: "Boxes", label: "Packs", accent: null, dataService: false },
};

/** The glyph grid; every icon's viewBox. */
export const SERVICE_ICON_GRID = 24;

/** Stroke width in grid units by displayed size: 2 at 20 px and below, 1.6 above. */
export const SERVICE_ICON_STROKE = { compact: 2, regular: 1.6 } as const;
export const SERVICE_ICON_COMPACT_MAX = 20;

export function serviceIconStroke(size: number): 2 | 1.6 {
  return size <= SERVICE_ICON_COMPACT_MAX
    ? SERVICE_ICON_STROKE.compact
    : SERVICE_ICON_STROKE.regular;
}

/**
 * The icon tile (BRAND.md §7.8): a raised square holding the glyph at half its size. The 1 px
 * border is the accent `solid` on dark and `fg` on light; the glyph is the accent `fg`. Never a
 * solid accent plate, never a glow.
 */
export const SERVICE_ICON_TILE = {
  sizes: [64, 48, 28, 20],
  radius: { 64: 14, 48: 12, 28: 8, 20: 6 },
  glyphRatio: 0.5,
  border: 1,
} as const;

export type ServiceIconTileSize = (typeof SERVICE_ICON_TILE.sizes)[number];
