#!/usr/bin/env node
// Regenerates the generated blocks of the mockup kit's one stylesheet,
// docs/design/mockups/kit/mockup.css: the embedded fonts and the icon set.
//
//   mise exec node@22 -- node tools/mockups/build-kit.mjs           # rewrite the blocks
//   mise exec node@22 -- node tools/mockups/build-kit.mjs --check   # fail if they are stale
//
// Everything between `@generated <name>:start` and `@generated <name>:end` is owned by this
// script; the rest of mockup.css is hand-written. Sources:
//   - fonts:  packages/brand/fonts/*.woff2 (Rubik and JetBrains Mono, latin + latin-ext), plus
//             tools/mockups/assets/jetbrains-mono-symbols.woff2: JetBrains Mono's arrows, box
//             drawing, blocks and geometric shapes (U+2190-21FF, U+2300-23FF, U+2500-27BF),
//             subset from packages/brand/fonts/ttf/JetBrainsMono-Variable.ttf with
//             `pyftsubset --unicodes=... --flavor=woff2`. It is also registered under "Rubik" for
//             the arrows and ⌘ ⇧ ⌥, which Rubik does not draw, so they never fall back to a
//             system face. JetBrains Mono has no ✓ ✗ ○ or braille: those fall back (Menlo).
//   - icons:  lucide-react (ISC) at the version the console ships, so a mockup draws exactly
//             the glyph the built console will; the platform glyphs from the portal
//             (packages/admin/src/portal/components/Glyphs.tsx); the Pinned K and the Star Cut from
//             @polaris-key/brand (packages/brand/src/svg.ts).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const KIT = join(repo, "docs/design/mockups/kit/mockup.css");
const FONTS = join(repo, "packages/brand/fonts");
const LUCIDE = join(
  dirname(
    createRequire(join(repo, "packages/admin/package.json")).resolve(
      "lucide-react/package.json",
    ),
  ),
  "dist/esm/icons",
);
const check = process.argv.includes("--check");

// ── Fonts ─────────────────────────────────────────────────────────────────────────────────

const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";
const SYMBOLS = "U+2190-21FF, U+2300-23FF, U+2500-27BF";
/** Rubik borrows only the arrows and the modifier-key glyphs. */
const SANS_SYMBOLS = "U+2190-21FF, U+2318, U+2325, U+238B, U+23CE";

const b64 = (file) => readFileSync(file).toString("base64");
const face = (family, weight, file, range) =>
  `@font-face {\n  font-family: "${family}";\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: block;\n  src: url("data:font/woff2;base64,${b64(file)}") format("woff2");\n  unicode-range: ${range};\n}`;

function fontsBlock() {
  const symbols = join(here, "assets/jetbrains-mono-symbols.woff2");
  return [
    face("Rubik", "300 900", join(FONTS, "rubik-var-latin.woff2"), LATIN),
    face(
      "Rubik",
      "300 900",
      join(FONTS, "rubik-var-latin-ext.woff2"),
      LATIN_EXT,
    ),
    face("Rubik", "300 900", symbols, SANS_SYMBOLS),
    face(
      "JetBrains Mono",
      "400 800",
      join(FONTS, "jetbrains-mono-var-latin.woff2"),
      LATIN,
    ),
    face(
      "JetBrains Mono",
      "400 800",
      join(FONTS, "jetbrains-mono-var-latin-ext.woff2"),
      LATIN_EXT,
    ),
    face("JetBrains Mono", "400 800", symbols, SYMBOLS),
  ].join("\n");
}

// ── Icons ─────────────────────────────────────────────────────────────────────────────────

