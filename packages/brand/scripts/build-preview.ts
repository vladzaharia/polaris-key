// The living preview: dist/preview/index.html, built by `pnpm --filter @polaris-key/brand build`.
// A static page that renders every token, mark, lockup, badge and section accent in both themes,
// from the same sources the package ships (tokens.css, fonts.css, the SVG renderers), with the
// theme toggle working exactly as a consumer's would (data-theme on <html>, or the system).
//
// Open it straight from disk: everything it loads is relative.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { contrastRatio } from "../src/color.js";
import { SERVICE_ACCENTS, THEME_TOKENS } from "../src/generated/tokens.js";
import {
  serviceIconSvg,
  serviceIconSymbolId,
  serviceIconTileSvg,
} from "../src/marks/icons.js";
import {
  escapeHtml,
  lockupSvg,
  markSvg,
  poweredBySvg,
} from "../src/marks/svg.js";
import {
  SERVICE_ICON_IDS,
  SERVICE_ICON_TILE,
  SERVICE_ICONS,
} from "../src/tokens/icons.js";
import { BRAND, POWERED_BY } from "../src/tokens/primitives.js";
import {
  ELEVATION,
  MOTION,
  RADIUS,
  SPACE,
  TYPE_SCALE,
} from "../src/tokens/scales.js";
import {
  SERVICE_FAMILY,
  SERVICE_IDS,
  SERVICE_LABEL,
  SERVICE_MARK,
  STATUS_IDS,
  THEMES,
  type Theme,
} from "../src/tokens/source.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, "dist", "preview");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(PKG, "css"), join(OUT, "css"), { recursive: true });
cpSync(join(PKG, "fonts"), join(OUT, "fonts"), { recursive: true });
cpSync(join(PKG, "preview", "proofs"), join(OUT, "proofs"), {
  recursive: true,
});
for (const dir of ["icons", "marks", "social", "web"])
  cpSync(join(PKG, dir), join(OUT, dir), { recursive: true });
for (const dir of ["04-web", "06-games", "07-social"])
  cpSync(join(PKG, "kit", dir), join(OUT, "kit", dir), { recursive: true });

const ratio = (a: string, b: string) => contrastRatio(a, b).toFixed(2);

const swatch = (name: string, hex: string, note = "") =>
  `<div class="sw"><span class="chip" style="background:${hex}"></span><code>${escapeHtml(name)}</code><code class="hex">${hex}</code>${note ? `<small>${note}</small>` : ""}</div>`;

function themePanel(theme: Theme): string {
  const t = THEME_TOKENS[theme];
  const page = t.surface.page;
  const rows: string[] = [];
  rows.push(
    `<h3>Surfaces</h3><div class="grid">${Object.entries(t.surface)
      .map(([k, v]) => swatch(`surface.${k}`, v))
      .join("")}</div>`,
  );
  rows.push(
    `<h3>Text</h3><div class="grid">${Object.entries(t.text)
      .map(([k, v]) =>
        swatch(
          `text.${k}`,
          v,
          k === "onAccent"
            ? `${ratio(v, t.accent.violet.solid)}:1 on violet`
            : `${ratio(v, page)}:1`,
        ),
      )
      .join("")}</div>`,
  );
  rows.push(
    `<h3>Borders and focus</h3><div class="grid">${swatch("border.subtle", t.border.subtle, "decorative")}${swatch("border.strong", t.border.strong, `${ratio(t.border.strong, page)}:1`)}${swatch("focus", t.focus, `${ratio(t.focus, page)}:1`)}</div>`,
  );
  rows.push(
    `<h3>Status and signed</h3><div class="status">${STATUS_IDS.map(
      (s) =>
        `<div class="callout" style="background:${t.status[s].subtle};border-color:${t.status[s].border};color:${t.text.default}"><b style="color:${t.status[s].fg}">${s}</b> fg ${t.status[s].fg} · ${ratio(t.status[s].fg, t.status[s].subtle)}:1 on its callout <span class="pill" style="background:${t.status[s].fg};color:${t.status[s].on}">${s}</span></div>`,
    ).join(
      "",
    )}<div class="callout" style="background:${t.signed.subtle};border-color:${t.signed.border};color:${t.text.default}"><span class="pill" style="background:${t.signed.solid};color:${t.signed.on}">Signed</span> release key · verified signature (gold means signed, nothing else)</div></div>`,
  );
  return `<section class="panel" data-theme="${theme}"><h2>${theme} theme</h2>${rows.join("")}</section>`;
}

