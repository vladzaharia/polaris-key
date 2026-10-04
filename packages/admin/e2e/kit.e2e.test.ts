import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";

/**
 * Chunk 3's overlays (ADMIN.md §7.2) under the Worker's real CSP: every dialog, confirm, drawer,
 * one-time secret, menu, select, popover, tooltip, toast and the lazy CodeMirror editor in the
 * `#/__kit` gallery, in real Chromium. Each must log zero `securitypolicyviolation` events; each
 * modal overlay must really lock the page behind it (through the react-style-singleton shim,
 * src/lib/styleSingleton.ts) and release the lock when it closes.
 *
 * The gallery is development-only, so this builds a separate bundle with `VITE_PK_KIT=1` into
 * `dist-kit/` (git-ignored). The shipped `dist/` never contains it.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const OUT = "dist-kit";

let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  process.env.VITE_PK_KIT = "1";
  try {
    await build({
      root: here,
      configFile: `${here}vite.config.ts`,
      logLevel: "silent",
      build: { outDir: OUT, emptyOutDir: true },
    });
  } finally {
    delete process.env.VITE_PK_KIT;
  }
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    build: { outDir: OUT },
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
  viewport = { width: 1440, height: 900 },
  consoleErrors?: string[],
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport,
    colorScheme: theme,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await ctx.addInitScript(() => {
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
      ),
    );
  });
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      return route.fulfill({ status: 404, json: { error: "not_found" } });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors?.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors?.push(e.message));
  await page.goto(`${base}/manage.html#/__kit`);
  await page
    .getByRole("heading", { level: 1, name: "Component gallery" })
    .waitFor();
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

const locked = (page: Page): Promise<boolean> =>
  page.evaluate(() => getComputedStyle(document.body).overflow === "hidden");

const story = (page: Page, id: string): Locator => page.locator(`#story-${id}`);

const report: Record<string, { violations: number; locked: boolean }> = {};

/**
 * Open an overlay, check the scroll lock (modal) or its absence (non-modal), close it, and
 * require zero CSP violations across the whole open/close cycle.
 */
async function check(
  page: Page,
  name: string,
  openIt: () => Promise<void>,
  opts: {
    modal: boolean;
    close?: () => Promise<void>;
  },
): Promise<void> {
  await violations(page);
  await openIt();
  await page.waitForTimeout(300);
  const isLocked = await locked(page);
  if (opts.close) await opts.close();
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const v = await violations(page);
  report[name] = { violations: v.length, locked: isLocked };
  expect(v, `${name}: CSP violations`).toEqual([]);
  expect(isLocked, `${name}: scroll lock`).toBe(opts.modal);
  expect(await locked(page), `${name}: lock not released`).toBe(false);
}

