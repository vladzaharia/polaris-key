// S-23 frame-time check: run each motion moment in Chromium at CPU throttling 1×, 4× and 6×
// (DevTools Emulation.setCPUThrottlingRate) and record requestAnimationFrame intervals for 700 ms
// after the action. Writes strips/perf.json and prints a table.
//
//   mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/perf.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { serve, REPO, PROTO } from "./serve.mjs";

const require = createRequire(`${REPO}packages/admin/package.json`);
const { chromium } = require("playwright");
const OUT = fileURLToPath(new URL("../strips/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOMENTS = [
  {
    name: "portal: tile → product (shared element)",
    url: "portal.html",
    setup: async () => sleep(1300),
    act: (p) => p.click('[data-slug="nightfall"]'),
  },
  {
    name: "portal: free a device (list)",
    url: "portal.html",
    setup: async (p) => {
      await sleep(1300);
      await p.click('[data-slug="nightfall"]');
      await sleep(500);
      await p.click('[data-id="mbp"] .dev .btn');
      await sleep(400);
    },
    act: (p) => p.click('[data-id="mbp"] .btn.danger'),
  },
  {
    name: "portal: library load (stagger + skeleton)",
    url: "portal.html",
    setup: async () => {},
    act: async () => {},
    window: 1400,
  },
  {
    name: "console: overview load (count-up, meter, burst)",
    url: "console.html",
    setup: async () => {},
    act: async () => {},
    window: 1500,
  },
  {
    name: "console: filter 8 rows (list)",
    url: "console.html",
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
    },
    act: (p) => p.click(".chip:nth-child(2)"),
  },
  {
    name: "console: filter 60 rows (list)",
    url: "console.html?rows=60",
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
    },
    act: (p) => p.click(".chip:nth-child(2)"),
  },
  {
    name: "console: filter 200 rows (list)",
    url: "console.html?rows=200",
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(800);
    },
    act: (p) => p.click(".chip:nth-child(2)"),
  },
  {
    name: "console: row → record (forward)",
    url: "console.html",
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
    },
    act: (p) => p.click('.trow[data-key="pkey_nightfall_9F2C"]'),
  },
  {
    name: "console: drawer open",
    url: "console.html",
    setup: async (p) => {
      await sleep(1200);
      await p.click('.side a[data-route="licenses"]');
      await sleep(500);
      await p.click('.trow[data-key="pkey_nightfall_9F2C"]');
      await sleep(500);
      await p.click(".rtabs button:nth-child(2)");
      await sleep(500);
    },
    act: (p) => p.click('.trow[data-id="d1"]'),
  },
];

const { server, base } = await serve();
const browser = await chromium.launch();
const results = {
  chromium: browser.version(),
  host: process.platform,
  rows: [],
};
// The baseline: the same change as an instant swap (reduced motion), to separate the cost of
// rendering the new state from the cost of the transition.
for (const name of [
  "portal: tile → product (shared element)",
  "console: filter 60 rows (list)",
  "console: filter 200 rows (list)",
])
  MOMENTS.push({
    ...MOMENTS.find((m) => m.name === name),
    name: `${name} [instant baseline]`,
    reduced: true,
  });
for (const m of MOMENTS) {
  for (const rate of [1, 4, 6]) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: m.reduced ? "reduce" : "no-preference",
    });
    const page = await ctx.newPage();
    await page.goto(`${base}${PROTO}${m.url}`);
    await page.waitForFunction(() => !!window.__proto);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await m.setup(page);
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const tick = (t) => {
        window.__frames.push(t - last);
        last = t;
        if (window.__frames.length < 400) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const t0 = Date.now();
    await m.act(page);
    const actMs = Date.now() - t0;
    await sleep(m.window ?? 700);
    const frames = await page.evaluate(() => window.__frames.slice(1));
    await ctx.close();
    const sorted = [...frames].sort((a, b) => a - b);
    const q = (p) =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const row = {
      moment: m.name,
      cpu: `${rate}x`,
      frames: frames.length,
      p50: +q(0.5).toFixed(1),
      p95: +q(0.95).toFixed(1),
      max: +sorted.at(-1).toFixed(1),
      over25ms: frames.filter((f) => f > 25).length,
      actMs,
    };
    results.rows.push(row);
    console.log(JSON.stringify(row));
  }
}
writeFileSync(`${OUT}perf.json`, `${JSON.stringify(results, null, 2)}\n`);
await browser.close();
server.close();