function accentTable(): string {
  const head = `<tr><th>Section</th><th>Mark</th><th>Family</th>${THEMES.map((t) => `<th>${t}: solid · fg · on</th><th>${t}: fg on page</th><th>${t}: section bit (48 px)</th>`).join("")}</tr>`;
  const rows = SERVICE_IDS.map((id) => {
    const cells = THEMES.map((t) => {
      const a = SERVICE_ACCENTS[t][id];
      const page = THEME_TOKENS[t].surface.page;
      return `<td style="background:${page}"><span class="chip" style="background:${a.solid}"></span><code style="color:${a.fg}">${a.solid}</code> <code style="color:${a.fg}">${a.fg}</code> <span class="pill" style="background:${a.solid};color:${a.on}">on</span></td><td style="background:${page};color:${THEME_TOKENS[t].text.default}">${ratio(a.fg, page)}:1</td><td style="background:${page}">${markSvg({ size: 48, theme: t, bit: id })}</td>`;
    }).join("");
    return `<tr data-service="${id}"><th>${SERVICE_LABEL[id]}</th><td>${SERVICE_MARK[id] === "update" ? "Star Cut" : "Pinned K"}</td><td>${SERVICE_FAMILY[id]}</td>${cells}</tr>`;
  }).join("");
  return `<div class="scroll"><table class="accents">${head}${rows}</table></div>`;
}

function marks(): string {
  const sizes = [16, 24, 32, 48, 96];
  const row = (theme: "dark" | "light" | "mono", kind: "key" | "update") =>
    sizes
      .map(
        (s) =>
          `<figure>${markSvg({ kind, size: s, theme, signed: true, title: kind === "key" ? "Polaris Key" : "Polaris Key Delivery" })}<figcaption>${s} px</figcaption></figure>`,
      )
      .join("");
  return (["dark", "light"] as const)
    .map(
      (t) =>
        `<div class="ground" data-theme="${t}"><h3>For ${t} grounds (signed where allowed)</h3><div class="row">${row(t, "key")}</div><div class="row">${row(t, "update")}</div><div class="row mono" style="color:var(--pk-text-strong)">${row("mono", "key")}</div></div>`,
    )
    .join("");
}

function sectionBitDemo(): string {
  const buttons = SERVICE_IDS.map(
    (id) =>
      `<button type="button" data-pick="${id}">${SERVICE_LABEL[id]}</button>`,
  ).join("");
  return `<div class="header-demo" id="header-demo" data-service="core">${markSvg({ size: 48, bit: "section", theme: "dark" }).replace("<svg", '<svg class="demo-dark"')}${markSvg({ size: 48, bit: "section", theme: "light" }).replace("<svg", '<svg class="demo-light"')}<strong>Console</strong><span class="crumb">section: <b id="crumb">Core</b></span></div><div class="row">${buttons}</div>
<p>On core (the platform) the K has no terminal bit at all; in a service section the bit takes that section's accent and eases between sections over <code>--pk-duration-base</code> (with reduced motion it switches instantly). The star never changes. Proofs at 32/40/48 px:</p>
<div class="row"><a href="proofs/section-bit-dark.png"><img src="proofs/section-bit-dark.png" alt="Section-bit proof sheet, dark" width="380"></a><a href="proofs/section-bit-light.png"><img src="proofs/section-bit-light.png" alt="Section-bit proof sheet, light" width="380"></a></div>`;
}

function lockups(): string {
  const out: string[] = [];
  for (const t of ["dark", "light"] as const)
    for (const kind of ["key", "delivery"] as const)
      out.push(
        `<div class="ground" data-theme="${t}">${(["horizontal", "stacked", "compact"] as const).map((layout) => lockupSvg({ kind, layout, theme: t, height: layout === "compact" ? 64 : 120 })).join("")}</div>`,
      );
  return out.join("");
}

/** The trimmed horizontal lockup in the 64 px console header, which supplies the clear space. */
function trimmedLockups(): string {
  return (["dark", "light"] as const)
    .map(
      (t) =>
        `<div class="ground" data-theme="${t}"><h3>${t}: 64 px header, 48 px glyph</h3>${(["key", "delivery"] as const).map((kind) => `<div class="hdr">${lockupSvg({ kind, layout: "horizontal", theme: t, trim: true, height: 48 })}</div>`).join("")}</div>`,
    )
    .join("");
}

