/**
 * Help search under the Worker's REAL docs CSP, in Chromium (v0.9.15 stabilization, LF2).
 *
 * Pagefind compiles a WebAssembly module. The docs CSP once lacked 'wasm-unsafe-eval', so the
 * compile failed and the search dialog spun forever on every docs page, on both hosts, while a
 * test that served `dist/` without the Worker's headers saw results. This drives the built site
 * through the Worker router (so the CSP and headers are the shipped ones), types a query and
 * expects a Help result.
 *
 * Not part of `pnpm test` (it needs Chromium): run it as
 *   PKEY_DOCS_BROWSER=1 _lead/heavy.sh pnpm --filter @polaris-key/worker exec vitest run docsSearchBrowser
 * Without the flag it skips; with the flag and no docs dist it fails (CI job help-search).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispatchWith } from "../src/dispatch.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "docs", "dist");
const requested = process.env.PKEY_DOCS_BROWSER === "1";
// Requested without a docs dist is a failure (CI), never a silent skip.
const enabled = requested && existsSync(dist);
if (requested && !existsSync(dist))
  throw new Error(`PKEY_DOCS_BROWSER=1 but the docs dist is missing: ${dist}`);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".pagefind": "application/wasm",
};

function assets(): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const u = new URL(
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url,
      );
      let file = join(
        dist,
        decodeURIComponent(u.pathname).replace(/^\/docs\//, ""),
      );
      if (existsSync(file) && statSync(file).isDirectory())
        file = join(file, "index.html");
      if (!existsSync(file)) return new Response("no", { status: 404 });
      return new Response(readFileSync(file), {
        headers: {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        },
      });
    },
  } as unknown as Fetcher;
}

/** Open Help search on `origin` through the Worker router and type the query. */
async function searchOn(
  origin: string,
  query: string,
  mutate?: (headers: Record<string, string>) => void,
  path = "/docs/help/",
  viewport?: { width: number; height: number },
): Promise<{ page: any; close: () => Promise<void> }> {
  const require = createRequire(join(here, "..", "..", "docs", "package.json"));
  // playwright is the docs package's dependency, not the worker's: resolved from there, untyped here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { chromium } = require("playwright") as { chromium: any };
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.CONSOLE_ORIGIN = "https://key.plrs.im";
  env.CUSTOMER_ORIGIN = "https://polaris.locker";
  env.ASSETS = assets();
  const browser = await chromium.launch();
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  await ctx.route(`${origin}/**`, async (route: any) => {
    const req = route.request();
    const res = await dispatchWith(
      new Request(req.url(), { method: req.method() }),
      env,
      db,
      NOW,
    );
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    mutate?.(headers);
    await route.fulfill({
      status: res.status,
      headers,
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}${path}`);
  await page.locator("button[data-open-modal]").first().click();
  await page.locator("#starlight__search input").fill(query);
  return { page, close: () => browser.close() };
}

describe.skipIf(!enabled)("Help search under the Worker's docs CSP", () => {
  it.each([
    ["https://polaris.locker", "/docs/help/", "/docs/help/"],
    // The console host's developer docs (Help lives on the customer host): the full public bundle.
    ["https://key.plrs.im", "/docs/start/", "/docs/"],
  ])(
    "returns results on %s%s",
    async (origin, path, prefix) => {
      const { page, close } = await searchOn(
        origin,
        "device limit",
        undefined,
        path,
      );
      try {
        const first = page.locator(".pagefind-ui__result-link").first();
        await first.waitFor({ timeout: 20000 });
        expect(await first.getAttribute("href")).toMatch(
          new RegExp(`^${prefix}`),
        );
        expect(await page.locator(".pk-search-failed").count()).toBe(0);
        if (origin.endsWith("polaris.locker")) {
          // Help's own bundle: no developer page in the list.
          const hrefs: string[] = await page
            .locator(".pagefind-ui__result-link")
            .evaluateAll((a: any[]) => a.map((x) => x.getAttribute("href")));
          expect(hrefs.every((h) => h.startsWith("/docs/help/"))).toBe(true);
        }
      } finally {
        await close();
      }
    },
    90_000,
  );

  it("styles the Help home's cards in Locker ink, not the browser's link colours", async () => {
    const { page, close } = await searchOn("https://polaris.locker", "x");
    try {
      await page.keyboard.press("Escape");
      const colour: string = await page
        .locator(".pk-help-cards a")
        .first()
        .evaluate((a: any) => (globalThis as any).getComputedStyle(a).color);
      expect(["rgb(0, 0, 238)", "rgb(158, 158, 255)"]).not.toContain(colour);
    } finally {
      await close();
    }
  }, 90_000);

  it.each([
    [390, true],
    [360, true],
    // Under 20 rem (a 320 px window) there is no room for the words: the mark stands alone.
    [319, false],
  ])(
    "Help's header on a %i px phone draws the Locker lockup: %s (LF3)",
    async (width, lockup) => {
      const { page, close } = await searchOn(
        "https://polaris.locker",
        "x",
        undefined,
        "/docs/help/",
        { width, height: 800 },
      );
      try {
        await page.keyboard.press("Escape");
        const seen = await page.evaluate(() => {
          const g = globalThis as any;
          const shown = (sel: string): boolean => {
            const el = [...g.document.querySelectorAll(sel)].find(
              (e: any) => e.getBoundingClientRect().width > 0,
            ) as any;
            return !!el;
          };
          return {
            lockup: shown(".pk-site-title .pk-lockup svg"),
            mark: shown(".pk-site-title .pk-lockup-mark svg"),
            sideways: g.document.documentElement.scrollWidth - g.innerWidth,
          };
        });
        expect(seen.lockup).toBe(lockup);
        expect(seen.mark).toBe(!lockup);
        expect(seen.sideways).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    },
    90_000,
  );

  it("says so, instead of spinning, when the engine cannot start", async () => {
    // The pre-fix policy: no 'wasm-unsafe-eval'.
    const { page, close } = await searchOn(
      "https://polaris.locker",
      "device limit",
      (h) => {
        if (h["content-security-policy"])
          h["content-security-policy"] = h["content-security-policy"].replace(
            "'wasm-unsafe-eval' ",
            "",
          );
      },
    );
    try {
      const note = page.locator(".pk-search-failed");
      await note.waitFor({ timeout: 30000 });
      expect(await note.textContent()).toContain("isn\u2019t working");
      expect(await page.locator(".pagefind-ui__result-link").count()).toBe(0);
    } finally {
      await close();
    }
  }, 90_000);
});
