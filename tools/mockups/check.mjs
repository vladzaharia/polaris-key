#!/usr/bin/env node
// Checks mockup screens in a real browser, without writing screenshots:
//   - no sideways scroll at every width from 320 to 2560 (WIDTHS below, both themes);
//   - axe (WCAG 2.2 A/AA rules) at 390, 1024, 1440 and 1920 in both themes: zero violations;
//   - the kit rule: a screen sets no margin, padding or gap of its own (README "Rules").
//
//   mise exec node@22 -- node tools/mockups/check.mjs --all
//   mise exec node@22 -- node tools/mockups/check.mjs --screen identity.sign-in,portal.library
//   mise exec node@22 -- node tools/mockups/check.mjs --area portal --no-axe
//
// Options: --all | --area <key> | --screen <id> (repeatable or comma-separated), --no-axe,
// --no-widths, --themes dark,light. Exits non-zero on any failure and names the screen, the width,
// the theme and the widest element (overflow) or the rule and its first nodes (axe).
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
    if (!flag("no-widths")) {
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
    if (!flag("no-axe")) {
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
console.log(`${screens.length} screen(s), ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
