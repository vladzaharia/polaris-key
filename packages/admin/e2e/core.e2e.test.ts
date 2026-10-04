import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { CORE_ROUTES, DEVICE_ID } from "./coreFixtures.js";

/**
 * The Core pages (Overview, Services, Devices and the device drawer, Keys & secrets, Activity,
 * Settings) in real Chromium under the Worker's CSP, in both themes: each loads with zero
 * violations, and its drawers and dialogs open and close cleanly.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of every page in both themes there.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;

const PAGES: { name: string; hash: string; title: string }[] = [
  { name: "overview", hash: "#/p/djdl", title: "DJDL" },
  { name: "services", hash: "#/p/djdl/services", title: "Services" },
  { name: "devices", hash: "#/p/djdl/devices", title: "Devices" },
  {
    name: "device-drawer",
    hash: `#/p/djdl/devices/${DEVICE_ID}`,
    title: "Devices",
  },
  { name: "keys", hash: "#/p/djdl/keys", title: "Keys & secrets" },
  { name: "activity", hash: "#/p/djdl/activity", title: "Activity" },
  {
    name: "activity-table",
    hash: "#/p/djdl/activity?view=table",
    title: "Activity",
  },
  { name: "settings", hash: "#/p/djdl/settings", title: "Settings" },
];

let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  if (!existsSync(`${here}dist/manage.html`)) {
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  }
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

async function open(
  theme: "dark" | "light",
  hash: string,
  viewport?: { width: number; height: number },
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: SHOTS ? 2400 : 1000 },
    colorScheme: theme,
  });
  await ctx.addInitScript((t) => {
    window.localStorage.setItem("pk-admin-theme", t);
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
      ),
    );
  }, theme);
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      const body = CORE_ROUTES[url.pathname];
      return body
        ? route.fulfill({ json: body })
        : route.fulfill({ status: 404, json: { error: "not_found" } });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/manage.html${hash}`);
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

describe("Core pages under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`every Core page loads with no violations (${theme})`, async () => {
      for (const p of PAGES) {
        const page = await open(theme, p.hash);
        await page
          .locator("[data-page-title]", { hasText: p.title })
          .first()
          .waitFor();
        if (p.name === "device-drawer") {
          await page.getByRole("dialog").waitFor();
          await page.getByText("Hardware binding").waitFor();
        }
        await page.waitForTimeout(400);
        if (SHOTS) {
          await page.screenshot({
            path: `${SHOTS}/${p.name}-${theme}.png`,
            fullPage: p.name !== "device-drawer",
          });
        }
        expect(await violations(page), `${p.name} (${theme})`).toEqual([]);
        await page.context().close();
      }
    });
  }

  it("the Set secret drawer and the Delete product dialog open and close cleanly", async () => {
    const page = await open("dark", "#/p/djdl/keys");
    await page
      .locator("[data-page-title]", { hasText: "Keys & secrets" })
      .waitFor();
    await violations(page);
    await page.getByRole("button", { name: "Set secret" }).first().click();
    await page.getByRole("dialog", { name: "Set secret" }).waitFor();
    await page.keyboard.press("Escape");
    await page.goto(`${base}/manage.html#/p/djdl/settings`);
    await page.locator("[data-page-title]", { hasText: "Settings" }).waitFor();
    await page.getByRole("button", { name: "Delete product…" }).click();
    await page.locator("[role=dialog],[role=alertdialog]").first().waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  // The shell owns scrolling: the document itself never scrolls, so nothing (an sr-only span, a
  // Radix bubble input) can push a blank band under the page or a sideways scroll at the window.
  it("the document never scrolls past the viewport, desktop or phone", async () => {
    const cases: [string, string, { width: number; height: number }][] = [
      ["#/p/djdl", "DJDL", { width: 1440, height: 900 }],
      ["#/p/djdl/services", "Services", { width: 1440, height: 900 }],
      ["#/p/djdl/settings", "Settings", { width: 1440, height: 900 }],
      ["#/p/djdl/activity", "Activity", { width: 1440, height: 900 }],
      ["#/p/djdl/services", "Services", { width: 390, height: 844 }],
      ["#/p/djdl/devices", "Devices", { width: 390, height: 844 }],
    ];
    for (const [hash, title, viewport] of cases) {
      const page = await open("dark", hash, viewport);
      await page
        .locator("[data-page-title]", { hasText: title })
        .first()
        .waitFor();
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({
        h: document.scrollingElement!.scrollHeight,
        w: document.scrollingElement!.scrollWidth,
        ih: window.innerHeight,
        iw: window.innerWidth,
      }));
      expect(m.h, `${hash} @${viewport.width} height`).toBe(m.ih);
      expect(m.w, `${hash} @${viewport.width} width`).toBe(m.iw);
      await page.context().close();
    }
  });
});
