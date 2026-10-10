import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";

/**
 * The Config pages (docs/design/ADMIN.md §6.6) in Chromium under the Worker's exact CSP: the
 * catalog's key and history drawers, the catalog editor in both modes (JSON mode loads the lazy
 * CodeMirror editor), a profile's payload editor and its review drawer, and the edge-mint approve
 * drawer. Zero violations, and each drawer scroll-locks the page behind it.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const P = "/manage/api/products/djdl";

const services = Object.fromEntries(
  ["license", "config", "release", "distribution", "update", "identity"].map(
    (s) => [s, { enabled: true }],
  ),
);
const product = {
  slug: "djdl",
  name: "DJDL",
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
  releaseSource: "github",
  setup: { status: "ok", healthy: true, nextActions: [] },
};
const entries = [
  {
    key: "network.timeout",
    kind: "config",
    category: "Network",
    label: "Timeout",
    description: "",
    schema: { type: "integer", minimum: 1 },
    default: 30,
  },
  {
    key: "license.hd",
    kind: "flag",
    category: "Content",
    label: "HD",
    description: "",
    schema: { type: "boolean" },
  },
];
const FIELDS = {
  alg: "ES256",
  signingKeySecret: "MINT_KEY",
  kid: "K1",
  claimsTemplateJson: '{"iss":"T"}',
  ttlSeconds: 3600,
  audience: null,
};
const ROUTES: Record<string, unknown> = {
  "/manage/api/me": {
    sub: "u1",
    name: "Ada Lovelace",
    email: "ada@x.io",
    csrf: "c",
    platformAdmin: true,
    products: [{ slug: "djdl", name: "DJDL", schemaVersion: 2 }],
  },
  "/manage/api/products": { products: [product] },
  [P]: { product },
  [`${P}/config/catalog`]: { schemaVersion: 2, entries },
  [`${P}/config/catalog/versions`]: {
    versions: [
      {
        version: 2,
        active: true,
        createdAt: 1_700_000_000,
        entryCount: 2,
        source: "admin",
        publishedBy: "ada@x.io",
      },
    ],
  },
  [`${P}/config/catalog/usage`]: {
    keys: {
      "network.timeout": { profiles: [], tiers: [], licenses: [] },
    },
  },
  [`${P}/config/profiles`]: { profiles: [] },
  [`${P}/config/profiles/base`]: {
    id: "base",
    name: "Base",
    payload: {
      config: {
        "network.timeout": { value: 45, state: "enforced", updatedAt: 1 },
      },
      secrets: {},
      entitlements: {},
    },
    usedBy: { tiers: [], licenses: [] },
  },
  [`${P}/config/mint`]: {
    registration: "open",
    anonymousEnroll: false,
    oidcDefault: false,
    publicMint: true,
    licenseEnabled: true,
    identity: null,
    recipes: [
      {
        id: "music",
        ...FIELDS,
        claimsTemplate: {},
        status: "pending",
        secretUsage: "edge-mint",
        approval: null,
        changedFields: [],
      },
    ],
  },
  [`${P}/license/tiers`]: { tiers: [] },
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

async function open(hash: string, title: string): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
      ),
    );
  });
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
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
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/manage.html${hash}`);
  await page.locator("[data-page-title]", { hasText: title }).waitFor();
  expect(errors).toEqual([]);
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

const locked = (page: Page): Promise<boolean> =>
  page.evaluate(() => getComputedStyle(document.body).overflow === "hidden");

async function drawer(page: Page, name: string, openIt: () => Promise<void>) {
  await violations(page);
  await openIt();
  await page.getByRole("dialog", { name }).waitFor();
  await page.waitForTimeout(300);
  expect(await locked(page), `${name}: background not scroll-locked`).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await violations(page), `${name}: CSP violations`).toEqual([]);
  expect(await locked(page), `${name}: lock not released`).toBe(false);
}

describe("Config pages under the Worker's CSP", () => {
  it("catalog: the table, the key drawer and version history", async () => {
    const page = await open("#/p/djdl/config/catalog", "Catalog");
    expect(await violations(page)).toEqual([]);
    await drawer(page, "Timeout", async () => {
      await page.getByRole("link", { name: /network\.timeout/ }).click();
    });
    await drawer(page, "Version history", async () => {
      await page.getByRole("button", { name: /Version history/ }).click();
    });
    await page.context().close();
  });

  it("catalog editor: form mode, JSON mode (CodeMirror) and the review drawer", async () => {
    const page = await open(
      "#/p/djdl/config/catalog/edit?entry=network.timeout",
      "Edit catalog",
    );
    await page.getByRole("textbox", { name: /^Label/ }).fill("Request timeout");
    await page.getByRole("radio", { name: "JSON" }).click();
    await page.locator(".cm-editor").waitFor();
    await page.waitForTimeout(300);
    expect(await violations(page)).toEqual([]);
    await drawer(page, "Publish version 3", async () => {
      await page.getByRole("button", { name: "Review changes" }).click();
    });
    await page.context().close();
  });

  it("profile: the payload editor and its review drawer", async () => {
    const page = await open("#/p/djdl/config/profiles/base", "Base");
    await page.getByRole("radio", { name: "Hidden" }).click();
    await drawer(page, "Review changes", async () => {
      await page.getByRole("button", { name: "Review changes" }).click();
    });
    await page.context().close();
  });

  it("edge mint: the approve drawer", async () => {
    const page = await open("#/p/djdl/config/edge-mint", "Edge mint");
    await drawer(page, "Approve music?", async () => {
      await page.getByRole("link", { name: "music" }).click();
    });
    await page.context().close();
  });
});
