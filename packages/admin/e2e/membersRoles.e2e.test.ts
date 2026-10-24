/**
 * Platform → Members in real Chromium under the Worker's CSP (ST-31.11 lead fixes): a Product admin
 * on a 38-character product with three areas must not push any row's menu out of the table at
 * 1024, 1280 and 1440 px, and below 640 px the one-row filter bar scrolls a focused facet fully
 * into view. Uses the layout gate's fixtures (the long role set is member 7).
 */

import { closeContext } from "./teardown.js";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { fixtureImage, IMG_ORIGIN, resolve } from "./layoutFixtures.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders(new Headers(), {
  imgOrigin: IMG_ORIGIN,
}).get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;

let server: PreviewServer;
let browser: Browser;
let base: string;
beforeAll(async () => {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "silent",
  });
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.httpServer.close(() => done()));
});

async function open(
  w: number,
  h: number,
  theme: "dark" | "light",
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((t) => {
    window.localStorage.setItem("pk-admin-theme", t);
  }, theme);
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
  await page.goto(`${base}/manage.html#/platform/members`);
  await page.getByRole("heading", { level: 1, name: "Members" }).waitFor();
  await page.getByText("Ada Lindqvist").first().waitFor();
  return { page, close: () => closeContext(ctx) };
}

describe("Members: a long role set", () => {
  for (const w of [1024, 1280, 1440]) {
    it(`keeps every row menu in the table at ${w}`, async () => {
      const { page, close } = await open(w, 800, "dark");
      try {
        if (SHOTS)
          await page.screenshot({ path: `${SHOTS}/long-roles--${w}-dark.png` });
        const r = await page.evaluate(() => {
          const sc = document.querySelector<HTMLElement>(
            '[role="region"][aria-label="Members table"], [data-workbench] .overflow-auto',
          );
          const box = (sc ?? document.body).getBoundingClientRect();
          const buttons = [
            ...document.querySelectorAll<HTMLElement>(
              'button[aria-label^="Actions for"]',
            ),
          ].map((b) => {
            const x = b.getBoundingClientRect();
            return x.left >= box.left - 1 && x.right <= box.right + 1;
          });
          return {
            overflow: sc ? sc.scrollWidth - sc.clientWidth : 0,
            buttons,
          };
        });
        expect(r.overflow).toBeLessThanOrEqual(1);
        expect(r.buttons.length).toBeGreaterThan(8);
        expect(r.buttons.every(Boolean)).toBe(true);
        await page
          .getByRole("button", {
            name: /Actions for Bartholomew/,
          })
          .waitFor({ state: "visible" });
      } finally {
        await close();
      }
    });
  }
});

describe("Members: the one-row filter bar below sm", () => {
  it("scrolls a focused facet fully into view at 360", async () => {
    const { page, close } = await open(360, 780, "light");
    try {
      const last = page.getByRole("button", { name: /Filter by access from/ });
      await last.focus();
      await page.waitForTimeout(250);
      if (SHOTS) {
        await page.getByRole("button", { name: /Filter by product/ }).focus();
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${SHOTS}/facet-focus--360-light.png` });
        await last.focus();
        await page.waitForTimeout(250);
      }
      const inView = await last.evaluate((el) => {
        const row = el.parentElement!;
        const a = el.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        // Fully inside the scroller's padding box, so the ring is not clipped.
        return a.left >= b.left && a.right <= b.right;
      });
      expect(inView).toBe(true);
    } finally {
      await close();
    }
  });
});