describe("the kit gallery's overlays under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`${theme}: the gallery loads with no violations or console errors`, async () => {
      const errors: string[] = [];
      const page = await open(theme, undefined, errors);
      await page.waitForTimeout(300);
      expect(await violations(page)).toEqual([]);
      expect(errors).toEqual([]);
      await page.context().close();
    });
  }

  it("the gallery settles: no render loop at load or after a theme change, phone or desktop", async () => {
    // A react-table auto-reset once re-rendered every DataTable forever after any second render
    // (a theme change; the virtualizer's first measure on a phone), freezing the page.
    const quiet = (page: Page): Promise<number> =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let n = 0;
            const mo = new MutationObserver((ms) => {
              n += ms.length;
            });
            mo.observe(document, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            setTimeout(() => {
              mo.disconnect();
              resolve(n);
            }, 1000);
          }),
      );
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      const page = await open("dark", viewport);
      await page.waitForTimeout(1000);
      expect(await quiet(page), `${viewport.width}px at rest`).toBe(0);
      await page
        .getByRole("group", { name: "Theme" })
        .getByRole("button", { name: "light" })
        .click();
      await page.waitForTimeout(500);
      expect(
        await quiet(page),
        `${viewport.width}px after a theme change`,
      ).toBe(0);
      await page.context().close();
    }
  });

  it("dialogs, confirms, drawers and the one-time secret lock scroll and log nothing", async () => {
    const page = await open("dark");
    for (const size of ["sm", "md", "lg", "xl"]) {
      await check(
        page,
        `dialog ${size}`,
        async () => {
          await story(page, "dialog")
            .getByRole("button", { name: `Open ${size} dialog` })
            .click();
          await page.getByRole("dialog", { name: "Edit holder" }).waitFor();
        },
        { modal: true },
      );
    }
    for (const label of [
      "Resync from repo…",
      "Disable license…",
      "Yank…",
      "Delete product…",
    ]) {
      await check(
        page,
        `confirm ${label}`,
        async () => {
          await story(page, "confirm-dialog")
            .getByRole("button", { name: label, exact: true })
            .click();
          await page
            .getByRole("alertdialog")
            .or(page.getByRole("dialog"))
            .first()
            .waitFor();
        },
        { modal: true },
      );
    }
    // The typed confirm with a server error stays open with the inline error, then closes.
    await check(
      page,
      "confirm with an inline error",
      async () => {
        await story(page, "confirm-dialog")
          .getByRole("button", { name: "Disable license (server refuses)…" })
          .click();
        const dlg = page
          .getByRole("alertdialog")
          .or(page.getByRole("dialog"))
          .first();
        await dlg.getByRole("button", { name: "Disable license" }).click();
        await dlg.getByText("Someone changed this license").waitFor();
      },
      { modal: true },
    );
    for (const side of ["end", "start"]) {
      await check(
        page,
        `drawer ${side}`,
        async () => {
          await story(page, "drawer")
            .getByRole("button", { name: `Open drawer from the ${side}` })
            .click();
          await page.getByRole("dialog").waitFor();
        },
        { modal: true },
      );
    }
    await check(
      page,
      "one-time secret (close guard)",
      async () => {
        await story(page, "one-time-secret")
          .getByRole("button", { name: "Create license" })
          .click();
        await page.getByRole("dialog", { name: "License created" }).waitFor();
      },
      {
        modal: true,
        close: async () => {
          await page.keyboard.press("Escape");
          // Escape asks first: the key cannot be shown again.
          await page
            .getByRole("button", { name: "Close without copying" })
            .click();
        },
      },
    );
    await page.context().close();
  });

  it("menus, selects, popovers, tooltips, toasts and the code editor log nothing", async () => {
    const page = await open("light");
    await check(
      page,
      "action menu",
      async () => {
        await story(page, "action-menu")
          .getByRole("button", { name: "More actions" })
          .click();
        await page.getByRole("menu").waitFor();
      },
      { modal: true },
    );
    await check(
      page,
      "select",
      async () => {
        await story(page, "form-select")
          .getByRole("combobox", { name: /Usage/ })
          .click();
        await page.getByRole("listbox").waitFor();
      },
      { modal: true },
    );
    await check(
      page,
      "combobox",
      async () => {
        await story(page, "form-combobox")
          .getByRole("button", { name: /^Release/ })
          .first()
          .click();
        await page.getByRole("listbox").first().waitFor();
      },
      { modal: false },
    );
    await check(
      page,
      "source badge popover",
      async () => {
        await story(page, "source-badges").getByRole("button").first().click();
        await page.getByRole("dialog").waitFor();
      },
      { modal: false },
    );
    await check(
      page,
      "table facet popover",
      async () => {
        await story(page, "data-table-default")
          .getByRole("button", { name: /^Status/ })
          .first()
          .click();
        await page.getByRole("dialog").waitFor();
      },
      { modal: false },
    );
    await check(
      page,
      "tooltip (disabled reason)",
      async () => {
        await story(page, "button-states")
          .locator("[aria-disabled=true]")
          .first()
          .focus();
        await page.getByRole("tooltip").waitFor();
      },
      { modal: false },
    );
    await check(
      page,
      "toasts",
      async () => {
        const s = story(page, "toasts");
        await s.getByRole("button", { name: "Success" }).click();
        await s.getByRole("button", { name: /^Error/ }).click();
        await page.getByText("Tier saved").waitFor();
      },
      { modal: false },
    );
    await violations(page);
    await story(page, "form-code-editor").scrollIntoViewIfNeeded();
    await story(page, "form-code-editor")
      .locator(".cm-editor")
      .first()
      .waitFor({ timeout: 15_000 });
    await story(page, "form-code-editor")
      .locator(".cm-content")
      .first()
      .click();
    await page.keyboard.type('{"a": 1}');
    await page.waitForTimeout(300);
    const v = await violations(page);
    report["code editor"] = { violations: v.length, locked: false };
    expect(v, "code editor: CSP violations").toEqual([]);
    await page.context().close();
  });

  it("the phone layout: a dialog becomes a bottom sheet and still locks", async () => {
    const page = await open("dark", { width: 390, height: 844 });
    await check(
      page,
      "dialog (phone)",
      async () => {
        await story(page, "dialog")
          .getByRole("button", { name: "Open md dialog" })
          .click();
        await page.getByRole("dialog", { name: "Edit holder" }).waitFor();
      },
      { modal: true },
    );
    await page.context().close();
  });

  afterAll(() => {
    console.log("kit overlay CSP report", JSON.stringify(report, null, 2));
  });
});