/** Every lucide icon a mockup may use, by its lucide file name (= the class `ic-<name>`). */
const LUCIDE_ICONS = `
house boxes box package package-check package-open key-round key key-square sliders-horizontal
sliders-vertical circle-arrow-up user-round users user-plus cloud cloud-upload cloud-download store
shopping-bag plug shield shield-check badge-check settings activity smartphone monitor laptop
layers git-branch git-pull-request git-commit-horizontal github search command book-open moon sun
chevron-down chevron-right chevron-left chevron-up chevrons-up-down arrow-right arrow-left
arrow-up-right arrow-down arrow-up external-link plus minus x check circle-check circle-check-big
circle circle-dot circle-plus circle-minus triangle-alert info circle-x ban clock circle-pause
refresh-cw copy download upload trash-2 pencil ellipsis ellipsis-vertical list-filter columns-3
eye eye-off lock lock-open fingerprint mail globe link square-terminal terminal code-xml
file-text file-json file-code-2 file-lock folder inbox bell log-out panel-left-close
panel-left-open menu gamepad-2 disc-3 headphones music audio-waveform dice-5 rocket sparkles zap
wand-sparkles server database cpu wifi-off hourglass calendar calendar-clock timer repeat receipt
credit-card wallet tag ticket gift coins badge-percent circle-dollar-sign chart-line
chart-column list list-checks layout-grid table grip-vertical history send at-sign building-2
id-card qr-code archive puzzle crown award flag toggle-right circle-help loader-circle image
palette app-window workflow webhook map-pin languages truck hammer wrench scroll-text
layout-dashboard blocks monitor-smartphone users-round lock-keyhole list-tree file-pen file-stack
stamp waypoints grid-3x3 flask-conical trending-up square-pen heart-pulse rss log-in
server-cog gauge plug-zap arrow-right-left circle-dashed git-merge user-check clipboard-check
square wifi signal battery-full
`
  .trim()
  .split(/\s+/);

