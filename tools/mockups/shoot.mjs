#!/usr/bin/env node
// Renders mockup screens to PNG: docs/design/mockups/screens/<area>/<id>.html, wrapped in a
// document with the kit stylesheet, at desktop (1440×900), wide (1920×1080), tablet (1024×768) and
// phone (390×844), dark and light (the owner, 2026-10-08: test every screen at several resolutions),
// full page.
//
//   mise exec node@22 -- node tools/mockups/shoot.mjs --area products --out /Users/vlad/Repos/pk-wt/_mockups/shots/products
//   mise exec node@22 -- node tools/mockups/shoot.mjs --all --out /Users/vlad/Repos/pk-wt/_mockups/shots
//   mise exec node@22 -- node tools/mockups/shoot.mjs --screen products.home --out /tmp/shots
//   mise exec node@22 -- node tools/mockups/shoot.mjs --gallery --out /Users/vlad/Repos/pk-wt/_mockups/shots/kit
//
// Options
//   --area <key>        one area (repeatable, or comma-separated)
//   --all               every area in docs/design/mockups/areas.json; files go to <out>/<area>/
//   --screen <id>       only these screen ids (repeatable, or comma-separated)
//   --gallery           the kit's component gallery (docs/design/mockups/kit/gallery.html), as kit.gallery
//   --out <dir>         output directory (default /Users/vlad/Repos/pk-wt/_mockups/shots[/<area>])
//   --sizes wide,desktop,tablet,phone (default: all four; portrait 834×1194 is opt-in)   --themes dark,light   --scale 1 (device pixel ratio)
//   --html <dir>        also write each composed page (<id>.<theme>.html) for opening in a browser
//   --check             validate the screen contract only; render nothing
//
// Writes <id>.{wide,desktop,tablet,phone}-{light,dark}.png: eight shots per screen, every one to
// be opened and judged (kit/README.md "Four sizes"). Deterministic: the fonts are embedded and awaited, animations and
// transitions are off, the caret is hidden, and every network request is refused (a mockup
// makes none). It exits non-zero on a contract error, a console error, a failed font, a blocked
// request, or a page wider than its viewport (sideways scroll). Phone shots, and any shot of a page
// taller than its viewport, draw the portal's fixed bottom bar and toasts at the end of the page,
// so they cover nothing mid-page.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const ROOT = join(repo, "docs/design/mockups");
const SCREENS = join(ROOT, "screens");
const KIT = join(ROOT, "kit/mockup.css");
const DEFAULT_OUT = "/Users/vlad/Repos/pk-wt/_mockups/shots";

const SIZES = {
  desktop: { width: 1440, height: 900 },
  wide: { width: 1920, height: 1080 },
  tablet: { width: 1024, height: 768 },
  phone: { width: 390, height: 844 },
  // Opt-in (--sizes portrait): a portrait tablet, where a split layout (the hosted card's passport,
  // device-code and activation screens) stacks.
  portrait: { width: 834, height: 1194 },
};
const DEFAULT_SIZES = ["wide", "desktop", "tablet", "phone"];
const SURFACES = ["console", "portal", "terminal", "code", "kit", "dialog"];
const REQUIRED = [
  "id",
  "title",
  "area",
  "surface",
  "packages",
  "uxRows",
  "summary",
  "compare",
  "status",
  "designReview",
];

// ── Arguments ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const many = (k) =>
  argv
    .flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : a.startsWith(`--${k}=`) ? [a.split("=")[1]] : []))
    .flatMap((v) => (v ?? "").split(","))
    .filter(Boolean);
const one = (k, d) => many(k)[0] ?? d;
const flag = (k) => argv.includes(`--${k}`);

const areasJson = JSON.parse(readFileSync(join(ROOT, "areas.json"), "utf8"));
const AREA_KEYS = areasJson.map((a) => a.key);
const all = flag("all");
const gallery = flag("gallery");
let areas = all ? AREA_KEYS : many("area");
const onlyScreens = many("screen");
if (!areas.length && onlyScreens.length) {
  areas = [...new Set(onlyScreens.map((id) => id.split(".")[0]))];
}
if (!areas.length && !gallery) {
  console.error("Pass --area <key>, --screen <id>, --all or --gallery. Areas: " + AREA_KEYS.join(", "));
  process.exit(2);
}
for (const a of areas) {
  if (!AREA_KEYS.includes(a)) {
    console.error(`Unknown area "${a}". Areas: ${AREA_KEYS.join(", ")}`);
    process.exit(2);
  }
}
const sizes = many("sizes").length ? many("sizes") : DEFAULT_SIZES;
const themes = many("themes").length ? many("themes") : ["dark", "light"];
const scale = Number(one("scale", "1"));
const htmlDir = one("html", "");
const checkOnly = flag("check");
const outArg = one("out", "");
const outFor = (area) =>
  outArg ? (all || areas.length > 1 ? join(outArg, area) : outArg) : join(DEFAULT_OUT, area);

