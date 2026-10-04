import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { DISTRIBUTION_ROUTES } from "../test/distributionData.js";

/**
 * The Distribution and Update pages (admin chunk 9) in the BUILT console, in Chromium, under the
 * Worker's exact Content-Security-Policy: every page, its drawers and its dialogs open with zero
 * violations and no console error, and every modal overlay locks the page behind it.
 *
 * With `PK_SHOTS=<dir>` it also writes a screenshot of each page in the dark and the light theme
 * (the review surface; not part of the assertion).
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS;

const services = Object.fromEntries(
  ["license", "config", "release", "distribution", "update", "identity"].map(
    (s) => [s, { enabled: true }],
  ),
);
const row = (slug: string, name: string) => ({
  slug,
  name,
  signingKid: "k",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: null,
  createdAt: 1,
  modifiedAt: 1,
  services,
  registration: null,
  effectiveRegistration: "requires-license",
  servicesSource: "manifest",
  setup: { status: "ok", healthy: true, nextActions: [] },
});
const ROUTES: Record<string, unknown> = {
  "/manage/api/me": {
    sub: "u1",
    name: "Ada Lovelace",
    email: "ada@x.io",
    csrf: "c",
    platformAdmin: true,
    environment: "staging",
    sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    products: [{ slug: "djdl", name: "DJDL", schemaVersion: 2 }],
  },
  "/manage/api/products": { products: [row("djdl", "DJDL")] },
  "/manage/api/products/djdl": { product: row("djdl", "DJDL") },
  // A platform admin's account menu reads the deployed version (chunk 4).
  "/manage/api/platform/version": {
    releaseTag: "v0.8.6",
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    cloudflare: null,
    protocolVersion: 4,
    discoveryVersion: 2,
    latestMigration: "0054_b_platform_audit.sql",
    environment: "staging",
  },
  ...DISTRIBUTION_ROUTES,
};

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

interface Opened {
  page: Page;
  errors: string[];
}

async function open(
  hash: string,
  opts: { theme?: "dark" | "light"; width?: number } = {},
): Promise<Opened> {
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: SHOTS ? 1800 : 900 },
    colorScheme: opts.theme ?? "dark",
  });
  await ctx.addInitScript((theme) => {
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
      ),
    );
    window.localStorage.setItem("pk-admin-theme", theme);
  }, opts.theme ?? "dark");
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      if (route.request().method() !== "GET")
        return route.fulfill({ json: { ok: true } });
      const body = ROUTES[url.pathname];
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
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/manage.html${hash}`);
  return { page, errors };
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

const locked = (page: Page): Promise<boolean> =>
  page.evaluate(() => getComputedStyle(document.body).overflow === "hidden");

async function title(page: Page, text: string): Promise<void> {
  await page.locator("[data-page-title]", { hasText: text }).first().waitFor();
}

/** Open a modal overlay, check it locks the page, close it, and check nothing was blocked. */
async function overlay(
  page: Page,
  name: string,
  openIt: () => Promise<void>,
): Promise<void> {
  await violations(page);
  await openIt();
  await page.waitForTimeout(250);
  expect(await locked(page), `${name}: background not scroll-locked`).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  expect(await violations(page), `${name}: CSP violations`).toEqual([]);
}

const PAGES: { hash: string; title: string; file: string }[] = [
  { hash: "#/p/djdl/distribution/matrix", title: "Matrix", file: "matrix" },
  {
    hash: "#/p/djdl/distribution/matrix?cell=rel_240:altstore",
    title: "Matrix",
    file: "matrix-cell",
  },
  {
    hash: "#/p/djdl/distribution/rollouts",
    title: "Rollouts",
    file: "rollouts",
  },
  {
    hash: "#/p/djdl/distribution/outlets",
    title: "Outlets & feeds",
    file: "outlets",
  },
  {
    hash: "#/p/djdl/distribution/outlets?outlet=altstore",
    title: "Outlets & feeds",
    file: "outlet-drawer",
  },
  { hash: "#/p/djdl/distribution/access", title: "Access", file: "access" },
  { hash: "#/p/djdl/distribution/health", title: "Health", file: "health" },
  {
    hash: "#/p/djdl/distribution/credentials",
    title: "Outlet credentials",
    file: "credentials",
  },
  // A-17g: the App Store Distribute flow (its steps) and Commerce's App Store products.
  {
    hash: "#/p/djdl/distribution/app-store",
    title: "App Store",
    file: "app-store",
  },
  {
    hash: "#/p/djdl/distribution/app-store?build=b-52&step=compliance",
    title: "App Store",
    file: "app-store-compliance",
  },
  {
    hash: "#/p/djdl/distribution/app-store?build=b-48&step=notes",
    title: "App Store",
    file: "app-store-notes",
  },
  {
    hash: "#/p/djdl/distribution/app-store?build=b-48&step=testflight",
    title: "App Store",
    file: "app-store-testflight",
  },
  {
    hash: "#/p/djdl/distribution/app-store?build=b-48&version=v-240&step=version",
    title: "App Store",
    file: "app-store-version",
  },
  {
    hash: "#/p/djdl/distribution/commerce",
    title: "Commerce",
    file: "commerce",
  },
  { hash: "#/p/djdl/update/feed", title: "Feed", file: "feed" },
];

