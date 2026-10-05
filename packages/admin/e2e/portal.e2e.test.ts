import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { mediaResponseHeaders } from "../../worker/src/services/identity/portal/media.js";
import {
  portalMedia,
  portalRoutes,
  type PortalScenario,
} from "./portalFixtures.js";

/**
 * The customer site (PORTAL.md) in real Chromium under the Worker's exact CSP: every main flow
 * loads with zero violations and no horizontal scroll at 360 px, in both themes.
 *
 * Set `PK_SHOTS_DIR` to also save screenshots (dark and light, 1440 and 390 px) there.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;

let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  if (!existsSync(`${here}dist/index.html`)) {
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

interface Opened {
  page: Page;
  violations: () => Promise<string[]>;
  requests: string[];
  /**
   * Closes the context. The catch-all route passes static assets through, and a font fetch can
   * still be in flight when a test ends; dropping the routes first (Playwright's own advice)
   * keeps that callback from rejecting into whichever test runs next.
   */
  close: () => Promise<void>;
}

async function open(
  scenario: PortalScenario,
  path: string,
  opts: { theme?: "dark" | "light"; width?: number; height?: number } = {},
): Promise<Opened> {
  const theme = opts.theme ?? "dark";
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
    colorScheme: theme,
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
  const routes = portalRoutes(scenario);
  const requests: string[] = [];
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/") || url.pathname === "/logout") {
      requests.push(`${req.method()} ${url.pathname}${url.search}`);
      const handler =
        routes[`${req.method()} ${url.pathname}`] ?? routes[url.pathname];
      if (!handler)
        return route.fulfill({ status: 404, json: { error: "not_found" } });
      const res = typeof handler === "function" ? handler(req) : handler;
      return route.fulfill({ status: res.status ?? 200, json: res.body });
    }
    // PX-08: developer art as the media proxy answers it (same origin, its own headers).
    if (url.pathname.startsWith("/media/")) {
      requests.push(`${req.method()} ${url.pathname}`);
      const png = portalMedia(url.pathname);
      if (!png) return route.fulfill({ status: 404, body: "" });
      const headers = Object.fromEntries(
        mediaResponseHeaders({
          "content-type": "image/png",
          "content-length": String(png.byteLength),
          "content-disposition": "inline",
        }),
      );
      return route.fulfill({ status: 200, headers, body: png });
    }
    // The Worker serves the SPA shell for `/activate` (router.ts); vite preview does not.
    const res =
      url.pathname === "/activate"
        ? await route.fetch({ url: `${base}/index.html` })
        : await route.fetch();
    const headers = { ...res.headers() };
    if (
      url.pathname.endsWith(".html") ||
      url.pathname === "/" ||
      url.pathname === "/activate"
    )
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}${path}`);
  return {
    page,
    requests,
    close: async () => {
      await ctx.unrouteAll({ behavior: "ignoreErrors" });
      await ctx.close();
    },
    violations: () =>
      page.evaluate(() =>
        (window as unknown as { __v: string[] }).__v.splice(0),
      ),
  };
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, "horizontal page scroll").toBeLessThanOrEqual(0);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

const h1 = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name }).first().waitFor();

/** Each screen at both widths in both themes: zero violations, no 360 px scroll. */
const SCREENS: {
  name: string;
  scenario: PortalScenario;
  path: string;
  ready: (page: Page) => Promise<void>;
  act?: (page: Page) => Promise<void>;
}[] = [
  {
    name: "signin",
    scenario: "signedOut",
    path: "/",
    ready: (p) => h1(p, "Sign in to Polaris Key"),
  },
  {
    name: "library-empty",
    scenario: "empty",
    path: "/",
    ready: (p) => h1(p, "Your library"),
  },
  {
    name: "library-1",
    scenario: "one",
    path: "/",
    ready: (p) => h1(p, "Your library"),
  },
  {
    name: "library-3",
    scenario: "three",
    path: "/",
    ready: (p) => h1(p, "Your library"),
  },
  {
    name: "library-12",
    scenario: "twelve",
    // No forced view: the desktop default grid, the phone default list (§8, mockup 21).
    path: "/",
    ready: (p) => h1(p, "Your library"),
  },
  {
    name: "library-12-list",
    scenario: "twelve",
    path: "/#/?view=list",
    ready: (p) => h1(p, "Your library"),
  },
  {
    name: "product",
    scenario: "three",
    path: "/#/p/nightfall",
    ready: (p) => h1(p, "Nightfall"),
  },
  {
    name: "product-not-found",
    scenario: "three",
    path: "/#/p/unknown-thing",
    ready: (p) => h1(p, "That product isn't in your library"),
  },
  {
    name: "account",
    scenario: "three",
    path: "/#/account",
    ready: (p) => h1(p, "Account"),
  },
  {
    name: "product-package",
    scenario: "three",
    path: "/#/p/tidewater/package",
    ready: async (p) => {
      await h1(p, "Tidewater Studio");
      await p.getByRole("heading", { name: /Package access/ }).waitFor();
    },
  },
  {
    name: "device-limit",
    scenario: "twelve",
    path: "/#/p/orbit-survey/free-device?for=Mara%E2%80%99s%20Steam%20Deck&return=orbitsurvey%3A%2F%2Fretry",
    ready: (p) => h1(p, "Your license is on 2 of 2 devices"),
  },
  {
    name: "download-flow",
    scenario: "three",
    path: "/#/p/nightfall/download?platform=linux",
    ready: (p) => h1(p, "Download Nightfall for Linux"),
  },
  {
    name: "discover-empty",
    scenario: "three",
    path: "/#/discover",
    ready: (p) => h1(p, "Nothing to add right now"),
  },
];

describe("the customer site under the Worker's CSP", () => {
  for (const screen of SCREENS) {
    it(`${screen.name}: both themes, 1440 and 390 px, no violations or 360 px scroll`, async () => {
      for (const theme of ["dark", "light"] as const) {
        for (const width of [1440, 390]) {
          const o = await open(screen.scenario, screen.path, {
            theme,
            width,
            height: width === 390 ? 844 : 900,
          });
          await screen.ready(o.page);
          await shoot(
            o.page,
            `${screen.name}-${width === 390 ? "mobile" : "desktop"}-${theme}`,
          );
          if (width === 390) {
            await o.page.setViewportSize({ width: 360, height: 780 });
            await o.page.waitForTimeout(100);
            await noHorizontalScroll(o.page);
          }
          expect(
            await o.violations(),
            `${screen.name} ${theme} ${width}`,
          ).toEqual([]);
          await o.close();
        }
      }
    });
  }
});

describe("Library on GET /api/library (PX-08)", () => {
  it("shows proxied art with zero violations, every image decoded", async () => {
    const o = await open("three", "/");
    await h1(o.page, "Your library");
    await expect
      .poll(() =>
        o.page.evaluate(
          () =>
            [...document.images].filter((i) => i.complete && i.naturalWidth > 0)
              .length,
        ),
      )
      .toBeGreaterThanOrEqual(4);
    const srcs = await o.page.evaluate(() =>
      [...document.images].map((i) => new URL(i.src).pathname),
    );
    expect(srcs.every((s) => s.startsWith("/media/"))).toBe(true);
    expect(o.requests).toContain("GET /media/nightfall/header");
    await o.page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: /Discover/ })
      .waitFor();
    expect(await o.violations()).toEqual([]);
    await o.close();
  });
});

describe("focused flows (PX-10)", () => {
  it("frees a device and returns only to the declared app link", async () => {
    const o = await open(
      "twelve",
      "/#/p/orbit-survey/free-device?for=Steam%20Deck&return=orbitsurvey%3A%2F%2Fretry",
      { width: 390, height: 844 },
    );
    await h1(o.page, "Your license is on 2 of 2 devices");
    expect(
      await o.page
        .getByRole("radio", { name: /Work laptop/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await o.page
      .getByRole("button", { name: "Remove Work laptop and continue" })
      .click();
    await h1(o.page, "Work laptop was removed");
    await shoot(o.page, "device-limit-done-mobile-dark");
    expect(
      await o.page
        .getByRole("link", { name: "Back to Orbit Survey" })
        .last()
        .getAttribute("href"),
    ).toBe("orbitsurvey://retry");
    expect(o.requests).toContain(
      "DELETE /api/licenses/orbit-survey/lic_orbit-survey/devices/work",
    );
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("drops an undeclared return URL", async () => {
    const o = await open(
      "twelve",
      "/#/p/orbit-survey/free-device?return=https%3A%2F%2Fevil.example%2F",
    );
    await h1(o.page, "Your license is on 2 of 2 devices");
    expect(
      await o.page
        .getByRole("link", { name: "See Orbit Survey in your library" })
        .getAttribute("href"),
    ).toBe("#/p/orbit-survey");
    expect(await o.page.content()).not.toContain("evil.example");
    await o.close();
  });
});

describe("package access (PX-11)", () => {
  it("creates a token and shows it once in a dialog that Escape doesn't close", async () => {
    const o = await open("three", "/#/p/tidewater/package");
    await h1(o.page, "Tidewater Studio");
    await o.page.getByRole("button", { name: "Create token" }).click();
    const form = o.page.getByRole("dialog", { name: "Create a token" });
    await form.getByLabel("Name").fill("Laptop 2");
    await form.getByRole("button", { name: "Create token" }).click();
    const shown = o.page.getByRole("dialog", { name: "Copy your token now" });
    await shown.waitFor();
    await shoot(o.page, "product-token-desktop-dark");
    await o.page.keyboard.press("Escape");
    await shown.getByText(/Close without copying\?/).waitFor();
    expect(await shown.isVisible()).toBe(true);
    expect(o.requests).toContain(
      "POST /api/licenses/tidewater/lic_tidewater/registry-tokens",
    );
    expect(await o.violations()).toEqual([]);
    await o.close();
  });
});

describe("main flows", () => {
  it("activates a license from the header and lands on the product page", async () => {
    const o = await open("three", "/");
    await h1(o.page, "Your library");
    await o.page.getByRole("button", { name: "Activate license" }).click();
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.waitFor();
    await dialog
      .getByRole("textbox", { name: "License key" })
      .fill("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w");
    await dialog.getByText("Key format is valid").waitFor();
    await shoot(o.page, "activate-key-desktop-dark");
    await dialog.getByRole("button", { name: "Continue" }).click();
    const confirm = o.page.getByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await confirm.waitFor();
    await confirm.getByText("Lifetime · up to 5 devices").waitFor();
    await shoot(o.page, "activate-confirm-desktop-dark");
    expect(o.requests).toContain("POST /api/activate/preview");
    expect(o.requests).not.toContain("POST /api/claim/license-key");
    await confirm.getByRole("button", { name: "Add Mossgarden" }).click();
    const done = o.page.getByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    await done.waitFor();
    await shoot(o.page, "activate-done-desktop-dark");
    await done.getByRole("button", { name: "Open Mossgarden" }).click();
    await h1(o.page, "Mossgarden");
    await expect
      .poll(() => o.page.evaluate(() => document.activeElement?.tagName))
      .toBe("H1");
    expect(o.requests).toContain("POST /api/claim/license-key");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("opens /activate?key=… as the Library with the modal prefilled", async () => {
    const o = await open(
      "three",
      "/activate?key=pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w",
      { width: 390, height: 844 },
    );
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.waitFor();
    expect(
      await dialog.getByRole("textbox", { name: "License key" }).inputValue(),
    ).toBe("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w");
    await dialog.getByText("Filled in from your link").waitFor();
    expect(await o.page.evaluate(() => location.pathname)).toBe("/");
    await shoot(o.page, "activate-link-mobile-dark");
    await o.page.keyboard.press("Escape");
    await h1(o.page, "Your library");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("shows the inline errors of a refused key", async () => {
    const o = await open("three", "/#/?activate=5XKQ7-B2M9P-HT4LZ");
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.getByText(/looks like a Steam key/).waitFor();
    await dialog
      .getByRole("textbox", { name: "License key" })
      .fill("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4z");
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByText(/We couldn't find that key/).waitFor();
    await shoot(o.page, "activate-errors-desktop-dark");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("removes a device with the inline confirmation", async () => {
    const o = await open("three", "/#/p/nightfall/devices");
    await h1(o.page, "Nightfall");
    await o.page
      .getByRole("button", { name: "Remove Studio PC" })
      .first()
      .click();
    const heading = o.page.getByRole("heading", { name: "Remove Studio PC?" });
    await heading.waitFor();
    await expect
      .poll(() => o.page.evaluate(() => document.activeElement?.textContent))
      .toBe("Remove Studio PC?");
    await shoot(o.page, "product-remove-device-desktop-dark");
    await o.page
      .getByRole("button", { name: "Remove Studio PC", exact: true })
      .last()
      .click();
    await o.page.getByText("Studio PC was removed").first().waitFor();
    expect(o.requests.some((r) => r.startsWith("DELETE /api/licenses/"))).toBe(
      true,
    );
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("jumps to a product with ⌘K from 8 products", async () => {
    const o = await open("twelve", "/");
    await h1(o.page, "Your library");
    await o.page.keyboard.press("Control+k");
    const palette = o.page.getByRole("dialog", { name: "Jump to a product" });
    await palette.waitFor();
    await o.page.keyboard.type("glyph");
    await shoot(o.page, "switcher-desktop-dark");
    await o.page.keyboard.press("Enter");
    await h1(o.page, "Glyphsmith");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("filters and searches the library, kept in the URL", async () => {
    const o = await open("twelve", "/");
    await h1(o.page, "Your library");
    await o.page
      .getByRole("searchbox", { name: /Search 12 products/ })
      .fill("orbit");
    await o.page.getByText("Showing 1 of 12 ·").waitFor();
    expect(await o.page.evaluate(() => location.hash)).toContain("q=orbit");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("signs in with an email link: the honest sent screen", async () => {
    const o = await open("signedOut", "/", { width: 390, height: 844 });
    await h1(o.page, "Sign in to Polaris Key");
    await o.page
      .getByRole("textbox", { name: "Email" })
      .fill("mara@fennick.studio");
    await o.page.getByRole("button", { name: "Continue" }).click();
    await h1(o.page, "Check your email");
    await shoot(o.page, "signin-sent-mobile-dark");
    expect(o.requests).toContain("POST /api/magic/start");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("switches the theme from Account → Appearance", async () => {
    const o = await open("three", "/#/account/appearance");
    await h1(o.page, "Account");
    await o.page.getByRole("radio", { name: /Light/ }).click();
    expect(
      await o.page.evaluate(() => document.documentElement.dataset.theme),
    ).toBe("light");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });
});
