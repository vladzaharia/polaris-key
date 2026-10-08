import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { resolve } from "./layoutFixtures.js";

/**
 * The console shell's motion at phone width (notes/S-23 §4.2, §6.1, §6.6; MO-10), in the BUILT
 * console under the Worker's CSP:
 *
 *   - the nav drawer slides in from the inline start (pk-nav-in, `slow`) and out (pk-nav-out,
 *     `base`), then unmounts;
 *   - below 640 px a dialog is a sheet that slides up (pk-sheet-in) and down (pk-sheet-out);
 *   - a lazy section loads behind a skeleton, never a spinner or visible "Loading…";
 *   - under prefers-reduced-motion and html[data-motion="reduce"] each is an instant swap: no
 *     animation on open or close, the node gone at once, and `document.getAnimations()` empty.
 *
 * Zero CSP violations throughout. With `PK_SHOTS_DIR` set it saves a frame mid-slide of each.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const PHONE = { width: 390, height: 844 };

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

interface OpenOptions {
  hash?: string;
  reducedMotion?: "reduce" | "no-preference";
  /** Set html[data-motion="reduce"], the in-app preference (MO-12). */
  dataMotion?: boolean;
  /** Hold the Platform section's lazy chunk this long, so its fallback shows. */
  holdChunkMs?: number;
  /** The viewport; a phone (390 × 844) by default. */
  viewport?: { width: number; height: number };
}

async function open(o: OpenOptions = {}): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: o.viewport ?? PHONE,
    colorScheme: "dark",
    reducedMotion: o.reducedMotion ?? "no-preference",
  });
  await ctx.addInitScript((dataMotion) => {
    const w = window as unknown as { __v: string[] };
    w.__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__v.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    // Before the app's first paint, as MO-12's entry modules will (the init script runs before
    // the parser has made <html>).
    if (dataMotion)
      document.addEventListener("readystatechange", () =>
        document.documentElement.setAttribute("data-motion", "reduce"),
      );
  }, o.dataMotion ?? false);
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      if (route.request().method() !== "GET")
        return route.fulfill({ json: { ok: true } });
      const body = resolve(url.pathname);
      return body === undefined
        ? route.fulfill({ status: 404, json: { error: "not_found" } })
        : route.fulfill({ json: body });
    }
    if (o.holdChunkMs && /\/assets\/platform-[\w-]+\.js$/.test(url.pathname))
      await new Promise((r) => setTimeout(r, o.holdChunkMs));
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(
    `${base}/manage.html${o.hash ?? "#/p/djdl/license/licenses"}`,
  );
  await page.locator("[data-page-title]").first().waitFor({ timeout: 15_000 });
  if (o.dataMotion)
    expect(
      await page.evaluate(() => document.documentElement.dataset.motion),
    ).toBe("reduce");
  await page.waitForTimeout(300);
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v);

/** Running animations, aside from loading indicators that loop by design. */
const running = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document
      .getAnimations()
      .map((a) => (a as CSSAnimation).animationName ?? "")
      .filter((n) => !/spin/.test(n) && n !== "pk-shimmer"),
  );

/** The animations on the first element matching `selector`, the moment it is called. */
const animationsOn = (
  page: Page,
  selector: string,
): Promise<Array<{ name: string; duration: number }>> =>
  page.evaluate(
    (sel) =>
      (document.querySelector(sel)?.getAnimations() ?? []).map((a) => ({
        name: (a as CSSAnimation).animationName,
        duration: Number(a.effect?.getTiming().duration ?? 0),
      })),
    selector,
  );

/**
 * Close the overlay matched by `selector` with Escape and record, the moment it flips to closed,
 * its animations; then whether it is still in the document after `waitMs`.
 */
async function closeAndProbe(
  page: Page,
  selector: string,
  waitMs: number,
): Promise<{
  animations: Array<{ name: string; duration: number }>;
  connectedAfter: boolean;
}> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const w = window as unknown as {
      __exit: { el: Element; animations: unknown[] } | null;
    };
    w.__exit = null;
    new MutationObserver((_, obs) => {
      if (el.getAttribute("data-state") !== "closed") return;
      w.__exit = {
        el,
        animations: el.getAnimations().map((a) => ({
          name: (a as CSSAnimation).animationName,
          duration: Number(a.effect?.getTiming().duration ?? 0),
        })),
      };
      obs.disconnect();
    }).observe(el, { attributes: true, attributeFilter: ["data-state"] });
  }, selector);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(waitMs);
  return page.evaluate(() => {
    const x = (
      window as unknown as {
        __exit: {
          el: Element;
          animations: Array<{ name: string; duration: number }>;
        } | null;
      }
    ).__exit;
    return {
      animations: x?.animations ?? [],
      connectedAfter: x ? x.el.isConnected : true,
    };
  });
}

