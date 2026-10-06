import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { mediaResponseHeaders } from "../../worker/src/services/identity/portal/media.js";
import {
  FIXTURE_NOW,
  portalMedia,
  portalRoutes,
  type Handler,
  type PortalScenario,
} from "./portalFixtures.js";

/**
 * The customer site's browser harness (PORTAL.md §8, §9; PX-20): the BUILT SPA served by
 * `vite preview`, in real Chromium, with the Worker's exact Content-Security-Policy and
 * Referrer-Policy on every document, the portal API answered from `portalFixtures.ts`, every
 * request recorded (`all`), and the four checks every §4 state must pass:
 *
 * - `violations()`: CSP violations seen by the page (`securitypolicyviolation`), drained per call;
 * - `axe(page)`: axe-core's WCAG 2.2 A/AA and best-practice rules, zero violations (§9);
 * - `h1Count(page)`: exactly one visible `h1` per screen (§9 item 1);
 * - `horizontalOverflow(page)`: no horizontal page scroll (§8: never at 360 px);
 * - `matchBaseline(page, name)`: the visual baseline (below).
 *
 * The page's clock is pinned to the fixtures' `FIXTURE_NOW`, in UTC and en-US, so relative times
 * and printed dates are the same on every run. The user agent is pinned to {@link USER_AGENT} (a
 * Mac), so the portal's device detection ("Recommended for this Mac", ⌘K) does not follow the host
 * OS and every platform renders the same screens.
 *
 * ## Visual baselines
 *
 * A full-page screenshot is downscaled 2× (a box filter, which also absorbs sub-pixel
 * anti-aliasing) and compared with `e2e/__baselines__/portal/<platform>/<name>.png`. Up to
 * {@link MAX_DIFF_RATIO} of the pixels may differ by more than {@link CHANNEL_TOLERANCE} on any
 * channel; a different size is a mismatch. On a mismatch the actual image and a diff land in
 * `e2e/__baselines__/portal/.out/` (git-ignored) for review.
 *
 * Fonts render differently per OS, so baselines are per platform. **`linux` is the committed set**:
 * it is what CI renders (ubuntu, Playwright's Chromium). A missing baseline fails under `CI`;
 * locally it is recorded and the check passes, so a macOS run compares against its own earlier
 * run (`darwin/` is git-ignored). `PK_UPDATE_BASELINES=1` re-records every baseline it visits;
 * regenerate the linux set in Playwright's image (`pnpm --filter @polaris-key/admin
 * e2e:baselines`, which runs `scripts/portal-baselines.sh`).
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const CSP = appSecurityHeaders().get("content-security-policy")!;
/** The shell's `no-referrer`, so a legacy `/activate?key=` never reaches a subresource's Referer. */
const REFERRER_POLICY = appSecurityHeaders().get("referrer-policy")!;
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const BASELINE_ROOT = `${here}e2e/__baselines__/portal`;
const BASELINES = `${BASELINE_ROOT}/${process.platform}`;
const OUT = `${BASELINE_ROOT}/.out`;
const UPDATE = process.env.PK_UPDATE_BASELINES === "1";
const IN_CI = Boolean(process.env.CI);
const SCALE = 2;
export const CHANNEL_TOLERANCE = 48;
/** The browser's user agent on every page: Chrome on a Mac, whatever the host. */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const MAX_DIFF_RATIO = 0.004;

/** Set `PK_SHOTS_DIR` to also save full-size screenshots there (the mockup comparison). */
const SHOTS = process.env.PK_SHOTS_DIR;

export type Theme = "dark" | "light";
/** A route override: a fixture reply, or `"abort"` for a network failure (status 0). */
export type Override = Handler | "abort";

export interface Opened {
  page: Page;
  /** CSP violations since the last call. */
  violations: () => Promise<string[]>;
  /** `METHOD /path?query` of every portal API and media request, in order. */
  requests: string[];
  /**
   * `METHOD <url> referer=<Referer>` of EVERY request the page made, in order: the document
   * navigation, `/assets/*`, fonts, favicons and the manifest as well as the API and media
   * requests. What the deep-link tests check for a key in a request line or a `Referer`.
   */
  all: string[];
  /**
   * Closes the context. The catch-all route passes static assets through, and a font fetch can
   * still be in flight when a test ends; dropping the routes first (Playwright's own advice)
   * keeps that callback from rejecting into whichever test runs next.
   */
  close: () => Promise<void>;
}