function serviceIcons(): string {
  const sizes = [16, 20, 24, 32, 64];
  const out = (["dark", "light"] as const).map((t) => {
    const rows = SERVICE_ICON_IDS.map((id) => {
      const spec = SERVICE_ICONS[id];
      const accent = spec.accent ?? "none";
      const bare = sizes
        .map(
          (s) =>
            `<figure${spec.accent ? ` data-service="${spec.accent}"` : ""}>${serviceIconSvg(id, { size: s })}<figcaption>${s}</figcaption></figure>`,
        )
        .join("");
      const tiles = SERVICE_ICON_TILE.sizes
        .map(
          (s) =>
            `<figure>${serviceIconTileSvg(id, { size: s, theme: t, title: spec.label })}<figcaption>${s}</figcaption></figure>`,
        )
        .join("");
      return `<div class="icon-row${spec.accent ? "" : " neutral"}"${spec.accent ? ` data-service="${spec.accent}"` : ""}><strong>${escapeHtml(spec.label)}</strong><small>${spec.glyph} · accent ${accent}${spec.dataService ? "" : " · marketing and docs only"}</small><div class="row ink">${bare}</div><div class="row">${tiles}</div></div>`;
    }).join("");
    return `<div class="ground icons" data-theme="${t}"><h3>${t}: glyphs in the section accent (fg), then the tiles</h3>${rows}</div>`;
  });
  const sprite = SERVICE_ICON_IDS.map(
    (id) =>
      `<svg width="24" height="24" aria-hidden="true"><use href="icons/services/sprite.svg#${serviceIconSymbolId(id)}"/></svg><svg width="16" height="16" aria-hidden="true"><use href="icons/services/sprite.svg#${serviceIconSymbolId(id, true)}"/></svg>`,
  ).join("");
  return `${out.join("")}<div class="ground" data-theme="dark"><h3>sprite.svg, both strokes (1.6 at 24, 2 at 16)</h3><div class="row ink">${sprite}</div></div>`;
}

function deliveryAssets(): string {
  const marksRow = (t: string) =>
    (["display", "service", "favicon"] as const)
      .map(
        (cut) =>
          `<figure class="ground" data-theme="${t}"><img src="marks/delivery/delivery-${cut}-${t}.svg" alt="Polaris Key Delivery mark, ${cut} cut" width="${cut === "display" ? 96 : cut === "service" ? 48 : 32}"><figcaption>${cut}</figcaption></figure>`,
      )
      .join("");
  const cards = (["dark", "light"] as const)
    .flatMap((t) =>
      ["delivery", "key"].flatMap((k) => [
        `<figure><img src="social/${k}/portrait-${t}.svg" alt="${k} portrait card, ${t}" width="216"><figcaption>${k} portrait ${t}, 1080×1350</figcaption></figure>`,
      ]),
    )
    .join("");
  const social = (["dark", "light"] as const)
    .flatMap((t) =>
      ["social-card", "square", "banner", "splash"].map(
        (c) =>
          `<figure><img src="social/delivery/${c}-${t}.svg" alt="Polaris Key Delivery ${c}, ${t}" width="${c === "square" ? 180 : 320}"><figcaption>delivery ${c} ${t}</figcaption></figure>`,
      ),
    )
    .join("");
  const web = ["favicon.svg", "app-icon-dark-192.png", "app-icon-light-192.png"]
    .map(
      (f) =>
        `<figure><img src="web/delivery/${f}" alt="" width="${f.startsWith("favicon") ? 48 : 96}"><figcaption>web/delivery/${f}</figcaption></figure>`,
    )
    .join("");
  return `<h3>Polaris Key Delivery marks</h3><div class="row">${marksRow("dark")}${marksRow("light")}</div><h3>Web (manifest name "Polaris Key Delivery")</h3><div class="row">${web}</div><h3>Social</h3><div class="row">${social}</div><h3>Portrait cards</h3><div class="row">${cards}</div>`;
}

