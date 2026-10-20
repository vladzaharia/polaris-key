// Polaris Locker artwork rules (docs/design/BRAND.md §15): two optical cuts, no bit, and the
// kit's lockups and badges as colour templates. The geometry and templates are generated from
// locker-kit/ (scripts/locker.ts); this module only picks among them. `markSvg`, `lockupSvg` and
// `<PolarisMark>` / `<PolarisLockup>` delegate here for `kind: "locker"`; `badgeSvg` is Locker's
// alone.

import {
  LOCKER_BADGE_LABELS,
  LOCKER_BADGE_PALETTES,
  LOCKER_BADGE_PREFIXES,
  LOCKER_BADGE_TEMPLATES,
  LOCKER_GEOMETRY,
  LOCKER_LOCKUP_PALETTES,
  LOCKER_LOCKUP_TEMPLATES,
  LOCKER_MARK_PALETTES,
} from "../generated/locker.js";
import { LOCKER_CUT_GRID, type LockerCut } from "../tokens/primitives.js";
import { isNoBit, opticalCut, type BitColor, type MarkTheme } from "./core.js";
import type { LockerTemplate } from "./types.js";

/** Which Locker cut a mark DISPLAYED at `size` CSS px uses: micro below 24, master from 24 up. */
export const lockerCut = (size: number): LockerCut =>
  opticalCut(size, "locker");

/** Locker has no terminal bit (it has no gold): any request for one throws. */
export function refuseBit(
  what: string,
  opts: { signed?: boolean; bit?: BitColor },
): void {
  if (opts.signed === true || (opts.bit !== undefined && !isNoBit(opts.bit)))
    throw new RangeError(`${what}: the Locker mark has no bit`);
}

export interface LockerPart {
  role: "body" | "star";
  d: string;
  fill: string;
}

/** The drawing of a Locker mark at `size`: grid, cut and the two filled paths. */
export function lockerMarkParts(opts: {
  size?: number;
  theme?: MarkTheme;
  signed?: boolean;
  bit?: BitColor;
}): { size: number; grid: number; cut: LockerCut; parts: LockerPart[] } {
  refuseBit("mark", opts);
  const { size = 24, theme = "dark" } = opts;
  const cut = lockerCut(size);
  const ink = LOCKER_MARK_PALETTES[cut][theme === "mono" ? "dark" : theme];
  return {
    size,
    grid: LOCKER_CUT_GRID[cut],
    cut,
    parts: LOCKER_GEOMETRY[cut][1].map(([role, d]) => ({
      role,
      d,
      fill: theme === "mono" ? "currentColor" : ink[role],
    })),
  };
}

/** The kit's own mark file for a cut and variant, byte for byte (logos/svg/locker-mark-*). */
export function lockerKitMarkSvg(
  cut: LockerCut,
  variant: "dark" | "light" | "white" | "black" | "coral" | "currentColor",
): string {
  if (variant === "currentColor" && cut === "micro")
    throw new RangeError("the kit has no currentColor micro mark");
  const ink =
    variant === "currentColor"
      ? { body: "currentColor", star: "currentColor" }
      : LOCKER_MARK_PALETTES[cut][variant];
  const [body, star] = LOCKER_GEOMETRY[cut][1];
  const paths = `<path fill="${ink.body}" d="${body[1]}"/><path fill="${ink.star}" d="${star[1]}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Polaris Locker">${cut === "micro" ? `<g transform="scale(8)">${paths}</g>` : paths}</svg>`;
}

export type LockerLockupTheme =
  | "dark"
  | "light"
  | "mono"
  | "mono-black"
  | "mono-white"
  | "coral";

export type LockerLayout = keyof typeof LOCKER_LOCKUP_TEMPLATES;

const MONO = {
  body: "currentColor",
  star: "currentColor",
  text: "currentColor",
} as const;

function lockupPalette(theme: LockerLockupTheme): Record<string, string> {
  if (theme === "mono") return MONO;
  const key =
    theme === "mono-black" ? "black" : theme === "mono-white" ? "white" : theme;
  return LOCKER_LOCKUP_PALETTES[key];
}

export function lockerLockupTemplate(layout: LockerLayout): LockerTemplate {
  return LOCKER_LOCKUP_TEMPLATES[layout];
}

