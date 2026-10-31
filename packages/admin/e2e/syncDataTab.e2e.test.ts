import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES, USER_SUBJECT } from "./coreFixtures.js";
import { axe } from "./portalHarness.js";
import { closeContext } from "./teardown.js";

/**
 * U-11a.5, U-11a.6 and U-11a.8: Users → Data with Show values, the records browser, the record
 * drawer with file history, Download and Delete Cloud Sync data, in real Chromium under the Worker's CSP. Two
 * fixtures (a server-mode product and an end-to-end one), each with settings, a collection with a
 * file that keeps a revision, a key ring and an upload in flight. Each state renders with zero CSP
 * violations and no sideways scroll at 1440, 768, 390 and 320 px, in both themes.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of each state there. This is also the fixture the
 * U-11a.7 UX review drives.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);
const API = "/manage/api/products/djdl";
const SUMMARY = `${API}/sync/subjects/${USER_SUBJECT}`;
const HASH = `#/p/djdl/users/${USER_SUBJECT}/data`;

type Mode = "server" | "e2e";
let mode: Mode = "server";
let stepUp: "fresh" | "stale" = "fresh";
let deleted = false;
/** How many collections the person has (the picker is a Select from five). */
let collections = 1;
/** Long keys and ids, right-to-left text, nested, empty, sealed and 4 GiB: the values that broke the first layout. */
let messy = false;
let download: "ok" | "fail" | "slow" = "ok";
/** The step-up refusal as the Worker words it, with its message. */
let realBody = false;

const summary = (): unknown => ({
  enabled: true,
  empty: deleted,
  encryption: mode,
  encryptionSince: mode === "e2e" ? 1 : null,
  quota: {
    bytes: 52_428_800,
    defaultBytes: 26_214_400,
    tierId: "pro",
    tierLabel: "Pro",
  },
  usage: deleted
    ? { bytes: 0, settings: 0, settingsBytes: 0 }
    : { bytes: 3_146_000, settings: 4, settingsBytes: 420 },
  settings: {
    declared: deleted
      ? []
      : [
          { key: "ui.theme", bytes: 24, updatedAt: NOW - 60, platform: null },
          {
            key: "audio.output.device",
            bytes: 38,
            updatedAt: NOW - 600,
            platform: "desktop",
          },
        ],
    open: { count: deleted ? 0 : 2, bytes: deleted ? 0 : 310 },
  },
  collections: deleted
    ? []
    : Array.from({ length: collections }, (_, i) => ({
        name: i === 0 ? "saves" : `saves-${i + 1}`,
        label: i === 0 ? "Saves" : `Saves ${i + 1}`,
        records: 3,
        bytes: 640,
        files: 2,
        fileBytes: 2_600_000,
        revisionBytes: 500_000,
        lastWriteAt: NOW - 300,
      })),
  uploadsOpen: deleted ? 0 : 1,
  ring: deleted
    ? null
    : {
        kid: "kid-9f3a1c",
        createdAt: NOW - 20 * 86_400,
        recoverySet: true,
        devices: ["Studio Mac", "Unnamed device"],
      },
});

