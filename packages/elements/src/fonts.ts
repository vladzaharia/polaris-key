// Fonts (UI-KITS.md §2.1): every web kit loads its own. `@font-face` does not work inside a shadow
// root, so the module registers the faces on the document, once, in one constructed stylesheet
// (never an inline `<style>`, so a CSP without 'unsafe-inline' still passes). The woff2 files are
// named with literal `new URL(..., import.meta.url)` expressions, which is what a bundler (Vite,
// webpack, Rollup) looks for: it emits each file and rewrites the URL, so a bundled app loads
// Rubik with no setup. Beside the module (the CDN folder, `node_modules` served as is) the same
// URLs resolve to `fonts/` as built. The metric-matched fallback faces keep the host page from
// shifting when Rubik arrives.
//
// A host that ships its own fonts calls `PolarisKey.fonts(false)` first; one that serves the
// folder elsewhere gives its URL (`PolarisKey.fonts("/static/pk-fonts/")`), which loads that
// folder's `fonts.css` with a link, and `@polaris-key/elements/fonts.css` is the same sheet for a
// bundler's CSS import.

let base: string | false | null = null;
let installed = false;

/** Where fonts.css lives (a URL ending in `/`), or `false` to leave fonts to the host. */
export function setFontBase(url: string | false): void {
  base = url;
}

const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

/** The `@font-face` rules, the files at the URLs the bundler resolved. */
export function fontFaceCss(): string {
  const files = {
    rubikExt: new URL("./fonts/rubik-var-latin-ext.woff2", import.meta.url)
      .href,
    rubik: new URL("./fonts/rubik-var-latin.woff2", import.meta.url).href,
    monoExt: new URL(
      "./fonts/jetbrains-mono-var-latin-ext.woff2",
      import.meta.url,
    ).href,
    mono: new URL("./fonts/jetbrains-mono-var-latin.woff2", import.meta.url)
      .href,
  };
  const face = (family: string, weight: string, url: string, range: string) =>
    `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url("${url}") format("woff2");unicode-range:${range}}`;
  return [
    face("Rubik", "300 900", files.rubikExt, LATIN_EXT),
    face("Rubik", "300 900", files.rubik, LATIN),
    face("JetBrains Mono", "400 600", files.monoExt, LATIN_EXT),
    face("JetBrains Mono", "400 600", files.mono, LATIN),
    `@font-face{font-family:"Rubik Fallback";src:local("Arial"),local("ArialMT"),local("Liberation Sans");size-adjust:105.73%;ascent-override:88.43%;descent-override:23.64%;line-gap-override:0%}`,
    `@font-face{font-family:"JetBrains Mono Fallback";src:local("Menlo"),local("Courier New"),local("Liberation Mono");size-adjust:99.66%;ascent-override:102.35%;descent-override:30.1%;line-gap-override:0%}`,
  ].join("\n");
}

export function installFonts(): void {
  if (installed || typeof document === "undefined") return;
  if (base === false) return;
  installed = true;
  if (document.querySelector(`link[data-pk-fonts], style[data-pk-fonts]`))
    return;
  if (base) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("fonts.css", new URL(base, document.baseURI)).href;
    link.dataset.pkFonts = "";
    document.head.append(link);
    return;
  }
  const css = fontFaceCss();
  if (
    "adoptedStyleSheets" in document &&
    typeof CSSStyleSheet === "function" &&
    "replaceSync" in CSSStyleSheet.prototype
  ) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  }
  const style = document.createElement("style");
  style.textContent = css;
  style.dataset.pkFonts = "";
  document.head.append(style);
}