// ── The screen contract ───────────────────────────────────────────────────────────────────

const problems = [];
const problem = (id, msg) => problems.push(`${id}: ${msg}`);

function loadScreens(area) {
  const dir = join(SCREENS, area);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".html"));
  const list = [];
  for (const f of files.sort()) {
    const id = f.replace(/\.html$/, "");
    if (onlyScreens.length && !onlyScreens.includes(id)) continue;
    const html = readFileSync(join(dir, f), "utf8");
    const metaPath = join(dir, `${id}.json`);
    let meta = null;
    if (!id.startsWith(`${area}.`)) problem(id, `id must start with "${area}."`);
    if (!/^[a-z]+\.[a-z0-9-]+$/.test(id)) problem(id, 'id must be "<area>.<slug>" (lowercase, digits, hyphens)');
    if (!existsSync(metaPath)) problem(id, `missing ${id}.json`);
    else {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch (e) {
        problem(id, `${id}.json is not JSON: ${e.message}`);
      }
    }
    if (meta) {
      for (const k of REQUIRED) if (!(k in meta)) problem(id, `${id}.json lacks "${k}"`);
      if (meta.id !== id) problem(id, `${id}.json "id" is "${meta.id}"`);
      if (meta.area !== area) problem(id, `${id}.json "area" is "${meta.area}"`);
      if (!SURFACES.includes(meta.surface)) problem(id, `"surface" must be one of ${SURFACES.join(", ")}`);
      if (!Array.isArray(meta.packages)) problem(id, '"packages" must be an array of package ids');
      if (!Array.isArray(meta.uxRows)) problem(id, '"uxRows" must be an array');
      if (!Array.isArray(meta.compare) || !meta.compare.length) problem(id, '"compare" must list what to check');
    }
    if (/<\/?(html|head|body)[\s>]/i.test(html)) problem(id, "the .html is body markup only (no <html>, <head> or <body>)");
    if (/<link\b|<script\b[^>]*\bsrc=|<img\b[^>]*\bsrc=["']https?:|url\(\s*["']?https?:|@import/i.test(html)) {
      problem(id, "no external resources (links, script src, remote images, @import)");
    }
    if (/lorem ipsum/i.test(html)) problem(id, "lorem ipsum: use realistic content");
    list.push({ id, area, html, meta });
  }
  return list;
}

const screens = areas.flatMap((a) => loadScreens(a).map((s) => ({ ...s, out: outFor(a) })));
if (gallery) {
  screens.push({
    id: "kit.gallery",
    area: "kit",
    html: readFileSync(join(ROOT, "kit/gallery.html"), "utf8"),
    meta: { title: "Mockup kit gallery" },
    out: outArg && areas.length === 0 ? outArg : join(outArg || DEFAULT_OUT, "kit"),
  });
}
if (!screens.length) {
  console.error(`No screens found for ${areas.join(", ")}${onlyScreens.length ? ` matching ${onlyScreens.join(", ")}` : ""}.`);
  process.exit(problems.length ? 1 : 2);
}
if (checkOnly || problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  console.log(`✓ ${screens.length} screen(s) meet the contract`);
  process.exit(0);
}

// ── Render ────────────────────────────────────────────────────────────────────────────────

