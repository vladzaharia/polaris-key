// S-23 baseline: frame strips of TODAY's portal (the built SPA, on the e2e fixtures, under the
// Worker's CSP), to show what moves now. Run after `pnpm --filter @polaris-key/admin build`:
//
//   cd packages/admin && mise exec node@22 -- npx tsx \
//     ../../docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/real-app.ts
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { appSecurityHeaders } from "../../../../../../packages/worker/src/platform/securityHeaders.js";
import {
  portalMedia,
  portalRoutes,
} from "../../../../../../packages/admin/e2e/portalFixtures.js";

const admin = fileURLToPath(
  new URL("../../../../../../packages/admin/", import.meta.url),
);
// Resolve the admin package's own Playwright and Vite (this file lives outside the workspace).
const req = createRequire(`${admin}package.json`);
const { chromium } = req("playwright") as typeof import("playwright");
const { preview } = (await import(
  pathToFileURL(req.resolve("vite")).href
)) as typeof import("vite");
const OUT = fileURLToPath(new URL("../strips/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const CSP = appSecurityHeaders().get("content-security-policy")!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = await preview({
  root: admin,
  configFile: `${admin}vite.config.ts`,
  preview: { port: 0, strictPort: false, host: "127.0.0.1" },
  logLevel: "silent",
});
const base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
const browser = await chromium.launch();

async function open(): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  await ctx.addInitScript(() => localStorage.setItem("pk-admin-theme", "dark"));
  const routes = portalRoutes("three");
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/") || url.pathname === "/logout") {
      const handler =
        routes[`${req.method()} ${url.pathname}`] ?? routes[url.pathname];
      if (!handler)
        return route.fulfill({ status: 404, json: { error: "not_found" } });
      const res =
        typeof handler === "function" ? handler(req as never) : handler;
      return route.fulfill({ status: res.status ?? 200, json: res.body });
    }
    if (url.pathname.startsWith("/media/")) {
      const png = portalMedia(url.pathname);
      return png
        ? route.fulfill({ status: 200, contentType: "image/png", body: png })
        : route.fulfill({ status: 404 });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html") || url.pathname === "/")
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.getByRole("heading", { level: 1, name: "Your library" }).waitFor();
  await sleep(400);
  return page;
}

async function strip(
  id: string,
  page: Page,
  act: () => Promise<void>,
  frames: number[],
  rate = 0.1,
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: rate });
  const shots: { png: string; t: number; n: number }[] = [];
  const t0 = Date.now();
  await act();
  for (const at of frames) {
    const wait = t0 + at - Date.now();
    if (wait > 0) await sleep(wait);
    const n = await page.evaluate(() => document.getAnimations().length);
    shots.push({
      png: (await page.screenshot()).toString("base64"),
      t: Math.round((Date.now() - t0) * rate),
      n,
    });
  }
  const sheet = await browser.newPage({
    viewport: { width: 1660, height: 600 },
  });
  const cells = shots
    .map(
      (s, i) =>
        `<figure><img src="data:image/png;base64,${s.png}"><figcaption>${i + 1} · t ≈ ${s.t} ms · ${s.n} running animations</figcaption></figure>`,
    )
    .join("");
  await sheet.setContent(
    `<style>body{margin:0;padding:16px;background:#0b0e17;font:13px system-ui;color:#c9cbe0}h1{font-size:15px;margin:0 0 10px;color:#fff}
    .g{display:grid;grid-template-columns:repeat(4,400px);gap:12px}figure{margin:0}img{width:400px;display:block;border:1px solid #2a2f45;border-radius:6px}</style>
    <h1>TODAY · ${id} · playback ×${rate}</h1><div class="g">${cells}</div>`,
  );
  await sheet.screenshot({ path: `${OUT}today-${id}.png`, fullPage: true });
  await sheet.close();
  console.log(id, shots.map((s) => s.n).join(","));
}

const spread = [0, 300, 600, 900, 1200, 1500, 2000, 3000];

let page = await open();
await strip(
  "portal-activate-open",
  page,
  () =>
    page
      .getByRole("button", { name: /Activate license/ })
      .first()
      .click(),
  spread,
);
await strip(
  "portal-activate-close",
  page,
  () => page.keyboard.press("Escape"),
  spread,
);
await page.context().close();

page = await open();
await strip(
  "portal-library-to-product",
  page,
  () =>
    page
      .getByRole("link", { name: /Nightfall/ })
      .first()
      .click(),
  spread,
);
await page.context().close();

await browser.close();
await new Promise<void>((r) => server.httpServer.close(() => r()));
