// S-23 frame strips: drive the prototypes (and nothing else) through each motion moment in
// Chromium under the Worker's CSP, slow the animations down with the DevTools Animation domain,
// and compose the captured frames into one PNG per moment.
//
//   mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/strips.mjs [filter]
//
// Writes strips/<proto>-<moment>-<theme>.png and strips/report.json (CSP violations and the number
// of running animations per moment). Frame labels are animation time (real time × rate).
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { serve, REPO, PROTO } from "./serve.mjs";

const require = createRequire(`${REPO}packages/admin/package.json`);
const { chromium } = require("playwright");
const OUT = fileURLToPath(new URL("../strips/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const FILTER = process.argv[2] ?? "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalP = (page, fn, ...a) => page.evaluate(fn, ...a);
const call = (page, name, ...args) =>
  page.evaluate(([n, a]) => window.__proto[n](...a), [name, args]);

/** Real-time capture offsets for a slowed moment: `n` frames spread over `anim` ms of animation. */
const spread = (anim, rate, n = 8) =>
  Array.from({ length: n }, (_, i) => Math.round((anim * i) / (n - 1) / rate));

const portal = (
  name,
  { setup, act, rate = 0.1, anim = 420, frames, clip },
) => ({
  proto: "portal",
  name,
  setup,
  act,
  rate,
  clip,
  frames: frames ?? spread(anim, rate),
});
const cons = (name, { setup, act, rate = 0.1, anim = 420, frames, clip }) => ({
  proto: "console",
  name,
  setup,
  act,
  rate,
  clip,
  frames: frames ?? spread(anim, rate),
});

const MOMENTS = [
  portal("01-library-load", {
    setup: async () => {},
    act: async () => {},
    rate: 0.25,
    frames: [0, 450, 700, 760, 900, 1100, 1400, 1900],
  }),
  portal("02-tile-to-product", {
    setup: async (p) => sleep(1300),
    act: async (p) => p.click('[data-slug="nightfall"]'),
    anim: 380,
  }),
  portal("03-activate-open", {
    setup: async (p) => {
      await sleep(1300);
      await p.click('[data-slug="nightfall"]');
      await sleep(600);
    },
    act: async (p) => p.click("#activate-open"),
    anim: 360,
  }),
  portal("04-activate-success", {
    clip: "#dialog",
    setup: async (p) => {
      await sleep(1300);
      await p.click('[data-slug="nightfall"]');
      await sleep(600);
      await p.click("#activate-open");
      await sleep(500);
    },
    act: async (p) => p.click("#dialog .btn.primary"),
    rate: 0.1,
    frames: [0, 650, 900, 1500, 2500, 3500, 4800, 6400],
  }),
  portal("05-device-added", {
    clip: "#devices",
    setup: async (p) => {
      await sleep(1300);
      await p.click('[data-slug="nightfall"]');
      await sleep(600);
      await p.click("#activate-open");
      await sleep(400);
      await p.click("#dialog .btn.primary");
      await sleep(1600);
    },
    act: async (p) => p.click("#dialog .btn.primary"),
    rate: 0.1,
    frames: [0, 1000, 2000, 2600, 3200, 4000, 5000, 7000],
  }),
  portal("06-remove-expand", {
    clip: "#devices",
    setup: async (p) => {
      await sleep(1300);
      await p.click('[data-slug="nightfall"]');
      await sleep(600);
    },
    act: async (p) => p.click('[data-id="pc"] .dev .btn'),
    anim: 320,
  }),
  portal("07-remove-confirm", {
    clip: "#devices",
    setup: async (p) => {
      await sleep(1300);
      await p.click('[data-slug="nightfall"]');
      await sleep(600);
      await p.click('[data-id="mbp"] .dev .btn');
      await sleep(500);
    },
    act: async (p) => p.click('[data-id="mbp"] .btn.danger'),
    anim: 480,
  }),
  portal("08-back-to-library", {
    setup: async (p) => {
      await sleep(1300);
      await p.click('[data-slug="tidewater"]');
      await sleep(600);
    },
    act: async (p) => p.click(".back"),
    anim: 380,
  }),
  cons("01-overview-load", {
    setup: async () => {},
    act: async () => {},
    rate: 0.25,
    frames: [0, 500, 700, 800, 1000, 1300, 1700, 2600],
  }),
  cons("02-nav-licenses", {
    setup: async () => sleep(1600),
    act: async (p) => p.click('.side a[data-route="licenses"]'),
    anim: 260,
  }),
  cons("03-filter-chip", {
    clip: ".table",
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
    },
    act: async (p) => p.click(".chip:nth-child(2)"),
    anim: 300,
  }),
  cons("04-row-to-record", {
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
    },
    act: async (p) => p.click('.trow[data-key="pkey_nightfall_9F2C"]'),
    anim: 380,
  }),
  cons("05-tab-switch", {
    clip: "main",
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
      await p.click('.trow[data-key="pkey_nightfall_9F2C"]');
      await sleep(600);
    },
    act: async (p) => p.click(".rtabs button:nth-child(2)"),
    anim: 360,
  }),
  cons("06-drawer-open", {
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
      await p.click('.trow[data-key="pkey_nightfall_9F2C"]');
      await sleep(600);
      await p.click(".rtabs button:nth-child(2)");
      await sleep(600);
    },
    act: async (p) => p.click('.trow[data-id="d1"]'),
    anim: 360,
  }),
  cons("07-confirm-open", {
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
      await p.click('.trow[data-key="pkey_nightfall_9F2C"]');
      await sleep(600);
      await p.click(".rtabs button:nth-child(2)");
      await sleep(600);
      await p.click('.trow[data-id="d1"]');
      await sleep(600);
    },
    act: async (p) => p.click("#drawer .btn.danger"),
    anim: 360,
  }),
  cons("08-deauthorize-toast", {
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
      await p.click('.trow[data-key="pkey_nightfall_9F2C"]');
      await sleep(600);
      await p.click(".rtabs button:nth-child(2)");
      await sleep(600);
      await p.click('.trow[data-id="d1"]');
      await sleep(600);
      await p.click("#drawer .btn.danger");
      await sleep(600);
    },
    act: async (p) => p.click("#dialog .btn.danger"),
    rate: 0.1,
    frames: [0, 1000, 2000, 3000, 4000, 5000, 6500, 9000],
  }),
  cons("09-palette", {
    setup: async () => sleep(1600),
    act: async (p) => p.click("#palette-open"),
    anim: 360,
  }),
  cons("10-theme", {
    setup: async () => sleep(1600),
    act: async (p) => p.click("#t-theme"),
    anim: 220,
  }),
];

