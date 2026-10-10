import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";

/**
 * Licence deletion's three dialogs in real Chromium under the Worker's CSP, in both themes: the
 * record's typed "Delete license…", the list's bulk "Delete…" with what it skips, and "Clean up
 * duplicates". Each opens with zero violations and closes cleanly.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of each dialog in both themes there.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const API = "/manage/api/products/djdl";
const DUP = "lic_7_IEvg_dxmkT";

const OK = { allowed: true, reasons: [] };
const ISSUED = {
  allowed: false,
  reasons: [
    {
      code: "issued_active",
      message:
        "It is active and was issued by the developer. Disable it first.",
    },
  ],
};

function summary(
  id: string,
  name: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    email: "ada@example.com",
    status: "active",
    activatedAt: NOW - 90 * DAY,
    expiresAt: null,
    keyCount: 1,
    activeKeyCount: 1,
    deviceCount: 1,
    profile: null,
    profiles: [],
    tier: "standard",
    channels: ["stable"],
    minVersion: null,
    maxVersion: null,
    identityProvider: "manual",
    origin: "admin",
    deletion: ISSUED,
    ...over,
  };
}

const LICENSES = [
  summary("lic_paid", "Ada Lovelace"),
  summary(DUP, "Ada Lovelace (sign-in)", {
    status: "disabled",
    identityProvider: "oidc",
    origin: "oidc",
    deletion: OK,
  }),
  summary("lic_club", "Club"),
];

const DETAIL = {
  ...LICENSES[1],
  groups: [],
  maxOfflineDays: null,
  overrides: { config: {}, secrets: {}, entitlements: {} },
  keys: [
    {
      hash: "a1b2c3d4e5f6a7b8c9d0",
      status: "active",
      label: "Initial key",
      createdAt: NOW - 30 * DAY,
      createdBy: "oidc",
    },
  ],
  devices: [
    {
      deviceId: "kklhA6HWtEZho0RfhTjNTrlnaDcZq1je",
      status: "authorized",
      firstSeen: NOW - 30 * DAY,
      lastSeen: NOW - 20 * DAY,
      platform: "macos",
      appVersion: "1.1.0",
    },
  ],
};

const ROUTES: Record<string, unknown> = {
  ...CORE_ROUTES,
  [`${API}/license/licenses`]: { licenses: LICENSES },
  [`${API}/license/licenses/${DUP}`]: DETAIL,
  [`${API}/license/tiers`]: {
    tiers: [
      {
        id: "standard",
        label: "Standard",
        profile: null,
        policyExpiryDays: null,
        policyDeviceLimit: 3,
        channels: [],
        minVersion: null,
        maxVersion: null,
      },
    ],
  },
  [`${API}/config/profiles`]: { profiles: [] },
  [`${API}/release/releases`]: { releases: [], channels: [] },
  [`${API}/license/deletions/candidates`]: {
    candidates: [
      {
        id: DUP,
        name: "Ada Lovelace (sign-in)",
        email: "ada@example.com",
        status: "disabled",
        tier: "standard",
        accountSubject: "ps_Xq3v9TbN2kLm8PwRz1YcAa",
        deviceCount: 1,
        lastSeen: NOW - 20 * DAY,
        reason: "duplicate",
        keeps: "lic_paid",
        deletion: OK,
      },
      {
        id: "lic_second_signin",
        name: "Club (sign-in)",
        email: "club@example.com",
        status: "active",
        tier: null,
        accountSubject: null,
        deviceCount: 0,
        lastSeen: null,
        reason: "duplicate",
        keeps: "lic_club",
        deletion: OK,
      },
      {
        id: "lic_steam",
        name: "Bought on Steam",
        email: "",
        status: "active",
        tier: "standard",
        accountSubject: null,
        deviceCount: 2,
        lastSeen: NOW - DAY,
        reason: "duplicate",
        keeps: "lic_club",
        deletion: {
          allowed: false,
          reasons: [
            {
              code: "store_purchases",
              message: "1 store purchase is recorded against it.",
            },
          ],
        },
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

async function open(theme: "dark" | "light", hash: string): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
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
  await page.goto(`${base}/manage.html${hash}`);
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

describe("License deletion dialogs under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`the record's Delete license… dialog (${theme})`, async () => {
      const page = await open(theme, `#/p/djdl/license/licenses/${DUP}`);
      await page
        .locator("[data-page-title]", { hasText: "Ada Lovelace (sign-in)" })
        .first()
        .waitFor();
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page.getByRole("menuitem", { name: /Delete license…/ }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await dialog.getByRole("textbox").fill(`delete ${DUP}`);
      await shot(page, `license-delete-${theme}`);
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.context().close();
    });

    it(`the list's bulk Delete… dialog (${theme})`, async () => {
      const page = await open(theme, "#/p/djdl/license/licenses");
      const table = page.getByRole("table", { name: "Licenses" });
      await table.waitFor();
      for (const name of ["Ada Lovelace", "Ada Lovelace (sign-in)"]) {
        await table
          .getByRole("row")
          .filter({ has: page.getByText(name, { exact: true }) })
          .getByRole("checkbox")
          .check();
      }
      await page.getByRole("button", { name: "Delete…" }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await dialog.getByText(/is skipped/).waitFor();
      await dialog.getByRole("textbox").fill("delete 1 license");
      await shot(page, `license-bulk-delete-${theme}`);
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.context().close();
    });

    it(`the Clean up duplicates dialog (${theme})`, async () => {
      const page = await open(theme, "#/p/djdl/license/licenses");
      await page.getByRole("table", { name: "Licenses" }).waitFor();
      const inline = page.getByRole("button", {
        name: "Clean up duplicates…",
      });
      if (await inline.count()) await inline.first().click();
      else {
        await page
          .getByRole("button", { name: "More actions" })
          .first()
          .click();
        await page
          .getByRole("menuitem", { name: "Clean up duplicates…" })
          .click();
      }
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await dialog.getByText(/account keeps lic_paid/).waitFor();
      await dialog.getByRole("textbox").fill("delete 2 licenses");
      await shot(page, `license-cleanup-${theme}`);
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.context().close();
    });
  }
});
