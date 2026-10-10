import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/platform/securityHeaders.js";
import { DISTRIBUTION_ROUTES } from "../test/distributionData.js";
import { CORE_ROUTES } from "./coreFixtures.js";

/**
 * Console flow conformance (FLOWS.md §2 C3, C5, C13, C18; UX-77) in the BUILT console, in
 * Chromium, under the Worker's exact Content-Security-Policy:
 *
 * - first focus lands on the first field or the title, never on Close or Back;
 * - Create license moves focus to each step's heading, names its primaries and asks before
 *   Escape drops a draft; its result takes focus on the title;
 * - the offline bundle result is not dropped by Escape before it is saved;
 * - Escape from a controlled confirm (Services, a rollout's row menu) returns focus to the
 *   control that opened it, never to `<body>`;
 * - `?secret=` opens Set secret with the name filled in.
 *
 * Set `PK_SHOTS_DIR` to also save each state at 1440 and 390 in both themes there.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const API = "/manage/api/products/djdl";

const LICENSE = {
  id: "lic_ada",
  name: "Ada Lovelace",
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
  deletion: { allowed: false, reasons: [] },
};

const ROUTES: Record<string, unknown> = {
  ...DISTRIBUTION_ROUTES,
  ...CORE_ROUTES,
  [`${API}/license/licenses`]: { licenses: [LICENSE] },
  [`${API}/license/licenses/lic_ada`]: {
    ...LICENSE,
    groups: [],
    maxOfflineDays: null,
    overrides: { config: {}, secrets: {}, entitlements: {} },
    keys: [],
    devices: [],
  },
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
};

const WRITES: Record<string, unknown> = {
  [`${API}/license/licenses`]: {
    licenseId: "lic_new",
    key: "PK-7Q2M-9XKD-4HRW-C3VA",
    license: { ...LICENSE, id: "lic_new", name: "Grace Hopper" },
  },
  [`${API}/bundles`]: {
    bundleId: "01JBUNDLEID0000000000000A",
    bundle: "eyJhbGciOiJFZERTQSJ9.e30.sig",
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

type Theme = "dark" | "light";

async function open(
  hash: string,
  opts: { theme?: Theme; width?: number } = {},
): Promise<{ page: Page; errors: string[] }> {
  const width = opts.width ?? 1440;
  const ctx = await browser.newContext({
    viewport: { width, height: width < 640 ? 844 : 900 },
    colorScheme: opts.theme ?? "dark",
  });
  await ctx.addInitScript((t) => {
    window.localStorage.setItem("pk-admin-theme", t);
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
      ),
    );
  }, opts.theme ?? "dark");
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      if (route.request().method() !== "GET")
        return route.fulfill({ json: WRITES[url.pathname] ?? { ok: true } });
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
  return { page, errors };
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

/** What has focus: its accessible-ish name, or "body". */
/**
 * Waits until React has committed what a fill typed AND run the passive effects that follow it:
 * a dialog registers "holds unsaved input" from an effect, and Escape pressed before that
 * effect's re-render reaches the dialog's handler closes it instead of asking "Discard your
 * changes?" (CI under load, 2026-10-09: the ask never came). Two frames and a task is past it.
 */
const afterTyping = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(done, 0)),
        ),
      ),
  );

const focused = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    const label =
      el.getAttribute("aria-label") ??
      (el.id
        ? document.querySelector(`label[for="${el.id}"]`)?.textContent
        : null) ??
      el.textContent ??
      "";
    return `${el.tagName.toLowerCase()}:${label.trim()}`;
  });