const VARIANTS = [
  { theme: "dark", motion: "full" },
  { theme: "light", motion: "full" },
  { theme: "dark", motion: "reduce" },
];

const { server, base } = await serve();
const browser = await chromium.launch();
const report = {
  chromium: browser.version(),
  viewport: "1280x800",
  moments: {},
};

for (const variant of VARIANTS) {
  for (const m of MOMENTS) {
    const id = `${m.proto}-${m.name}-${variant.theme}${variant.motion === "reduce" ? "-reduced" : ""}`;
    if (FILTER && !id.includes(FILTER)) continue;
    // Light theme and reduced motion: a representative subset keeps the run short.
    if (
      variant.theme === "light" &&
      !/02-|04-|07-|05-tab|08-deauth/.test(m.name)
    )
      continue;
    if (variant.motion === "reduce" && !/02-|07-|04-row|08-deauth/.test(m.name))
      continue;
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: variant.theme,
      reducedMotion: variant.motion === "reduce" ? "reduce" : "no-preference",
    });
    const page = await ctx.newPage();
    const violations = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") violations.push(`console: ${msg.text()}`);
    });
    await page.addInitScript(() => {
      window.__v = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        window.__v.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    });
    await page.goto(`${base}${PROTO}${m.proto}.html?theme=${variant.theme}`);
    await page.waitForFunction(() => !!window.__proto);
    await m.setup(page);
    let clip;
    if (m.clip) {
      const loc = page.locator(m.clip).first();
      await loc.scrollIntoViewIfNeeded();
      await sleep(250);
      const b = await loc.boundingBox();
      const y = Math.max(0, b.y - 24);
      clip = {
        x: Math.max(0, b.x - 24),
        y,
        width: Math.min(1280, b.width + 48),
        height: Math.min(800 - y, b.height + 200),
      };
    }
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: m.rate });
    const shots = [];
    let maxAnimations = 0;
    const t0 = Date.now();
    await m.act(page);
    for (const at of m.frames) {
      const wait = t0 + at - Date.now();
      if (wait > 0) await sleep(wait);
      const real = Date.now() - t0;
      maxAnimations = Math.max(
        maxAnimations,
        await evalP(page, () => document.getAnimations().length),
      );
      shots.push({
        png: (await page.screenshot({ clip })).toString("base64"),
        t: Math.round(real * m.rate),
      });
    }
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    violations.push(...(await evalP(page, () => window.__v)));
    report.moments[id] = {
      violations,
      maxRunningAnimations: maxAnimations,
      rate: m.rate,
    };
    await ctx.close();

    // Compose: 4 frames a row, each 1280×800 scaled to 400×250, labelled with animation time.
    const sheet = await browser.newPage({
      viewport: { width: 1660, height: 600 },
    });
    const cells = shots
      .map(
        (s, i) =>
          `<figure><img src="data:image/png;base64,${s.png}"><figcaption>${i + 1} · t ≈ ${s.t} ms</figcaption></figure>`,
      )
      .join("");
    await sheet.setContent(
      `<style>body{margin:0;padding:16px;background:#0b0e17;font:13px system-ui;color:#c9cbe0}
      h1{font-size:15px;margin:0 0 10px;color:#fff}.g{display:grid;grid-template-columns:repeat(4,400px);gap:12px}
      figure{margin:0}img{width:400px;height:auto;max-height:520px;object-fit:contain;object-position:top;display:block;border:1px solid #2a2f45;border-radius:6px}
      figcaption{margin-top:4px}</style><h1>${id} · playback ×${m.rate} · Chromium ${browser.version()}</h1><div class="g">${cells}</div>`,
    );
    await sheet.screenshot({ path: `${OUT}${id}.png`, fullPage: true });
    await sheet.close();
    console.log(id, JSON.stringify(report.moments[id]));
  }
}
writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
server.close();
