#!/usr/bin/env node
// Checks mockup screens in a real browser, without writing screenshots:
//   - no sideways scroll at every width from 320 to 2560 (WIDTHS below, both themes);
//   - axe (WCAG 2.2 A/AA rules) at 390, 1024, 1440 and 1920 in both themes: zero violations;
//   - the kit rule: a screen sets no margin, padding or gap of its own (README "Rules");
//   - layout sanity at 390/1024/1440/1920: no table wider than twice its scroll region, no button
//     whose label overflows it, the active sidebar item inside the sidebar's viewport (above its
//     foot), no visible text under 12px and no text at weight 700 (B6, B7);
//   - owner rule B17 at 390 and 1440 in both themes (the colour follows the service): every
//     checked, selected, active and focused element (each focusable control is focused in turn)
//     paints its state in the accent of its nearest data-service (--pk-service-<s> or its -fg
//     step; commerce is the Distribution green), never in the neutral ink; no status element
//     (success, warning, danger, info, signed, error, failed) paints a service accent other than
//     its own tone token; a focus ring and a checked control's edge or bar are at least 3:1 against
//     what they sit on, and text in a service accent at least 4.5:1 (3:1 from 24px). In-app UI kit
//     frames (.kit-*, host chrome, terminals) keep their own look and are left out.
//
//   mise exec node@22 -- node tools/mockups/check.mjs --all
//   mise exec node@22 -- node tools/mockups/check.mjs --screen identity.sign-in,portal.library
//   mise exec node@22 -- node tools/mockups/check.mjs --area portal --no-axe
//   mise exec node@22 -- node tools/mockups/check.mjs --all --only-b17 --contrast-report
//
// Options: --all | --area <key> | --screen <id> (repeatable or comma-separated), --no-axe,
// --no-widths, --no-layout, --no-b17, --only-b17 (skips widths, layout and axe), --contrast-report
// (prints the lowest measured ratio per theme, service and kind), --themes dark,light. Exits
// non-zero on any failure and names the screen, the width, the theme and the widest element
// (overflow), the rule and its first nodes (axe), or the element and the colours (B17).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const ROOT = join(repo, "docs/design/mockups");
const WIDTHS = [320, 360, 390, 480, 640, 834, 1024, 1180, 1280, 1440, 1600, 1920, 2560];
const AXE_SIZES = [
  [390, 844],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
];

const argv = process.argv.slice(2);
const many = (k) =>
  argv
    .flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : a.startsWith(`--${k}=`) ? [a.split("=")[1]] : []))
    .flatMap((v) => (v ?? "").split(","))
    .filter(Boolean);
const flag = (k) => argv.includes(`--${k}`);
const areas = JSON.parse(readFileSync(join(ROOT, "areas.json"), "utf8")).map((a) => a.key);
const only = many("screen");
const pick = flag("all") ? areas : many("area").length ? many("area") : [...new Set(only.map((s) => s.split(".")[0]))];
if (!pick.length) {
  console.error("Pass --all, --area <key> or --screen <id>.");
  process.exit(2);
}
const themes = many("themes").length ? many("themes") : ["dark", "light"];
const onlyB17 = flag("only-b17");
const run = {
  widths: !onlyB17 && !flag("no-widths"),
  layout: !onlyB17 && !flag("no-layout"),
  axe: !onlyB17 && !flag("no-axe"),
  b17: !flag("no-b17"),
};
const B17_SIZES = [
  [390, 844],
  [1440, 900],
];

const screens = [];
for (const area of pick) {
  const dir = join(ROOT, "screens", area);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".html")).sort()) {
    const id = f.slice(0, -5);
    if (only.length && !only.includes(id)) continue;
    screens.push({ id, html: readFileSync(join(dir, f), "utf8") });
  }
}

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.error(`✗ ${msg}`);
};

// The kit rule: spacing comes from the kit, never from a screen.
for (const s of screens) {
  if (/style="[^"]*\b(margin|padding|gap)\b/.test(s.html)) fail(`${s.id}: sets spacing in a style attribute`);
  const block = (s.html.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  if (/^\s*(margin|padding|gap|row-gap|column-gap)[a-z-]*\s*:/m.test(block)) fail(`${s.id}: sets spacing in its style block`);
}

