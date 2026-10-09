// The preview's 'Expression' page (dist/preview/expression.html): display type in both themes, a
// CJK sample at tracking 0, the action-neutral role and the B17 state tokens per service. Built
// from the same sources as the package (marketing.css, tokens.css, the generated tokens).

import { contrastRatio } from "../src/color.js";
import { THEME_TOKENS } from "../src/generated/tokens.js";
import { escapeHtml } from "../src/marks/svg.js";
import { DISPLAY_SCALE, DISPLAY_TRACKING } from "../src/tokens/scales.js";
import {
  SERVICE_IDS,
  SERVICE_LABEL,
  THEMES,
  type Theme,
} from "../src/tokens/source.js";

const ratio = (a: string, b: string) => contrastRatio(a, b).toFixed(1);

function displayPanel(theme: Theme): string {
  const sizes = Object.entries(DISPLAY_SCALE)
    .map(
      ([k, [size]]) =>
        `<div class="spec"><code>display-${k} · ${size} · tracking ${DISPLAY_TRACKING.display}</code><p class="pk-display-${k}">Ship builds, not plumbing</p></div>`,
    )
    .join("");
  return `<section class="ground stack" data-theme="${theme}">
<h3>${theme === "dark" ? "Dark" : "Light"}: marketing display type</h3>
${sizes}
<div class="spec"><code>product: at most ${DISPLAY_TRACKING.product}, from 40 px up</code><p class="product-display">Every license, one key</p></div>
<div class="spec"><code>CJK sample · tracking 0 (lang="ja")</code><p class="pk-display-md" lang="ja">鍵を、もっと確かに。ビルドを届ける。</p></div>
<div class="spec"><code>CJK sample · tracking 0 (lang="zh")</code><p class="pk-display-md" lang="zh">更稳妥的密钥，更顺畅的交付。</p></div>
<div class="spec"><code>eyebrow · 12 px · ${DISPLAY_TRACKING.eyebrow}</code><p class="pk-eyebrow">License</p></div>
</section>`;
}

function actionRow(theme: Theme): string {
  const a = THEME_TOKENS[theme].action;
  return `<div class="spec"><button type="button" class="action">Save changes</button> <code>${theme}: action ${a.fill} · label ${a.on} · ${ratio(a.on, a.fill)}:1</code></div>`;
}

function stateRow(theme: Theme, id: (typeof SERVICE_IDS)[number]): string {
  const t = THEME_TOKENS[theme];
  const s = t.state[id];
  const page = t.surface.page;
  return `<div class="state-row" data-service="${id}">
<strong>${escapeHtml(SERVICE_LABEL[id])}</strong>
<span class="ring-demo" title="ring ${s.ring}: ${ratio(s.ring, page)}:1">ring</span>
<span class="sel" title="selected-fill: text ${ratio(t.text.default, s.selectedFill)}:1">Selected</span>
<span class="hov" title="hover-tint: text ${ratio(t.text.default, s.hoverTint)}:1">Hover</span>
<span class="chk" title="checked-fill ${ratio(s.checkedFill, page)}:1, glyph ${ratio(s.checkedOn, s.checkedFill)}:1">✓</span>
<span class="edge" title="context-edge ${ratio(s.contextEdge, page)}:1">Context</span>
</div>`;
}

export function expressionPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Polaris Key expression</title>
<link rel="icon" type="image/svg+xml" href="kit/04-web/key/favicon.svg">
<link rel="stylesheet" href="fonts/fonts.css">
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/marketing.css">
<style>
  body { margin: 0; font-family: var(--pk-font-sans); background: var(--pk-surface-page); color: var(--pk-text-default); font-size: var(--pk-font-size-base); line-height: var(--pk-line-height-base); }
  main { padding: var(--pk-space-6); max-width: 90rem; margin: 0 auto; }
  h1, h2, h3 { color: var(--pk-text-strong); font-weight: var(--pk-font-weight-semibold); }
  a { color: var(--pk-accent-fg); }
  .themes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr)); gap: var(--pk-space-4); }
  .ground { background: var(--pk-surface-page); color: var(--pk-text-default); border: 1px solid var(--pk-border-subtle); border-radius: var(--pk-radius-lg); padding: var(--pk-space-6); overflow-wrap: anywhere; }
  .ground h3 { margin: 0 0 var(--pk-space-4); font-size: var(--pk-font-size-lg); }
  .spec { margin: 0 0 var(--pk-space-4); }
  .spec p { margin: var(--pk-space-1) 0 0; color: var(--pk-text-strong); }
  .spec code, .ground code { font-family: var(--pk-font-mono); font-size: var(--pk-font-size-xs); color: var(--pk-text-muted); }
  .product-display { font-size: 2.5rem; line-height: 1.1; font-weight: var(--pk-font-weight-semibold); letter-spacing: var(--pk-tracking-product-display); }
  .action { font: inherit; font-weight: var(--pk-font-weight-medium); background: var(--pk-action); color: var(--pk-action-on); border: 0; border-radius: var(--pk-radius-md); padding: var(--pk-space-2) var(--pk-space-4); }
  .state-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--pk-space-2); margin: 0 0 var(--pk-space-2); font-size: var(--pk-font-size-sm); }
  .state-row strong { flex: 0 0 6.5rem; color: var(--pk-text-strong); font-weight: var(--pk-font-weight-medium); }
  .state-row > span { padding: var(--pk-space-1) var(--pk-space-3); border-radius: var(--pk-radius-md); border: 1px solid transparent; }
  .ring-demo { outline: 2px solid var(--pk-state-ring); outline-offset: 2px; background: var(--pk-surface-raised); }
  .sel { background: var(--pk-state-selected-fill); box-shadow: inset 3px 0 0 var(--pk-accent); color: var(--pk-text-strong); }
  .hov { background: var(--pk-state-hover-tint); color: var(--pk-text-strong); }
  .state-row > .chk { background: var(--pk-state-checked-fill); color: var(--pk-state-checked-on); border-color: var(--pk-state-checked-edge); font-weight: var(--pk-font-weight-semibold); }
  .state-row > .edge { border-color: var(--pk-state-context-edge); background: var(--pk-surface-raised); }
  @media (forced-colors: active) { .ring-demo, .edge, .chk { forced-color-adjust: auto; } }
</style>
</head>
<body>
<main>
<p><a href="index.html">Brand preview</a></p>
<h1>Expression</h1>
<p>Display type exists for marketing and the docs landing (<code>marketing.css</code>); product tracking stays at or above ${DISPLAY_TRACKING.product} and only from 40 px up. The state tokens follow the service an element references (B17).</p>
<h2>Display type</h2>
<div class="themes">${THEMES.map(displayPanel).join("")}</div>
<h2>Action and state tokens</h2>
<div class="themes">${THEMES.map(
    (theme) => `<section class="ground" data-theme="${theme}">
<h3>${theme === "dark" ? "Dark" : "Light"}</h3>
${actionRow(theme)}
${SERVICE_IDS.map((id) => stateRow(theme, id)).join("")}
</section>`,
  ).join("")}</div>
</main>
</body>
</html>
`;
}
