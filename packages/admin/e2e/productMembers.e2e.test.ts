import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { closeContext } from "./teardown.js";
import { IMG_ORIGIN, fixtureImage, resolve } from "./layoutFixtures.js";

/**
 * Product → Settings → Members (ST-31.14 B1), measured at large text on a desktop window, where
 * the layout matrix cannot go (the shell's own lint rules stop at 200 % text from 1024 px): the
 * rows stack, no name breaks inside a word, and the page does not scroll sideways (WCAG 1.4.4).
 */

const here = new URL("..", import.meta.url).pathname;
const CSP = appSecurityHeaders(new Headers(), {
  imgOrigin: IMG_ORIGIN,
}).get("content-security-policy")!;
let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
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
  await browser.close();
  await new Promise<void>((r) => server.httpServer.close(() => r()));
});

async function open(
  width: number,
  height: number,
  textPercent = 100,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((pct) => {
    window.localStorage.setItem("pk-admin-theme", "light");
    if (pct !== 100)
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = `${pct}%`;
      });
  }, textPercent);
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
  await page.goto(`${base}/manage.html#/p/djdl/settings/members`);
  await page.locator("table[aria-label=Admins]").waitFor({ timeout: 15_000 });
  await page
    .waitForFunction(() => !document.querySelector("#content [data-skeleton]"))
    .catch(() => undefined);
  await page.waitForTimeout(400);
  return { page, close: () => closeContext(ctx) };
}

describe("Product Members at large text", () => {
  for (const [w, h, pct] of [
    [1440, 900, 200],
    [1440, 900, 150],
    [1280, 800, 150],
  ] as const) {
    it(`${w}px at ${pct} %: stacked rows, whole words, no sideways scroll`, async () => {
      const { page, close } = await open(w, h, pct);
      try {
        const found = await page.evaluate(`(() => {
          const out = [];
          const content = document.getElementById("content");
          if (content.scrollWidth > content.clientWidth + 1)
            out.push("page scrolls sideways by " + (content.scrollWidth - content.clientWidth) + "px");
          for (const el of document.querySelectorAll('table[aria-label="Admins"] td:first-child p')) {
            const node = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : (el.querySelector("span") || {}).firstChild;
            if (!node || node.nodeType !== 3) continue;
            const text = node.textContent || "";
            if (text.length > 24) continue;
            let at = 0;
            for (const word of text.split(/\\s+/)) {
              const i = text.indexOf(word, at);
              at = i + word.length;
              const r = document.createRange();
              r.setStart(node, i);
              r.setEnd(node, i + word.length);
              const tops = new Set([...r.getClientRects()].map((x) => Math.round(x.top)));
              if (tops.size > 1) out.push("broken: " + text + " / " + word);
            }
          }
          return out;
        })()`);
        expect(found).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});