const kitCss = readFileSync(join(ROOT, "kit/mockup.css"), "utf8");
const FREEZE = `*,*::before,*::after{animation:none!important;transition:none!important}`;
const doc = (s, theme) =>
  `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${s.id}</title><style>${kitCss}</style><style>${FREEZE}</style></head><body data-screen="${s.id}">${s.html}</body></html>`;

// ── B17: interaction and context colour follow the service (owner rule, 2026-10-09) ────────────
// Runs in the page. Returns { out: [failure lines], ratios: [{ svc, kind, ratio }] }.
function b17Audit() {
  const out = [];
  const ratios = [];
  const seen = new Set();
  const say = (key, msg) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(msg);
  };
  const cvs = document.createElement("canvas");
  cvs.width = cvs.height = 1;
  const c2 = cvs.getContext("2d", { willReadFrequently: true });
  /** Any CSS colour (rgb, oklab, color-mix result, color()) as 8-bit sRGB + alpha. */
  const rgba = (s) => {
    if (!s || s === "transparent" || s === "none") return [0, 0, 0, 0];
    c2.clearRect(0, 0, 1, 1);
    c2.fillStyle = "rgba(0,0,0,0)";
    c2.fillStyle = s;
    c2.fillRect(0, 0, 1, 1);
    const d = c2.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const hex = (c) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
  const same = (a, b) => a[3] > 0.99 && b[3] > 0.99 && Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2;
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const x = lum(a),
      y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map((i) => Math.round(top[i] * a + under[i] * (1 - a))).concat(1);
  };
  /** The colour an element's box sits on: its ancestors' backgrounds, blended down to the page. */
  const bgOf = (el, includeSelf = false) => {
    const stack = [];
    for (let a = includeSelf ? el : el.parentElement; a; a = a.parentElement) {
      const c = rgba(getComputedStyle(a).backgroundColor);
      if (c[3] > 0) stack.push(c);
      if (c[3] > 0.99) break;
    }
    let col = rgba(getComputedStyle(document.body).backgroundColor);
    if (col[3] < 0.99) col = rgba(getComputedStyle(document.documentElement).getPropertyValue("--pk-surface-page"));
    for (let i = stack.length - 1; i >= 0; i--) col = over(stack[i], col);
    return col;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let a = el; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    }
    return true;
  };
  const OPT_IN = new Set(["kit-next", "kit-prod", "kit-cfg"]);
  /** In-app UI kit frames and host chrome keep their own look (DL13): left out. */
  const inKit = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      for (const c of a.classList) {
        if (c.startsWith("kit-") && !OPT_IN.has(c)) return true;
        if (/^(host-|term|ide-|device-status|window-bar|browser-bar|anno)/.test(c)) return true;
      }
    }
    return false;
  };
  const name = (el) => {
    const t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    return `${el.tagName.toLowerCase()}${[...el.classList].map((c) => "." + c).join("")}${t ? ` "${t}"` : ""}`;
  };
  const root = getComputedStyle(document.documentElement);
  const SERVICES = ["core", "license", "config", "release", "distribution", "update", "identity", "sync"];
  /** The service whose accent an element should carry: the nearest data-service, unless a nested
   *  data-theme sits nearer (the generated tokens reset the accent to core there). */
  const svcOf = (el) => {
    const s = el.closest("[data-service]");
    const t = el.parentElement?.closest("[data-theme]:not(html)") ?? (el.matches("[data-theme]:not(html)") ? el : null);
    if (t && (!s || s.contains(t)) && t !== s) return "core";
    const v = s?.getAttribute("data-service") || "core";
    return v === "commerce" ? "distribution" : v;
  };
  const tokens = (el, svc) => {
    const cs = getComputedStyle(el);
    const g = (n) => rgba(cs.getPropertyValue(n).trim());
    return { base: g(`--pk-service-${svc}`), fg: g(`--pk-service-${svc}-fg`), subtle: g(`--pk-service-${svc}-subtle`) };
  };
  const allAccents = (el) => {
    const cs = getComputedStyle(el);
    return SERVICES.flatMap((s) => [`--pk-service-${s}`, `--pk-service-${s}-fg`].map((n) => ({ s, c: rgba(cs.getPropertyValue(n).trim()) })));
  };
  const ink = () => {
    const c = rgba(getComputedStyle(document.body).getPropertyValue("--mk-action").trim());
    return c;
  };
  const shadows = (v) =>
    !v || v === "none"
      ? []
      : v.split(/,(?![^(]*\))/).map((s) => {
          const m = s.match(/(rgba?\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i);
          return { color: m ? rgba(m[1]) : [0, 0, 0, 0], inset: /inset/.test(s), raw: s.trim() };
        });
  const paint = (el, how) => {
    const cs = getComputedStyle(el);
    switch (how) {
      case "bg":
        return rgba(cs.backgroundColor);
      case "border": {
        for (const side of ["Top", "Left", "Right", "Bottom"])
          if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== "none") return rgba(cs[`border${side}Color`]);
        return [0, 0, 0, 0];
      }
      case "bottom":
        return parseFloat(cs.borderBottomWidth) > 0 ? rgba(cs.borderBottomColor) : [0, 0, 0, 0];
      case "bar":
      case "ring": {
        const sh = shadows(cs.boxShadow).filter((x) => x.color[3] > 0);
        return (how === "bar" ? sh.find((x) => x.inset && !/^\S+\s+0px\s+0px\s+0px\s+\d/.test(x.raw.replace(/^(rgba?\([^)]*\)|oklab\([^)]*\)|color\([^)]*\))\s*/, "x "))) : sh[0])?.color ?? [0, 0, 0, 0];
      }
      case "before":
        return rgba(getComputedStyle(el, "::before").backgroundColor);
      case "after":
        return rgba(getComputedStyle(el, "::after").backgroundColor);
      case "outline":
        return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 ? rgba(cs.outlineColor) : [0, 0, 0, 0];
    }
    return [0, 0, 0, 0];
  };
  // [selector, paint, against: "parent" | "self", kind]
  const STATES = [
    [".check.on > .box, .check.mixed > .box", "bg", "parent", "checked fill"],
    [".radio.on > .box", "border", "parent", "checked ring"],
    [".switch.on", "bg", "parent", "checked fill"],
    [".choice.on", "border", "parent", "selected edge"],
    [".choice.on:not(.nocheck)", "after", "self", "checked fill"],
    [".chip.on, .filter.on", "border", "parent", "selected edge"],
    [".segmented > .on", "ring", "parent", "selected edge"],
    [".card.selected, .pick-tile.on, .role-tile.on, .jump-nav > a.on", "border", "parent", "selected edge"],
    [".tab.active, .code-tabs > .active, .portal-nav > a.active, .docs-doors > a.on", "bottom", "parent", "selected bar"],
    [".docs-toc > a.on", "border", "parent", "selected bar"],
    [".nav-item.active, .list-nav-item.active, .toc-nav > a.on, .item-row.marked[aria-current], .hosted-row.choice-row.on", "bar", "self", "selected bar"],
    [".nav-group.single > .nav-label.active", "before", "self", "selected bar"],
    [".table tr.selected > td:first-child, .table tr.marked[aria-current] > td:first-child", "bar", "self", "selected bar"],
    [".step.done .step-mark", "bg", "parent", "checked fill"],
    [".step.current .step-mark", "border", "parent", "selected edge"],
    [".portal-tabbar > a.active", "ring", "parent", "selected edge"],
    [".focus, .code-cells > span.on", "outline", "parent", "focus ring"],
  ];
  const audited = new Set();
  const judge = (el, colour, against, kind, sel) => {
    if (colour[3] < 0.5) {
      say(`none ${sel} ${name(el)}`, `B17 ${kind} not drawn: ${name(el)} (${sel})`);
      return;
    }
    const svc = svcOf(el);
    const t = tokens(el, svc);
    const ok = same(colour, t.base) || same(colour, t.fg);
    if (!ok) {
      const inkC = ink();
      const what = same(colour, inkC) ? "the neutral ink" : hex(colour);
      say(`col ${kind} ${name(el)}`, `B17 ${kind} is ${what}, not the ${svc} accent (${hex(t.base)} / ${hex(t.fg)}): ${name(el)} in [data-service="${el.closest("[data-service]")?.getAttribute("data-service") ?? "—"}"]`);
    }
    const bg = against === "self" ? bgOf(el, true) : bgOf(el);
    const r = ratio(over(colour, bg), bg);
    ratios.push({ svc, kind, ratio: +r.toFixed(2), bg: hex(bg) });
    if (r < 3) say(`cr ${kind} ${name(el)}`, `B17 ${kind} ${hex(colour)} on ${hex(bg)} is ${r.toFixed(2)}:1 (< 3): ${name(el)}`);
  };
  for (const [sel, how, against, kind] of STATES) {
    for (const el of document.querySelectorAll(sel)) {
      if (inKit(el) || !visible(el)) continue;
      audited.add(el);
      judge(el, paint(el, how), against, kind, sel);
    }
  }
  // Any other checked, selected or pressed element: some part of it must be drawn in its accent
  // (the edge, the fill, a bar, the tint), and none of it in the neutral ink.
  const inkC = ink();
  for (const el of document.querySelectorAll('[aria-checked="true"], [aria-selected="true"], [aria-pressed="true"], .on, .selected, .active')) {
    if (inKit(el) || !visible(el) || el.matches(".btn, .val-on, .rank, .meter > i, .dot, .segs > i, .term-after, .on-art, .anno")) continue;
    if ([...audited].some((a) => a === el || a.contains(el) || el.contains(a))) continue;
    const svc = svcOf(el);
    const t = tokens(el, svc);
    const parts = ["bg", "border", "bottom", "bar", "ring", "before", "after", "outline"].map((h) => paint(el, h));
    const box = el.querySelector(":scope > .box, :scope > .switch, :scope > .check > .box, :scope > .radio > .box");
    if (box) parts.push(paint(box, "bg"), paint(box, "border"));
    if (parts.some((c) => same(c, inkC) && !same(c, rgba(getComputedStyle(el).color)))) say(`ink ${name(el)}`, `B17 selection drawn in the neutral ink: ${name(el)}`);
    else if (!parts.some((c) => same(c, t.base) || same(c, t.fg) || same(c, t.subtle)))
      say(`gen ${name(el)}`, `B17 selected state shows no ${svc} accent: ${name(el)}`);
  }
  // Status never takes a service accent (unless that is its own tone token).
  const TONES = ["success", "warning", "danger", "info", "signed", "error", "failed"];
  for (const el of document.querySelectorAll(TONES.map((t) => "." + t).join(","))) {
    if (inKit(el) || !visible(el)) continue;
    const tone = TONES.find((t) => el.classList.contains(t));
    const cs = getComputedStyle(el);
    const toneKey = tone === "error" || tone === "failed" ? "danger" : tone;
    const own = ["", "-border", "-subtle", "-on", "-mark"].map((s) => rgba(cs.getPropertyValue(`--pk-${toneKey}${s}`).trim()));
    const accents = allAccents(el);
    const parts = [
      ["text", rgba(cs.color)],
      ["fill", rgba(cs.backgroundColor)],
      ["edge", paint(el, "border")],
      ["glyph", el.querySelector(":scope > .ic, :scope > .dot") ? rgba(getComputedStyle(el.querySelector(":scope > .ic, :scope > .dot")).color) : [0, 0, 0, 0]],
    ];
    for (const [k, c] of parts) {
      if (c[3] < 0.5 || own.some((o) => same(o, c))) continue;
      const hit = accents.find((a) => same(a.c, c));
      if (hit) say(`st ${name(el)} ${k}`, `B17 status .${tone} ${k} is the ${hit.s} accent ${hex(c)}: ${name(el)}`);
    }
  }
  // Text in a service accent reads at 4.5:1 (3:1 from 24px).
  for (const el of document.body.querySelectorAll("*")) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || inKit(el) || el.closest("svg, .art, pre, .code, .term") || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const c = rgba(cs.color);
    const hit = allAccents(el).find((a) => same(a.c, c));
    if (!hit) continue;
    const bg = bgOf(el, true);
    const r = ratio(c, bg);
    const large = parseFloat(cs.fontSize) >= 24;
    ratios.push({ svc: hit.s, kind: "accent text", ratio: +r.toFixed(2), bg: hex(bg) });
    if (r < (large ? 3 : 4.5)) say(`tx ${name(el)}`, `B17 accent text ${hex(c)} on ${hex(bg)} is ${r.toFixed(2)}:1 (< ${large ? 3 : 4.5}): ${name(el)}`);
  }
  return { out, ratios };
}

