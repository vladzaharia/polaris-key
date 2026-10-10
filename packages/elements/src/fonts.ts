// Fonts (UI-KITS.md §2.1): every web kit loads its own. `@font-face` does not work inside a shadow
// root, so the module adds one stylesheet link to the document: brand's fonts.css, copied beside
// the module at build (dist/fonts/), with the metric-matched fallback faces so the host page does
// not shift when Rubik arrives. A link, not an inline style: it passes a CSP without
// 'unsafe-inline'. A host that ships its own fonts calls `PolarisKey.fonts(false)` first.

let base: string | false | null = null;
let installed = false;

/** Where fonts.css lives (a URL ending in `/`), or `false` to leave fonts to the host. */
export function setFontBase(url: string | false): void {
  base = url;
}

export function installFonts(): void {
  if (installed || typeof document === "undefined") return;
  if (base === false) return;
  installed = true;
  const href = new URL(
    "fonts.css",
    base ?? new URL("./fonts/", import.meta.url).href,
  ).href;
  if (document.querySelector(`link[data-pk-fonts]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.pkFonts = "";
  document.head.append(link);
}
