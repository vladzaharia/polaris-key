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
import type { Page } from "playwright";
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
const feed = (over: Record<string, unknown>) => ({
  product: "tidewater",
  productName: "Tidewater Studio",
  licenseId: "lic_tidewater",
  ecosystem: "npm",
  accessMode: "licensed",
  baseUrl: "https://pkg.plrs.im/npm/tidewater/",
  namespace: { scope: "@tidewater" },
  ...over,
});
const legacy = {
  product: "tidewater",
  productName: "Tidewater Studio",
  licenseId: "lic_tidewater",
  tokenId: "rt_old",
  label: "Old laptop",
  hint: "q9Zx",
  ecosystems: null,
  presentation: "header",
  createdAt: FIXTURE_NOW - 90 * DAY,
  expiresAt: FIXTURE_NOW + 30 * DAY,
  lastUsedAt: null,
  revokedAt: null,
  status: "active",
};
const limits = {
  minDays: 1,
  maxDays: 365,
  defaultDays: 90,
  labelMax: 64,
  perAccount: 25,
};
const list = {
  registryOrigin: "https://pkg.plrs.im",
  username: "__token__",
  feeds: [
    feed({}),
    feed({
      ecosystem: "pypi",
      baseUrl: "https://pkg.plrs.im/pypi/tidewater/simple/",
      namespace: {},
    }),
    feed({
      ecosystem: "godot",
      baseUrl: "https://pkg.plrs.im/godot/tidewater/",
      namespace: {},
    }),
    feed({
      product: "fennick",
      productName: "Fennick",
      licenseId: "lic_fennick",
      ecosystem: "oci",
      baseUrl: null,
      namespace: {},
    }),
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
  legacy: [legacy],
  limits,
};

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

/** Controls inside the Packages section under 44 px on either side (the customer-surface floor). */
async function belowFloor(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.getElementById("section-packages");
    if (!root) return [];
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(
      'button, [role="tab"], a[href], select, input:not([type="checkbox"])',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5)
        out.push(
          `${el.tagName} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
    return out;
  });
}

const SIZES = [
  { w: 360, h: 780, theme: "dark" as Theme, scale: 1 },
  { w: 390, h: 844, theme: "light" as Theme, scale: 1 },
  { w: 1280, h: 800, theme: "dark" as Theme, scale: 1 },
  { w: 1440, h: 900, theme: "dark" as Theme, scale: 1 },
  { w: 1440, h: 900, theme: "light" as Theme, scale: 1 },
  // 200 % and 400 % zoom: a smaller CSS viewport at a higher ratio.
  { w: 640, h: 400, theme: "light" as Theme, scale: 2 },
  { w: 320, h: 256, theme: "dark" as Theme, scale: 4 },
];

describe.concurrent("Account → Packages", () => {
  for (const s of SIZES) {
    it(`section, create, step-up and shown once at ${s.w} (${s.theme}, ${s.scale}x)`, async () => {
      let stale = true;
      const o = await portal.open("three", "/#/account/packages", {
        theme: s.theme,
        width: s.w,
        height: s.h,
        deviceScaleFactor: s.scale,
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
        const tag = `${s.w}-${s.theme}${s.scale > 1 ? `-${s.scale}x` : ""}`;
        const check = async (name: string, floor = false): Promise<void> => {
          await shoot(o.page, `packages.${name}-${tag}`);
          expect(await o.violations(), `${name} csp`).toEqual([]);
          expect(await axe(o.page), `${name} axe`).toEqual([]);
          expect(await h1Count(o.page), `${name} h1`).toBe(1);
          expect(await horizontalOverflow(o.page), `${name} overflow`).toBe(0);
          expect(await smallTargets(o.page), `${name} targets`).toEqual([]);
          if (floor)
            expect(await belowFloor(o.page), `${name} 44px`).toEqual([]);
        };
        await check("section", true);
        await region
          .getByRole("button", { name: "Create personal token" })
          .click();
        const dialog = o.page.getByRole("dialog", {
          name: "Create a personal token",
        });
        await dialog.getByLabel("Name").fill("Laptop");
        await check("create");
        await dialog
          .getByRole("button", { name: "Create", exact: true })
          .click();
        await dialog
          .getByText(/confirm|sign in/i)
          .first()
          .waitFor();
        // One footer only while the step-up shows.
        expect(
          await dialog
            .getByRole("button", { name: "Create", exact: true })
            .count(),
        ).toBe(0);
        await check("step-up");
        stale = false;
        // A confirmed sign-in runs the request again; here, press Escape-free: reopen the form.
        await dialog.getByRole("button", { name: "Cancel" }).first().click();
        await dialog
          .getByRole("button", { name: "Create", exact: true })
          .click();
        const shown = o.page.getByRole("dialog", {
          name: "Copy your personal token now",
        });
        await shown.waitFor();
        await check("shown-once");
        // The setup in the dialog names the variable: the token is in no config file.
        expect(await shown.textContent()).not.toContain(`_authToken=${TOKEN}`);
        await shown.getByRole("checkbox", { name: /stored it/ }).check();
        await shown.getByRole("button", { name: "Done" }).click();
        await shown.waitFor({ state: "detached" });
        // Focus goes to the new row or Create, never the body.
        await o.page.waitForFunction(
          () =>
            document.activeElement && document.activeElement.tagName !== "BODY",
        );
      } finally {
        await o.close();
      }
    });
  }

  it("the Godot feed gets its own URL, and forced colours keep the section legible", async () => {
    const o = await portal.open("three", "/#/account/packages", {
      forcedColors: "active",
      routes: {
        "GET /api/me/tokens": () => ({ body: list }),
      },
    });
    try {
      await h1(o.page, "Account");
      const region = o.page.getByRole("region", { name: /^Packages$/ });
      await region.getByText("CI build server").waitFor();
      await region.getByRole("radio", { name: "Godot" }).click();
      await region.getByText(/can't use personal tokens/).waitFor();
      await shoot(o.page, "packages.godot-forced-1440");
      expect(await o.violations()).toEqual([]);
      expect(await axe(o.page, { forcedColors: true })).toEqual([]);
    } finally {
      await o.close();
    }
  });

  it("is left out with no feed, token or per-app token", async () => {
    const o = await portal.open("three", "/#/account", {
      routes: {
        "GET /api/me/tokens": () => ({
          body: { ...list, feeds: [], tokens: [], legacy: [] },
        }),
      },
    });
    try {
      await h1(o.page, "Account");
      await o.page.getByRole("region", { name: "Sign-in methods" }).waitFor();
      await o.page.waitForTimeout(300);
      expect(
        await o.page.getByRole("region", { name: /^Packages$/ }).count(),
      ).toBe(0);
    } finally {
      await o.close();
    }
  });
});