/** Focus every focusable control in turn: its ring (or the ring its container draws for it) is in
 *  the accent of its nearest data-service and at least 3:1 against what it sits on. */
async function b17Focus(p) {
  return p.evaluate(() => {
    const out = [];
    const ratios = [];
    const seen = new Set();
    const cvs = document.createElement("canvas");
    cvs.width = cvs.height = 1;
    const c2 = cvs.getContext("2d", { willReadFrequently: true });
    const rgba = (s) => {
      if (!s || s === "transparent") return [0, 0, 0, 0];
      c2.clearRect(0, 0, 1, 1);
      c2.fillStyle = "rgba(0,0,0,0)";
      c2.fillStyle = s;
      c2.fillRect(0, 0, 1, 1);
      const d = c2.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const hex = (c) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
    const same = (a, b) => a[3] > 0.99 && b[3] > 0.99 && Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2;
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const over = (top, under) => [0, 1, 2].map((i) => Math.round(top[i] * top[3] + under[i] * (1 - top[3]))).concat(1);
    const bgOf = (el, self) => {
      const stack = [];
      for (let a = self ? el : el.parentElement; a; a = a.parentElement) {
        const c = rgba(getComputedStyle(a).backgroundColor);
        if (c[3] > 0) stack.push(c);
        if (c[3] > 0.99) break;
      }
      let col = rgba(getComputedStyle(document.body).backgroundColor);
      if (col[3] < 0.99) col = rgba(getComputedStyle(document.documentElement).getPropertyValue("--pk-surface-page"));
      for (let i = stack.length - 1; i >= 0; i--) col = over(stack[i], col);
      return col;
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      for (let a = el; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      }
      return true;
    };
    const OPT_IN = new Set(["kit-next", "kit-prod", "kit-cfg"]);
    const inKit = (el) => {
      for (let a = el; a && a !== document.body; a = a.parentElement)
        for (const c of a.classList) {
          if (c.startsWith("kit-") && !OPT_IN.has(c)) return true;
          if (/^(host-|term|ide-|device-status|window-bar|browser-bar|anno)/.test(c)) return true;
        }
      return false;
    };
    const svcOf = (el) => {
      const s = el.closest("[data-service]");
      const t = el.parentElement?.closest("[data-theme]:not(html)");
      if (t && (!s || s.contains(t)) && t !== s) return "core";
      const v = s?.getAttribute("data-service") || "core";
      return v === "commerce" ? "distribution" : v;
    };
    const name = (el) => {
      const t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
      return `${el.tagName.toLowerCase()}${[...el.classList].map((c) => "." + c).join("")}${t ? ` "${t}"` : ""}`;
    };
    const ringOf = (el) => {
      for (let a = el, i = 0; a && i < 5; a = a.parentElement, i++) {
        const cs = getComputedStyle(a);
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) return { el: a, c: rgba(cs.outlineColor), inset: parseFloat(cs.outlineOffset) < 0 };
      }
      return null;
    };
    const focusables = [...document.querySelectorAll('a[href], button, summary, [tabindex]:not([tabindex="-1"]), input, select, textarea, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], .btn')];
    for (const el of focusables) {
      if (inKit(el) || !visible(el) || el.closest("[inert], [aria-hidden='true']")) continue;
      el.focus({ focusVisible: true, preventScroll: true });
      if (document.activeElement !== el) continue;
      const ring = ringOf(el);
      if (!ring) {
        const k = "none " + name(el);
        if (!seen.has(k)) (seen.add(k), out.push(`B17 focus draws no ring: ${name(el)}`));
        continue;
      }
      const svc = svcOf(ring.el === el ? el : ring.el);
      const cs = getComputedStyle(el);
      const base = rgba(cs.getPropertyValue(`--pk-service-${svc}`).trim());
      const fg = rgba(cs.getPropertyValue(`--pk-service-${svc}-fg`).trim());
      if (!same(ring.c, base) && !same(ring.c, fg)) {
        const k = "col " + name(el);
        if (!seen.has(k)) (seen.add(k), out.push(`B17 focus ring is ${hex(ring.c)}, not the ${svc} accent (${hex(base)} / ${hex(fg)}): ${name(el)}`));
      }
      const bg = ring.inset ? bgOf(ring.el, true) : bgOf(ring.el);
      const r = ratio(over(ring.c, bg), bg);
      ratios.push({ svc, kind: "focus ring", ratio: +r.toFixed(2), bg: hex(bg) });
      if (r < 3) {
        const k = "cr " + name(el);
        if (!seen.has(k)) (seen.add(k), out.push(`B17 focus ring ${hex(ring.c)} on ${hex(bg)} is ${r.toFixed(2)}:1 (< 3): ${name(el)}`));
      }
      el.blur();
    }
    return { out, ratios };
  });
}

