import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { feedRoutes } from "../test/feedsFixture.js";

/**
 * Every overlay of the console under the Worker's real CSP (`style-src 'self'`, no inline style).
 *
 * Radix's scroll lock used to inject a <style> element (react-style-singleton), which that policy
 * blocks: each dialog, menu and drawer logged a violation and the background still scrolled. The
 * console now aliases react-style-singleton to a constructable-stylesheet shim
 * (src/lib/styleSingleton.ts). This proves it end to end: zero violations per overlay, and the
 * page behind each modal overlay really is scroll-locked.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;

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
  // F-11: Distribution → Package feeds is listed while the product has package feeds on.
  packageFeeds: true,
});
const ROUTES: Record<string, unknown> = {
  ...feedRoutes(),
  "/manage/api/me": {
    sub: "u1",
    name: "Ada Lovelace",
    email: "ada@x.io",
    csrf: "c",
    platformAdmin: true,
    environment: "staging",
    sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    products: [
      { slug: "djdl", name: "DJDL", schemaVersion: 2 },
      { slug: "acme", name: "Acme", schemaVersion: 1 },
    ],
  },
  "/manage/api/products": {
    products: [row("djdl", "DJDL"), row("acme", "Acme")],
  },
  "/manage/api/products/djdl": { product: row("djdl", "DJDL") },
  "/manage/api/products/djdl/license/licenses": { licenses: [] },
  "/manage/api/products/djdl/license/tiers": { tiers: [] },
  "/manage/api/products/djdl/config/profiles": { profiles: [] },
  "/manage/api/products/djdl/release/releases": { releases: [] },
  "/manage/api/platform/version": {
    releaseTag: "v0.8.6",
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    cloudflare: null,
    protocolVersion: 4,
    discoveryVersion: 2,
    latestMigration: "0054_b_platform_audit.sql",
    environment: "staging",
  },
  "/manage/api/platform/deployment": {
    current: {
      releaseTag: "v0.8.6",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      cloudflare: null,
      protocolVersion: 4,
      discoveryVersion: 2,
      latestMigration: "0054_b_platform_audit.sql",
      environment: "staging",
    },
    deploys: { items: [], nextCursor: null },
    migrations: {
      latest: "0054_b_platform_audit.sql",
      applied: null,
      upToDate: null,
    },
    indexes: { missing: [] },
    bindings: { DB: true, HOT: true },
  },
  "/manage/api/platform/activity": { items: [], nextCursor: null },
  "/manage/api/platform/reserved-names": {
    mode: "warn",
    keys: [
      {
        key: "deviceLimit",
        type: "integer",
        rule: "The tier's device limit, else the license's, else the product default.",
      },
    ],
    prefixes: ["license.", "app.", "pkey."],
    products: [
      {
        slug: "djdl",
        name: "djdl",
        catalogVersion: 1,
        declarations: [{ key: "deviceLimit", compatible: true, problem: null }],
      },
    ],
  },
  "/manage/api/platform/settings": {
    settings: [
      {
        key: "LAZY_DELTAS",
        area: "background-jobs",
        label: "Lazy deltas",
        description: "Lazy hot-pair deltas.",
        kind: "switch",
        scripts: ["main", "deltas"],
        precedence: "ceiling",
        default: "off",
        deployValue: "runtime",
        value: "off",
        source: "default",
        forcedOff: false,
        stored: null,
        version: 0,
        confirm: { on: "L1", off: "L0" },
      },
      {
        key: "BLOB_GC_GRACE_DAYS",
        area: "background-jobs",
        label: "Blob collector grace period",
        description: "Grace before deletion.",
        kind: "integer",
        unit: "days",
        min: 1,
        max: 365,
        scripts: ["main"],
        precedence: "runtime",
        default: 30,
        deployValue: null,
        value: 30,
        source: "default",
        forcedOff: false,
        stored: null,
        version: 0,
        confirm: { raise: "L0", lower: "L1" },
      },
      {
        key: "LICENSING_RESERVED_NAMES",
        area: "licensing",
        label: "Reserved entitlement names",
        description: "Incompatible reserved-name declarations.",
        kind: "choice",
        options: [
          { value: "warn", label: "Warn" },
          { value: "error", label: "Refuse" },
        ],
        scripts: ["main"],
        precedence: "runtime",
        default: "warn",
        deployValue: null,
        value: "warn",
        source: "default",
        forcedOff: false,
        stored: null,
        version: 0,
        confirm: { warn: "L0", error: "L1" },
      },
    ],
    storeAvailable: true,
    propagationSeconds: 30,
    deployTime: [
      { name: "PKEY_ENVIRONMENT", area: "deployment", value: "staging" },
    ],
    secrets: [{ name: "KEY_HASH_PEPPER", set: true }],
    constants: [],
    warnings: [],
  },
  "/manage/api/products/kek": {
    ok: true,
    active: "kek-1",
    kids: ["kek-1"],
    counts: { keys: { "kek-1": 2 } },
    remaining: 0,
    unopenable: 0,
  },
  "/manage/api/platform/operations": {
    generatedAt: 1_790_000_000,
    probes: {
      d1: { bound: true, ok: true, latencyMs: 8 },
      kv: { bound: true, ok: true, latencyMs: 9 },
      r2: { bound: true, ok: true, latencyMs: 11 },
      updateHealth: { bound: false },
      email: { bound: false },
    },
    queues: {
      deltas: {
        bound: true,
        ok: true,
        latencyMs: 4,
        backlogCount: 0,
        backlogBytes: 0,
        oldestMessageAt: null,
      },
      deadLetter: {
        bound: true,
        ok: true,
        latencyMs: 4,
        backlogCount: 0,
        backlogBytes: 0,
        oldestMessageAt: null,
      },
      consumer: {
        maxBatchSize: 1,
        maxBatchTimeoutSeconds: 5,
        maxRetries: 3,
        maxConcurrency: 1,
      },
    },
    heartbeats: [],
    jobs: {
      latest: { maintenance: null, connectorPoll: null },
      recent: [],
      failures: [],
    },
    storage: {
      d1: { sizeBytes: 1_000_000 },
      r2: { committedBytes: 0, objects: 0, byKind: [] },
    },
    indexes: { missing: [] },
    connectors: {
      items: [],
      lastPollFailure: null,
      commerce: { available: false },
    },
    recentErrors: { jobFailures: [], lazyDeltaRefusals: [] },
  },
  "/manage/api/platform/store-connections": {
    ok: true,
    stores: [
      {
        store: "app-store",
        label: "App Store",
        configured: true,
        primary: "app-store.api-key",
        credentials: [
          {
            id: "app-store.api-key",
            store: "app-store",
            slot: "api-key",
            kind: "asc-api-key",
            label: "App Store Connect API key (team)",
            configured: true,
            source: "secret",
            meta: { keyId: "ABC123DEFG", issuerId: "69a6de7f-0000" },
            console: {
              present: false,
              status: null,
              meta: null,
              createdAt: null,
              createdBy: null,
              rotatedAt: null,
              lastUsedAt: null,
              lastOkAt: null,
              lastError: null,
            },
            secret: {
              name: "PLATFORM_ASC_API_KEY",
              present: true,
              valid: true,
            },
            pinField: "appleId",
            pins: 0,
          },
        ],
        settings: [],
        appsListing: true,
        assignments: [],
      },
    ],
  },
  "/manage/api/platform/store-connections/app-store/apps": {
    ok: true,
    store: "app-store",
    source: "secret",
    fetchedAt: 1_790_000_000,
    cached: false,
    truncated: false,
    apps: [
      {
        appId: "1234567890",
        name: "Godot Demo",
        pins: {},
        identifiers: { bundleId: "com.acme.demo", sku: null },
        status: { appStore: { versions: [], phasedRelease: null } },
        assignedProduct: null,
        assignedVia: null,
      },
    ],
  },
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

async function open(viewport: {
  width: number;
  height: number;
}): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
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
  await page.goto(`${base}/manage.html#/p/djdl/license/licenses`);
  await page.locator("[data-page-title]", { hasText: "Licenses" }).waitFor();
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

/** Is the page behind the overlay scroll-locked (react-remove-scroll-bar's body rule applied)? */
const locked = (page: Page): Promise<boolean> =>
  page.evaluate(() => getComputedStyle(document.body).overflow === "hidden");