const record = (
  id: string,
  withFile: boolean,
  over: Record<string, unknown> = {},
) => ({
  id,
  version: 4,
  updatedAt: NOW - 120,
  bytes: 96,
  value: withFile ? null : { level: 4, coins: 1280, name: "A".repeat(220) },
  sealed: false,
  ...over,
  ...(withFile
    ? {
        file: {
          version: 3,
          size: messy ? 4 * 1024 ** 3 : 1_300_000,
          sha256: "ab".repeat(32),
          format: "whole",
        },
      }
    : {}),
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
  m: Mode,
  fresh = true,
  scenario: {
    collections?: number;
    messy?: boolean;
    download?: "ok" | "fail" | "slow";
    realBody?: boolean;
  } = {},
): Promise<Page> {
  mode = m;
  stepUp = fresh ? "fresh" : "stale";
  deleted = false;
  collections = scenario.collections ?? 1;
  messy = scenario.messy ?? false;
  download = scenario.download ?? "ok";
  realBody = scenario.realBody ?? false;
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
    const path = url.pathname;
    const method = route.request().method();
    if (path.startsWith("/manage/api/")) {
      if (path === SUMMARY) return route.fulfill({ json: summary() });
      const gated = (): boolean => stepUp === "stale";
      const refuse = () =>
        route.fulfill({
          status: 403,
          json: {
            error: {
              code: "step_up_required",
              ...(realBody
                ? {
                    message:
                      "Sign in again to confirm it's you. This needs a sign-in from the last 5 minutes.",
                  }
                : {}),
            },
            code: "step_up_required",
          },
        });
      if (path === `${SUMMARY}/values`) {
        if (gated()) return refuse();
        const collection = url.searchParams.get("collection");
        return route.fulfill({
          json: collection
            ? {
                settings: null,
                records: messy
                  ? [
                      record("slot-1", true),
                      record("slot-2", false),
                      record(
                        "keybindings.custom.profile.default.overrides.0123456789-abcdefghij",
                        false,
                        {
                          value: { deep: { a: [1, 2, { b: "c".repeat(90) }] } },
                        },
                      ),
                      record("שמירה-ראשית", false, {
                        value: { שם: "מרים", רמה: 12 },
                      }),
                      record("zero", false, { value: 0, bytes: 1 }),
                      record("empty", false, { value: {} }),
                      record("sealed", false, { value: null, sealed: true }),
                    ]
                  : [record("slot-1", true), record("slot-2", false)],
                next: null,
              }
            : {
                settings: [
                  ...(messy
                    ? [
                        {
                          key: "keybindings.custom.profile.default.overrides",
                          declared: false,
                          platform: "desktop",
                          bytes: 400,
                          updatedAt: NOW - 90,
                          value: "z".repeat(300),
                          sealed: false,
                        },
                      ]
                    : []),
                  {
                    key: "ui.theme",
                    declared: true,
                    platform: null,
                    bytes: 24,
                    updatedAt: NOW - 60,
                    value: "dark",
                    sealed: false,
                  },
                ],
                records: [],
                next: null,
              },
        });
      }
      if (path === `${SUMMARY}/files/saves/slot-1/revisions`)
        return gated()
          ? refuse()
          : route.fulfill({
              json: {
                revisions: [
                  {
                    version: 2,
                    size: 1_100_000,
                    sha256: "cd".repeat(32),
                    format: "whole",
                    createdAt: NOW - 3600,
                  },
                ],
              },
            });
      if (path === `${SUMMARY}/files/saves/slot-1`) {
        if (gated()) return refuse();
        if (download === "fail")
          return route.fulfill({
            status: 500,
            json: { error: { code: "internal_error" } },
          });
        if (download === "slow") await new Promise((r) => setTimeout(r, 900));
        return route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          body: Buffer.from([1, 2, 3]),
        });
      }
      if (path === `${SUMMARY}/delete` && method === "POST") {
        if (gated()) return refuse();
        deleted = true;
        return route.fulfill({ json: { deleted: true } });
      }
      const body = CORE_ROUTES[path];
      return body
        ? route.fulfill({ json: body })
        : route.fulfill({ status: 404, json: { error: "not_found" } });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (path.endsWith(".html")) headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/manage.html${HASH}`);
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

/** No sideways scroll: the page is never wider than the window. */
const reflows = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

describe("Users → Data: values, files and delete under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1440, 768, 390, 320]) {
      it(`a server-mode person with values shown (${theme}, ${width} px)`, async () => {
        const page = await open(theme, width, "server");
        await page
          .getByRole("heading", { level: 2, name: "Storage" })
          .waitFor();
        await page.getByRole("button", { name: "Show values" }).click();
        // A table from 40 rem up, cards (a list) on a phone.
        const kind = width >= 640 ? "table" : "list";
        await page.getByRole(kind, { name: "Setting values" }).waitFor();
        await page.getByRole(kind, { name: "Saves records" }).waitFor();
        await shot(page, `sync-data-values-${theme}-${width}`);
        expect(await reflows(page)).toBe(true);
        expect(await violations(page)).toEqual([]);
        await closeContext(page.context());
      });
    }

    it(`the record drawer, file history and downloads named <id>-v<n>.bin (${theme})`, async () => {
      const page = await open(theme, 1440, "server");
      await page.getByRole("button", { name: "Show values" }).click();
      await page.getByRole("button", { name: "slot-1", exact: true }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("table", { name: "File versions" }).waitFor();
      await shot(page, `sync-data-history-${theme}`);
      expect(await axe(page)).toEqual([]);
      const old = page.waitForEvent("download");
      await drawer.getByRole("button", { name: "Download version 2" }).click();
      expect((await old).suggestedFilename()).toBe("slot-1-v2.bin");
      const live = page.waitForEvent("download");
      await drawer.getByRole("button", { name: "Download version 3" }).click();
      expect((await live).suggestedFilename()).toBe("slot-1-v3.bin");
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`a failed download says what failed, with Try again, in the drawer (${theme})`, async () => {
      const page = await open(theme, 390, "server", true, { download: "fail" });
      await page.getByRole("button", { name: "Show values" }).click();
      await page.getByRole("button", { name: /^slot-1/ }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("button", { name: "Download version 3" }).click();
      const alert = drawer.getByRole("alert");
      await alert.getByText("Couldn't download slot-1").waitFor();
      await alert.getByRole("button", { name: "Try again" }).waitFor();
      await shot(page, `sync-data-download-error-${theme}`);
      expect(await axe(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`a slow download shows it is running (${theme})`, async () => {
      const page = await open(theme, 1440, "server", true, {
        download: "slow",
      });
      await page.getByRole("button", { name: "Show values" }).click();
      await page.getByRole("button", { name: "slot-1", exact: true }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("button", { name: "Download version 3" }).click();
      await drawer
        .getByRole("status")
        .getByText(/^Downloading/)
        .waitFor();
      await shot(page, `sync-data-download-busy-${theme}`);
      await page.waitForEvent("download");
      await closeContext(page.context());
    });

    it(`six collections are picked from a Select, labelled Collection (${theme})`, async () => {
      for (const width of [1440, 390]) {
        const page = await open(theme, width, "server", true, {
          collections: 6,
        });
        await page.getByRole("button", { name: "Show values" }).click();
        const pick = page.getByRole("combobox", { name: "Collection" });
        await pick.waitFor();
        await shot(page, `sync-data-collections-6-${theme}-${width}`);
        await pick.click();
        await page.getByRole("option", { name: "Saves 4 · 3" }).click();
        await page
          .getByRole("table", { name: "Saves 4 records" })
          .waitFor()
          .catch(() =>
            page.getByRole("list", { name: "Saves 4 records" }).waitFor(),
          );
        expect(await reflows(page)).toBe(true);
        expect(await axe(page)).toEqual([]);
        await closeContext(page.context());
      }
    });

    it(`messy values stay readable: long keys, RTL, 4 GiB, clamped to two lines (${theme})`, async () => {
      for (const [width, rootPx] of [
        [1440, 16],
        [1440, 32],
        [768, 16],
        [390, 16],
        [320, 16],
      ] as const) {
        const page = await open(theme, width, "server", true, { messy: true });
        if (rootPx !== 16)
          await page.evaluate(
            (px) => (document.documentElement.style.fontSize = `${px}px`),
            rootPx,
          );
        await page.getByRole("button", { name: "Show values" }).click();
        await page.getByText("שמירה-ראשית").first().waitFor();
        await shot(page, `sync-data-messy-${theme}-${width}-${rootPx}`);
        expect(await reflows(page)).toBe(true);
        // A value is never one character wide, and an id is never cut mid-word.
        const widths = await page
          .locator("#sync-data-values code")
          .evaluateAll((els) =>
            els.map((e) => e.getBoundingClientRect().width),
          );
        expect(Math.min(...widths)).toBeGreaterThan(90);
        if (width * (16 / rootPx) >= 640) {
          // A table: the id is one line (the button is at most 2.5 rem tall), never cut mid-word.
          const slot = page.getByRole("button", {
            name: "slot-1",
            exact: true,
          });
          const box = (await slot.boundingBox())!;
          expect(box.height).toBeLessThan(2.5 * rootPx);
        }
        expect(await violations(page)).toEqual([]);
        await closeContext(page.context());
      }
    });

    it(`a long value is read whole in the drawer, with Copy (${theme})`, async () => {
      const page = await open(theme, 1440, "server", true, { messy: true });
      await page.getByRole("button", { name: "Show values" }).click();
      await page.getByRole("button", { name: "שמירה-ראשית" }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("button", { name: /^Copy value/ }).waitFor();
      await shot(page, `sync-data-record-rtl-${theme}`);
      expect(await axe(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`a delete refused for a stale sign-in asks to sign in, not for edit access (${theme})`, async () => {
      const page = await open(theme, 1440, "server", false, { realBody: true });
      await page
        .getByRole("button", { name: "Delete Cloud Sync data" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("textbox").fill("delete");
      await dialog.getByRole("button", { name: "Delete data" }).click();
      await dialog.getByRole("button", { name: "Sign in again" }).waitFor();
      expect(await dialog.innerText()).not.toContain("edit access");
      await shot(page, `sync-data-delete-stepup-${theme}`);
      await closeContext(page.context());
    });

    it(`a stale sign-in asks to sign in again (${theme})`, async () => {
      const page = await open(theme, 390, "server", false);
      await page.getByRole("button", { name: "Show values" }).click();
      await page
        .getByRole("alert")
        .getByText("Sign in again to show values")
        .waitFor();
      await shot(page, `sync-data-stepup-${theme}`);
      expect(await reflows(page)).toBe(true);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`an end-to-end person: no values, the devices line (${theme})`, async () => {
      const page = await open(theme, 1440, "e2e");
      await page
        .getByText("Values and names stay on the person's devices")
        .waitFor();
      expect(
        await page.getByRole("button", { name: "Show values" }).count(),
      ).toBe(0);
      await shot(page, `sync-data-e2e-${theme}`);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });

    it(`Delete Cloud Sync data: typed word, then nothing synced (${theme})`, async () => {
      const page = await open(theme, 390, "server");
      await page
        .getByRole("button", { name: "Delete Cloud Sync data" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await shot(page, `sync-data-delete-${theme}`);
      await dialog.getByRole("textbox").fill("delete");
      await dialog.getByRole("button", { name: "Delete data" }).click();
      const empty = page.getByRole("heading", { name: "Nothing synced yet" });
      await empty.waitFor();
      // The trigger is gone: focus lands on the heading that replaced the tab.
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Nothing synced yet",
      );
      await shot(page, `sync-data-deleted-${theme}`);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });
  }
});