const fillRoles = (body: string, palette: Record<string, string>) =>
  body.replace(/\{(\w+)\}/g, (_, r: string) => {
    const v = palette[r];
    if (v === undefined) throw new Error(`locker: no colour for ${r}`);
    return v;
  });

/** The inner markup of a Locker lockup in `theme`. */
export function lockerLockupBody(
  layout: LockerLayout,
  theme: LockerLockupTheme,
): string {
  return fillRoles(LOCKER_LOCKUP_TEMPLATES[layout].body, lockupPalette(theme));
}

/** The kit's own lockup file, byte for byte (logos/svg/locker-<layout>-<variant>.svg). */
export function lockerKitLockupSvg(
  layout: LockerLayout,
  variant: "dark" | "light" | "white" | "black" | "coral",
): string {
  const t = LOCKER_LOCKUP_TEMPLATES[layout];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}" viewBox="0 0 ${t.width} ${t.height}" role="img" aria-label="${t.title}">${fillRoles(t.body, LOCKER_LOCKUP_PALETTES[variant])}</svg>`;
}

// ── Badges ──────────────────────────────────────────────────────────────────────────────────

/** A badge label slug from the kit's badges/index.json ("open-in", "sync-with", ...). */
export type LockerBadgeSlug = keyof typeof LOCKER_BADGE_LABELS;
/** `locker-<slug>`: all 16 labels. "Open in" needs a real destination, "Purchase with" a real flow. */
export type LockerBadgeKind = `locker-${LockerBadgeSlug}`;
export type LockerBadgeTreatment = "transparent" | "sticker" | "outline";
export type LockerBadgeTheme = "dark" | "light" | "white";

export interface LockerBadgeOptions {
  kind: LockerBadgeKind;
  treatment?: LockerBadgeTreatment;
  /** Which ground it is FOR. */
  theme?: LockerBadgeTheme;
  /** Rendered width in CSS px. Default 320; a smaller request is raised to the 320 minimum. */
  width?: number;
  /** Accessible name; defaults to "<label> Polaris Locker". "" marks it decorative. */
  title?: string;
}

/** The badge canvas, 320 × 104 (never cropped). */
export const LOCKER_BADGE_CANVAS = { width: 320, height: 104 } as const;

/** The smallest displayed width (kit v1.3): the full canvas at 320 CSS px or more. */
export const LOCKER_BADGE_MIN_WIDTH = 320;

export const LOCKER_BADGE_KINDS = (
  Object.keys(LOCKER_BADGE_LABELS) as LockerBadgeSlug[]
).map((slug) => `locker-${slug}` as LockerBadgeKind);

const slugOf = (kind: LockerBadgeKind): LockerBadgeSlug => {
  const slug = kind.slice("locker-".length) as LockerBadgeSlug;
  if (!kind.startsWith("locker-") || !(slug in LOCKER_BADGE_LABELS))
    throw new RangeError(`badge: unknown kind ${String(kind)}`);
  return slug;
};

/** The accessible name of a label's badge: "<label> Polaris Locker". */
export function lockerBadgeAlt(kind: LockerBadgeKind): string {
  return `${LOCKER_BADGE_LABELS[slugOf(kind)]} Polaris Locker`;
}

export function lockerBadgeTemplate(
  treatment: LockerBadgeTreatment = "transparent",
): LockerTemplate {
  return LOCKER_BADGE_TEMPLATES[treatment];
}

export function lockerBadgeBody(
  kind: LockerBadgeKind,
  treatment: LockerBadgeTreatment = "transparent",
  theme: LockerBadgeTheme = "dark",
): string {
  const prefix = LOCKER_BADGE_PREFIXES[slugOf(kind)];
  return fillRoles(
    lockerBadgeTemplate(treatment).body.replace("{prefix}", prefix),
    LOCKER_BADGE_PALETTES[treatment][theme],
  );
}

/** The kit's own badge file, byte for byte (badges/locker-<slug>-<theme>-<treatment>.svg). */
export function lockerKitBadgeSvg(
  kind: LockerBadgeKind,
  treatment: LockerBadgeTreatment,
  theme: LockerBadgeTheme,
): string {
  const t = lockerBadgeTemplate(treatment);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}" viewBox="0 0 ${t.width} ${t.height}" role="img" aria-label="${lockerBadgeAlt(kind)}">${lockerBadgeBody(kind, treatment, theme)}</svg>`;
}