/** The portal's platform marks (Glyphs.tsx), filled in currentColor. */
const FILLED = {
  apple:
    '<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>',
  windows:
    '<path d="M3 5.1 10.4 4v7.3H3zM11.4 3.9 21 2.5v8.8h-9.6zM3 12.6h7.4V20L3 18.9zM11.4 12.6H21v8.9l-9.6-1.4z"/>',
  linux:
    '<path fill-rule="evenodd" d="M12 2c2.3 0 3.6 1.9 3.6 4.4 0 1.3.5 2.3 1.4 3.6 1.2 1.7 2.4 3.6 2.4 6 0 1.3-.4 2.4-1.1 3.2.6.3 1 .8 1 1.4 0 .9-1.2 1.4-3 1.4-1.2 0-2-.3-2.4-.8a8.4 8.4 0 0 1-3.8 0c-.4.5-1.2.8-2.4.8-1.8 0-3-.5-3-1.4 0-.6.4-1.1 1-1.4A4.8 4.8 0 0 1 4.6 16c0-2.4 1.2-4.3 2.4-6 .9-1.3 1.4-2.3 1.4-3.6C8.4 3.9 9.7 2 12 2zm0 7.3c-1.9 0-3.4 2.6-3.4 5.8 0 2.6 1.5 4.2 3.4 4.2s3.4-1.6 3.4-4.2c0-3.2-1.5-5.8-3.4-5.8zM10.6 5a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6zm2.8 0a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z"/>',
  android:
    '<path d="M6.2 7.6 4.7 5a.5.5 0 0 1 .9-.5l1.5 2.6A9.6 9.6 0 0 1 12 6c1.8 0 3.5.4 4.9 1.1l1.5-2.6a.5.5 0 0 1 .9.5l-1.5 2.6A8.3 8.3 0 0 1 21.5 14h-19a8.3 8.3 0 0 1 3.7-6.4zM8 10.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm8 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM2.5 15.5h19V19a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 19z"/>',
  steam:
    '<path fill-rule="evenodd" d="M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22zm3.5 4.25a3.75 3.75 0 0 0-3.72 4.24l-2.9 4.06a2.75 2.75 0 0 0-.38-.03c-.4 0-.78.09-1.12.24L3.6 12.4a8.6 8.6 0 0 0 .18 3.06l2.95 1.17a2.75 2.75 0 0 0 5.38-.95l4.3-3.06a3.75 3.75 0 1 0-.91-7.37zm0 1.6a2.15 2.15 0 1 1 0 4.3 2.15 2.15 0 0 1 0-4.3zM8.5 14.85a1.65 1.65 0 1 1 0 3.3 1.65 1.65 0 0 1 0-3.3z"/>',
  // itch.io: a simplified storefront awning with the controller eyes (no official mono mark).
  itch: '<path fill-rule="evenodd" d="M4.2 3h15.6l2.2 4.2v1.6a2.6 2.6 0 0 1-4.4 1.9 2.6 2.6 0 0 1-3.8 0 2.6 2.6 0 0 1-3.6 0 2.6 2.6 0 0 1-3.8 0A2.6 2.6 0 0 1 2 8.8V7.2zM3.4 11.7a4 4 0 0 0 3 .1 4 4 0 0 0 5.6 0 4 4 0 0 0 5.6 0 4 4 0 0 0 3 0c.3 3 .2 6-.4 8.2-1.6.7-5.1 1-8.2 1s-6.6-.3-8.2-1c-.6-2.2-.7-5.2-.4-8.3zM12 15.2l-1.3 1.6H9.3v1.5h5.4v-1.5h-1.4z"/>',
  godot:
    '<path fill-rule="evenodd" d="M9.8 2.3c.8-.2 1.6-.3 2.4-.3l.6 2.2c.6.1 1.2.3 1.8.5l1.6-1.6c.7.4 1.4.9 2 1.4l-.6 2.2c.4.4.8.9 1.1 1.5l2.3.2c.3.8.4 1.6.5 2.5L19.4 12v3.4c1.1.3 2 .9 2.6 1.6-.9 2.8-3 4.9-5.6 5.7-.4-.7-.6-1.5-.6-2.4H8.2c0 .9-.2 1.7-.6 2.4-2.6-.8-4.7-2.9-5.6-5.7.6-.7 1.5-1.3 2.6-1.6V12L2.3 10.9c.1-.9.2-1.7.5-2.5l2.3-.2c.3-.6.7-1.1 1.1-1.5L5.6 4.5c.6-.5 1.3-1 2-1.4l1.6 1.6c.6-.2 1.2-.4 1.8-.5zM8.5 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 16v2h2v-2z"/>',
  "app-store":
    '<path fill-rule="evenodd" d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm6.9 4.6a.9.9 0 0 0-1.6.9l.4.6-3.9 6.8H6.4a.9.9 0 0 0 0 1.8h7.4a2.2 2.2 0 0 0-.2-1.8h-2.9l3.6-6.3zm-5.4 9.8-.6 1.1a.9.9 0 1 0 1.6.9l.9-1.6c-.5-.4-1.2-.5-1.9-.4zm6.3-5.7a2.2 2.2 0 0 0-.5 2.7l2.6 4.5a.9.9 0 0 0 1.6-.9l-1-1.7h1.1a.9.9 0 0 0 0-1.8h-2.1z"/>',
  "google-play":
    '<path d="M4.3 2.4c-.2.3-.3.6-.3 1v17.2c0 .4.1.7.3 1l9.4-9.6zM15.2 13.5 5.4 23c.4.1.9.1 1.3-.2l11.4-6.5zm0-3 2.9-2.9L6.7 1.2C6.3 1 5.8.9 5.4 1zm4.1-2.2-3.2 3.7 3.2 3.7 2.5-1.4c.9-.5.9-1.9 0-2.4z"/>',
  "microsoft-store":
    '<path fill-rule="evenodd" d="M8 4.5V3a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5h5a1 1 0 0 1 1 1V19a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5.5a1 1 0 0 1 1-1zm2 0h4V3h-4zM7 9v4h4.5V9zm5.5 0v4H17V9zM7 14v4h4.5v-4zm5.5 0v4H17v-4z"/>',
};

function lucideSvg(name) {
  const file = join(LUCIDE, `${name}.js`);
  if (!existsSync(file)) throw new Error(`lucide-react has no icon "${name}"`);
  const src = readFileSync(file, "utf8");
  const body = src.slice(src.indexOf("["), src.lastIndexOf("]") + 1);
  // The node list is a JS literal: [["path", { d: "…", key: "…" }], …]
  const nodes = Function(`"use strict"; return (${body});`)();
  const inner = nodes
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${v}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner.replaceAll("currentColor", "black")}</svg>`;
}

const filledSvg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="black">${inner}</svg>`;

/** A data: URI that survives being a CSS url("…"): only the characters CSS and URLs care about. */
const dataUri = (svg) =>
  `data:image/svg+xml,${svg
    .replace(/"/g, "'")
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/\s+/g, " ")}`;

