// Screenshots today's Home (the BUILT console over the layout lint's fixtures, under the Worker's
// CSP) as the "before" reference, and prints each product card's measured size.
//
//   mise exec node@22 -- pnpm --filter @polaris-key/admin build
//   mise exec node@22 -- node_modules/.bin/tsx docs/design/console-product-card/_src/today.mts
//
// Output: shots/00-today-<desktop|phone>-<dark|light>.png at device scale 2 (1280 × 800 and
// 390 × 844, the viewport only), palette-quantised like render.mts.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const ADMIN = join(repo, "packages/admin/");
const req = createRequire(ADMIN);
const { chromium } = req("playwright") as typeof import("playwright");
const { preview } = (await import(
  req.resolve("vite")
)) as typeof import("vite");
const sharp = createRequire(join(repo, "packages/brand/package.json"))(
  "sharp",
) as typeof import("sharp");
const { resolve } = await import(join(ADMIN, "e2e/layoutFixtures.ts"));
const { appSecurityHeaders } = await import(
  join(repo, "packages/worker/src/core/securityHeaders.ts")
);
const CSP = appSecurityHeaders().get("content-security-policy")!;
const out = join(here, "..", "shots");

const server = await preview({
  root: ADMIN,
  configFile: join(ADMIN, "vite.config.ts"),
  preview: { port: 0, strictPort: false, host: "127.0.0.1" },
  logLevel: "silent",
});
const base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
const browser = await chromium.launch();
const shots: string[] = [];
try {
  for (const [name, vp] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const theme of ["dark", "light"] as const) {
      const ctx = await browser.newContext({
        viewport: vp,
        colorScheme: theme,
        reducedMotion: "reduce",
        deviceScaleFactor: 2,
      });
      await ctx.addInitScript((t) => {
        window.localStorage.setItem("pk-admin-theme", t);
      }, theme);
      await ctx.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/manage/api/")) {
          const body = resolve(url.pathname);
          if (body === undefined)
            return route.fulfill({ status: 404, json: { error: "not_found" } });
          return route.fulfill({ json: body });
        }
        const res = await route.fetch();
        const headers = { ...res.headers() };
        if (url.pathname.endsWith(".html"))
          headers["content-security-policy"] = CSP;
        return route.fulfill({ response: res, headers });
      });
      const page = await ctx.newPage();
      await page.goto(`${base}/manage.html#/`);
      const list = page.locator("ul[aria-label=Products]");
      await list.locator("article").first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(400);
      const sizes = await list.locator("article").evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return `${Math.round(r.width)}x${Math.round(r.height)}`;
        }),
      );
      console.log(`${name} ${theme}: cards ${sizes.join(" ")}`);
      await list.scrollIntoViewIfNeeded();
      const path = join(out, `00-today-${name}-${theme}.png`);
      await page.screenshot({ path });
      shots.push(path);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.httpServer.close(() => r()));
}
for (const path of shots) {
  const buf = await sharp(path)
    .png({ palette: true, quality: 90, effort: 10 })
    .toBuffer();
  await sharp(buf).toFile(path);
}
