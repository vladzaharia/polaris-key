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
export function lockerLockup(height: number, className: string): string {
  const m = lockupMetrics({ kind: "locker", layout: "horizontal", height });
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
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${m.template.width} ${m.template.height}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>`;
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
 * The Locker favicon (the kit's `web/favicon.svg`, adaptive): the micro mark, coral and white by
 * default and the light inks under `prefers-color-scheme: light`. Drawn at 16 px, unscaled.
 */
export function lockerFaviconSvg(): string {
  const dark = markParts({ kind: "locker", size: 16, theme: "dark" });
  const light = markParts({ kind: "locker", size: 16, theme: "light" });
  const fill = (ps: typeof dark.parts, role: "body" | "star"): string =>
    ps.find((p) => p.role === role)?.fill ?? "currentColor";
  const paths = dark.parts
    .map(
      (p) =>
        `<path class="${p.role === "star" ? "star" : "body"}" d="${p.d}"/>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 ${dark.grid} ${dark.grid}">` +
    `<style>.body{fill:${fill(dark.parts, "body")}}.star{fill:${fill(dark.parts, "star")}}@media(prefers-color-scheme:light){.body{fill:${fill(light.parts, "body")}}.star{fill:${fill(light.parts, "star")}}}</style>` +
    `${paths}</svg>`
  );
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
  `.svc{display:flex;align-items:center;gap:.5rem;margin:0;color:var(--strong);font-size:1rem;line-height:1.5rem;font-weight:700}`,
  `.svc svg{display:block;flex:none}`,
].join("");

/** The row under the Locker lockup: the Star Cut and the service's name. */
export function serviceRow(): string {
  return `<div class="svc">${deliverySymbol(24, "svc-mark")}<span>Delivery</span></div>`;
}
