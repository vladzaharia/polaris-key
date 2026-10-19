// Polaris Locker artwork rules (docs/design/BRAND.md §15): two optical cuts, no bit, and the
// kit's lockups and badges as colour templates. The geometry and templates are generated from
// locker-kit/ (scripts/locker.ts); this module only picks among them. `markSvg`, `lockupSvg` and
// `<PolarisMark>` / `<PolarisLockup>` delegate here for `kind: "locker"`; `badgeSvg` is Locker's
// alone.

import {
  LOCKER_BADGE_PALETTES,
  LOCKER_BADGE_TEMPLATES,
  LOCKER_GEOMETRY,
  LOCKER_LOCKUP_PALETTES,
  LOCKER_LOCKUP_TEMPLATES,
  LOCKER_MARK_PALETTES,
} from "../generated/locker.js";
import {
  LOCKER_BADGE_ALT,
  LOCKER_CUT_GRID,
  type LockerCut,
} from "../tokens/primitives.js";
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

export type LockerBadgeKind = keyof typeof LOCKER_BADGE_ALT;
export type LockerBadgeTreatment = "transparent" | "sticker" | "outline";
export type LockerBadgeTheme = "dark" | "light" | "white";

export interface LockerBadgeOptions {
  /** "locker-open-in" needs a real destination; "locker-available-on" needs real availability. */
  kind: LockerBadgeKind;
  treatment?: LockerBadgeTreatment;
  /** Which ground it is FOR. */
  theme?: LockerBadgeTheme;
  /** Rendered width in CSS px. Default: the canvas, 320. The 320 × 104 aspect is never changed. */
  width?: number;
  /** Accessible name; defaults to the action ("Open in Polaris Locker"). "" marks it decorative. */
  title?: string;
}

/** The badge canvas, 320 × 104 (never cropped). */
export const LOCKER_BADGE_CANVAS = { width: 320, height: 104 } as const;

export function lockerBadgeTemplate(
  kind: LockerBadgeKind,
  treatment: LockerBadgeTreatment = "transparent",
): LockerTemplate {
  const t =
    LOCKER_BADGE_TEMPLATES[
      kind === "locker-open-in" ? "open-in" : "available-on"
    ][treatment];
  return t;
}

export function lockerBadgeBody(
  kind: LockerBadgeKind,
  treatment: LockerBadgeTreatment = "transparent",
  theme: LockerBadgeTheme = "dark",
): string {
  return fillRoles(
    lockerBadgeTemplate(kind, treatment).body,
    LOCKER_BADGE_PALETTES[treatment][theme],
  );
}

/** The kit's own badge file, byte for byte (badges/locker-<kind>-<theme>-<treatment>.svg). */
export function lockerKitBadgeSvg(
  kind: LockerBadgeKind,
  treatment: LockerBadgeTreatment,
  theme: LockerBadgeTheme,
): string {
  const t = lockerBadgeTemplate(kind, treatment);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}" viewBox="0 0 ${t.width} ${t.height}" role="img" aria-label="${t.title}">${lockerBadgeBody(kind, treatment, theme)}</svg>`;
}
