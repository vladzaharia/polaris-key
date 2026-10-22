import { existsSync, mkdirSync } from "node:fs";
import { closeContext } from "./teardown.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { fixtureImage, IMG_ORIGIN, resolve } from "./layoutFixtures.js";

/**
 * Page moved (ST-49, ADMIN.md §2.8) in the BUILT console under the Worker's CSP, dark and light, at
 * a desktop and a phone width: one h1, the new home named, no sideways scroll, no CSP violation, and
 * the address left as it was (no redirect). With `PK_SHOTS_DIR` set it saves each render.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders(new Headers(), {
  imgOrigin: IMG_ORIGIN,
}).get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const SIZES = {
  "1440": { width: 1440, height: 900 },
  "390": { width: 390, height: 844 },
};

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

/** A moved record address, and (A-27.11) Distribution's old Listing address. */
const MOVED = [
  ["", "#/p/djdl/licenses/lic_1?status=disabled"],
  ["listing-", "#/p/djdl/distribution/listing"],
] as const;

describe("Page moved in the built console", () => {
  for (const [tag, hash] of MOVED)
    for (const scheme of ["dark", "light"] as const) {
      for (const [name, viewport] of Object.entries(SIZES)) {
        it(`${tag}${scheme} at ${name}`, async () => {
          const ctx = await browser.newContext({
            viewport,
            colorScheme: scheme,
          });
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
                headers: {
                  "content-type": "image/png",
                  "access-control-allow-origin": "*",
                },
              });
            if (url.pathname.startsWith("/manage/api/")) {
              const body = resolve(url.pathname);
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
          await page.goto(`${base}/manage.html${hash}`);
          await page
            .getByRole("heading", { level: 1, name: "Page moved" })
            .waitFor({ timeout: 15_000 });
          await page.waitForTimeout(400);
          expect(await page.locator("h1").count()).toBe(1);
          await page
            .getByRole("heading", { level: 2, name: /^This page moved to/ })
            .waitFor();
          expect(await page.evaluate(() => location.hash)).toBe(hash);
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth,
            ),
          ).toBe(true);
          expect(
            await page.evaluate(
              () => (window as unknown as { __v: string[] }).__v,
            ),
          ).toEqual([]);
          if (SHOTS)
            await page.screenshot({
              path: `${SHOTS}/page-moved-${tag}${scheme}-${name}.png`,
            });
          await closeContext(ctx);
        });
      }
    }
});
