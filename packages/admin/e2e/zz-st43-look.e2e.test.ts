import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { IMG_ORIGIN, resolve } from "./layoutFixtures.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const OUT = process.env.ST43_SHOTS!;
const CSP = appSecurityHeaders(new Headers(), { imgOrigin: IMG_ORIGIN }).get("content-security-policy")!;
let server: PreviewServer, browser: Browser, base: string;
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  server = await preview({ root: here, configFile: `${here}vite.config.ts`, preview: { port: 0, host: "127.0.0.1" }, logLevel: "silent" });
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
});
const REPOS = { configured: true, app: { slug: "pk", installUrl: "https://github.com/apps/pk/installations/new" },
  installations: [{ id: 1, account: "acme", repositorySelection: "all", repositoryCount: 3, listingError: null }],
  repositories: [
    { installationId: 1, owner: "acme", name: "tonebox", fullName: "acme/tonebox", language: "TypeScript", pushedAt: 1_700_000_000, private: false, defaultBranch: "main", product: null, hasManifest: true },
    { installationId: 1, owner: "acme", name: "beatgrid", fullName: "acme/beatgrid", language: null, pushedAt: null, private: true, defaultBranch: "main", product: "beatgrid", hasManifest: true },
    { installationId: 1, owner: "acme", name: "empty-with-a-very-long-repository-name-to-test-wrapping", fullName: "acme/empty-with-a-very-long-repository-name-to-test-wrapping", language: null, pushedAt: null, private: false, defaultBranch: "main", product: null, hasManifest: false },
  ], total: 3, nextCursor: null };
const DRY = { ok: true, dryRun: true, repository: "acme/tonebox", installationId: 1, commit: "abcdef1234567890", manifestDigest: "d", ready: true,
  product: { slug: "tonebox", name: "Tonebox", presentation: null }, slug: { slug: "tonebox", status: "available" }, registeredAs: null,
  services: ["license", "config"], catalog: { entries: 4 }, platforms: { values: ["macos"], source: "artifact-map" }, secrets: ["SENTRY_AUTH_TOKEN"], releaseWorkflow: true, problems: [] };

for (const [w, h] of [[360, 780], [390, 844], [1440, 900]] as const)
  for (const theme of ["dark", "light"] as const)
    it(`look ${w} ${theme}`, async () => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, reducedMotion: "reduce" });
      await ctx.addInitScript((t) => window.localStorage.setItem("pk-admin-theme", t), theme);
      await ctx.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/manage/api/")) {
          if (url.pathname.endsWith("/slug-check")) return route.fulfill({ json: { slug: url.searchParams.get("slug"), status: "available" } });
          if (url.pathname.endsWith("/github/repositories")) return route.fulfill({ json: REPOS });
          if (url.pathname.endsWith("/link-repo")) return route.fulfill({ json: DRY });
          if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
          const body = resolve(url.pathname);
          return route.fulfill({ status: body === undefined ? 404 : 200, json: body ?? { error: "not_found" } });
        }
        const res = await route.fetch();
        const headers = { ...res.headers() };
        if (url.pathname.endsWith(".html")) headers["content-security-policy"] = CSP;
        return route.fulfill({ response: res, headers });
      });
      const page = await ctx.newPage();
      const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}-${w}-${theme}.png`, fullPage: false });
      const sideways = async (n: string) => {
        const o = await page.evaluate(() => { const m = document.getElementById("content")!; return [document.documentElement.scrollWidth - document.documentElement.clientWidth, m.scrollWidth - m.clientWidth]; });
        console.log("SIDEWAYS", n, w, theme, JSON.stringify(o));
      };
      await page.goto(`${base}/manage.html#/products/new?via=manual`);
      await page.locator("h1").first().waitFor();
      await page.waitForTimeout(500);
      await page.getByLabel(/^Name/).fill("Tonebox");
      await page.waitForTimeout(700);
      await shot("1-name"); await sideways("name");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: "macos" }).click();
      await shot("2-purpose"); await sideways("purpose");
      await page.goto(`${base}/manage.html#/products/new?via=github`);
      await page.waitForTimeout(900);
      await page.getByRole("button", { name: /acme\/tonebox/ }).click();
      await shot("3-repo"); await sideways("repo");
      await page.getByRole("button", { name: /^Read/ }).click();
      await page.waitForTimeout(900);
      await shot("4-check"); await sideways("check");
      await ctx.close();
    }, 60_000);
