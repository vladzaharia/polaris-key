import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  axe,
  h1,
  h1Count,
  horizontalOverflow,
  shoot,
  smallTargets,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { FIXTURE_NOW } from "./portalFixtures.js";

/**
 * Account → Packages (F-33, portal-11) in real Chromium under the Worker's CSP: the section, the
 * create dialog, the shown-once dialog and the stale-sign-in step, at 360, 390 and 1440 px in
 * dark and light. Each render has zero CSP violations, zero axe violations, one h1, no page-level
 * sideways scroll and no target under 24 px. With PK_SHOTS_DIR set it saves each render.
 */

const DAY = 86_400;
const TOKEN = "pkeyp_Lm9xT2qVb8sPzK4wNc7dRf1hYj3e";
const view = (over: Record<string, unknown>) => ({
  id: "pt_ci",
  label: "CI build server",
  hint: "Hq2a",
  scope: "packages:read",
  createdAt: FIXTURE_NOW - 60 * DAY,
  expiresAt: FIXTURE_NOW + 90 * DAY,
  lastUsedAt: FIXTURE_NOW - 3 * 3600,
  revokedAt: null,
  status: "active",
  ...over,
});
const list = {
  registryOrigin: "https://pkg.plrs.im",
  username: "__token__",
  feeds: [
    {
      product: "tidewater",
      productName: "Tidewater Studio",
      ecosystem: "npm",
      accessMode: "licensed",
      baseUrl: "https://pkg.plrs.im/npm/tidewater/",
    },
    {
      product: "tidewater",
      productName: "Tidewater Studio",
      ecosystem: "pypi",
      accessMode: "licensed",
      baseUrl: "https://pkg.plrs.im/pypi/tidewater/simple/",
    },
    {
      product: "fennick",
      productName: "Fennick",
      ecosystem: "oci",
      accessMode: "licensed",
      baseUrl: null,
    },
  ],
  tokens: [
    view({}),
    view({
      id: "pt_laptop",
      label: "Work laptop with a rather long name that must wrap",
      hint: "j3eX",
      lastUsedAt: null,
      expiresAt: FIXTURE_NOW + 6 * DAY - 60,
    }),
  ],
  limits: {
    minDays: 1,
    maxDays: 365,
    defaultDays: 90,
    labelMax: 64,
    perAccount: 25,
  },
};

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

const SIZES = [
  { w: 360, h: 780, theme: "dark" as Theme },
  { w: 390, h: 844, theme: "light" as Theme },
  { w: 1440, h: 900, theme: "dark" as Theme },
  { w: 1440, h: 900, theme: "light" as Theme },
];

describe.concurrent("Account → Packages", () => {
  for (const s of SIZES) {
    it(`section, create, shown once and step-up at ${s.w} (${s.theme})`, async () => {
      let stale = true;
      const o = await portal.open("three", "/#/account/packages", {
        theme: s.theme,
        width: s.w,
        height: s.h,
        routes: {
          "GET /api/me/tokens": () => ({ body: list }),
          "POST /api/me/tokens": () =>
            stale
              ? { status: 401, body: { error: "step_up_required" } }
              : {
                  status: 201,
                  body: {
                    ok: true,
                    token: TOKEN,
                    view: view({ id: "pt_new", label: "Laptop", hint: "j3e" }),
                  },
                },
        },
      });
      try {
        await h1(o.page, "Account");
        const region = o.page.getByRole("region", { name: /^Packages$/ });
        await region.getByText("CI build server").waitFor();
        const check = async (name: string): Promise<void> => {
          await shoot(o.page, `packages.${name}-${s.w}-${s.theme}`);
          expect(await o.violations(), `${name} csp`).toEqual([]);
          expect(await axe(o.page), `${name} axe`).toEqual([]);
          expect(await h1Count(o.page), `${name} h1`).toBe(1);
          expect(await horizontalOverflow(o.page), `${name} overflow`).toBe(0);
          expect(await smallTargets(o.page), `${name} targets`).toEqual([]);
        };
        await check("section");
        await region.getByRole("button", { name: "Create token" }).click();
        const dialog = o.page.getByRole("dialog", { name: "Create a token" });
        await dialog.getByLabel("Name").fill("Laptop");
        await check("create");
        await dialog.getByRole("button", { name: "Create token" }).click();
        await dialog
          .getByText(/confirm|sign in/i)
          .first()
          .waitFor();
        await check("step-up");
        // A confirmed sign-in: the next try succeeds.
        stale = false;
        await dialog.getByRole("button", { name: "Create token" }).click();
        const shown = o.page.getByRole("dialog", {
          name: "Copy your token now",
        });
        await shown.waitFor();
        await check("shown-once");
      } finally {
        await o.close();
      }
    });
  }
});
