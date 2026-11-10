import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { fixtureImage, IMG_ORIGIN, resolve } from "./layoutFixtures.js";
import { closeContext } from "./teardown.js";

/**
 * Update → Updates (P2-11) in the BUILT console under the Worker's POLICY, in Chromium: every state
 * (loading, empty, error, verified with a platform not seen yet, failing, no data) at 390 and
 * 1440 px, light and dark, and at 200 % text. Each has one h1, no sideways page scroll, no POLICY
 * violation and no console error. With `PK_SHOTS_DIR` set it saves each render.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const POLICY = appSecurityHeaders(new Headers(), {
  imgOrigin: IMG_ORIGIN,
}).get("content-security-policy")!;
const SHOT_DIR = process.env.PK_SHOTS_DIR;
const HASH = "#/p/djdl/update/updates";
const SIZES = {
  "1440": { width: 1440, height: 900 },
  "390": { width: 390, height: 844 },
};

const mac = {
  platform: "macos",
  arches: ["arm64", "x86_64"],
  updaters: ["sparkle", "velopack"],
};
const win = {
  platform: "windows",
  arches: ["x86_64"],
  updaters: ["winsparkle", "velopack", "app-installer"],
};
const direct = (over: Record<string, unknown> = {}) => ({
  id: "direct",
  state: "verified",
  reports: 64,
  reverted: 0,
  release: null,
  platforms: [mac, win],
  ...over,
});
const play = (over: Record<string, unknown> = {}) => ({
  id: "play",
  state: "not_seen",
  reports: 0,
  reverted: 0,
  release: null,
  platforms: [{ platform: "android", arches: ["arm64"], updaters: ["play"] }],
  ...over,
});
const view = (groups: unknown[], store: string[] = []) => ({
  product: "djdl",
  now: 1,
  access: "licensed",
  groups,
  store,
});

type Answer = { json: unknown; status?: number; delayMs?: number };
// Only states the update-health data can produce: the direct group shares one fact across its platforms.
const STATES: Record<string, Answer> = {
  verified: { json: view([direct(), play()], ["ios"]) },
  "not-seen": { json: view([direct({ state: "not_seen", reports: 0 })]) },
  failing: {
    json: view([
      direct({ state: "failing", reverted: 12, release: "4.2.2" }),
      play({ state: "verified", reports: 9 }),
    ]),
  },
  "no-data": {
    json: view([direct({ state: "unavailable", reports: 0 })]),
  },
  "store-only": { json: view([], ["macos", "ios"]) },
  empty: { json: view([]) },
  error: { json: { error: "internal" }, status: 500 },
  loading: { json: view([direct()]), delayMs: 4000 },
};

let app: PreviewServer;
let chrome: Browser;
let origin: string;

beforeAll(async () => {
  const built = `${root}dist/manage.html`;
  if (!existsSync(built))
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
  app = await preview({
    root: root,
    configFile: `${root}vite.config.ts`,
    preview: { port: 0, host: "127.0.0.1" },
    logLevel: "silent",
  });
  origin = app.resolvedUrls!.local[0]!.replace(/\/$/, "");
  chrome = await chromium.launch();
});

afterAll(async () => {
  await chrome?.close();
  await new Promise<void>((done) => app?.httpServer.close(() => done()));
});

async function render(
  state: string,
  scheme: "dark" | "light",
  size: keyof typeof SIZES,
  zoom: boolean,
): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const answer = STATES[state]!;
  const ctx = await chrome.newContext({
    viewport: SIZES[size],
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((theme) => {
    window.localStorage.setItem("pk-admin-theme", theme);
  }, scheme);
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const png = fixtureImage(url);
    const isApi = url.pathname.startsWith("/manage/api/");
    if (png)
      return route.fulfill({
        body: png,
        headers: {
          "content-type": "image/png",
          "access-control-allow-origin": "*",
        },
      });
    if (url.pathname.endsWith("/distribution/updaters")) {
      await new Promise((r) => setTimeout(r, answer.delayMs ?? 0));
      return route.fulfill({ status: answer.status ?? 200, json: answer.json });
    }
    if (isApi) {
      const found = resolve(url.pathname);
      return found === undefined
        ? route.fulfill({ status: 404, json: { error: "not_found" } })
        : route.fulfill({ json: found });
    }
    const res = await route.fetch();
    const out = { ...res.headers() };
    if (url.pathname.endsWith(".html")) out["content-security-policy"] = POLICY;
    return route.fulfill({ response: res, headers: out });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    // The error state is a failed request on purpose; the browser logs it as a console error.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
      errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/manage.html${HASH}`);
  if (zoom)
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
  return { page, errors, close: () => closeContext(ctx) };
}

describe("Update → Updates in the built console", () => {
  for (const state of Object.keys(STATES))
    for (const scheme of ["dark", "light"] as const)
      for (const size of Object.keys(SIZES) as (keyof typeof SIZES)[])
        for (const zoom of [false, true]) {
          // 200 % text is checked on the states that carry the most text.
          if (zoom && !["verified", "failing", "error"].includes(state))
            continue;
          const tag = `${state}-${scheme}-${size}${zoom ? "-200" : ""}`;
          it(tag, async () => {
            const { page, errors, close } = await render(
              state,
              scheme,
              size,
              zoom,
            );
            await page
              .getByRole("heading", { level: 1, name: "Updates" })
              .waitFor({ timeout: 15_000 });
            if (state === "loading") {
              await page.locator('[aria-busy="true"]').first().waitFor();
            } else if (state === "error") {
              await page
                .getByRole("button", { name: /Try again/i })
                .waitFor({ timeout: 15_000 });
            } else if (state === "empty") {
              await page.getByText("No platform shipped yet").waitFor();
            } else if (state === "store-only") {
              await page.getByText("Updated by the store").first().waitFor();
            } else {
              await page
                .getByRole("region", { name: /Direct downloads/ })
                .waitFor();
            }
            await page.waitForTimeout(400);
            expect(await page.locator("h1").count()).toBe(1);
            expect(
              await page.evaluate(
                () =>
                  document.documentElement.scrollWidth <=
                  document.documentElement.clientWidth,
              ),
              "no sideways page scroll",
            ).toBe(true);
            // A POLICY violation is logged as a console error, so this covers it.
            expect(errors, "console errors and POLICY violations").toEqual([]);
            if (state === "failing")
              await page.getByText("4.2.2 did not hold").first().waitFor();
            if (SHOT_DIR)
              await page.screenshot({
                path: `${SHOT_DIR}/updates-${tag}.png`,
                fullPage: true,
              });
            await close();
          });
        }
});