const contrast = new Map(); // `${theme} ${svc} ${kind}` -> { min, bg, screen }
const noteRatios = (theme, id, ratios) => {
  for (const r of ratios) {
    const k = `${theme}\t${r.svc}\t${r.kind}`;
    const cur = contrast.get(k);
    if (!cur || r.ratio < cur.min) contrast.set(k, { min: r.ratio, bg: r.bg, screen: id });
  }
};

const require = createRequire(join(repo, "packages/admin/package.json"));
const { chromium } = require("playwright");
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const browser = await chromium.launch();

for (const s of screens) {
  for (const theme of themes) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
    await ctx.route("**/*", (r) => (r.request().url().startsWith("data:") ? r.continue() : r.abort()));
    const p = await ctx.newPage();
    await p.setContent(doc(s, theme), { waitUntil: "load" });
    await p.evaluate(() => document.fonts.ready);
    if (run.widths) {
      for (const w of WIDTHS) {
        await p.setViewportSize({ width: w, height: 900 });
        const o = await p.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const sw = document.documentElement.scrollWidth;
          if (sw <= vw + 1) return null;
          let worst = null;
          for (const el of document.body.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.right <= vw + 1 || (worst && r.right <= worst.right)) continue;
            let inScroller = false;
            for (let a = el.parentElement; a; a = a.parentElement) {
              const ox = getComputedStyle(a).overflowX;
              if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") {
                inScroller = true;
                break;
              }
            }
            if (!inScroller) worst = { right: r.right, what: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}` };
          }
          return { sw, vw, what: worst?.what };
        });
        if (o) fail(`${s.id} ${w}px ${theme}: page is ${o.sw}px wide (widest: ${o.what ?? "?"})`);
      }
    }
    if (run.layout) {
      for (const [w, h] of AXE_SIZES) {
        await p.setViewportSize({ width: w, height: h });
        const res = await p.evaluate(() => {
          const out = [];
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            for (let a = el; a; a = a.parentElement) {
              const cs = getComputedStyle(a);
              if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
              if (cs.clip === "rect(0px, 0px, 0px, 0px)" || (cs.position === "absolute" && r.width <= 1)) return false;
            }
            return true;
          };
          const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
          // Tables: never wider than twice the region they scroll in.
          for (const tb of document.querySelectorAll("table")) {
            if (!visible(tb)) continue;
            let reg = tb.parentElement;
            while (reg && !["auto", "scroll"].includes(getComputedStyle(reg).overflowX)) reg = reg.parentElement;
            if (reg && reg !== document.documentElement && tb.scrollWidth > 2 * reg.clientWidth + 2)
              out.push(`table ${name(tb)} is ${tb.scrollWidth}px in a ${reg.clientWidth}px region`);
          }
          // Buttons: the label fits.
          for (const b of document.querySelectorAll(".btn, button")) {
            if (!visible(b) || !(b.textContent || "").trim() || parseFloat(getComputedStyle(b).fontSize) === 0) continue;
            const cs = getComputedStyle(b);
            const box = b.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(b);
            const r = range.getBoundingClientRect();
            const left = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - 2;
            const right = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) + 2;
            if (r.left < left || r.right > right) out.push(`button "${b.textContent.trim().slice(0, 30)}" label overflows its box`);
          }
          // The active sidebar item is inside the sidebar's viewport, above its pinned foot.
          for (const sb of document.querySelectorAll(".console > .sidebar")) {
            if (!visible(sb)) continue;
            const act = [...sb.querySelectorAll(".nav-item.active, .nav-label.active")].find(visible);
            if (!act) continue;
            const s = sb.getBoundingClientRect();
            const foot = sb.querySelector(":scope > .sidebar-foot");
            const limit = foot && visible(foot) && !foot.contains(act) ? foot.getBoundingClientRect().top : s.bottom;
            const r = act.getBoundingClientRect();
            if (r.top < s.top - 1 || r.bottom > limit + 1) out.push(`active nav item "${act.textContent.trim()}" is outside the sidebar's viewport`);
          }
          // Type: no visible text under 12px, nothing at 700 (B6, B7). In-app kit frames draw native
          // platform sizes and the host's own art, so they are left out.
          const seen = new Set();
          for (const el of document.body.querySelectorAll("*")) {
            if (el.closest(".device-status, .window-bar, .host-game, .kit-host, .ide-bar, .term-bar, svg, .art")) continue;
            const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
            if (!own || !visible(el)) continue;
            const cs = getComputedStyle(el);
            const fs = parseFloat(cs.fontSize);
            const key = name(el);
            if (fs > 0 && fs < 11.95 && !seen.has("s" + key)) { seen.add("s" + key); out.push(`text ${fs.toFixed(1)}px in ${key} "${el.textContent.trim().slice(0, 24)}"`); }
            if (parseInt(cs.fontWeight) >= 700 && !seen.has("w" + key)) { seen.add("w" + key); out.push(`weight ${cs.fontWeight} in ${key} "${el.textContent.trim().slice(0, 24)}"`); }
          }
          return out;
        });
        for (const v of res) fail(`${s.id} ${w}px ${theme}: ${v}`);
      }
    }
    if (run.b17) {
      for (const [w, h] of B17_SIZES) {
        await p.setViewportSize({ width: w, height: h });
        const a = await p.evaluate(b17Audit);
        await p.keyboard.press("Shift");
        const f = await b17Focus(p);
        noteRatios(theme, s.id, [...a.ratios, ...f.ratios]);
        for (const v of [...a.out, ...f.out]) fail(`${s.id} ${w}px ${theme}: ${v}`);
      }
    }
    if (run.axe) {
      await p.addScriptTag({ content: axeSource });
      for (const [w, h] of AXE_SIZES) {
        await p.setViewportSize({ width: w, height: h });
        const res = await p.evaluate(async () => {
          const r = await window.axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
          });
          return r.violations.map((v) => ({ id: v.id, n: v.nodes.length, first: v.nodes.slice(0, 3).map((x) => x.target.join(" ")) }));
        });
        for (const v of res) fail(`${s.id} ${w}px ${theme}: axe ${v.id} ×${v.n} — ${v.first.join(" | ")}`);
      }
    }
    await ctx.close();
  }
  if (!failures.some((f) => f.startsWith(s.id + " ") || f.startsWith(s.id + ":"))) console.log(`✓ ${s.id}`);
}
await browser.close();
if (flag("contrast-report")) {
  console.log("\nB17 contrast, lowest measured ratio per theme, service and kind (floor: 3 for rings, edges and bars, 4.5 for text):");
  for (const k of [...contrast.keys()].sort()) {
    const { min, bg, screen } = contrast.get(k);
    console.log(`  ${k.replace(/\t/g, "  ").padEnd(40)} ${min.toFixed(2).padStart(6)}:1 on ${bg}  (${screen})`);
  }
}
console.log(`${screens.length} screen(s), ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