function badges(): string {
  const out: string[] = [];
  for (const theme of ["dark", "light"] as const)
    out.push(
      `<div class="ground" data-theme="${theme}">${(
        ["transparent", "sticker", "outline"] as const
      )
        .map((treatment) =>
          (["compact", "horizontal", "stacked"] as const)
            .map((layout) => poweredBySvg({ layout, treatment, theme }))
            .join(""),
        )
        .join("")}</div>`,
    );
  out.push(
    `<div class="row"><div class="ground" style="background:#7a5f3a">${poweredBySvg({ layout: "compact", treatment: "sticker", theme: "dark" })}${poweredBySvg({ layout: "compact", treatment: "sticker", theme: "light" })}</div><div class="ground" style="background:#060912">${poweredBySvg({ layout: "compact", theme: "mono-white" })}</div><div class="ground" style="background:#ffffff">${poweredBySvg({ layout: "compact", theme: "mono-black" })}</div></div>`,
  );
  return `${out.join("")}<p>Minimums: ${Object.entries(POWERED_BY.minimum)
    .map(([k, v]) => `${k} ${v.width}×${v.height}`)
    .join(", ")} CSS px. Requesting less renders at the minimum.</p>`;
}

function assets(): string {
  const icons = (k: string) =>
    [
      "favicon.svg",
      "favicon-32.svg",
      "favicon-64.svg",
      "app-icon-dark-192.png",
      "app-icon-light-192.png",
      "app-icon-dark-maskable-192.png",
    ]
      .map(
        (f) =>
          `<figure><img src="kit/04-web/${k}/${f}" alt="" width="${f.startsWith("favicon") ? 48 : 96}"><figcaption>${k}/${f}</figcaption></figure>`,
      )
      .join("");
  const games = ["key", "update"]
    .flatMap((k) =>
      ["dark", "light"].map(
        (t) =>
          `<figure class="ground" data-theme="${t}"><img src="kit/06-games/${k}/${t}/${k}-16.svg" alt="" width="16" height="16"><img src="kit/06-games/${k}/${t}/${k}-16.svg" alt="" width="64" height="64" style="image-rendering:pixelated"><figcaption>${k} ${t} 16 px</figcaption></figure>`,
      ),
    )
    .join("");
  const social = ["key", "update"]
    .map(
      (k) =>
        `<figure><img src="kit/07-social/${k}/social-card-dark-1200.png" alt="" width="360"><figcaption>${k} social card (OG 1200×630)</figcaption></figure>`,
    )
    .join("");
  return `<h3>Favicons and PWA icons (console + portal: key; delivery surfaces: update)</h3><div class="row">${icons("key")}</div><div class="row">${icons("update")}</div><h3>Godot editor glyphs</h3><div class="row">${games}</div><h3>Social</h3><div class="row">${social}</div>`;
}

