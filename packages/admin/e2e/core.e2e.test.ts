import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES, DEVICE_ID, USER_SUBJECT } from "./coreFixtures.js";

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
  { name: "users", hash: "#/p/djdl/users", title: "Users" },
  {
    name: "user-record",
    hash: `#/p/djdl/users/${USER_SUBJECT}`,
    title: USER_SUBJECT,
  },
  {
    name: "user-licenses",
    hash: `#/p/djdl/users/${USER_SUBJECT}/licenses`,
    title: USER_SUBJECT,
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
    reducedMotion: "reduce",
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

  it("the relink dialog opens and closes cleanly (I-12)", async () => {
    const page = await open("dark", `#/p/djdl/users/${USER_SUBJECT}/licenses`);
    await page
      .locator("[data-page-title]", { hasText: USER_SUBJECT })
      .first()
      .waitFor();
    await violations(page);
    await page.getByRole("button", { name: "Relink…" }).click();
    await page.getByRole("alertdialog").waitFor();
    await page.getByRole("link", { name: "Sign in again" }).waitFor();
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
      ["#/p/djdl/users", "Users", { width: 1440, height: 900 }],
      ["#/p/djdl/users", "Users", { width: 390, height: 844 }],
      [
        `#/p/djdl/users/${USER_SUBJECT}/licenses`,
        USER_SUBJECT,
        { width: 390, height: 844 },
      ],
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

/**
 * The one resync flow (UX-78, FLOWS.md C-10): the confirm shows the dry run's plan, a plan that
 * conflicts keeps the button disabled, a refusal is worded for its check, and the result panel
 * takes focus once the confirm has gone. Every state under the CSP, both themes, 1440 and 390.
 */
const RESYNC = "/manage/api/products/djdl/release/resync";
const PLAN = {
  ok: true,
  dryRun: true,
  slug: "djdl",
  repository: "polaris/djdl",
  commit: "4be1c0ffee5a7d2e",
  plan: {
    apply: [
      { area: "tiers", id: "studio", summary: "Tier studio added" },
      {
        area: "catalog",
        summary: "Publishes a new catalog version: adds run.mode",
      },
    ],
    skipClaimed: [
      {
        area: "services",
        summary:
          "Services stay as set in the console (the manifest turns on distribution)",
      },
    ],
    delete: [{ area: "tiers", id: "legacy", summary: "Tier legacy" }],
    conflicts: [] as { area: string; id?: string; summary: string }[],
  },
};
const RESULT = {
  ok: true,
  slug: "djdl",
  updated: ["tiers", "schema"],
  packSets: { ok: true, sets: 2 },
};

async function resyncPage(
  theme: "dark" | "light",
  viewport: { width: number; height: number },
  dryRun: { status: number; json: unknown },
): Promise<Page> {
  const page = await open(theme, "#/p/djdl/settings", viewport);
  await page.route(`**${RESYNC}*`, (route) => {
    const dry = new URL(route.request().url()).searchParams.get("dryRun");
    return dry === "1"
      ? route.fulfill(dryRun)
      : route.fulfill({ json: RESULT });
  });
  await page.locator("[data-page-title]", { hasText: "Settings" }).waitFor();
  await page.getByRole("button", { name: "Resync from repo…" }).click();
  await page.getByRole("alertdialog").waitFor();
  return page;
}

describe("One resync flow (UX-78)", () => {
  const sizes = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ];
  for (const theme of ["dark", "light"] as const) {
    it(`plan, conflict, refusal and focused result under the CSP (${theme})`, async () => {
      for (const viewport of sizes) {
        const tag = `${theme}-${viewport.width}`;
        // The plan, then the result.
        let page = await resyncPage(theme, viewport, {
          status: 200,
          json: PLAN,
        });
        const dialog = page.getByRole("alertdialog");
        await dialog.getByText("Tier studio added").waitFor();
        await dialog.getByText("polaris/djdl").waitFor();
        await page.waitForTimeout(300);
        if (SHOTS)
          await page.screenshot({ path: `${SHOTS}/resync-plan-${tag}.png` });
        await dialog.getByRole("button", { name: "Resync from repo" }).click();
        const panel = page.getByTestId("resync-result");
        await panel.waitFor();
        await expect
          .poll(() =>
            page.evaluate(
              () => document.activeElement?.getAttribute("data-testid") ?? "",
            ),
          )
          .toBe("resync-result");
        expect(await panel.textContent()).toContain(
          "Resynced DJDL from polaris/djdl",
        );
        await page.waitForTimeout(300);
        if (SHOTS)
          await page.screenshot({ path: `${SHOTS}/resync-result-${tag}.png` });
        expect(await violations(page), `result ${tag}`).toEqual([]);
        await page.context().close();

        // A conflict blocks the resync.
        page = await resyncPage(theme, viewport, {
          status: 200,
          json: {
            ...PLAN,
            plan: {
              ...PLAN.plan,
              conflicts: [
                {
                  area: "tiers",
                  id: "pro",
                  summary:
                    "Tier pro is not in the manifest but 3 licenses use it: add it to .pkey/product or move them first",
                },
              ],
            },
          },
        });
        await page.getByText("Blocks the resync").waitFor();
        const button = page
          .getByRole("alertdialog")
          .getByRole("button", { name: "Resync from repo" });
        expect(
          (await button.getAttribute("aria-disabled")) === "true" ||
            (await button.isDisabled()),
        ).toBe(true);
        await page.waitForTimeout(300);
        if (SHOTS)
          await page.screenshot({
            path: `${SHOTS}/resync-conflict-${tag}.png`,
          });
        expect(await violations(page), `conflict ${tag}`).toEqual([]);
        await page.context().close();

        // A refusal, worded for its check.
        page = await resyncPage(theme, viewport, {
          status: 422,
          // The worker's `err()` shape: the fields nested and at the top level.
          json: {
            error: {
              code: "bad_request",
              message: "manifest validation failed",
              reason: "manifest",
              errors: ["product.tiers[0].id: required"],
            },
            code: "bad_request",
            message: "manifest validation failed",
            reason: "manifest",
            errors: ["product.tiers[0].id: required"],
          },
        });
        await page.getByText("1 problem in .pkey/").waitFor();
        await page.waitForTimeout(300);
        if (SHOTS)
          await page.screenshot({ path: `${SHOTS}/resync-refused-${tag}.png` });
        expect(await violations(page), `refused ${tag}`).toEqual([]);
        await page.context().close();
      }
    });
  }
});
