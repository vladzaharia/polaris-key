import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { closeContext } from "./teardown.js";
import { IMG_ORIGIN, fixtureImage, resolve } from "./layoutFixtures.js";

/**
 * Platform → Members → Roles (ST-31.13), measured. The layout lint does not look inside buttons
 * or grid tracks, so these checks do: nothing runs out of its tile or card and the page does not
 * scroll sideways at 200 % text (WCAG 1.4.4), the matrix starts in the first screen on the sizes
 * that were pushing it down, and the matrix header sticks while the rows scroll.
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
  await page.goto(`${base}/manage.html#/platform/members?tab=roles`);
  await page.locator("[data-roles-tab]").waitFor({ timeout: 15_000 });
  await page
    .waitForFunction(() => !document.querySelector("#content [data-skeleton]"))
    .catch(() => undefined);
  await page.waitForTimeout(400);
  return { page, close: () => closeContext(ctx) };
}

describe("Roles tab at 200 % text", () => {
  for (const [w, h] of [
    [360, 780],
    [390, 844],
    [1280, 800],
  ] as const) {
    it(`${w}px: no tile or card is overrun and the page does not scroll sideways`, async () => {
      const { page, close } = await open(w, h, 200);
      try {
        const found = await page.evaluate(() => {
          const out: string[] = [];
          const boxes = [
            ...document.querySelectorAll<HTMLElement>(
              '[role="radiogroup"] > *, [data-role-card]',
            ),
          ].filter((b) => b.offsetParent !== null);
          for (const box of boxes) {
            const r = box.getBoundingClientRect();
            if (box.scrollWidth > box.clientWidth + 1)
              out.push(`${box.textContent?.slice(0, 20)}: scrolls inside`);
            for (const el of box.querySelectorAll<HTMLElement>("*")) {
              const c = el.getBoundingClientRect();
              if (c.width > 0 && c.right > r.right + 1)
                out.push(
                  `${el.textContent?.slice(0, 20)}: ${Math.round(c.right - r.right)}px past its box`,
                );
            }
          }
          const content = document.getElementById("content")!;
          if (content.scrollWidth > content.clientWidth + 1)
            out.push(
              `page scrolls sideways by ${content.scrollWidth - content.clientWidth}px`,
            );
          if (boxes.length === 0) out.push("no tiles or cards drawn");
          return out;
        });
        expect(found).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});

describe("Roles tab matrix at 200 % text", () => {
  for (const [w, h] of [
    [640, 900],
    [700, 900],
    [1024, 768],
    [1280, 800],
    [1440, 900],
  ] as const) {
    it(`${w}px: no cell overflows, no header names overlap, no sideways scroll`, async () => {
      const { page, close } = await open(w, h, 200);
      try {
        const found = await page.evaluate(() => {
          const out: string[] = [];
          const cells = [
            ...document.querySelectorAll<HTMLElement>("table th, table td"),
          ].filter((c) => c.offsetParent !== null);
          for (const c of cells) {
            if (c.scrollWidth > c.clientWidth + 1)
              out.push(
                `${c.textContent?.trim().slice(0, 20)}: content ${c.scrollWidth - c.clientWidth}px wider than its cell`,
              );
            const box = c.getBoundingClientRect();
            for (const el of c.querySelectorAll<HTMLElement>("*")) {
              const r = el.getBoundingClientRect();
              if (
                r.width > 0 &&
                (r.right > box.right + 1 || r.left < box.left - 1)
              )
                out.push(`${el.textContent?.slice(0, 20)}: outside its cell`);
            }
          }
          const names = [...document.querySelectorAll<HTMLElement>("thead th")]
            .filter((c) => c.offsetParent !== null)
            .map((th) => {
              const range = document.createRange();
              range.selectNodeContents(th);
              return {
                t: th.textContent!.trim(),
                rects: [...range.getClientRects()],
              };
            });
          for (let i = 0; i < names.length; i++)
            for (let j = i + 1; j < names.length; j++)
              for (const a of names[i]!.rects)
                for (const b of names[j]!.rects)
                  if (
                    a.left < b.right - 1 &&
                    b.left < a.right - 1 &&
                    a.top < b.bottom - 1 &&
                    b.top < a.bottom - 1
                  )
                    out.push(`${names[i]!.t} overlaps ${names[j]!.t}`);
          const content = document.getElementById("content")!;
          if (content.scrollWidth > content.clientWidth + 1)
            out.push(
              `page scrolls sideways by ${content.scrollWidth - content.clientWidth}px`,
            );
          return out;
        });
        expect(found).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});

describe("Roles tab: the matrix starts in the first screen", () => {
  // 844x390 cannot hold the first row: the shell and the page header take 223 px of 390. The
  // matrix's own card must at least begin on screen there, with its title.
  it("844x390: the matrix card begins on screen", async () => {
    const { page, close } = await open(844, 390);
    try {
      const top = await page.evaluate(
        () =>
          document
            .querySelector("section[aria-labelledby]")!
            .getBoundingClientRect().top,
      );
      expect(top).toBeLessThan(390);
    } finally {
      await close();
    }
  });
  for (const [w, h] of [
    [1024, 768],
    [1180, 820],
    [1280, 800],
  ] as const) {
    it(`${w}x${h}`, async () => {
      const { page, close } = await open(w, h);
      try {
        const bottom = await page.evaluate(
          () =>
            document.querySelector("[data-matrix-row]")!.getBoundingClientRect()
              .bottom,
        );
        expect(bottom).toBeLessThanOrEqual(h);
      } finally {
        await close();
      }
    });
  }
});

describe("Roles tab: the column names stay while the rows scroll", () => {
  it("1440x900", async () => {
    const { page, close } = await open(1440, 900);
    try {
      await page.evaluate(() => {
        const c = document.getElementById("content")!;
        c.scrollTop = c.scrollHeight;
      });
      await page.waitForTimeout(200);
      const top = await page.evaluate(() => {
        const th = document.querySelector("thead th")!;
        return th.getBoundingClientRect().top;
      });
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThan(200);
    } finally {
      await close();
    }
  });
});