describe("Distribution and Update pages under the Worker's CSP", () => {
  for (const p of PAGES) {
    it(`${p.file}: loads with no violations or console errors`, async () => {
      for (const theme of ["dark", "light"] as const) {
        const { page, errors } = await open(p.hash, { theme });
        await title(page, p.title);
        await page.waitForTimeout(500);
        expect(await violations(page)).toEqual([]);
        expect(errors).toEqual([]);
        if (SHOTS)
          await page.screenshot({
            path: `${SHOTS}/${p.file}-${theme}.png`,
            fullPage: true,
          });
        await page.context().close();
      }
    });
  }

  it("matrix: the cell drawer, a verb confirmation and Start rollout", async () => {
    const { page, errors } = await open("#/p/djdl/distribution/matrix");
    await title(page, "Matrix");
    await overlay(page, "cell drawer", async () => {
      await page.getByRole("gridcell", { name: /^2\.4\.0 on direct/ }).click();
      await page.getByRole("dialog", { name: "2.4.0 on direct" }).waitFor();
    });
    await page.getByRole("gridcell", { name: /^2\.4\.0 on direct/ }).click();
    await page.getByRole("dialog", { name: "2.4.0 on direct" }).waitFor();
    await violations(page);
    await page.getByRole("button", { name: "Halt direct / stable" }).click();
    await page.getByRole("alertdialog").waitFor();
    await page.waitForTimeout(250);
    expect(await violations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await overlay(page, "start rollout", async () => {
      await page
        .getByRole("button", { name: "Start rollout…" })
        .first()
        .click();
      await page.getByRole("dialog", { name: "Start a rollout" }).waitFor();
    });
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("outlets: the drawer and the narrowing drawer", async () => {
    const { page, errors } = await open(
      "#/p/djdl/distribution/outlets?outlet=direct",
    );
    await page.getByRole("dialog", { name: "direct" }).waitFor();
    await violations(page);
    await page.getByRole("button", { name: "Narrow capabilities…" }).click();
    await page.getByRole("dialog", { name: "Narrow direct" }).waitFor();
    await page.waitForTimeout(250);
    expect(await locked(page)).toBe(true);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("credentials: the set-credential drawer and its kind select", async () => {
    const { page, errors } = await open("#/p/djdl/distribution/credentials");
    await title(page, "Outlet credentials");
    await overlay(page, "set credential", async () => {
      await page.getByRole("button", { name: "Set credential…" }).click();
      await page
        .getByRole("dialog", { name: "Set an outlet credential" })
        .waitFor();
    });
    await page.getByRole("button", { name: "Set credential…" }).click();
    await page
      .getByRole("dialog", { name: "Set an outlet credential" })
      .waitFor();
    await violations(page);
    await page.getByRole("combobox", { name: /Kind/ }).click();
    await page
      .getByRole("option", { name: /App Store Connect API key/ })
      .click();
    await page.waitForTimeout(250);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("app store: the typed submit dialog and an IAP price change open cleanly", async () => {
    const { page, errors } = await open(
      "#/p/djdl/distribution/app-store?build=b-48&version=v-239&step=version",
    );
    await title(page, "App Store");
    await overlay(page, "release to everyone", async () => {
      await page
        .getByRole("button", { name: "Release to everyone…" })
        .first()
        .click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByLabel(/App name/).waitFor();
    });
    await overlay(page, "cancel submission", async () => {
      await page.getByRole("button", { name: "Cancel submission…" }).click();
      await page.getByRole("alertdialog").waitFor();
    });
    expect(errors).toEqual([]);
    await page.context().close();

    const c = await open("#/p/djdl/distribution/commerce");
    await title(c.page, "Commerce");
    await overlay(c.page, "price change", async () => {
      await c.page
        .getByRole("button", { name: "Actions for gg.acme.djdl.pro" })
        .click();
      await c.page.getByRole("menuitem", { name: "Set price…" }).click();
      await c.page.getByRole("alertdialog").waitFor();
      await c.page.getByLabel(/App name/).waitFor();
    });
    expect(c.errors).toEqual([]);
    await c.page.context().close();
  });

  for (const p of [
    {
      hash: "#/p/djdl/distribution/app-store",
      title: "App Store",
      file: "app-store",
    },
    {
      hash: "#/p/djdl/distribution/app-store?build=b-48&version=v-240&step=version",
      title: "App Store",
      file: "app-store-version",
    },
    {
      hash: "#/p/djdl/distribution/commerce",
      title: "Commerce",
      file: "commerce",
    },
  ]) {
    it(`${p.file}: is usable at phone width`, async () => {
      for (const theme of ["dark", "light"] as const) {
        const { page, errors } = await open(p.hash, { theme, width: 390 });
        await title(page, p.title);
        await page.waitForTimeout(500);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        ).toBe(true);
        expect(await violations(page)).toEqual([]);
        expect(errors).toEqual([]);
        if (SHOTS)
          await page.screenshot({
            path: `${SHOTS}/${p.file}-phone-${theme}.png`,
            fullPage: true,
          });
        await page.context().close();
      }
    });
  }

  it("is usable at phone width: the matrix becomes release cards", async () => {
    const { page, errors } = await open("#/p/djdl/distribution/matrix", {
      width: 390,
    });
    await title(page, "Matrix");
    await page.getByRole("list", { name: "Releases" }).waitFor();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    if (SHOTS)
      await page.screenshot({
        path: `${SHOTS}/matrix-phone-dark.png`,
        fullPage: true,
      });
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
