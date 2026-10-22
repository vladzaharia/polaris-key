import { existsSync, mkdirSync } from "node:fs";
import { closeContext } from "./teardown.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { fixtureImage, IMG_ORIGIN, resolve } from "./layoutFixtures.js";

/**
 * ST-30c.2 (D-S7): a break-glass session (`/me.breakGlass`) gets a warning banner in the BUILT
 * console shell, with a Sign out action, under the Worker's CSP and with no violation. With
 * `PK_SHOTS_DIR` set it saves the shell at 1440 dark and 390 light.
 */
const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders(new Headers(), {
  imgOrigin: IMG_ORIGIN,
}).get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;

let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  if (!existsSync(`${here}dist/manage.html`))
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "silent",
  });
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
});

async function shell(
  breakGlass: boolean,
  viewport: { width: number; height: number },
  scheme: "dark" | "light",
) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __v: string[] };
    w.__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__v.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const image = fixtureImage(url);
    if (image)
      return route.fulfill({
        body: image,
        headers: { "content-type": "image/png" },
      });
    if (url.pathname.startsWith("/manage/api/")) {
      if (route.request().method() !== "GET")
        return route.fulfill({ json: { ok: true } });
      const body = resolve(url.pathname);
      if (url.pathname === "/manage/api/me")
        return route.fulfill({
          json: {
            ...(body as object),
            ...(breakGlass ? { breakGlass: true } : {}),
          },
        });
      return body === undefined
        ? route.fulfill({ status: 404, json: { error: "not_found" } })
        : route.fulfill({ json: body });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/manage.html#/p/djdl/license/licenses`);
  await page.locator("[data-page-title]").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  return { ctx, page };
}

describe("the break-glass banner in the built console shell", () => {
  it.each([
    ["dark", 1440, 900],
    ["light", 390, 844],
  ] as const)(
    "shows the warning with Sign out, %s at %i px",
    async (scheme, width, height) => {
      const { ctx, page } = await shell(true, { width, height }, scheme);
      const banner = page.getByText(
        "You’re signed in with break-glass. Sign out when you’re done.",
      );
      await banner.waitFor();
      expect(
        await page
          .locator('[data-tone="warning"]')
          .getByRole("button", { name: "Sign out" })
          .count(),
      ).toBe(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { __v: string[] }).__v),
      ).toEqual([]);
      if (SHOTS)
        await page.screenshot({
          path: `${SHOTS}/shell-banner-${width}-${scheme}.png`,
        });
      await closeContext(ctx);
    },
  );

  it("a normal session has no banner", async () => {
    const { ctx, page } = await shell(
      false,
      { width: 1440, height: 900 },
      "dark",
    );
    expect(await page.getByText(/signed in with break-glass/).count()).toBe(0);
    await closeContext(ctx);
  });
});