export interface OpenOptions {
  theme?: Theme;
  width?: number;
  height?: number;
  /** Replace or add portal routes (`"GET /api/x"` or `"/api/x"` keys) for this page. */
  routes?: Record<string, Override>;
  /** Motion is off by default so every check sees final states (S-23 §6.8); the motion suite turns it on. */
  reducedMotion?: "reduce" | "no-preference";
}

export interface PortalHarness {
  base: () => string;
  open: (
    scenario: PortalScenario,
    path: string,
    opts?: OpenOptions,
  ) => Promise<Opened>;
  stop: () => Promise<void>;
}

/** Serve the built SPA and launch Chromium; call `stop` in `afterAll`. */
export async function startPortal(): Promise<PortalHarness> {
  if (!existsSync(`${here}dist/index.html`)) {
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const server: PreviewServer = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "silent",
  });
  const base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  const browser: Browser = await chromium.launch();

  const open = async (
    scenario: PortalScenario,
    path: string,
    opts: OpenOptions = {},
  ): Promise<Opened> => {
    const theme = opts.theme ?? "dark";
    const ctx = await browser.newContext({
      viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
      colorScheme: theme,
      userAgent: USER_AGENT,
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: opts.reducedMotion ?? "reduce",
    });
    await ctx.clock.setFixedTime(FIXTURE_NOW * 1000);
    await ctx.addInitScript((t) => {
      window.localStorage.setItem("pk-admin-theme", t);
      (window as unknown as { __v: string[] }).__v = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as unknown as { __v: string[] }).__v.push(
          `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
        ),
      );
    }, theme);
    const routes: Record<string, Override> = {
      ...portalRoutes(scenario),
      ...opts.routes,
    };
    const requests: string[] = [];
    const all: string[] = [];
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      all.push(
        `${req.method()} ${req.url()} referer=${req.headers()["referer"] ?? ""}`,
      );
      const url = new URL(req.url());
      if (url.pathname.startsWith("/api/") || url.pathname === "/logout") {
        requests.push(`${req.method()} ${url.pathname}${url.search}`);
        const handler =
          routes[`${req.method()} ${url.pathname}`] ?? routes[url.pathname];
        if (handler === "abort") return route.abort("connectionfailed");
        if (!handler)
          return route.fulfill({ status: 404, json: { error: "not_found" } });
        const res = typeof handler === "function" ? handler(req) : handler;
        return route.fulfill({ status: res.status ?? 200, json: res.body });
      }
      // PX-08: developer art as the media proxy answers it (same origin, its own headers).
      if (url.pathname.startsWith("/media/")) {
        requests.push(`${req.method()} ${url.pathname}${url.search}`);
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
      ) {
        headers["content-security-policy"] = CSP;
        headers["referrer-policy"] = REFERRER_POLICY;
      }
      return route.fulfill({ response: res, headers });
    });
    const page = await ctx.newPage();
    await page.goto(`${base}${path}`);
    return {
      page,
      requests,
      all,
      violations: () =>
        page.evaluate(() =>
          (window as unknown as { __v: string[] }).__v.splice(0),
        ),
      close: async () => {
        await ctx.unrouteAll({ behavior: "ignoreErrors" });
        await ctx.close();
      },
    };
  };

  return {
    base: () => base,
    open,
    stop: async () => {
      await browser.close();
      await new Promise<void>((r) => server.httpServer.close(() => r()));
    },
  };
}

/** Wait for the first `h1` with this name. */
export const h1 = (page: Page, name: string | RegExp): Promise<void> =>
  page.getByRole("heading", { level: 1, name }).first().waitFor();

/** How far the page scrolls sideways (≤ 0 means it doesn't). */
export function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
}

/** Visible `h1` elements on the screen (§9: exactly one, dialogs included). */
export function h1Count(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll("h1")].filter((el) =>
        el.checkVisibility({ visibilityProperty: true }),
      ).length,
  );
}

/** The WCAG 2.2 A/AA rule set plus axe's best practices (landmarks, heading order, regions). */
export const AXE_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
];

/** axe-core over the whole document; one line per failing node. */
export async function axe(page: Page): Promise<string[]> {
  const loaded = await page.evaluate(
    () => typeof (window as unknown as { axe?: unknown }).axe === "object",
  );
  // Evaluated over the DevTools protocol, which the page's CSP does not govern.
  if (!loaded) await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (tags) => {
    const a = (
      window as unknown as {
        axe: {
          run: (
            ctx: Document,
            opts: unknown,
          ) => Promise<{
            violations: {
              id: string;
              impact: string | null;
              help: string;
              nodes: { target: unknown[]; failureSummary?: string }[];
            }[];
          }>;
        };
      }
    ).axe;
    const r = await a.run(document, {
      runOnly: { type: "tag", values: tags },
      resultTypes: ["violations"],
    });
    return r.violations.flatMap((v) =>
      v.nodes.map(
        (n) =>
          `${v.id} (${v.impact}): ${v.help} @ ${n.target.join(" ")}${
            n.failureSummary
              ? ` | ${n.failureSummary.replace(/\s+/g, " ")}`
              : ""
          }`,
      ),
    );
  }, AXE_TAGS);
}

/** Let fonts, images and layout settle before a screenshot. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // A lazy image off screen never loads, so its decode() never settles: cap the wait.
    const decoded = Promise.all(
      [...document.images].map((i) =>
        i.complete ? null : i.decode().catch(() => null),
      ),
    );
    await Promise.race([decoded, new Promise((r) => setTimeout(r, 2000))]);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
}

/** Save a full-size screenshot to `PK_SHOTS_DIR` when it is set. */
export async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

export interface BaselineResult {
  status: "match" | "recorded" | "missing" | "mismatch";
  detail: string;
}

/** Compare the page with its visual baseline (see the module comment). */
export async function matchBaseline(
  page: Page,
  name: string,
): Promise<BaselineResult> {
  await settle(page);
  const shot = PNG.sync.read(
    await page.screenshot({
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    }),
  );
  const actual = downscale(shot, SCALE);
  const file = `${BASELINES}/${name}.png`;
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE && IN_CI)
      return {
        status: "missing",
        detail: `no ${process.platform} baseline for ${name}: record it with PK_UPDATE_BASELINES=1 (scripts/portal-baselines.sh for linux)`,
      };
    writePng(file, actual);
    return { status: "recorded", detail: file };
  }
  const expected = PNG.sync.read(readFileSync(file));
  if (expected.width !== actual.width || expected.height !== actual.height) {
    writePng(`${OUT}/${name}.actual.png`, actual);
    return {
      status: "mismatch",
      detail: `${name}: size ${actual.width}×${actual.height}, baseline ${expected.width}×${expected.height} (at 1/${SCALE} scale); actual in ${OUT}`,
    };
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  let differing = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    const d = Math.max(
      Math.abs(actual.data[i]! - expected.data[i]!),
      Math.abs(actual.data[i + 1]! - expected.data[i + 1]!),
      Math.abs(actual.data[i + 2]! - expected.data[i + 2]!),
    );
    const off = d > CHANNEL_TOLERANCE;
    if (off) differing++;
    diff.data[i] = off ? 255 : expected.data[i]! >> 2;
    diff.data[i + 1] = off ? 0 : expected.data[i + 1]! >> 2;
    diff.data[i + 2] = off ? 64 : expected.data[i + 2]! >> 2;
    diff.data[i + 3] = 255;
  }
  const ratio = differing / (actual.width * actual.height);
  if (ratio <= MAX_DIFF_RATIO)
    return { status: "match", detail: `${(ratio * 100).toFixed(3)}% differ` };
  writePng(`${OUT}/${name}.actual.png`, actual);
  writePng(`${OUT}/${name}.diff.png`, diff);
  return {
    status: "mismatch",
    detail: `${name}: ${(ratio * 100).toFixed(2)}% of pixels differ (allowed ${(MAX_DIFF_RATIO * 100).toFixed(2)}%); actual and diff in ${OUT}`,
  };
}

function writePng(file: string, png: PNG): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png, { colorType: 2 }));
}

/** Box-filter downscale by an integer factor; the result is opaque RGB(A). */
function downscale(src: PNG, f: number): PNG {
  const w = Math.floor(src.width / f);
  const h = Math.floor(src.height / f);
  const out = new PNG({ width: w, height: h });
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * src.width + (x * f + dx)) * 4;
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = 255;
    }
  }
  return out;
}
