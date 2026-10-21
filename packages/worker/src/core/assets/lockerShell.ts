/**
 * The Polaris Locker shell of the Delivery surfaces (LK-07; plans/LK-00.md §14.2): the download
 * page on `dl.plrs.im`, and the bytes and registry hosts' landing pages take the Locker title,
 * lockup and favicon, and keep the Star Cut inside as Delivery's service symbol (the kit:
 * services keep their symbols under a Locker header).
 *
 * Static artwork only: inline SVG coloured by the page's own stylesheet, and a `data:` favicon, so
 * the inert-document policy of the bytes host (`inertDocumentPolicy`) needs nothing new. The
 * pages' stylesheets carry `LOCKER_SHELL_CSS` as a constant tail.
 */

import { SERVICE_ACCENTS, THEME_TOKENS } from "@polaris-key/brand";
import {
  LOCKER_LOCKUP_PALETTES,
  lockupMetrics,
  markParts,
} from "@polaris-key/brand/svg";
import { escapeHtml } from "../../platform/html.js";

/** The Locker lockup's colour roles, as classes `LOCKER_SHELL_CSS` fills per theme. */
const LOCKUP_CLASS = { body: "lb", star: "ls", text: "lt" } as const;

/** The Locker horizontal lockup as inline SVG at `height` px, themed by the page's stylesheet. */
export function lockerLockup(
  height: number,
  className: string,
  trim = false,
): string {
  const m = lockupMetrics({
    kind: "locker",
    layout: "horizontal",
    height,
    trim,
  });
  const body = m.template.body.replace(
    /fill="\{(\w+)\}"/g,
    (_, role: string) => {
      const cls = LOCKUP_CLASS[role as keyof typeof LOCKUP_CLASS];
      if (!cls) throw new Error(`locker shell: unexpected lockup role ${role}`);
      return `class="${cls}"`;
    },
  );
  if (body.includes("{"))
    throw new Error("locker shell: unresolved placeholder");
  const w = Math.round(m.width * 100) / 100;
  const title = escapeHtml(m.template.title);
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="${m.view.x} ${m.view.y} ${m.view.width} ${m.view.height}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>`;
}

/**
 * The Star Cut at `size` px: Delivery's service symbol, decorative (the word beside it names
 * it). Coloured by `.sb` / `.ss` in `LOCKER_SHELL_CSS`: Distribution's green and the strong ink.
 */
export function deliverySymbol(size: number, className: string): string {
  const { parts, grid } = markParts({ kind: "update", size, theme: "dark" });
  const paths = parts
    .map((p) => `<path class="${p.role === "star" ? "ss" : "sb"}" d="${p.d}"/>`)
    .join("");
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${grid} ${grid}" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/**
 * The Locker favicon (the kit's `web/favicon.svg`; owner, 2026-10-20): the micro mark in the light
 * coral on a white rounded tile, as the Polaris Key icon reads on a dark tab bar. Fills are
 * attributes, not a `<style>`, so a strict page CSP can't unstyle it. Drawn at 16 px, unscaled.
 */
export function lockerFaviconSvg(): string {
  const light = markParts({ kind: "locker", size: 16, theme: "light" });
  const ink =
    light.parts.find((p) => p.role === "body")?.fill ?? "currentColor";
  const paths = light.parts.map((p) => `<path d="${p.d}"/>`).join("");
  const c = light.grid / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 ${light.grid} ${light.grid}">` +
    `<rect width="${light.grid}" height="${light.grid}" rx="${(light.grid * 3.5) / 16}" fill="#fff"/>` +
    `<g fill="${ink}" transform="translate(${c} ${c}) scale(0.8) translate(-${c} -${c})">${paths}</g></svg>`
  );
}

/**
 * The Polaris Key favicon (the kit's `04-web/key/favicon.svg`): the favicon cut in the Key violet on
 * the same white rounded tile as the Locker one. For the developer-facing registry landing.
 */
export function keyFaviconSvg(): string {
  const light = markParts({ kind: "key", size: 16, theme: "light" });
  const ink =
    light.parts.find((p) => p.role === "body")?.fill ?? "currentColor";
  const paths = light.parts.map((p) => `<path d="${p.d}"/>`).join("");
  const c = light.grid / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 ${light.grid} ${light.grid}">` +
    `<rect width="${light.grid}" height="${light.grid}" rx="${(light.grid * 3.5) / 16}" fill="#fff"/>` +
    `<g fill="${ink}" transform="translate(${c} ${c}) scale(0.8) translate(-${c} -${c})">${paths}</g></svg>`
  );
}

/** `<link rel="icon">` href for the Key favicon: a `data:` URI, as the Locker one. */
export function keyFaviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(keyFaviconSvg())}`;
}

/** `<link rel="icon">` href for the Locker favicon: a `data:` URI, so no icon route is needed. */
export function lockerFaviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(lockerFaviconSvg())}`;
}

function lockupInks(theme: "dark" | "light"): string {
  const ink = LOCKER_LOCKUP_PALETTES[theme];
  return [`--lb:${ink.body}`, `--ls:${ink.star}`, `--lt:${ink.text}`].join(";");
}

function inks(theme: "dark" | "light"): string {
  const accent = SERVICE_ACCENTS[theme].distribution;
  return [
    lockupInks(theme),
    `--sb:${accent.fg}`,
    `--ss:${THEME_TOKENS[theme].text.strong}`,
  ].join(";");
}

/**
 * The lockup's inks alone, for a customer page that draws no Delivery service symbol (the
 * download page): no Distribution green is carried into its stylesheet.
 */
export const LOCKER_LOCKUP_CSS = [
  `:root{${lockupInks("dark")}}`,
  `@media (prefers-color-scheme: light){:root{${lockupInks("light")}}}`,
  `.lb{fill:var(--lb)}.ls{fill:var(--ls)}.lt{fill:var(--lt)}`,
].join("");

/**
 * What a Locker shell adds to a Delivery page's stylesheet (a build constant, so its hash is
 * too): the lockup's inks, the Star Cut's, and the service row under the lockup.
 */
export const LOCKER_SHELL_CSS = [
  `:root{${inks("dark")}}`,
  `@media (prefers-color-scheme: light){:root{${inks("light")}}}`,
  `.lb{fill:var(--lb)}.ls{fill:var(--ls)}.lt{fill:var(--lt)}.sb{fill:var(--sb)}.ss{fill:var(--ss)}`,
  `.svc{display:flex;align-items:center;gap:.5rem;margin:0;color:var(--strong);font-size:1rem;line-height:1.5rem;font-weight:600}`,
  `.svc svg{display:block;flex:none}`,
].join("");

/** The row under the Locker lockup: the Star Cut and the service's name. */
export function serviceRow(): string {
  return `<div class="svc">${deliverySymbol(24, "svc-mark")}<span>Delivery</span></div>`;
}
