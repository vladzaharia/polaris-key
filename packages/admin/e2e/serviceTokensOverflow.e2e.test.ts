import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { feedRoutes } from "../test/feedsFixture.js";
import { closeContext } from "./teardown.js";

/**
 * F-33b.4: a long label with no spaces must not push the row actions out of the Service tokens
 * table. At 1100, 1280 and 1440 px, with and without the Legacy row, the table does not scroll
 * sideways and every row's actions button is fully inside the table.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const TOK = "/manage/api/products/djdl/distribution/feeds/tokens";
const services = Object.fromEntries(
  ["license", "config", "release", "distribution", "update", "identity"].map(
    (s) => [s, { enabled: true }],
  ),
);
const product = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "k",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  manifestAuthoritative: { value: false, locked: false },
  adminGroup: null,
  createdAt: 1,
  modifiedAt: 1,
  services,
  effectiveRegistration: "requires-license",
  servicesSource: "manifest",
  packageFeeds: true,
};
const ME = {
  sub: "u1",
  name: "Ada",
  email: "ada@x.io",
  csrf: "c",
  platformAdmin: true,
  environment: "staging",
  sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  products: [{ slug: "djdl", name: "DJDL", schemaVersion: 2 }],
};
const LABELS = [
  "x".repeat(64),
  "github_actions_deploy_production_eu_west_1",
] as const;

let browser: Browser;
let server: PreviewServer;
let base = "";
beforeAll(async () => {
  if (!existsSync(`${here}dist/manage.html`))
    throw new Error("Build the console first");
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    preview: { port: 0, host: "127.0.0.1" },
    logLevel: "silent",
  });
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

for (const width of [1100, 1280, 1440])
  for (const legacy of [true, false])
    for (const label of LABELS)
      it(`${width}px, ${label.length}-character label, ${legacy ? "with" : "without"} Legacy`, async () => {
        const page0 = feedRoutes()[TOK] as Record<string, unknown> & {
          tokens: unknown[];
          serviceTokens: Record<string, unknown>[];
        };
        const body = {
          ...page0,
          tokens: legacy ? page0.tokens : [],
          serviceTokens: [
            { ...page0.serviceTokens[0], label },
            { ...page0.serviceTokens[1], label: `${label}2` },
          ],
        };
        const routes: Record<string, unknown> = {
          ...feedRoutes(),
          "/manage/api/me": ME,
          "/manage/api/products": { products: [product] },
          "/manage/api/attention": { items: [] },
          "/manage/api/products/djdl": { product },
          [TOK]: body,
        };
        const ctx = await browser.newContext({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        });
        await ctx.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.startsWith("/manage/api/")) {
            const b = routes[url.pathname];
            return b
              ? route.fulfill({ json: b })
              : route.fulfill({ status: 404, json: { error: "not_found" } });
          }
          const res = await route.fetch();
          const headers = { ...res.headers() };
          if (url.pathname.endsWith(".html"))
            headers["content-security-policy"] = CSP;
          return route.fulfill({ response: res, headers });
        });
        const page = await ctx.newPage();
        await page.goto(
          `${base}/manage.html#/p/djdl/distribution/feeds/tokens`,
        );
        await page.getByRole("table", { name: "Service tokens" }).waitFor();
        await page
          .getByRole("button", { name: /^Actions for / })
          .first()
          .waitFor();
        const m = await page.evaluate(() => {
          const table = document.querySelector("table")!;
          const box = table.parentElement!.getBoundingClientRect();
          const buttons = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button[aria-label^="Actions for"]',
            ),
          ).map((b) => b.getBoundingClientRect());
          let scroller: HTMLElement | null = table.parentElement;
          while (scroller && scroller.scrollWidth <= scroller.clientWidth)
            scroller = scroller.parentElement;
          return {
            page: document.documentElement.scrollWidth - window.innerWidth,
            scrollerOverflow: scroller
              ? scroller.scrollWidth - scroller.clientWidth
              : 0,
            buttons: buttons.length,
            outside: buttons.filter(
              (r) => r.right > box.right + 0.5 || r.right > window.innerWidth,
            ).length,
          };
        });
        expect(m.buttons).toBeGreaterThan(1);
        expect(m.page).toBeLessThanOrEqual(0);
        expect(m.scrollerOverflow).toBeLessThanOrEqual(0);
        expect(m.outside).toBe(0);
        await closeContext(ctx);
      }, 60_000);