/** The per-overlay result, printed as the harness's report. */
const report: Record<string, { violations: number; locked: boolean }> = {};

async function check(
  page: Page,
  name: string,
  openIt: () => Promise<void>,
): Promise<void> {
  await violations(page);
  await openIt();
  await page.waitForTimeout(300);
  const isLocked = await locked(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const v = await violations(page);
  report[name] = { violations: v.length, locked: isLocked };
  expect(v, `${name}: CSP violations`).toEqual([]);
  expect(isLocked, `${name}: background not scroll-locked`).toBe(true);
  expect(await locked(page), `${name}: lock not released`).toBe(false);
}

describe("overlays under the Worker's CSP", () => {
  it("loads the console with no violations", async () => {
    const page = await open({ width: 1440, height: 900 });
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("desktop overlays: palette, account menu, theme menu, product switcher, shortcut sheet, a dialog", async () => {
    const page = await open({ width: 1440, height: 900 });
    await check(page, "command palette", async () => {
      await page.keyboard.press("Control+k");
      await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    });
    await check(page, "account menu", async () => {
      await page.getByRole("button", { name: "Account menu" }).click();
      await page.getByRole("menu").waitFor();
    });
    await check(page, "theme menu", async () => {
      await page.getByRole("button", { name: /^Theme: / }).click();
      await page.getByRole("menu").waitFor();
    });
    await check(page, "shortcut sheet", async () => {
      await page.locator("body").press("?");
      await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    });
    await check(page, "create license dialog", async () => {
      await page
        .getByRole("button", { name: "Create license" })
        .first()
        .click();
      await page.getByRole("dialog").waitFor();
    });
    // A popover is not modal: it must not violate the CSP, and it does not lock scroll.
    await violations(page);
    await page.getByRole("button", { name: /^Product: DJDL/ }).click();
    await page.getByRole("listbox", { name: "Products" }).waitFor();
    await page.keyboard.press("Escape");
    const v = await violations(page);
    report["product switcher"] = { violations: v.length, locked: false };
    expect(v).toEqual([]);
    await page.context().close();
  });

  it("Home, Products, the new-product wizard and every Platform page load with no violations", async () => {
    const page = await open({ width: 1440, height: 900 });
    await violations(page);
    for (const [hash, title] of [
      ["#/", "Home"],
      ["#/products", "Products"],
      ["#/products/new?via=manual&step=basics", "New product"],
      ["#/platform", "Settings"],
      ["#/platform/operations", "Operations"],
      ["#/platform/deployment", "Deployment"],
      ["#/platform/store-connections", "Store connections"],
    ] as const) {
      await page.evaluate((h) => {
        location.hash = h;
      }, hash);
      await page.locator("[data-page-title]", { hasText: title }).waitFor();
      await page.waitForTimeout(200);
      expect(await violations(page), `${hash}: CSP violations`).toEqual([]);
    }
    await check(page, "store app assign dialog", async () => {
      await page
        .getByRole("button", { name: "Actions for Godot Demo" })
        .click();
      await page.getByRole("menuitem", { name: "Assign to product…" }).click();
      await page.getByRole("alertdialog").waitFor();
    });
    await page.context().close();
  });

  it("Package feeds in both scopes: the overview, feed pages, a package record and its dialogs", async () => {
    const page = await open({ width: 1440, height: 900 });
    await violations(page);
    for (const [hash, title] of [
      ["#/platform/feeds", "Package feeds"],
      ["#/platform/feeds/npm", "npm"],
      ["#/platform/feeds/npm/setup", "npm"],
      ["#/platform/feeds/oci/settings", "Docker / OCI"],
      ["#/platform/feeds/pypi/setup", "PyPI"],
      ["#/platform/feeds/swift/settings", "Swift"],
      ["#/platform/feeds/godot/settings", "Godot"],
      ["#/platform/feeds/npm/activity", "npm"],
      [
        "#/platform/feeds/npm/packages/polaris-key/%40polaris-key%2Fnode",
        "@polaris-key/node",
      ],
      ["#/p/djdl/distribution/feeds", "Package feeds"],
      ["#/p/djdl/distribution/feeds/npm", "npm"],
      ["#/p/djdl/distribution/feeds/maven/settings", "Maven / Gradle"],
      ["#/p/djdl/distribution/feeds/oci/packages/djdl-server", "djdl-server"],
    ] as const) {
      await page.evaluate((h) => {
        location.hash = h;
      }, hash);
      await page
        .locator("[data-page-title]", { hasText: title })
        .first()
        .waitFor();
      await page.waitForTimeout(200);
      expect(await violations(page), `${hash}: CSP violations`).toEqual([]);
    }
    await check(page, "package yank dialog", async () => {
      await page.getByRole("button", { name: "Actions for 0.9.2" }).click();
      await page.getByRole("menuitem", { name: "Yank…" }).click();
      await page.getByRole("alertdialog").waitFor();
    });
    await page.context().close();
  });

  it("Registry tokens (F-21): the new-token dialog, the revoke confirmation and the access switch", async () => {
    const page = await open({ width: 1440, height: 900 });
    await violations(page);
    await page.evaluate(() => {
      location.hash = "#/platform/feeds/tokens";
    });
    await page
      .locator("[data-page-title]", { hasText: "Registry tokens" })
      .first()
      .waitFor();
    expect(await violations(page), "platform tokens: CSP violations").toEqual(
      [],
    );
    await page.evaluate(() => {
      location.hash = "#/p/djdl/distribution/feeds/tokens";
    });
    await page
      .locator("[data-page-title]", { hasText: "Registry tokens" })
      .first()
      .waitFor();
    await check(page, "new registry token dialog", async () => {
      await page.getByRole("button", { name: "New token…" }).click();
      await page.getByRole("dialog", { name: "New registry token" }).waitFor();
    });
    await check(page, "registry token revoke", async () => {
      await page.getByRole("button", { name: "Actions for CI pull" }).click();
      await page.getByRole("menuitem", { name: "Revoke…" }).click();
      await page.getByRole("alertdialog").waitFor();
    });
    await page.evaluate(() => {
      location.hash = "#/p/djdl/distribution/feeds/npm/settings";
    });
    await page
      .locator("[data-page-title]", { hasText: "npm" })
      .first()
      .waitFor();
    await check(page, "leaving public access", async () => {
      const access = page.getByRole("form", { name: "Access" });
      await access.getByRole("radio", { name: /Licensed/ }).click();
      await access.getByRole("button", { name: /^Save/ }).click();
      await page.getByRole("alertdialog").waitFor();
    });
    expect(await violations(page), "registry tokens: CSP violations").toEqual(
      [],
    );
    await page.context().close();
  });

  it("Platform → Settings: a setting's confirmation", async () => {
    const page = await open({ width: 1440, height: 900 });
    await page.evaluate(() => {
      location.hash = "#/platform/settings";
    });
    await page.locator("[data-page-title]", { hasText: "Settings" }).waitFor();
    await check(page, "platform setting confirmation", async () => {
      await page.getByRole("switch", { name: "Lazy deltas" }).click();
      await page.getByRole("alertdialog").waitFor();
    });
    await page.context().close();
  });

  it("the mobile navigation drawer", async () => {
    const page = await open({ width: 390, height: 844 });
    await check(page, "navigation drawer", async () => {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("dialog", { name: "Navigation" }).waitFor();
    });
    await page.context().close();
  });

  it("closes the drawer when the window grows past 1024 px, releasing the page", async () => {
    const page = await open({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("dialog", { name: "Navigation" }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    expect(await page.locator("[role=dialog]").count()).toBe(0);
    expect(
      await page.evaluate(() => ({
        pointerEvents: getComputedStyle(document.body).pointerEvents,
        mainHidden: !!document
          .getElementById("content")
          ?.closest("[aria-hidden=true]"),
      })),
    ).toEqual({ pointerEvents: "auto", mainHidden: false });
    await page.locator("aside a[data-page=products]").click({ timeout: 2000 });
    expect(await page.evaluate(() => location.hash)).toBe("#/products");
    await page.context().close();
    process.stdout.write(`CSP overlay report: ${JSON.stringify(report)}\n`);
  });
});