const DRAWER = '[role="dialog"].pk-nav-drawer';
const SHEET = '[role="dialog"].pk-sheet';

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.locator(DRAWER).waitFor();
}

async function openSheet(page: Page): Promise<void> {
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
}

describe("shell motion at 390 px (motion on)", () => {
  it("the nav drawer slides in from the inline start and out again, then unmounts", async () => {
    const page = await open();
    await openDrawer(page);
    expect(await animationsOn(page, DRAWER)).toEqual([
      { name: "pk-nav-in", duration: 320 },
    ]);
    if (SHOTS) {
      await page.waitForTimeout(60);
      await page.screenshot({ path: `${SHOTS}/nav-drawer-mid.png` });
    }
    await page.waitForTimeout(500);
    expect(await running(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/nav-drawer-open.png` });
    const exit = await closeAndProbe(page, DRAWER, 500);
    expect(exit.animations).toEqual([{ name: "pk-nav-out", duration: 200 }]);
    expect(exit.connectedAfter).toBe(false);
    expect(await running(page)).toEqual([]);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("a dialog is a sheet that slides up from the bottom edge and back down", async () => {
    const page = await open();
    await openSheet(page);
    expect(await animationsOn(page, SHEET)).toEqual([
      { name: "pk-sheet-in", duration: 320 },
    ]);
    if (SHOTS) {
      await page.waitForTimeout(60);
      await page.screenshot({ path: `${SHOTS}/sheet-mid.png` });
    }
    await page.waitForTimeout(500);
    expect(await running(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/sheet-open.png` });
    const exit = await closeAndProbe(page, SHEET, 500);
    expect(exit.animations).toEqual([{ name: "pk-sheet-out", duration: 200 }]);
    expect(exit.connectedAfter).toBe(false);
    expect(await running(page)).toEqual([]);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("a lazy section loads behind a skeleton, never a spinner or visible Loading…", async () => {
    // Hold the Platform chunk so its fallback is reliably seen.
    const page = await open({ holdChunkMs: 800 });
    await page.evaluate(() => {
      location.hash = "#/platform/settings";
    });
    const fallback = page.locator("#content [data-page-loading]");
    await fallback.waitFor({ state: "attached" });
    // Hold until the chunk is in: the skeleton is the only thing shown meanwhile.
    expect(await fallback.locator('[data-skeleton="form"]').count()).toBe(1);
    expect(await page.locator("#content svg.animate-pk-spin").count()).toBe(0);
    if (SHOTS) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/route-skeleton.png` });
    }
    await page
      .locator("[data-page-title]", { hasText: "Settings" })
      .waitFor({ timeout: 15_000 });
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });
});

describe("shell motion under reduced motion: instant swaps", () => {
  for (const mode of ["prefers-reduced-motion", "data-motion"] as const) {
    const opts: OpenOptions =
      mode === "prefers-reduced-motion"
        ? { reducedMotion: "reduce" }
        : { dataMotion: true };

    it(`${mode}: the nav drawer and the sheet open and close with no animation`, async () => {
      const page = await open(opts);
      await openDrawer(page);
      expect(await animationsOn(page, DRAWER)).toEqual([]);
      expect(await running(page)).toEqual([]);
      const drawerExit = await closeAndProbe(page, DRAWER, 50);
      expect(drawerExit.animations).toEqual([]);
      expect(drawerExit.connectedAfter).toBe(false);
      expect(await running(page)).toEqual([]);

      await openSheet(page);
      expect(await animationsOn(page, SHEET)).toEqual([]);
      expect(await running(page)).toEqual([]);
      const sheetExit = await closeAndProbe(page, SHEET, 50);
      expect(sheetExit.animations).toEqual([]);
      expect(sheetExit.connectedAfter).toBe(false);
      expect(await running(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });
  }
});

describe("a dialog body that scrolls (ui/Dialog DialogBody)", () => {
  it("draws its focus ring when focused, on a phone on its side (WCAG 2.4.7)", async () => {
    const page = await open({
      viewport: { width: 844, height: 390 },
      reducedMotion: "reduce",
    });
    // "?" with nothing focused (openSheet's click lands outside this short viewport).
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("?");
    await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    let ring: { style: string; width: string } | null = null;
    for (let i = 0; i < 12 && !ring; i++) {
      await page.keyboard.press("Tab");
      ring = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el?.matches("[role=dialog] [role=region]")) return null;
        const cs = getComputedStyle(el);
        return { style: cs.outlineStyle, width: cs.outlineWidth };
      });
    }
    expect(ring).toEqual({ style: "solid", width: "2px" });
    expect(await violations(page)).toEqual([]);
  });
});