async function title(page: Page, text: string): Promise<void> {
  await page.locator("[data-page-title]", { hasText: text }).first().waitFor();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const THEMES: Theme[] = ["dark", "light"];
const WIDTHS = [1440, 390];

describe("Create license (C-17)", () => {
  for (const theme of THEMES)
    for (const width of WIDTHS)
      it(`steps, focus, primaries and the draft guard (${theme}, ${width})`, async () => {
        const { page, errors } = await open("#/p/djdl/license/licenses", {
          theme,
          width,
        });
        await title(page, "Licenses");
        await page
          .getByRole("button", { name: "Create license" })
          .first()
          .click();
        const dialog = page.getByRole("dialog", { name: "Create license" });
        await dialog.waitFor();
        await page.waitForTimeout(200);
        expect(await focused(page)).toMatch(/^input:Name/);
        expect(await dialog.getByText("Step 1 of 2 for you").count()).toBe(1);
        await dialog.getByLabel(/^Name/).fill("Grace Hopper");
        await dialog.getByLabel(/^Email/).fill("grace@example.com");
        await shot(page, `create-license-holder-${theme}-${width}`);

        await afterTyping(page);
        await page.keyboard.press("Escape");
        await dialog.getByText("Discard your changes?").waitFor();
        await page.waitForTimeout(100);
        expect(await focused(page)).toBe("button:Keep editing");
        await shot(page, `create-license-discard-${theme}-${width}`);
        await dialog.getByRole("button", { name: "Keep editing" }).click();

        await dialog.getByRole("button", { name: "Continue to terms" }).click();
        await dialog.getByRole("heading", { name: "Set the terms" }).waitFor();
        await page.waitForTimeout(100);
        expect(await focused(page)).toBe("h3:Set the terms");
        await shot(page, `create-license-terms-${theme}-${width}`);

        await dialog.getByRole("button", { name: "Create license" }).click();
        await page.getByText("PK-7Q2M-9XKD-4HRW-C3VA").waitFor();
        await page.waitForTimeout(100);
        expect(await focused(page)).toBe("h2:License created");
        expect(
          await page
            .getByRole("dialog")
            .getByText(/shown once/i)
            .count(),
        ).toBe(1);
        await shot(page, `create-license-result-${theme}-${width}`);
        expect(await violations(page)).toEqual([]);
        expect(errors).toEqual([]);
        await page.context().close();
      });
});

describe("License record dialogs (C-20, C-21)", () => {
  async function fromMenu(page: Page, item: RegExp): Promise<void> {
    // Wide screens show secondary actions as buttons; phones fold them into the menu.
    const direct = page.getByRole("button", { name: item });
    if (await direct.first().isVisible()) return direct.first().click();
    const more = page.getByRole("button", { name: "More actions" }).first();
    await more.click();
    await page.getByRole("menuitem", { name: item }).click();
  }

  for (const theme of THEMES)
    for (const width of WIDTHS)
      it(`Edit holder asks; the bundle stays until saved (${theme}, ${width})`, async () => {
        const { page, errors } = await open(
          "#/p/djdl/license/licenses/lic_ada",
          { theme, width },
        );
        await title(page, "Ada Lovelace");
        await fromMenu(page, /Edit holder/);
        const holder = page.getByRole("dialog", { name: "Edit holder" });
        await holder.waitFor();
        await page.waitForTimeout(200);
        expect(await focused(page)).toMatch(/^input:Name/);
        await holder.getByLabel(/^Name/).fill("Ada King");
        await afterTyping(page);
        await page.keyboard.press("Escape");
        await holder.getByText("Discard your changes?").waitFor();
        await shot(page, `edit-holder-discard-${theme}-${width}`);
        await holder.getByRole("button", { name: "Discard" }).click();
        await holder.waitFor({ state: "hidden" });
        await page.waitForTimeout(150);
        // Back on the menu's trigger, not <body>.
        expect(await focused(page)).not.toBe("body");

        await fromMenu(page, /Mint offline bundle/);
        const bundle = page.getByRole("dialog", {
          name: "Mint offline bundle",
        });
        await bundle.waitFor();
        await bundle
          .getByLabel(/^Device ID/)
          .fill("kklhA6HWtEZho0RfhTjNTrlnaDcZq1je");
        await bundle.getByRole("button", { name: "Mint bundle" }).click();
        const minted = page.getByRole("dialog", { name: "Bundle minted" });
        await minted.getByText("01JBUNDLEID0000000000000A").waitFor();
        await page.waitForTimeout(100);
        expect(await focused(page)).toBe("h2:Bundle minted");
        await page.keyboard.press("Escape");
        await minted.getByText(/Close without copying\?/).waitFor();
        await shot(page, `offline-bundle-ask-${theme}-${width}`);
        expect(await minted.isVisible()).toBe(true);
        expect(await violations(page)).toEqual([]);
        expect(errors).toEqual([]);
        await page.context().close();
      });
});

describe("Controlled confirms return focus (C-5, C-41)", () => {
  it("Services: Escape from Turn off returns focus to the switch", async () => {
    const { page, errors } = await open("#/p/djdl/services");
    await title(page, "Services");
    const sw = page.locator("#service-update");
    await sw.focus();
    await page.keyboard.press("Space");
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor();
    await page.waitForTimeout(150);
    expect(await focused(page)).toBe("button:Cancel");
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "hidden" });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      "service-update",
    );
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("Rollouts: Escape from a row's verb confirm returns focus to its menu", async () => {
    const { page, errors } = await open("#/p/djdl/distribution/rollouts");
    await title(page, "Rollouts");
    const actions = page.getByRole("button", { name: /^Actions for / }).first();
    await actions.click();
    const item = page.getByRole("menuitem").filter({ hasText: /…$/ }).first();
    await item.click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor();
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "hidden" });
    await page.waitForTimeout(250);
    expect(await focused(page)).not.toBe("body");
    expect(errors).toEqual([]);
    await page.context().close();
  });
});

describe("Set secret (C-7)", () => {
  for (const theme of THEMES)
    for (const width of WIDTHS)
      it(`?secret= preselects the name; first focus on Value (${theme}, ${width})`, async () => {
        const { page, errors } = await open(
          "#/p/djdl/keys?secret=OIDC_CLIENT_SECRET",
          { theme, width },
        );
        const drawer = page.getByRole("dialog", {
          name: "Set OIDC_CLIENT_SECRET",
        });
        await drawer.waitFor();
        await page.waitForTimeout(200);
        expect(await focused(page)).toMatch(/Value/);
        await shot(page, `set-secret-${theme}-${width}`);
        expect(await violations(page)).toEqual([]);
        expect(errors).toEqual([]);
        await page.context().close();
      });
});