async function brandMarks() {
  const { tsImport } = await import("tsx/esm/api");
  const m = await tsImport(join(repo, "packages/brand/src/svg.ts"), import.meta.url);
  const plain = (s) => s.replace(/ aria-hidden="true"/, "").replace(/ width="\d+" height="\d+"/, "");
  return {
    keyDark: plain(m.markSvg({ size: 28, theme: "dark" })),
    keyLight: plain(m.markSvg({ size: 28, theme: "light" })),
    keyMono: plain(m.markSvg({ size: 28, theme: "mono" })).replaceAll("currentColor", "black"),
    starCut: plain(m.markSvg({ kind: "update", size: 16, theme: "mono" })).replaceAll(
      "currentColor",
      "black",
    ),
  };
}

async function iconsBlock() {
  const lines = [];
  const vars = [];
  const classes = [];
  for (const name of LUCIDE_ICONS) {
    vars.push(`  --ic-${name}: url("${dataUri(lucideSvg(name))}");`);
    classes.push(`.ic-${name} { --i: var(--ic-${name}); }`);
  }
  for (const [name, inner] of Object.entries(FILLED)) {
    vars.push(`  --ic-${name}: url("${dataUri(filledSvg(inner))}");`);
    classes.push(`.ic-${name} { --i: var(--ic-${name}); }`);
  }
  const marks = await brandMarks();
  vars.push(`  --ic-star-cut: url("${dataUri(marks.starCut)}");`);
  vars.push(`  --ic-polaris: url("${dataUri(marks.keyMono)}");`);
  classes.push(`.ic-star-cut { --i: var(--ic-star-cut); }`);
  classes.push(`.ic-polaris { --i: var(--ic-polaris); }`);
  vars.push(`  --pk-mark-dark: url("${dataUri(marks.keyDark)}");`);
  vars.push(`  --pk-mark-light: url("${dataUri(marks.keyLight)}");`);
  lines.push(":root {", ...vars, "}", ...classes);
  lines.push(
    `/* ${LUCIDE_ICONS.length} lucide icons, ${Object.keys(FILLED).length} platform and store marks, the Star Cut and the Pinned K. */`,
  );
  return lines.join("\n");
}

// ── Tokens ────────────────────────────────────────────────────────────────────────────────

/** Drops every `@media (prefers-color-scheme: …) { … }` block: mockups pick a theme by data-theme. */
function stripSchemeMedia(css) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = css.indexOf("@media (prefers-color-scheme", i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    let depth = 0;
    let j = css.indexOf("{", at);
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
}

/** The brand's generated CSS without its header comment. */
const brandCss = (file) =>
  stripSchemeMedia(readFileSync(join(repo, "packages/brand/css", file), "utf8"))
    .replace(/^(\s*\/\*[\s\S]*?\*\/\s*)+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function tokensBlock() {
  return [
    "/* packages/brand/css/tokens.css */",
    brandCss("tokens.css"),
    "/* packages/brand/css/kit.css (the in-app UI-kit measures, for surface \"kit\" screens) */",
    brandCss("kit.css"),
  ].join("\n");
}

// ── Splice ────────────────────────────────────────────────────────────────────────────────

function splice(css, name, body) {
  const start = `/* @generated ${name}:start`;
  const end = `/* @generated ${name}:end */`;
  const a = css.indexOf(start);
  const b = css.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`mockup.css has no @generated ${name} markers`);
  const headEnd = css.indexOf("*/", a) + 2;
  return `${css.slice(0, headEnd)}\n${body}\n${css.slice(b)}`;
}

const before = readFileSync(KIT, "utf8");
let after = splice(before, "tokens", tokensBlock());
after = splice(after, "fonts", fontsBlock());
after = splice(after, "icons", await iconsBlock());
if (check) {
  if (after !== before) {
    console.error("mockup.css is stale: run node tools/mockups/build-kit.mjs");
    process.exit(1);
  }
  console.log("mockup.css generated blocks are current");
} else {
  writeFileSync(KIT, after);
  console.log(
    `mockup.css: ${(Buffer.byteLength(after) / 1024).toFixed(0)} KB (${(Buffer.byteLength(after) / 1024 - Buffer.byteLength(before) / 1024).toFixed(1)} KB change)`,
  );
}