const kitCss = readFileSync(KIT, "utf8");
/** Mockups never move: no animation, no transition, no caret. */
const FREEZE = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`;
/** Phone shots (and long pages at any size): the portal's fixed bottom bar and the toasts (portal or console) sit at the page's end, not mid-page. */
const PHONE_FULL_PAGE = `.portal>.portal-tabbar,.portal>.toasts,.console>.toasts{position:absolute!important}`;
/** A pinned save bar (.save-bar.pinned, sticky to the window's bottom) is drawn where it rests, at the end of its record, so a full-page shot covers nothing. */
const REST_PINNED = `.save-bar.pinned,.mk-action-bar,.drawer-foot.sticky-foot{position:static!important}`;

const page = (s, theme) =>
  `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${s.meta?.title ?? s.id}</title><style>${kitCss}</style><style>${FREEZE}${REST_PINNED}</style></head><body data-screen="${s.id}">${s.html}</body></html>`;

const require = createRequire(join(repo, "packages/admin/package.json"));
const { chromium } = require("playwright");
const browser = await chromium.launch();
let failed = false;
let count = 0;

for (const s of screens) {
  mkdirSync(s.out, { recursive: true });
  for (const theme of themes) {
    const doc = page(s, theme);
    if (htmlDir) {
      mkdirSync(htmlDir, { recursive: true });
      writeFileSync(join(htmlDir, `${s.id}.${theme}.html`), doc);
    }
    for (const size of sizes) {
      const vp = SIZES[size];
      if (!vp) throw new Error(`Unknown size "${size}"`);
      const ctx = await browser.newContext({
        viewport: vp,
        deviceScaleFactor: scale,
        colorScheme: theme,
        reducedMotion: "reduce",
        javaScriptEnabled: true,
      });
      const tag = `${s.id} ${size}-${theme}`;
      const errors = [];
      await ctx.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url === "about:blank") return route.continue();
        errors.push(`blocked request ${url}`);
        return route.abort();
      });
      const p = await ctx.newPage();
      p.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
      p.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
      await p.setContent(doc, { waitUntil: "load" });
      // A full-page shot paints fixed elements at the viewport's bottom line, in the middle of a
      // long phone page, over the content under them. Draw the portal's bottom bar and any toasts
      // at the end of the page instead (.portal or .console is their positioned box), as when scrolled down.
      if (size === "phone") await p.addStyleTag({ content: PHONE_FULL_PAGE });
      const fonts = await p.evaluate(async () => {
        await Promise.all([
          document.fonts.load('400 16px "Rubik"'),
          document.fonts.load('500 16px "Rubik"'),
          document.fonts.load('600 16px "Rubik"'),
          document.fonts.load('400 16px "JetBrains Mono"'),
          document.fonts.load('600 16px "JetBrains Mono"'),
        ]);
        await document.fonts.ready;
        return {
          failed: [...document.fonts].filter((f) => f.status === "error").map((f) => f.family),
          ok: document.fonts.check('400 16px "Rubik"') && document.fonts.check('400 16px "JetBrains Mono"'),
        };
      });
      if (fonts.failed.length || !fonts.ok) errors.push(`fonts failed: ${fonts.failed.join(", ") || "not loaded"}`);
      // The same at any size whose page is taller than its viewport: a toast fixed to the first
      // viewport's bottom would otherwise sit over the page's content (a tablet Discover's tiles).
      if (size !== "phone" && (await p.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1)))
        await p.addStyleTag({ content: PHONE_FULL_PAGE });
      const overflow = await p.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const sw = document.documentElement.scrollWidth;
        if (sw <= w + 1) return null;
        // Name the widest offender that is not inside a scroller of its own.
        let worst = null;
        for (const el of document.body.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.right > w + 1 && (!worst || r.right > worst.right)) {
            let scroller = false;
            for (let a = el.parentElement; a; a = a.parentElement) {
              const o = getComputedStyle(a).overflowX;
              if (o === "auto" || o === "scroll" || o === "hidden") {
                scroller = true;
                break;
              }
            }
            if (!scroller) worst = { right: r.right, what: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}` };
          }
        }
        return { sw, w, what: worst?.what };
      });
      if (overflow) errors.push(`page is ${overflow.sw}px wide at a ${overflow.w}px viewport (sideways scroll; widest: ${overflow.what ?? "?"})`);
      await p.waitForTimeout(50);
      const file = join(s.out, `${s.id}.${size}-${theme}.png`);
      await p.screenshot({ path: file, fullPage: true, animations: "disabled", caret: "hide" });
      count++;
      if (errors.length) {
        failed = true;
        for (const e of errors) console.error(`✗ ${tag}: ${e}`);
      } else {
        console.log(`✓ ${tag}`);
      }
      await ctx.close();
    }
  }
}
await browser.close();
console.log(`${count} PNG(s) written${failed ? ", with errors" : ""}.`);
if (failed) process.exit(1);
