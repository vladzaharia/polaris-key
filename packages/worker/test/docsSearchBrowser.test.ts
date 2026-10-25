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

/** Open a docs page on `origin` through the Worker router, without touching the search. */
async function pageOn(
  origin: string,
  mutate?: (headers: Record<string, string>) => void,
  path = "/docs/help/",
  viewport?: { width: number; height: number },
  setup?: (ctx: any, requests: string[]) => Promise<void>,
  tweakEnv?: (env: any) => void,
): Promise<{ page: any; requests: string[]; close: () => Promise<void> }> {
  const require = createRequire(join(here, "..", "..", "docs", "package.json"));
  // playwright is the docs package's dependency, not the worker's: resolved from there, untyped here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { chromium } = require("playwright") as { chromium: any };
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.CONSOLE_ORIGIN = "https://key.plrs.im";
  env.CUSTOMER_ORIGIN = "https://polaris.locker";
  env.ASSETS = assets();
  tweakEnv?.(env);
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
  const requests: string[] = [];
  ctx.on("request", (r: any) => requests.push(new URL(r.url()).pathname));
  await setup?.(ctx, requests);
  const page = await ctx.newPage();
  await page.goto(`${origin}${path}`);
  return { page, requests, close: () => browser.close() };
}

/** Open Help search on `origin` through the Worker router and type the query. */
async function searchOn(
  origin: string,
  query: string,
  mutate?: (headers: Record<string, string>) => void,
  path = "/docs/help/",
  viewport?: { width: number; height: number },
  setup?: (ctx: any, requests: string[]) => Promise<void>,
  tweakEnv?: (env: any) => void,
): Promise<{ page: any; requests: string[]; close: () => Promise<void> }> {
  const opened = await pageOn(origin, mutate, path, viewport, setup, tweakEnv);
  const { page } = opened;
  await page.locator("button[data-open-modal]:not([disabled])").first().click();
  await page.locator("dialog.pk-search input").fill(query);
  return opened;
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
        const first = page.locator(".pk-search-row").first();
        await first.waitFor({ timeout: 20000 });
        expect(await first.getAttribute("href")).toMatch(
          new RegExp(`^${prefix}`),
        );
        expect(await page.locator(".pk-search-failed").isVisible()).toBe(false);
        if (origin.endsWith("polaris.locker")) {
          // Help's own bundle: no developer page in the list.
          const hrefs: string[] = await page
            .locator(".pk-search-row")
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

  it("groups All docs by door on the console host and never fetches a gated bundle without a session", async () => {
    const { page, requests, close } = await searchOn(
      "https://key.plrs.im",
      "licence",
      undefined,
      "/docs/start/",
    );
    try {
      await page.locator(".pk-search-row").first().waitFor({ timeout: 20000 });
      const groups: string[] = await page
        .locator(".pk-search-group")
        .evaluateAll((a: any[]) => a.map((x) => x.textContent));
      expect(groups.length).toBeGreaterThan(0);
      expect(groups).toContain("Developers");
      // One bundle, the public one: no gated bundle, and never a second one merged in.
      expect(requests.some((p) => /\/pagefind-(member|admin)\//.test(p))).toBe(
        false,
      );
      expect(requests.some((p) => p.startsWith("/docs/pagefind-help/"))).toBe(
        false,
      );
      expect(requests).toContain("/manage/api/me");
    } finally {
      await close();
    }
  }, 90_000);

  it("asks for the highest bundle the session may read", async () => {
    const { requests, close } = await searchOn(
      "https://key.plrs.im",
      "console",
      undefined,
      "/docs/start/",
      undefined,
      async (ctx) => {
        await ctx.route("https://key.plrs.im/manage/api/me", (route: any) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              permissions: { platform: { view: ["console"], edit: [] } },
            }),
          }),
        );
      },
    );
    try {
      await new Promise((r) => setTimeout(r, 4000));
      expect(requests.some((p) => p.startsWith("/docs/pagefind-member/"))).toBe(
        true,
      );
      expect(requests.some((p) => p.startsWith("/docs/pagefind/"))).toBe(false);
    } finally {
      await close();
    }
  }, 90_000);

  it("keeps Help's default to Help on the console host, and widens on request", async () => {
    const { page, close } = await searchOn(
      "https://key.plrs.im",
      "licensing",
      undefined,
      "/docs/help/",
      undefined,
      undefined,
      // No customer host: Help is served on the console host too.
      (env) => delete env.CUSTOMER_ORIGIN,
    );
    try {
      const widen = page.locator("[data-scope=all]");
      await widen.waitFor({ timeout: 20000 });
      await page.waitForTimeout(1500);
      const door = async (): Promise<string[]> =>
        page
          .locator(".pk-search-group")
          .evaluateAll((a: any[]) => a.map((x) => x.textContent));
      expect(await door()).not.toContain("Developers");
      await widen.click();
      await page
        .locator(".pk-search-group", { hasText: "Developers" })
        .waitFor({
          timeout: 20000,
        });
    } finally {
      await close();
    }
  }, 90_000);

  it("offers no widening on the customer host", async () => {
    const { page, close } = await searchOn(
      "https://polaris.locker",
      "device limit",
    );
    try {
      await page.locator(".pk-search-row").first().waitFor({ timeout: 20000 });
      expect(await page.locator("[data-scope=all]").isVisible()).toBe(false);
    } finally {
      await close();
    }
  }, 90_000);

  it("jumps to a message code, opens from ?q=, and works from the keyboard", async () => {
    const { page, close } = await searchOn(
      "https://polaris.locker",
      "rate_limited",
    );
    try {
      const first = page.locator(".pk-search-row").first();
      await first.waitFor({ timeout: 20000 });
      expect(await first.getAttribute("href")).toBe(
        "/docs/help/code/rate_limited/",
      );
      expect(await first.getAttribute("aria-selected")).toBe("true");
      // The jump stands for the page that holds the message, so it is the only row; the arrow wraps.
      expect(await page.locator(".pk-search-row").count()).toBe(1);
      await page.keyboard.press("ArrowDown");
      expect(
        await page
          .locator("dialog.pk-search input")
          .getAttribute("aria-activedescendant"),
      ).toBe("pk-search-o-0");
      await page.keyboard.press("Escape");
      expect(
        await page.locator("dialog.pk-search").evaluate((d: any) => d.open),
      ).toBe(false);
      await page.goto("https://polaris.locker/docs/help/?q=device+limit");
      await page.locator("dialog.pk-search[open]").waitFor({ timeout: 20000 });
      expect(await page.locator("dialog.pk-search input").inputValue()).toBe(
        "device limit",
      );
      await page.locator(".pk-search-row").first().waitFor({ timeout: 20000 });
    } finally {
      await close();
    }
  }, 90_000);

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
      expect(await page.locator(".pk-search-row").count()).toBe(0);
      expect(await page.locator("text=Try again").first().isVisible()).toBe(
        true,
      );
    } finally {
      await close();
    }
  }, 90_000);

  it("jumps to a message code on the console host too, from the bundle's own code list", async () => {
    const { page, requests, close } = await searchOn(
      "https://key.plrs.im",
      "rate_limited",
      undefined,
      "/docs/start/",
    );
    try {
      const first = page.locator(".pk-search-row").first();
      await first.waitFor({ timeout: 20000 });
      expect(await first.getAttribute("href")).toBe(
        "/docs/help/code/rate_limited/",
      );
      expect(await first.locator("code").textContent()).toBe("rate_limited");
      // The list rides in the loaded bundle; no Help path is fetched across hosts.
      expect(requests).toContain("/docs/pagefind/codes.json");
      expect(requests).not.toContain("/docs/help/codes.json");
    } finally {
      await close();
    }
  }, 90_000);

  it("Try again reloads with ?q= and recovers after a failed engine load", async () => {
    let failed = 0;
    const { page, close } = await searchOn(
      "https://polaris.locker",
      "device limit",
      undefined,
      "/docs/help/",
      undefined,
      async (ctx) => {
        await ctx.route(
          /\/pagefind-help\/pagefind\.js$/,
          async (route: any) => {
            if (failed++ === 0) return route.abort();
            return route.fallback();
          },
        );
      },
    );
    try {
      await page.locator(".pk-search-failed").waitFor({ timeout: 30000 });
      await page.locator(".pk-search-retry").click();
      await page.waitForURL(/[?&]q=device\+limit/);
      await page.locator(".pk-search-row").first().waitFor({ timeout: 20000 });
      expect(await page.locator("dialog.pk-search input").inputValue()).toBe(
        "device limit",
      );
      expect(failed).toBeGreaterThan(1);
    } finally {
      await close();
    }
  }, 90_000);

  // The preselected row is the engine's best hit, whichever door it is in (the review's examples).
  it.each([
    ["help a customer", "admin", "/docs/operate/console/help-a-customer/"],
    ["runbook", "admin", "/docs/operate/platform/runbook/"],
    [
      "device limit",
      "public",
      /^\/docs\/(build\/ui\/components|features\/licensing)\/device-limit\//,
    ],
  ] as const)(
    "puts the best-ranked page first for %s as %s",
    async (query, tier, want) => {
      const me =
        tier === "admin"
          ? {
              permissions: {
                platform: { view: ["console", "docs"], edit: [] },
              },
            }
          : null;
      const { page, close } = await searchOn(
        "https://key.plrs.im",
        query,
        undefined,
        "/docs/start/",
        undefined,
        async (ctx) => {
          if (me === null) return;
          await ctx.route("https://key.plrs.im/manage/api/me", (route: any) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(me),
            }),
          );
          // The gated bundles, straight from dist, as the Worker serves them to a session.
          await ctx.route(/\/docs\/pagefind-(member|admin)\//, (route: any) => {
            const f = join(
              dist,
              new URL(route.request().url()).pathname.replace(/^\/docs\//, ""),
            );
            if (!existsSync(f))
              return route.fulfill({ status: 404, body: "no" });
            return route.fulfill({
              status: 200,
              body: readFileSync(f),
              contentType: TYPES[extname(f)] ?? "application/octet-stream",
            });
          });
        },
      );
      try {
        const first = page.locator(".pk-search-row").first();
        await first.waitFor({ timeout: 20000 });
        const href = (await first.getAttribute("href")) ?? "";
        if (typeof want === "string") expect(href).toBe(want);
        else expect(href).toMatch(want);
        // Enter opens that row.
        expect(await first.getAttribute("aria-selected")).toBe("true");
      } finally {
        await close();
      }
    },
    90_000,
  );

  it("lists Top tasks on Help and Start here elsewhere before a query", async () => {
    for (const [origin, path, group] of [
      ["https://polaris.locker", "/docs/help/", "Top tasks"],
      ["https://key.plrs.im", "/docs/start/", "Start here"],
    ] as const) {
      const { page, close } = await searchOn(origin, "", undefined, path);
      try {
        await page.locator(".pk-search-group", { hasText: group }).waitFor();
        expect(await page.locator(".pk-search-row").count()).toBeGreaterThan(1);
      } finally {
        await close();
      }
    }
  }, 90_000);

  it("searches Help, not the developer docs, from Help's page-not-found page", async () => {
    const { page, requests, close } = await searchOn(
      "https://polaris.locker",
      "device limit",
      undefined,
      "/docs/help/nope-not-a-page/",
    );
    try {
      // The 404 is one static page for every door: the address makes it Help's, search included.
      expect(await page.locator("h1#_top").textContent()).toContain("Help");
      expect(
        await page
          .locator("button[data-open-modal]")
          .first()
          .getAttribute("aria-label"),
      ).toBe("Search help");
      expect(
        await page
          .locator("dialog.pk-search input")
          .getAttribute("placeholder"),
      ).toBe("Search help");
      await page.locator(".pk-search-row").first().waitFor({ timeout: 20000 });
      expect(await page.locator(".pk-search-failed-box").isVisible()).toBe(
        false,
      );
      expect(
        requests.some((p) => p === "/docs/pagefind-help/pagefind.js"),
      ).toBe(true);
      expect(requests.some((p) => p === "/docs/pagefind/pagefind.js")).toBe(
        false,
      );
      // Every row is a Help page.
      const hrefs: string[] = await page
        .locator(".pk-search-row")
        .evaluateAll((a: any[]) => a.map((x) => x.getAttribute("href") ?? ""));
      expect(hrefs.length).toBeGreaterThan(0);
      for (const h of hrefs) expect(h, h).toMatch(/^\/docs\/help\//);
      // Before a query it opens on Help's Top tasks, never the developers' Start here.
      await page.locator("dialog.pk-search input").fill("");
      await page
        .locator(".pk-search-group", { hasText: "Top tasks" })
        .waitFor();
      expect(
        await page
          .locator(".pk-search-group", { hasText: "Start here" })
          .count(),
      ).toBe(0);
    } finally {
      await close();
    }
  }, 90_000);

  it.each([
    ["https://key.plrs.im", "/docs/build/quickstart/", 390],
    ["https://key.plrs.im", "/docs/start/", 320],
    ["https://polaris.locker", "/docs/help/devices/", 390],
    ["https://polaris.locker", "/docs/help/devices/", 320],
  ] as const)(
    "keeps Tab inside the phone menu while it is open: %s%s at %d px",
    async (origin, path, width) => {
      const { page, close } = await pageOn(origin, undefined, path, {
        width,
        height: 800,
      });
      try {
        const active = () =>
          page.evaluate(() => {
            const g = globalThis as any;
            const a = g.document.activeElement as any;
            return {
              inPane: !!a?.closest("#starlight__sidebar"),
              body: a === g.document.body,
              label: (a?.getAttribute("aria-label") ?? a?.textContent ?? "")
                .trim()
                .slice(0, 30),
            };
          });
        const menu = page.locator("button.sl-menu-button");
        await menu.click();
        // The popover's toggle event (which inerts the page and moves focus) follows the open state.
        await page.waitForFunction(() =>
          (globalThis as any).document
            .querySelector("header.header")
            ?.hasAttribute("inert"),
        );
        // Focus starts on Close, inside the menu.
        expect(await active()).toMatchObject({
          inPane: true,
          label: "Close menu",
        });
        // The header, the Menu button and the brand footers cannot take focus behind the menu.
        const inert = await page.evaluate(() =>
          ["header.header", ".sl-menu-button", ".pk-section > footer"].map(
            (s) =>
              [...(globalThis as any).document.querySelectorAll(s)].every(
                (e: any) => e.hasAttribute("inert"),
              ),
          ),
        );
        expect(inert).toEqual([true, true, true]);
        for (let i = 0; i < 60; i++) {
          await page.keyboard.press("Tab");
          const at = await active();
          // Focus is in the menu, or has left the page for the browser (the body).
          expect(at.inPane || at.body, JSON.stringify(at)).toBe(true);
        }
        for (let i = 0; i < 60; i++) {
          await page.keyboard.press("Shift+Tab");
          const at = await active();
          expect(at.inPane || at.body, JSON.stringify(at)).toBe(true);
        }
        // Escape closes it and focus returns to Menu, with everything usable again.
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          () =>
            (globalThis as any).document.querySelectorAll("[inert]").length ===
            0,
        );
        expect(await active()).toMatchObject({ label: "Menu" });
      } finally {
        await close();
      }
    },
    90_000,
  );
});
