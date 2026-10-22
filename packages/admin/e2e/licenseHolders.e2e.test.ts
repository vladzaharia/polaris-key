import { existsSync, mkdirSync } from "node:fs";
import { closeContext } from "./teardown.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";

/**
 * LX-30's holder surfaces in real Chromium under the Worker's CSP, in both themes (notes/S-24
 * §8.8, frames 76 and 77): the Licenses list with a licence in each holder state and a batch,
 * a floating licence's record with Assign…, an assigned licence's Make floating… dialog (step-up,
 * reason, typed name), and a batch's page with its Disable unused keys… dialog. Each renders
 * with zero CSP violations.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of each in both themes there.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const API = "/manage/api/products/djdl";

const OK = { allowed: false, reasons: [] };

function summary(
  id: string,
  over: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    name: "",
    email: "",
    status: "active",
    activatedAt: NOW - 40 * DAY,
    expiresAt: null,
    keyCount: 1,
    activeKeyCount: 1,
    deviceCount: 1,
    profile: null,
    profiles: [],
    tier: "pro",
    channels: ["stable"],
    minVersion: null,
    maxVersion: null,
    identityProvider: "manual",
    origin: "admin",
    deletion: OK,
    batchId: null,
    keyEntries: null,
    ...over,
  };
}

const BATCH = {
  id: "batch_oct",
  label: "Steam keys, October",
  count: 50,
  tier: "pro",
  createdBy: "u1",
  createdAt: NOW - 5 * DAY,
  used: 12,
  unused: 37,
  disabled: 1,
};

const LENA = summary("lic_lena", {
  name: "Lena Ortiz",
  email: "lena@ortiz.audio",
  deviceCount: 2,
  holder: { kind: "assigned", inAccount: true, email: "lena@ortiz.audio" },
  ownerSubject: "ps_Xq3v9TbN2kLm8PwRz1YcAa",
});
const SAM = summary("lic_sam", {
  name: "Sam Reyes",
  email: "sam@reyes.fm",
  deviceCount: 0,
  holder: { kind: "assigned", inAccount: false, email: "sam@reyes.fm" },
  ownerSubject: null,
  keyEntries: { used: 0, limit: 10 },
});
const FLOAT_A = summary("lic_float_a", {
  holder: { kind: "floating" },
  ownerSubject: null,
  batchId: BATCH.id,
  keyEntries: { used: 1, limit: 10 },
});
const FLOAT_B = summary("lic_float_b", {
  holder: { kind: "floating" },
  ownerSubject: null,
  batchId: BATCH.id,
  deviceCount: 0,
  keyEntries: { used: 0, limit: 10 },
});
const JUN = summary("lic_jun", {
  name: "Jun Park",
  email: "jun@parkstudio.kr",
  tier: "free",
  holder: { kind: "assigned", inAccount: true, email: "jun@parkstudio.kr" },
  ownerSubject: "ps_Lm8PwRz1YcAaXq3v9TbN2k",
});

function detail(s: Record<string, unknown>): Record<string, unknown> {
  return {
    ...s,
    groups: [],
    maxOfflineDays: null,
    overrides: { config: {}, secrets: {}, entitlements: {} },
    keys: [
      {
        hash: "a1b2c3d4e5f6a7b8c9d0",
        status: "active",
        label: "Initial key",
        createdAt: NOW - 30 * DAY,
        createdBy: "u1",
      },
    ],
    devices: [
      {
        deviceId: "kklhA6HWtEZho0RfhTjNTrlnaDcZq1je",
        label: "Lena's MacBook Pro",
        status: "authorized",
        firstSeen: NOW - 30 * DAY,
        lastSeen: NOW - 240,
        platform: "macos",
        appVersion: "2.4.1",
      },
    ],
  };
}

const ROUTES: Record<string, unknown> = {
  ...CORE_ROUTES,
  "/manage/api/me": {
    ...(CORE_ROUTES["/manage/api/me"] as Record<string, unknown>),
    authAt: NOW,
    stepUpMaxAgeSeconds: 300,
  },
  [`${API}/license/licenses`]: { licenses: [LENA, SAM, FLOAT_A, FLOAT_B, JUN] },
  [`${API}/license/licenses/lic_float_a`]: detail(FLOAT_A),
  [`${API}/license/licenses/lic_lena`]: detail(LENA),
  [`${API}/users/licenses/lic_float_a/relinks`]: { relinks: [] },
  [`${API}/users/licenses/lic_lena/relinks`]: { relinks: [] },
  [`${API}/license/batches`]: { batches: [BATCH], nextCursor: null },
  [`${API}/license/batches/${BATCH.id}`]: BATCH,
  [`${API}/license/tiers`]: {
    tiers: [
      {
        id: "pro",
        label: "Pro",
        profile: null,
        policyExpiryDays: null,
        policyDeviceLimit: 3,
        channels: [],
        minVersion: null,
        maxVersion: null,
      },
      {
        id: "free",
        label: "Free",
        profile: null,
        policyExpiryDays: null,
        policyDeviceLimit: 1,
        channels: [],
        minVersion: null,
        maxVersion: null,
      },
    ],
  },
  [`${API}/config/profiles`]: { profiles: [] },
  [`${API}/release/releases`]: { releases: [], channels: [] },
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

let sendOutcome: "sent" | "failed" | "429" | "suppressed" = "sent";

async function open(
  theme: "dark" | "light",
  hash: string,
  width = 1440,
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width, height: width >= 1000 ? 900 : 780 },
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
      if (url.pathname.endsWith("/send-key")) {
        if (sendOutcome === "429")
          return route.fulfill({
            status: 429,
            json: { code: "rate_limited", message: "limited", retryAfter: 420 },
          });
        if (sendOutcome === "suppressed")
          return route.fulfill({
            status: 409,
            json: { code: "bad_request", reason: "suppressed" },
          });
        return route.fulfill({
          status: 201,
          json: {
            key: "pkey_djdl_3WPLDA7Q2M8K5NHV",
            hash: "h1",
            delivered:
              sendOutcome === "sent"
                ? { email: "sent" }
                : { email: "failed", reason: "provider_refused" },
            revoked: 0,
          },
        });
      }
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

describe("Licence holder surfaces under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`the Licenses list in each holder state (${theme})`, async () => {
      const page = await open(theme, "#/p/djdl/license/licenses");
      const table = page.getByRole("table", { name: "Licenses" });
      await table.waitFor();
      await table.getByText("Waiting for sam@reyes.fm").waitFor();
      await table.getByText("anyone with the key").first().waitFor();
      await table
        .getByRole("link", { name: "Steam keys, October" })
        .first()
        .waitFor();
      await shot(page, `license-holders-list-${theme}`);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`a floating licence's record (${theme})`, async () => {
      const page = await open(theme, "#/p/djdl/license/licenses/lic_float_a");
      await page
        .locator("[data-page-title]", { hasText: "Floating license" })
        .first()
        .waitFor();
      await page.getByText("Not in anyone's account").waitFor();
      await page.getByRole("link", { name: "Steam keys, October" }).waitFor();
      await shot(page, `license-holders-floating-record-${theme}`);
      await page.getByRole("button", { name: "Assign…" }).first().click();
      await page.getByRole("dialog", { name: "Assign license" }).waitFor();
      await page
        .getByRole("textbox", { name: /^Email/ })
        .fill("ada@example.com");
      await shot(page, `license-holders-assign-${theme}`);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`an assigned licence's Make floating… dialog (${theme})`, async () => {
      const page = await open(theme, "#/p/djdl/license/licenses/lic_lena");
      await page
        .locator("[data-page-title]", { hasText: "Lena Ortiz" })
        .first()
        .waitFor();
      await page
        .getByTestId("record-holder")
        .getByText("In an account")
        .waitFor();
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page.getByRole("menuitem", { name: "Make floating…" }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await dialog.getByLabel(/^Reason/).fill("Refunded on Steam");
      await dialog.getByLabel(/Type the license name/).fill("Lena Ortiz");
      await shot(page, `license-holders-make-floating-${theme}`);
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await closeContext(page.context());
    });

    it(`a batch's page and Disable unused keys… (${theme})`, async () => {
      const page = await open(theme, "#/p/djdl/license/batches/batch_oct");
      await page
        .locator("[data-page-title]", { hasText: "Steam keys, October" })
        .first()
        .waitFor();
      await page.getByText("Keys can't be downloaded again").waitFor();
      await shot(page, `license-holders-batch-${theme}`);
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page
        .getByRole("menuitem", { name: /Disable unused keys…/ })
        .click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await dialog.getByRole("textbox").fill("Steam keys, October");
      await shot(page, `license-holders-disable-unused-${theme}`);
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await closeContext(page.context());
    });
  }

  // LX-27: Send a new key… and the Assign… dialog's Email them the key, at the phone and
  // desktop widths in both themes (no page-level sideways scroll, zero CSP violations).
  for (const theme of ["dark", "light"] as const) {
    for (const width of [360, 390, 1440]) {
      it(`Send a new key… and the key-email box (${theme}, ${width}px)`, async () => {
        sendOutcome = "sent";
        const page = await open(
          theme,
          "#/p/djdl/license/licenses/lic_lena",
          width,
        );
        await page
          .locator("[data-page-title]", { hasText: "Lena Ortiz" })
          .first()
          .waitFor();
        await page
          .getByRole("button", { name: "More actions" })
          .first()
          .click();
        await page.getByRole("menuitem", { name: "Send a new key…" }).click();
        const dialog = page.getByRole("dialog", { name: "Send a new key" });
        await dialog.waitFor();
        await dialog.getByLabel(/Also revoke its other keys/).check();
        await shot(page, `lx27-send-key-${theme}-${width}`);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        expect(overflow).toBe(false);
        // The failed send keeps the new key: shown once, with Try again.
        sendOutcome = "failed";
        await dialog.getByRole("button", { name: "Send key" }).click();
        await page.getByRole("dialog", { name: "Key not emailed" }).waitFor();
        await shot(page, `lx27-send-key-failed-${theme}-${width}`);
        await page.keyboard.press("Escape");
        await page.getByText(/Close without copying\?/).waitFor();
        await shot(page, `lx27-send-key-guard-${theme}-${width}`);
        await page.getByRole("button", { name: "Keep it open" }).click();
        await page.getByRole("button", { name: "Try again" }).waitFor();
        expect(await violations(page)).toEqual([]);
        await closeContext(page.context());
      });

      it(`Send a new key… refusals: 429 wait, suppressed (${theme}, ${width}px)`, async () => {
        const page = await open(
          theme,
          "#/p/djdl/license/licenses/lic_lena",
          width,
        );
        await page
          .locator("[data-page-title]", { hasText: "Lena Ortiz" })
          .first()
          .waitFor();
        for (const mode of ["429", "suppressed"] as const) {
          sendOutcome = mode;
          await page
            .getByRole("button", { name: "More actions" })
            .first()
            .click();
          await page.getByRole("menuitem", { name: "Send a new key…" }).click();
          const dialog = page.getByRole("dialog", { name: "Send a new key" });
          await dialog.getByRole("button", { name: "Send key" }).click();
          await dialog
            .getByText(mode === "429" ? "Sent a moment ago" : "No key was made")
            .waitFor();
          if (mode === "suppressed") {
            // A refusal no retry changes: Send key stays off and Mint key is the way out.
            expect(
              await dialog
                .getByRole("button", { name: "Send key" })
                .getAttribute("aria-disabled"),
            ).toBe("true");
            await dialog.getByRole("button", { name: "Mint key…" }).waitFor();
          }
          await shot(page, `lx27-send-key-${mode}-${theme}-${width}`);
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
        }
        expect(await violations(page)).toEqual([]);
        await closeContext(page.context());
      });

      it(`Assign… with Email them the key (${theme}, ${width}px)`, async () => {
        const page = await open(
          theme,
          "#/p/djdl/license/licenses/lic_float_a",
          width,
        );
        await page
          .locator("[data-page-title]", { hasText: "Floating license" })
          .first()
          .waitFor();
        await page.getByRole("button", { name: "Assign…" }).first().click();
        const dialog = page.getByRole("dialog", { name: "Assign license" });
        await dialog.waitFor();
        await dialog
          .getByRole("textbox", { name: /^Email/ })
          .fill("ada@example.com");
        await dialog.getByLabel(/Email them the key/).check();
        await shot(page, `lx27-assign-key-${theme}-${width}`);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
          ),
        ).toBe(false);
        expect(await violations(page)).toEqual([]);
        await page.keyboard.press("Escape");
        await closeContext(page.context());
      });
    }
  }
});
