// What colorScheme "system" resolves to: the scheme of the page the provider sits on, not only
// the OS's. A kit drawn dark on a white host page (the OS dark, the page not) is a dark slab in
// a light app, and a control whose ground is the host's (a sign-out button) can vanish. So:
//
//   1. The first ancestor of the provider with a background decides, by its luminance (the same
//      0.179 midpoint `groundOf` uses for the marks: light when dark ink reads better on it).
//   2. With every ancestor transparent, the page canvas decides: dark only when the page opts in
//      to dark (`color-scheme` on the root, or a <meta name="color-scheme">, includes "dark")
//      AND the OS prefers dark. Otherwise the canvas is the browser's white, so light.

import { relativeLuminance } from "@polaris-key/brand/color";

export type Scheme = "dark" | "light";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A computed `rgb()` / `rgba()` colour; `null` for anything else (a computed colour in another
 *  space is rare and is skipped rather than guessed). */
export function parseComputedColor(css: string): Rgba | null {
  const m =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(
      css.trim(),
    );
  if (!m) return null;
  let a = 1;
  if (m[4] !== undefined)
    a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
}

function hex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

/** Light or dark for an opaque colour, at `groundOf`'s midpoint. */
export function schemeOfColor(c: Rgba): Scheme {
  return relativeLuminance(`#${hex(c.r)}${hex(c.g)}${hex(c.b)}`) > 0.179
    ? "light"
    : "dark";
}

/** The scheme of the first ancestor of `el` that paints a background, or `null`. */
export function backgroundScheme(el: Element | null): Scheme | null {
  if (typeof getComputedStyle !== "function") return null;
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const color = parseComputedColor(getComputedStyle(node).backgroundColor);
    if (color && color.a > 0) return schemeOfColor(color);
  }
  return null;
}

/** Whether the page opts in to a dark canvas. */
function pageAllowsDark(): boolean {
  if (typeof document === "undefined") return false;
  const root = getComputedStyle(document.documentElement).colorScheme ?? "";
  const meta =
    document
      .querySelector('meta[name="color-scheme"]')
      ?.getAttribute("content") ?? "";
  return /\bdark\b/.test(`${root} ${meta}`);
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_QUERY).matches
  );
}

/** "system", resolved for a provider mounted at `el`. */
export function resolveSystemScheme(el: Element | null): Scheme {
  const ground = backgroundScheme(el);
  if (ground) return ground;
  return pageAllowsDark() && prefersDark() ? "dark" : "light";
}