function scales(): string {
  const space = Object.entries(SPACE)
    .map(
      ([k, v]) =>
        `<div class="bar-row"><code>space-${k}</code><span class="bar" style="width:${v}"></span><small>${v}</small></div>`,
    )
    .join("");
  const radius = Object.entries(RADIUS)
    .map(
      ([k, v]) =>
        `<figure><span class="rad" style="border-radius:${v}"></span><figcaption>radius-${k}</figcaption></figure>`,
    )
    .join("");
  const elev = Object.keys(ELEVATION.dark)
    .map(
      (k) =>
        `<figure><span class="elev" style="box-shadow:var(--pk-elevation-${k})"></span><figcaption>elevation-${k}</figcaption></figure>`,
    )
    .join("");
  const type = Object.entries(TYPE_SCALE)
    .map(
      ([k, [size, lh]]) =>
        `<p style="font-size:${size};line-height:${lh};margin:0.25rem 0"><code>${k}</code> Polaris Key — a fixed point of trust. 0123456789</p>`,
    )
    .join("");
  const motion = Object.entries(MOTION.duration)
    .map(([k, v]) => `<code>duration-${k}: ${v}</code>`)
    .join(" · ");
  return `<h3>Type (Rubik 400/700; code in the system monospace)</h3><h1 style="margin:0">Rubik Bold heading</h1>${type}<p class="num"><code>tabular-nums</code> 1,111.11 · 8,888.88 · 0,000.01</p><pre><code>pkey license verify --product diceroll  # system monospace</code></pre>
<h3>Space</h3>${space}<h3>Radius</h3><div class="row">${radius}</div><h3>Elevation</h3><div class="row">${elev}</div><h3>Motion</h3><p>${motion}; easing standard ${MOTION.easing.standard}</p>`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Polaris Key brand preview</title>
<link rel="icon" type="image/svg+xml" href="kit/04-web/key/favicon.svg">
<link rel="stylesheet" href="fonts/fonts.css">
<link rel="stylesheet" href="css/tokens.css">
<script>
  try { const t = localStorage.getItem("pk-theme"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch {}
</script>
<style>
  body { margin: 0; font-family: var(--pk-font-sans); background: var(--pk-surface-page); color: var(--pk-text-default); font-size: var(--pk-font-size-base); line-height: var(--pk-line-height-base); }
  header.top { position: sticky; top: 0; z-index: 1; display: flex; gap: var(--pk-space-4); align-items: center; padding: var(--pk-space-3) var(--pk-space-6); background: var(--pk-surface-raised); border-bottom: 1px solid var(--pk-border-subtle); }
  header.top h1 { font-size: var(--pk-font-size-xl); margin: 0; color: var(--pk-text-strong); }
  main { padding: var(--pk-space-6); max-width: 90rem; margin: 0 auto; }
  h2 { color: var(--pk-text-strong); letter-spacing: var(--pk-tracking-tight); margin-top: var(--pk-space-12); }
  h3 { color: var(--pk-text-strong); font-size: var(--pk-font-size-lg); }
  section.panel, .ground { background: var(--pk-surface-page); color: var(--pk-text-default); border: 1px solid var(--pk-border-subtle); border-radius: var(--pk-radius-lg); padding: var(--pk-space-6); margin: var(--pk-space-4) 0; }
  .ground { display: flex; flex-wrap: wrap; gap: var(--pk-space-6); align-items: center; }
  .ground h3 { flex-basis: 100%; margin: 0; }
  .themes { display: grid; grid-template-columns: repeat(auto-fit, minmax(28rem, 1fr)); gap: var(--pk-space-4); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: var(--pk-space-2); }
  .sw { display: grid; grid-template-columns: 2rem 1fr; column-gap: var(--pk-space-2); align-items: center; font-size: var(--pk-font-size-sm); }
  .sw .chip { grid-row: span 3; }
  .chip { display: inline-block; width: 1.75rem; height: 1.75rem; border-radius: var(--pk-radius-md); border: 1px solid var(--pk-border-subtle); vertical-align: middle; }
  .hex { color: var(--pk-text-muted); } small { color: var(--pk-text-subtle); }
  .status { display: grid; gap: var(--pk-space-2); }
  .callout { border: 1px solid; border-radius: var(--pk-radius-md); padding: var(--pk-space-2) var(--pk-space-3); font-size: var(--pk-font-size-sm); }
  .pill { display: inline-block; border-radius: var(--pk-radius-full); padding: 0 var(--pk-space-2); font-size: var(--pk-font-size-xs); font-weight: 700; }
  .row { display: flex; flex-wrap: wrap; gap: var(--pk-space-4); align-items: end; margin: var(--pk-space-2) 0; }
  figure { margin: 0; display: grid; justify-items: center; gap: var(--pk-space-1); }
  figcaption { font-size: var(--pk-font-size-xs); color: var(--pk-text-muted); }
  .scroll { overflow-x: auto; }
  table.accents { border-collapse: collapse; font-size: var(--pk-font-size-sm); font-variant-numeric: tabular-nums; }
  table.accents th, table.accents td { border: 1px solid var(--pk-border-subtle); padding: var(--pk-space-2); text-align: left; vertical-align: middle; }
  .header-demo { display: flex; align-items: center; gap: var(--pk-space-3); padding: var(--pk-space-2) var(--pk-space-4); background: var(--pk-surface-raised); border: 1px solid var(--pk-border-subtle); border-radius: var(--pk-radius-lg); border-bottom: 3px solid var(--pk-accent); transition: border-color var(--pk-duration-base) var(--pk-ease-standard); }
  .header-demo .crumb { color: var(--pk-accent-fg); transition: color var(--pk-duration-base) var(--pk-ease-standard); }
  .demo-light { display: none; }
  :root[data-theme="light"] .demo-dark { display: none; } :root[data-theme="light"] .demo-light { display: inline; }
  @media (prefers-color-scheme: light) { :root:not([data-theme]) .demo-dark { display: none; } :root:not([data-theme]) .demo-light { display: inline; } }
  button { font: inherit; font-size: var(--pk-font-size-sm); background: var(--pk-surface-overlay); color: var(--pk-text-strong); border: 1px solid var(--pk-border-strong); border-radius: var(--pk-radius-md); padding: var(--pk-space-1) var(--pk-space-3); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--pk-focus); outline-offset: 2px; }
  button[aria-pressed="true"] { background: var(--pk-accent); color: var(--pk-accent-on); border-color: var(--pk-accent); }
  .bar-row { display: grid; grid-template-columns: 7rem auto 1fr; gap: var(--pk-space-2); align-items: center; }
  .bar { height: 0.75rem; background: var(--pk-accent); border-radius: var(--pk-radius-xs); }
  .rad { width: 4rem; height: 4rem; background: var(--pk-surface-overlay); border: 1px solid var(--pk-border-strong); }
  .elev { width: 6rem; height: 4rem; background: var(--pk-surface-raised); border-radius: var(--pk-radius-lg); border: 1px solid var(--pk-border-subtle); }
  pre { font-family: var(--pk-font-mono); background: var(--pk-surface-sunken); padding: var(--pk-space-3); border-radius: var(--pk-radius-md); color: var(--pk-text-default); }
  code { font-family: var(--pk-font-mono); font-size: 0.9em; }
  .num { font-variant-numeric: tabular-nums; }
  .hdr { display: flex; align-items: center; height: 64px; padding: 0 8px; background: var(--pk-surface-raised); border: 1px solid var(--pk-border-subtle); border-radius: var(--pk-radius-md); }
  .icons { flex-direction: column; align-items: stretch; }
  .icon-row { display: grid; gap: var(--pk-space-1); padding-bottom: var(--pk-space-3); border-bottom: 1px solid var(--pk-border-subtle); }
  .icon-row .ink { color: var(--pk-accent-fg); }
  .icon-row.neutral .ink { color: var(--pk-text-strong); }
  .ink { color: var(--pk-text-strong); }
</style>
</head>
<body>
<header class="top">
  ${lockupSvg({ layout: "compact", height: 40, theme: "mono", title: "Polaris Key" }).replace("<svg", '<svg style="color:var(--pk-text-strong)"')}
  <h1>Brand preview</h1>
  <span role="group" aria-label="Theme" class="row" style="margin:0 0 0 auto">
    <button type="button" data-theme-pick="system">System</button>
    <button type="button" data-theme-pick="dark">Dark</button>
    <button type="button" data-theme-pick="light">Light</button>
  </span>
</header>
<main>
<p>Every value on this page comes from <code>@polaris-key/brand</code>: <code>css/tokens.css</code>, <code>fonts/fonts.css</code> and the SVG renderers. The spec is <code>docs/design/BRAND.md</code>.</p>

<h2>Kit primitives</h2>
<div class="grid">${(["violet", "gold", "page", "star", "rose", "text", "muted"] as const).flatMap((k) => THEMES.map((t) => swatch(`${k} (for ${t})`, BRAND[k][t], k === "rose" ? "reserved: display only" : k === "gold" ? "the signing bit only" : ""))).join("")}</div>

<h2>Semantic tokens, both themes</h2>
<div class="themes">${THEMES.map(themePanel).join("")}</div>

<h2>Section accents</h2>
${accentTable()}

<h2>The section bit</h2>
${sectionBitDemo()}

<h2>Marks</h2>
${marks()}

<h2>Lockups</h2>
${lockups()}

<h2>Trimmed lockup (console header)</h2>
${trimmedLockups()}

<h2>Service icons</h2>
${serviceIcons()}

<h2>Powered by Polaris Key</h2>
${badges()}

<h2>Assets</h2>
${assets()}

<h2>Polaris Key Delivery assets</h2>
${deliveryAssets()}

<h2>Scales</h2>
${scales()}
</main>
<script>
  const root = document.documentElement;
  const press = () => { const cur = root.dataset.theme || "system"; document.querySelectorAll("[data-theme-pick]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themePick === cur))); };
  document.querySelectorAll("[data-theme-pick]").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.themePick;
    if (v === "system") { delete root.dataset.theme; try { localStorage.removeItem("pk-theme"); } catch {} }
    else { root.dataset.theme = v; try { localStorage.setItem("pk-theme", v); } catch {} }
    press();
  }));
  press();
  const demo = document.getElementById("header-demo");
  document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    demo.dataset.service = b.dataset.pick;
    document.getElementById("crumb").textContent = b.textContent;
    document.querySelectorAll("[data-pick]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
</script>
</body>
</html>
`;

writeFileSync(join(OUT, "index.html"), html);
console.log(`wrote ${join(OUT, "index.html")}`);
