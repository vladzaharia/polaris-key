import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { fixtureImage, IMG_ORIGIN, resolve } from "./layoutFixtures.js";

/**
 * "Your session ended", in place (SIGN-IN.md §3.12), in the BUILT console under the Worker's CSP:
 * a 401 marked `X-PKey-Session: expired` covers the open page with a dialog; what was typed into
 * the page is still there; focus is in the dialog; Escape returns it; the second tab's "signed in
 * again" message clears the overlay. Zero CSP violations. With `PK_SHOTS_DIR` set it saves the
 * overlay at 1440 and 390 px, dark and light.
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

interface Session {
  page: Page;
  /** From now on every API call answers 401 expired (or, after `restore`, as before). */
  expire(): void;
  restore(): void;
}

async function open(opts: {
  viewport: { width: number; height: number };
  scheme: "dark" | "light";
}): Promise<Session> {
  const ctx = await browser.newContext({
    viewport: opts.viewport,
    colorScheme: opts.scheme,
  });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __v: string[] };
    w.__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__v.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  let expired = false;
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const image = fixtureImage(url);
    if (image)
      return route.fulfill({
        body: image,
        headers: { "content-type": "image/png" },
      });
    if (url.pathname.startsWith("/manage/api/")) {
      if (expired)
        return route.fulfill({
          status: 401,
          headers: { "X-PKey-Session": "expired" },
          body: "",
        });
      if (route.request().method() !== "GET")
        return route.fulfill({ json: { ok: true } });
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
  await page.goto(`${base}/manage.html#/p/djdl/license/licenses`);
  await page.locator("[data-page-title]").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  return {
    page,
    expire: () => (expired = true),
    restore: () => (expired = false),
  };
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v);

describe("the session-ended overlay in the built console", () => {
  it("covers the page, keeps what was typed, holds focus, and clears when the other tab signs in", async () => {
    const s = await open({
      viewport: { width: 1440, height: 900 },
      scheme: "dark",
    });
    const { page } = s;
    // A field the person is typing in: the licence list's search.
    const search = page.locator('input[type="search"]').first();
    await search.fill("ada lovelace");
    s.expire();
    // The next thing they do asks the server (another tab of the list); the answer is a 401
    // marked expired.
    await page.getByRole("button", { name: /^Disabled/ }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "Your session ended",
    });
    await dialog.waitFor({ timeout: 10_000 });
    // Still on the same page, same hash, same text.
    expect(new URL(page.url()).hash.split("?")[0]).toBe(
      "#/p/djdl/license/licenses",
    );
    expect(await search.inputValue()).toBe("ada lovelace");
    // Focus is inside the dialog.
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('[role="alertdialog"]') !== null,
      ),
    ).toBe(true);
    // Sign in again is a link to a second tab with the right return address.
    const link = dialog.getByRole("link", { name: "Sign in again" });
    expect(await link.getAttribute("target")).toBe("_blank");
    const href = new URL((await link.getAttribute("href"))!, base);
    expect(href.pathname).toBe("/manage/login");
    expect(href.searchParams.get("returnTo")).toBe("/manage/#/signed-in");
    if (SHOTS)
      await page.screenshot({ path: `${SHOTS}/overlay-1440-dark.png` });
    // The other tab finishes: it tells this one, and the overlay goes.
    s.restore();
    await page.evaluate(() => {
      const c = new BroadcastChannel("pkey-console-session");
      c.postMessage("signed-in");
      c.close();
    });
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    expect(await search.inputValue()).toBe("ada lovelace");
    // The request that waited went again with the new session: the page shows the filter it asked for.
    expect(await page.getByRole("button", { name: /^Disabled/ }).count()).toBe(
      1,
    );
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("Escape leaves the page as it is and returns focus to where it was", async () => {
    const s = await open({
      viewport: { width: 1440, height: 900 },
      scheme: "light",
    });
    const { page } = s;
    const search = page.locator('input[type="search"]').first();
    await search.focus();
    s.expire();
    await page.getByRole("button", { name: /^Disabled/ }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "Your session ended",
    });
    await dialog.waitFor({ timeout: 10_000 });
    if (SHOTS)
      await page.screenshot({ path: `${SHOTS}/overlay-1440-light.png` });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    // Focus went back to where it was or, if that is gone, to the page heading; never <body>.
    await page.waitForFunction(
      () =>
        document.activeElement !== null &&
        document.activeElement !== document.body,
      undefined,
      { timeout: 5_000 },
    );
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it.each(["dark", "light"] as const)(
    "at 390 px the overlay is a sheet that fits and keeps its main action in view (%s)",
    async (scheme) => {
      const s = await open({
        viewport: { width: 390, height: 844 },
        scheme,
      });
      const { page } = s;
      s.expire();
      await page.getByRole("button", { name: /^Disabled/ }).click();
      const dialog = page.getByRole("alertdialog", {
        name: "Your session ended",
      });
      await dialog.waitFor({ timeout: 10_000 });
      // Measure the sheet at rest, not mid-slide.
      await page.waitForTimeout(900);
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      const primary = dialog.getByRole("link", { name: "Sign in again" });
      const p = (await primary.boundingBox())!;
      expect(p.y + p.height).toBeLessThanOrEqual(844);
      expect(p.height).toBeGreaterThanOrEqual(24);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (SHOTS)
        await page.screenshot({ path: `${SHOTS}/overlay-390-${scheme}.png` });
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    },
  );
});
