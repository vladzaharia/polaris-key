/**
 * NoAccessPage in a real browser (ST-29; mockups `admin.no-access`, `admin.no-access-home`): the
 * built console under the Worker's CSP, in dark and light, at a phone and a desktop width. Each
 * render must load with no CSP violation and no page-level sideways scroll, keep exactly one h1,
 * keep every target at 24 px or more, and survive forced colours. With PK_SHOTS_DIR set, each
 * render is written to `<dir>/admin.<state>/<width>-<theme>.png`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { forcedColourBreaches, unlabelledScrollers } from "./pageChecks.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);

const TEN = [
  "members",
  "core",
  "license",
  "config",
  "ship",
  "signin",
  "sync",
  "commerce",
  "keys",
  "settings",
];

const SERVICES = Object.fromEntries(
  [
    "license",
    "config",
    "release",
    "distribution",
    "update",
    "identity",
    "sync",
  ].map((s) => [s, { enabled: true }]),
);

function product(slug: string, name: string): Record<string, unknown> {
  return {
    slug,
    name,
    signingKid: "kid-1",
    compatMin: "1.0.0",
    compatMax: "2.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    adminGroup: null,
    createdAt: NOW - 86400,
    modifiedAt: NOW - 3600,
    setup: { status: "ok", healthy: true, nextActions: [] },
    services: SERVICES,
    registration: null,
    effectiveRegistration: "requires-license",
    servicesSource: "manifest",
  };
}

/** Diceroll's admin narrowed to Ship builds and Commerce (the mockup's Lucía). */
const LUCIA = {
  sub: "m-lucia",
  name: "Lucía Ortega",
  email: "lucia@example.com",
  csrf: "c",
  platformAdmin: false,
  sessionExpiresAt: NOW + 3600,
  products: [{ slug: "diceroll", name: "Diceroll", schemaVersion: 2 }],
  permissions: {
    roles: [
      {
        role: "product_admin",
        scope: "product:diceroll",
        areas: ["ship", "commerce"],
        source: "grant",
      },
    ],
    platform: { view: ["console"], edit: ["console"] },
    products: {
      diceroll: { view: ["ship", "commerce"], edit: ["ship", "commerce"] },
    },
  },
};

/** Console access only (the mockup's Noor). */
const NOOR = {
  sub: "m-noor",
  name: "Noor Haddad",
  email: "noor@studio.example.com",
  csrf: "c",
  platformAdmin: false,
  sessionExpiresAt: NOW + 3600,
  products: [],
  permissions: {
    roles: [
      {
        role: "console_access",
        scope: "platform",
        areas: null,
        source: "rule",
      },
    ],
    platform: { view: ["console"], edit: ["console"] },
    products: {},
  },
};

const STATES = [
  {
    name: "no-access",
    hash: "#/p/diceroll/license/licenses",
    me: LUCIA,
    h1: "You don’t have access to Diceroll → Licensing",
    admins: [
      { name: "Kenji Mori", email: "kenji@example.com", role: "product_admin" },
      { name: "Ada Lindqvist", email: "ada@example.com", role: "superadmin" },
      { name: "Jonas Weber", email: "jonas@example.com", role: "superadmin" },
    ],
  },
  {
    name: "no-access-home",
    hash: "#/",
    me: NOOR,
    h1: "You don’t have access to any product yet",
    admins: [
      { name: "Ada Lindqvist", email: "ada@example.com", role: "superadmin" },
      { name: "Jonas Weber", email: "jonas@example.com", role: "superadmin" },
    ],
  },
] as const;

const SIZES = [
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
] as const;

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
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.httpServer.close(() => done()));
});

async function open(
  state: (typeof STATES)[number],
  theme: "dark" | "light",
  viewport: { width: number; height: number },
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport,
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
  const routes: Record<string, unknown> = {
    "/manage/api/me": state.me,
    "/manage/api/products": {
      products: state.me.products.map((p) => product(p.slug, p.name)),
    },
    "/manage/api/products/diceroll": {
      product: product("diceroll", "Diceroll"),
    },
    "/manage/api/access/admins": {
      scope: "product:diceroll",
      area: "license",
      admins: state.admins,
    },
    "/manage/api/summary": { products: {} },
  };
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      const body = routes[url.pathname];
      return body
        ? route.fulfill({ json: body })
        : route.fulfill({
            status: 403,
            json: {
              error: { code: "forbidden", reason: "no_access" },
              code: "forbidden",
            },
          });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/manage.html${state.hash}`);
  await page.locator("[data-no-access]").waitFor();
  await page.getByText(state.admins[0]!.name).waitFor();
  return page;
}

/** Interactive targets under 24 px in either dimension (EXPERIENCE §7.3, console). */
function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll(
      "main a[href], main button, main [role=button]",
    )) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.width < 24 || r.height < 24)
        out.push(
          `${(el.textContent || el.getAttribute("aria-label") || "").trim()} ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
    return out;
  });
}

describe("NoAccessPage in the browser", () => {
  for (const state of STATES)
    for (const theme of ["dark", "light"] as const)
      for (const size of SIZES)
        it(`${state.name} ${size.width} ${theme}`, async () => {
          const page = await open(state, theme, size);
          const h1 = page.getByRole("heading", { level: 1 });
          expect(await h1.count()).toBe(1);
          expect((await h1.textContent())?.trim()).toBe(state.h1);
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth,
            ),
          ).toBe(true);
          expect(await unlabelledScrollers(page)).toEqual([]);
          expect(await smallTargets(page)).toEqual([]);
          expect(
            await page.evaluate(() =>
              (window as unknown as { __v: string[] }).__v.splice(0),
            ),
          ).toEqual([]);
          if (SHOTS) {
            mkdirSync(`${SHOTS}/admin.${state.name}`, { recursive: true });
            await page.screenshot({
              path: `${SHOTS}/admin.${state.name}/${size.width}-${theme}.png`,
              fullPage: true,
            });
          }
          await page.context().close();
        }, 60_000);

  it("keeps its parts in forced colours", async () => {
    const page = await open(STATES[0], "dark", SIZES[1]);
    await page.emulateMedia({ forcedColors: "active" });
    expect(await forcedColourBreaches(page)).toEqual([]);
    await page.context().close();
  }, 60_000);
});
