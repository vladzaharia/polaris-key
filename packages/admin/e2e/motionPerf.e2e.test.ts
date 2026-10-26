import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { atRest } from "./atRest.js";
import { CORE_ROUTES } from "./coreFixtures.js";
import { startPortal, type PortalHarness } from "./portalHarness.js";
import { closeContext } from "./teardown.js";
import { workerFields } from "./workerFields.js";

/**
 * The 4x CPU frame-budget check (notes/S-23 §3.5, §6.2 item 7; MO-13.4), in the BUILT apps under
 * the Worker's CSP. Opt-in: `PK_MOTION_PERF=1` (it is a timing measurement, so a loaded machine
 * makes it pessimistic, and the default e2e run skips it).
 *
 * Nine moments, each under `Emulation.setCPUThrottlingRate { rate: 4 }`, measured as the
 * requestAnimationFrame intervals for 700 ms after the action (1.5 s for a load):
 *
 *   portal:  tile -> product, free a device, library load
 *   console: overview (load), filter at 8, 60 and 200 rows, row -> record, drawer open
 *
 * Each reports p50, p95 and the worst interval; p95 must be at most P95_BUDGET (two frames at
 * 60 Hz, as S-23 measures them). rAF measures the main thread: compositor-driven transforms can
 * stay smooth while it stalls, so the numbers bound visible jank from above.
 *
 * Prints a table, and with `PK_SHOTS_DIR` set writes `$PK_SHOTS_DIR/perf.json`.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const RATE = 4;
const P95_BUDGET = 33.4;
const ACTION_MS = 700;
const LOAD_MS = 1500;
const VIEWPORT = { width: 1280, height: 800 };

interface Row {
  moment: string;
  frames: number;
  p50: number;
  p95: number;
  max: number;
}
const results: Row[] = [];

let server: PreviewServer;
let browser: Browser;
let base: string;
let portal: PortalHarness;

describe.skipIf(!process.env.PK_MOTION_PERF)(
  "motion frame budget at 4x CPU",
  () => {
    beforeAll(async () => {
      if (!existsSync(`${here}dist/manage.html`))
        throw new Error(
          "Build the console first: pnpm --filter @polaris-key/admin build",
        );
      server = await preview({
        root: here,
        configFile: `${here}vite.config.ts`,
        preview: { port: 0, strictPort: false, host: "127.0.0.1" },
        logLevel: "silent",
      });
      base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
      browser = await chromium.launch();
      portal = await startPortal();
    });

    afterAll(async () => {
      await portal?.stop();
      await browser?.close();
      await new Promise<void>((r) => server?.httpServer.close(() => r()));
      if (results.length === 0) return;
      const f = (n: number): string => n.toFixed(1).padStart(7);
      const lines = [
        "",
        `Motion frame budget at ${RATE}x CPU (rAF intervals, ms; budget p95 <= ${P95_BUDGET})`,
        `${"moment".padEnd(34)}${"frames".padStart(7)}${"p50".padStart(7)}${"p95".padStart(7)}${"max".padStart(7)}`,
        ...results.map(
          (r) =>
            `${r.moment.padEnd(34)}${String(r.frames).padStart(7)}${f(r.p50)}${f(r.p95)}${f(r.max)}${r.p95 > P95_BUDGET ? "  OVER" : ""}`,
        ),
        "",
      ];
      console.log(lines.join("\n"));
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(
          `${SHOTS}/perf.json`,
          `${JSON.stringify({ rate: RATE, budgetP95: P95_BUDGET, results }, null, 2)}\n`,
        );
      }
    });

    // ── Measurement ────────────────────────────────────────────────────────────────────────────

    /** rAF timestamps from the start of every document, so a load is measured from its first frame. */
    const RECORDER = (): void => {
      const w = window as unknown as { __frames: number[] };
      w.__frames = [];
      const tick = (t: number): void => {
        w.__frames.push(t);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const throttle = async (cdp: CDPSession, rate: number): Promise<void> => {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    };

    /** Nearest-rank percentile of an ascending list. */
    const pct = (sorted: number[], p: number): number =>
      sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

    const summarise = (moment: string, frames: number[]): Row => {
      const gaps = frames.slice(1).map((t, i) => t - frames[i]!);
      const sorted = [...gaps].sort((a, b) => a - b);
      return {
        moment,
        frames: gaps.length,
        p50: pct(sorted, 50),
        p95: pct(sorted, 95),
        max: sorted[sorted.length - 1] ?? 0,
      };
    };

    /**
     * Run `act` under the throttle and record the frames from just before it for `ms`. The page
     * must be at rest first. The recorder was installed with the document.
     */
    async function measureAction(
      page: Page,
      moment: string,
      act: () => Promise<void>,
      ms = ACTION_MS,
    ): Promise<void> {
      const cdp = await page.context().newCDPSession(page);
      try {
        await atRest(page);
        await throttle(cdp, RATE);
        const mark = await page.evaluate(() => performance.now());
        await act();
        await page.waitForTimeout(ms);
        const frames = await page.evaluate(
          ([m, len]) =>
            (window as unknown as { __frames: number[] }).__frames.filter(
              (t) => t >= m && t <= m + len,
            ),
          [mark, ms] as const,
        );
        await throttle(cdp, 1);
        record(moment, frames);
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }

    /** A load: throttle, navigate, and record every frame of the new document for `ms`. */
    async function measureLoad(
      page: Page,
      moment: string,
      navigate: () => Promise<void>,
      ms = LOAD_MS,
    ): Promise<void> {
      const cdp = await page.context().newCDPSession(page);
      try {
        await throttle(cdp, RATE);
        await navigate();
        await page.waitForTimeout(ms);
        const frames = await page.evaluate((len) => {
          const f = (window as unknown as { __frames: number[] }).__frames;
          // Frames inside the window, counted from the document's first one.
          return f.filter((t) => t <= f[0]! + len);
        }, ms);
        await throttle(cdp, 1);
        record(moment, frames);
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }

    function record(moment: string, frames: number[]): void {
      const row = summarise(moment, frames);
      results.push(row);
      expect(row.frames, `${moment}: no frames recorded`).toBeGreaterThan(1);
      expect(
        row.p95,
        `${moment}: p95 ${row.p95.toFixed(1)} ms over ${P95_BUDGET} ms (max ${row.max.toFixed(1)})`,
      ).toBeLessThanOrEqual(P95_BUDGET);
    }

    // ── Portal ─────────────────────────────────────────────────────────────────────────────────

    async function openPortal(path: string) {
      const s = await portal.open("three", path, {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        reducedMotion: "no-preference",
      });
      await s.page.context().addInitScript(RECORDER);
      await s.page.reload();
      return s;
    }

    it("portal: tile -> product", async () => {
      const s = await openPortal("/");
      const { page } = s;
      await page.getByRole("article", { name: "Nightfall" }).waitFor();
      await measureAction(page, "portal: tile -> product", () =>
        page
          .getByRole("article", { name: "Nightfall" })
          .getByRole("link", { name: "Nightfall", exact: true })
          .click(),
      );
      await s.close();
    });

    it("portal: free a device", async () => {
      const s = await openPortal("/#/p/nightfall/devices");
      const { page } = s;
      await page.getByText("Studio PC").first().waitFor();
      // Open the confirm first (the expand is a separate moment); measure the removal.
      await page
        .getByRole("button", { name: "Remove Studio PC" })
        .first()
        .click();
      await page.getByRole("heading", { name: "Remove Studio PC?" }).waitFor();
      await measureAction(page, "portal: free a device", () =>
        page
          .getByRole("button", { name: "Remove Studio PC", exact: true })
          .last()
          .click(),
      );
      await s.close();
    });

    it("portal: library load", async () => {
      const s = await openPortal("/");
      const { page } = s;
      await page.getByRole("article", { name: "Nightfall" }).waitFor();
      await measureLoad(page, "portal: library load", () =>
        page.reload({ waitUntil: "commit" }).then(() => undefined),
      );
      await s.close();
    });

    // ── Console ────────────────────────────────────────────────────────────────────────────────

    const NOW = Math.floor(Date.now() / 1000);
    const licenses = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `lic_${i + 1}`,
        name: `Seat ${String(i + 1).padStart(3, "0")}`,
        email: `seat${i + 1}@example.com`,
        status: i % 3 === 2 ? "disabled" : "active",
        activatedAt: NOW - 90 * 86_400,
        expiresAt: null,
        keyCount: 1,
        activeKeyCount: 1,
        deviceCount: 1,
        profile: null,
        tier: null,
        channels: ["stable"],
        minVersion: null,
        maxVersion: null,
        identityProvider: "manual",
        inheritedDeviceLimit: 5,
      })).map(workerFields);

    async function openConsole(hash: string, rows = 60): Promise<Page> {
      const list = licenses(rows);
      const record = {
        ...list[0]!,
        origin: "admin",
        profiles: [],
        deletion: { allowed: true, reasons: [] },
        groups: [],
        maxOfflineDays: null,
        overrides: { config: {}, secrets: {}, entitlements: {} },
        keys: [
          {
            hash: "a1b2c3d4e5f6a7b8c9d0",
            status: "active",
            label: "Initial key",
            createdAt: NOW - 30 * 86_400,
            createdBy: "admin",
          },
        ],
        devices: [
          {
            deviceId: "kklhA6HWtEZho0RfhTjNTrlnaDcZq1je",
            status: "authorized",
            firstSeen: NOW - 30 * 86_400,
            lastSeen: NOW - 86_400,
            platform: "macos",
            appVersion: "1.1.0",
          },
        ],
      };
      const routes: Record<string, unknown> = {
        ...CORE_ROUTES,
        "/manage/api/products/djdl/license/licenses": { licenses: list },
        "/manage/api/products/djdl/license/licenses/lic_1": record,
        "/manage/api/products/djdl/license/tiers": { tiers: [] },
      };
      const ctx = await browser.newContext({
        viewport: VIEWPORT,
        colorScheme: "dark",
        reducedMotion: "no-preference",
      });
      await ctx.addInitScript(RECORDER);
      await ctx.addInitScript(() =>
        window.localStorage.setItem("pk-admin-theme", "dark"),
      );
      await ctx.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/manage/api/")) {
          const body = routes[url.pathname];
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

    it("console: overview", async () => {
      const page = await openConsole("#/p/djdl");
      await page.getByRole("heading", { level: 1, name: "DJDL" }).waitFor();
      await atRest(page);
      await measureLoad(page, "console: overview", () =>
        page.reload({ waitUntil: "commit" }).then(() => undefined),
      );
      await closeContext(page.context());
    });

    for (const rows of [8, 60, 200])
      it(`console: filter, ${rows} rows`, async () => {
        const page = await openConsole("#/p/djdl/license/licenses", rows);
        await page.getByText("Seat 001", { exact: true }).waitFor();
        await page.getByRole("button", { name: "More filters" }).click();
        await page.getByRole("checkbox", { name: /^Disabled/ }).waitFor();
        await measureAction(page, `console: filter, ${rows} rows`, () =>
          page.getByRole("checkbox", { name: /^Disabled/ }).click(),
        );
        await closeContext(page.context());
      });

    it("console: row -> record", async () => {
      const page = await openConsole("#/p/djdl/license/licenses");
      const row = page.locator("main#content table tbody a", {
        hasText: "Seat 001",
      });
      await row.first().waitFor();
      await measureAction(page, "console: row -> record", () =>
        row.first().evaluate((a) => (a as HTMLElement).click()),
      );
      await closeContext(page.context());
    });

    it("console: drawer open", async () => {
      const page = await openConsole("#/p/djdl/license/licenses");
      await page.getByText("Seat 001", { exact: true }).waitFor();
      await measureAction(page, "console: drawer open", async () => {
        await page.getByRole("button", { name: "New license" }).first().click();
        await page.getByRole("dialog").waitFor();
      });
      await closeContext(page.context());
    });
  },
);
