import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { resolve } from "./layoutFixtures.js";

/**
 * UX-69 (SETUP.md D42): Platform → Store connections' connect form in the BUILT console, under
 * the Worker's CSP, in both themes. A key pasted into the field is sent once to the check route
 * (scripted here), and every answer the Worker can give renders as its own state: checking, valid,
 * a warning, refused with the fix, a refusal on one field, and the store being down. Save is
 * enabled only after a pass.
 *
 * With `PK_SHOTS_DIR` set, each state is saved as `store-check--<state>-<theme>.png`.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const BASE = "/manage/api/platform/store-connections";
const STEAM_KEY = "0123456789ABCDEF0123456789ABCDEF";

const CHECKS: Record<string, Record<string, unknown> | "pending"> = {
  checking: "pending",
  valid: {
    verdict: "valid",
    reason: "ok",
    title: "Publisher key · 2 apps",
    detail: null,
    facts: [
      { label: "Apps", value: "2" },
      { label: "First apps", value: "Dice, Dice Soundtrack" },
    ],
  },
  warning: {
    verdict: "warning",
    reason: "wrong-account",
    title: "This key cannot see an app a product is assigned: 480",
    detail:
      "It may belong to another team or account, or its access is limited to some apps. Saving it would leave that product without a working key.",
    facts: [{ label: "Apps", value: "1" }],
  },
  invalid: {
    verdict: "invalid",
    reason: "rejected",
    title: "Steam did not accept this as a publisher Web API key",
    detail:
      "Use the key from Steamworks → Users & Permissions → Manage Groups → your group → Web API key. A personal key from steamcommunity.com/dev/apikey cannot reach the publisher API.",
    facts: [],
    status: 403,
  },
  unavailable: {
    verdict: "unavailable",
    reason: "store-down",
    title: "Steam could not be reached",
    detail:
      "Nothing is known about the key yet. Steam answered HTTP 503; check again in a few minutes.",
    facts: [],
    status: 503,
  },
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
  hash: string,
  answer: Record<string, unknown> | "pending",
  sent: unknown[],
): Promise<{ page: Page; violations: () => Promise<string[]> }> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((t) => {
    window.localStorage.setItem("pk-admin-theme", t);
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  }, theme);
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith("/manage/api/")) {
      if (req.method() === "POST" && url.pathname.endsWith("/check")) {
        sent.push(req.postDataJSON());
        if (answer === "pending") return; // never answers: the checking state
        return route.fulfill({ json: { ok: true, check: answer } });
      }
      if (req.method() !== "GET") return route.fulfill({ json: { ok: true } });
      const body = resolve(url.pathname);
      return body === undefined
        ? route.fulfill({ status: 404, json: { error: "not_found" } })
        : route.fulfill({ json: body });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/manage.html${hash}`);
  await page.locator("[data-page-title]").first().waitFor({ timeout: 15_000 });
  return {
    page,
    violations: () =>
      page.evaluate(() => (window as unknown as { __v: string[] }).__v),
  };
}

async function shoot(page: Page, form: string, file: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.locator(form).screenshot({ path: `${SHOTS}/${file}.png` });
}

const STEAM_FORM =
  'form[aria-label="Connect Steamworks Web API publisher key (group)"]';

for (const theme of ["light", "dark"] as const) {
  describe(`store connections · live check · ${theme}`, () => {
    for (const [state, answer] of Object.entries(CHECKS)) {
      it(`renders the ${state} state`, async () => {
        const sent: unknown[] = [];
        const { page, violations } = await open(
          theme,
          "#/platform/store-connections?store=steam",
          answer,
          sent,
        );
        const form = page.locator(STEAM_FORM);
        await form.waitFor();
        // "Save key", or "Save anyway" after a warning: the form's one submit button.
        const save = form.locator('button[type="submit"]');
        expect(await save.isDisabled()).toBe(true);
        const field = form.getByLabel(/Publisher Web API key/);
        await field.focus();
        // A real paste: the clipboard is the browser's own, so the check fires on `paste`.
        await page.evaluate((v) => {
          const el = document.activeElement as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )!.set!;
          const data = new DataTransfer();
          data.setData("text/plain", v);
          el.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
          );
          setter.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, STEAM_KEY);
        if (answer === "pending") {
          await form.getByText("Checking with Steam…").waitFor();
        } else {
          await form
            .getByText(answer.title as string, { exact: true })
            .waitFor();
          const savable =
            answer.verdict === "valid" || answer.verdict === "warning";
          await expect
            .poll(async () => !(await save.isDisabled()))
            .toBe(savable);
          expect(await save.textContent()).toContain(
            answer.verdict === "warning" ? "Save anyway" : "Save key",
          );
        }
        expect(sent).toEqual([{ value: { key: STEAM_KEY } }]);
        await shoot(page, STEAM_FORM, `store-check--${state}-${theme}`);
        expect(await violations()).toEqual([]);
        await page.context().close();
      });
    }

    it("marks a refused field (Partner Center's expired client secret)", async () => {
      const sent: unknown[] = [];
      const { page, violations } = await open(
        theme,
        "#/platform/store-connections?store=microsoft-store",
        {
          verdict: "invalid",
          reason: "expired",
          title: "This client secret has expired",
          detail:
            "Create a new client secret for the app in Microsoft Entra ID → App registrations → Certificates & secrets, and paste its Value.",
          facts: [],
          field: "value.clientSecret",
          status: 401,
        },
        sent,
      );
      await page.getByRole("button", { name: "Replace key" }).first().click();
      const formSel = 'form[aria-label^="Connect Partner Center app"]';
      const form = page.locator(formSel);
      await form
        .getByLabel("Tenant ID")
        .fill("11111111-2222-3333-4444-555555555555");
      await form
        .getByLabel("Client ID")
        .fill("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      await form.getByLabel("Seller ID").fill("12345678");
      await form.getByLabel(/Client secret/).fill("expired-secret-value");
      await form.getByRole("button", { name: "Check", exact: true }).click();
      await expect
        .poll(() =>
          form.getByLabel(/Client secret/).getAttribute("aria-invalid"),
        )
        .toBe("true");
      expect(sent).toHaveLength(1);
      await shoot(page, formSel, `store-check--field-expired-${theme}`);
      expect(await violations()).toEqual([]);
      await page.context().close();
    });
  });
}
