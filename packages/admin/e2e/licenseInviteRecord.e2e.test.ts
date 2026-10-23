import { existsSync, mkdirSync } from "node:fs";
import { closeContext } from "./teardown.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";

/**
 * LX-27c.5: a waiting licence's record and the Licenses list under the Worker's CSP, at 360, 390
 * and 1440 px in both themes: Resend invitation as the primary, the Invitation card (sent and not
 * sent), its dialog (and a refusal), Assign…'s invitation box, and the list's "Invited" and
 * "Added" sub lines. Zero CSP violations and no sideways scroll.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of each there.
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
    keyCount: 0,
    activeKeyCount: 0,
    deviceCount: 0,
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
const waiting = (id: string, name: string, over: Record<string, unknown>) =>
  summary(id, {
    name,
    email: `${name.split(" ")[0]!.toLowerCase()}@example.com`,
    holder: {
      kind: "assigned",
      inAccount: false,
      email: `${name.split(" ")[0]!.toLowerCase()}@example.com`,
    },
    ownerSubject: null,
    ...over,
  });
const SAM = waiting("lic_sam", "Sam Reyes", { invitedAt: NOW - 2 * DAY });
const KIM = waiting("lic_kim", "Kim Lee", {});
const FLOAT = summary("lic_float", {
  holder: { kind: "floating" },
  ownerSubject: null,
});

const detail = (s: Record<string, unknown>): Record<string, unknown> => ({
  ...s,
  groups: [],
  maxOfflineDays: null,
  overrides: { config: {}, secrets: {}, entitlements: {} },
  keys: [],
  devices: [],
});

const TIER = {
  id: "pro",
  label: "Pro",
  profile: null,
  policyExpiryDays: null,
  policyDeviceLimit: 3,
  channels: [],
  minVersion: null,
  maxVersion: null,
};

let refuse: string | null = null;
const ROUTES: Record<string, unknown> = {
  ...CORE_ROUTES,
  "/manage/api/me": {
    ...(CORE_ROUTES["/manage/api/me"] as Record<string, unknown>),
    authAt: NOW,
  },
  [`${API}/license/licenses`]: {
    licenses: [SAM, KIM, FLOAT],
    nextCursor: null,
    holders: { invitations: true, invitationsOff: null },
  },
  [`${API}/license/licenses/lic_sam`]: detail(SAM),
  [`${API}/license/licenses/lic_kim`]: detail(KIM),
  [`${API}/license/licenses/lic_float`]: detail(FLOAT),
  [`${API}/users/licenses/lic_sam/relinks`]: { relinks: [] },
  [`${API}/users/licenses/lic_kim/relinks`]: { relinks: [] },
  [`${API}/users/licenses/lic_float/relinks`]: { relinks: [] },
  [`${API}/license/batches`]: { batches: [], nextCursor: null },
  [`${API}/license/tiers`]: { tiers: [TIER] },
  [`${API}/config/profiles`]: { profiles: [] },
  [`${API}/release/releases`]: { releases: [], channels: [] },
};

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

async function open(
  theme: "dark" | "light",
  width: number,
  hash: string,
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
      if (url.pathname.endsWith("/send-invite")) {
        if (refuse === "429")
          return route.fulfill({
            status: 429,
            json: { code: "rate_limited", retryAfter: 420 },
          });
        if (refuse)
          return route.fulfill({
            status: 409,
            json: { code: "bad_request", reason: refuse },
          });
        return route.fulfill({ json: { delivered: { invite: "sent" } } });
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
const sideways = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

describe("Invitations on the record and the list under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1440, 390, 360]) {
      it(`a waiting licence's record, sent and not sent (${theme}, ${width})`, async () => {
        for (const [id, name, action] of [
          ["lic_sam", "sent", "Resend invitation"],
          // Never invited: the primary says Send invitation (LX-27c.5).
          ["lic_kim", "not-sent", "Send invitation"],
        ] as const) {
          const page = await open(
            theme,
            width,
            `#/p/djdl/license/licenses/${id}`,
          );
          await page.getByRole("button", { name: action }).waitFor();
          await page.getByRole("region", { name: "Invitation" }).waitFor();
          await shot(page, `record-${name}-${theme}-${width}`);
          expect(await sideways(page)).toBe(false);
          expect(await violations(page)).toEqual([]);
          await closeContext(page.context());
        }
      });
    }

    it(`the Resend dialog, its refusal and Assign… (${theme})`, async () => {
      refuse = null;
      let page = await open(theme, 1440, "#/p/djdl/license/licenses/lic_sam");
      await page.getByRole("button", { name: "Resend invitation" }).click();
      const dialog = page.getByRole("dialog", { name: "Resend invitation" });
      await dialog.waitFor();
      await shot(page, `dialog-resend-${theme}`);
      refuse = "429";
      await dialog.getByRole("button", { name: "Send invitation" }).click();
      await dialog.getByText("Sent a moment ago").waitFor();
      await shot(page, `dialog-resend-429-${theme}`);
      await closeContext(page.context());
      refuse = "auto_link_off";
      page = await open(theme, 1440, "#/p/djdl/license/licenses/lic_sam");
      await page.getByRole("button", { name: "Resend invitation" }).click();
      await page
        .getByRole("dialog", { name: "Resend invitation" })
        .getByRole("button", { name: "Send invitation" })
        .click();
      await page.getByText("No invitation was sent").waitFor();
      await shot(page, `dialog-resend-refused-${theme}`);
      await closeContext(page.context());
      refuse = null;
      page = await open(theme, 1440, "#/p/djdl/license/licenses/lic_float");
      await page.getByRole("button", { name: "Assign to a person" }).click();
      await page.getByLabel(/Email them an invitation/).waitFor();
      await shot(page, `dialog-assign-${theme}`);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`the list: Invited and Added (${theme})`, async () => {
      const page = await open(theme, 1440, "#/p/djdl/license/licenses");
      const table = page.getByRole("table", { name: "Licenses" });
      await table.waitFor();
      await table.getByText(/^Invited /).waitFor();
      await table.getByText(/^Added /).waitFor();
      await shot(page, `list-invited-${theme}`);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });
  }
});
