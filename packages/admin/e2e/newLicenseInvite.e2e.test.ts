import { existsSync, mkdirSync } from "node:fs";
import { closeContext } from "./teardown.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";

/**
 * LX-27c.4: the New license wizard's invitation delivery in real Chromium under the Worker's CSP,
 * in both themes: the Delivery step (invitation by default, "Also create a key" ticked, auto-link
 * off, Identity off) and Done (sent, sent with a key, failed), plus the phone width and 200 % text.
 * Each renders with zero CSP violations.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of each there.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);
const API = "/manage/api/products/djdl";

const TIER = (id: string, label: string, limit: number) => ({
  id,
  label,
  profile: null,
  policyExpiryDays: null,
  policyDeviceLimit: limit,
  channels: [],
  minVersion: null,
  maxVersion: null,
});

type Holders =
  | { invitations: true; invitationsOff: null }
  | { invitations: false; invitationsOff: "identity_off" | "auto_link_off" };
let holders: Holders | null = null;
let created: "sent" | "failed" | "sent-key" = "sent";

const routes = (): Record<string, unknown> => ({
  ...CORE_ROUTES,
  "/manage/api/me": {
    ...(CORE_ROUTES["/manage/api/me"] as Record<string, unknown>),
    authAt: NOW,
  },
  [`${API}/license/licenses`]: {
    licenses: [],
    nextCursor: null,
    total: 0,
    ...(holders ? { holders } : {}),
  },
  [`${API}/license/tiers`]: {
    tiers: [TIER("pro", "Pro", 3), TIER("free", "Free", 1)],
  },
  [`${API}/config/profiles`]: { profiles: [] },
  [`${API}/release/releases`]: { releases: [], channels: [] },
});

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
  zoom = false,
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width, height: width >= 1000 ? 900 : 780 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(
    ([t, z]) => {
      window.localStorage.setItem("pk-admin-theme", t as string);
      (window as unknown as { __v: string[] }).__v = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as unknown as { __v: string[] }).__v.push(
          `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
        ),
      );
      if (z)
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.fontSize = "200%";
        });
    },
    [theme, zoom],
  );
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      if (
        route.request().method() === "POST" &&
        url.pathname.endsWith("/license/licenses")
      )
        return route.fulfill({
          status: 201,
          json: {
            licenseId: "lic_new",
            ...(created === "sent-key"
              ? { key: "pkey_djdl_3WPLDA7Q2M8K5NHV" }
              : {}),
            delivered:
              created === "failed"
                ? { invite: "failed", reason: "provider_refused" }
                : { invite: "sent" },
            license: { id: "lic_new" },
          },
        });
      const body = routes()[url.pathname];
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
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Opens the wizard and goes tier, holder, limits to Delivery for grace@x.io. */
async function toDelivery(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New license" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New license" });
  await dialog.getByRole("radio", { name: /^Pro/ }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByLabel(/^Email/).fill("grace@x.io");
  await dialog.getByLabel(/^Name/).fill("Grace");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
}

describe("New license: the invitation under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`Delivery: invitation by default, then a key ticked (${theme})`, async () => {
      holders = { invitations: true, invitationsOff: null };
      const page = await open(theme, 1440);
      await toDelivery(page);
      const dialog = page.getByRole("dialog", { name: "New license" });
      await dialog
        .getByRole("radio", { name: /Email an invitation/ })
        .waitFor();
      await dialog.getByLabel("Email preview").waitFor();
      await shot(page, `delivery-invite-${theme}`);
      await dialog.getByRole("checkbox", { name: /Also create a key/ }).click();
      await shot(page, `delivery-invite-key-${theme}`);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`Done: sent, sent with a key, and failed (${theme})`, async () => {
      holders = { invitations: true, invitationsOff: null };
      for (const outcome of ["sent", "sent-key", "failed"] as const) {
        created = outcome;
        const page = await open(theme, 1440);
        await toDelivery(page);
        const dialog = page.getByRole("dialog", { name: "New license" });
        if (outcome === "sent-key")
          await dialog
            .getByRole("checkbox", { name: /Also create a key/ })
            .click();
        await dialog.getByRole("button", { name: "Continue" }).click();
        await shot(page, `review-invite-${outcome}-${theme}`);
        await dialog.getByRole("button", { name: "Create and invite" }).click();
        await dialog
          .getByRole("heading", {
            name:
              outcome === "failed" ? "Invitation not sent" : "Invitation sent",
          })
          .waitFor();
        await shot(page, `done-${outcome}-${theme}`);
        expect(await violations(page)).toEqual([]);
        await closeContext(page.context());
      }
    });

    it(`Delivery where auto-link is off and where Identity is off (${theme})`, async () => {
      holders = { invitations: false, invitationsOff: "auto_link_off" };
      let page = await open(theme, 1440);
      await toDelivery(page);
      await page.getByText(/Invitations aren't offered/).waitFor();
      await shot(page, `delivery-auto-link-off-${theme}`);
      await closeContext(page.context());
      holders = { invitations: false, invitationsOff: "identity_off" };
      page = await open(theme, 1440);
      await toDelivery(page);
      await page
        .getByRole("radio", { name: /Email the key and show it/ })
        .waitFor();
      expect(await page.getByText(/Invitations aren't offered/).count()).toBe(
        0,
      );
      await shot(page, `delivery-identity-off-${theme}`);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });
  }

  it("the phone sheet and 200 % text keep the invitation reachable", async () => {
    holders = { invitations: true, invitationsOff: null };
    created = "sent";
    for (const [name, width, zoom] of [
      ["phone", 390, false],
      ["zoom200", 1280, true],
    ] as const) {
      const page = await open("light", width, zoom);
      await toDelivery(page);
      const dialog = page.getByRole("dialog", { name: "New license" });
      await dialog
        .getByRole("radio", { name: /Email an invitation/ })
        .waitFor();
      await shot(page, `delivery-invite-${name}`);
      await dialog.getByRole("button", { name: "Continue" }).click();
      await dialog.getByRole("button", { name: "Create and invite" }).click();
      await dialog.getByRole("heading", { name: "Invitation sent" }).waitFor();
      await shot(page, `done-sent-${name}`);
      const sideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      );
      expect(sideways).toBe(false);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    }
  });
});
