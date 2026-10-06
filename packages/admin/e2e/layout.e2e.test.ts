import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { GLOBAL_PAGES, SECTIONS } from "../src/console/nav.js";
import { DEVICE_ID, LONG_SLUG, PACK_ID, resolve } from "./layoutFixtures.js";
import {
  probeLayout,
  type LayoutViolation,
  type ScrollMetric,
} from "./layoutProbe.js";

/**
 * The console's layout lint: a permanent regression gate over EVERY console page.
 *
 * Each page (enumerated from `nav.ts`, plus every record, tab, drawer and dialog the fixtures
 * reach) is opened in the BUILT console, under the Worker's CSP, at 1440×900, 1280×800 (a laptop),
 * 768×1024 (a tablet) and 390×844, in the
 * dark and the light theme, over realistic data (`layoutFixtures.ts`): a populated product, a
 * product with a long name and an empty product. `probeLayout` (`layoutProbe.ts`) then measures
 * the page inside the console's own scroll container (`main#content`), every open drawer's scroller
 * and the document, and fails on any breach of the four invariants:
 *
 *   1. no trailing space below the last visible content (beyond the page's bottom padding);
 *   2. side-by-side cards share their outer height and footer edge, and no card runs far past its
 *      own content, whatever sits beside it (from 1024px);
 *   3. settings-style rows, switches, numeric/date table columns and header actions are flush right;
 *   4. no sideways scroll, no clipped or spilled text.
 *
 * A per-page report is printed, and written as JSON to `PK_LAYOUT_REPORT` when set. With
 * `PK_SHOTS_DIR` set it also saves a screenshot of every page (the top, and the bottom of the
 * scroll container when it scrolls).
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const REPORT = process.env.PK_LAYOUT_REPORT;
/** The page wrapper's bottom padding is 24px; 48 allows a card's own padding on top of it. */
const TRAILING_SLACK = 48;

interface Case {
  name: string;
  hash: string;
  /** Opens a drawer or dialog after the page settles. */
  act?: (page: Page) => Promise<void>;
}

// ── The case list: nav.ts's pages, their records and tabs, the overlays ──────────────────────

const RECORD_IDS: Record<string, { id: string; child?: string[] }> = {
  devices: { id: DEVICE_ID },
  licenses: { id: "lic_1" },
  tiers: { id: "pro" },
  profiles: { id: "base" },
  releases: { id: "v0.4.2" },
  deliverables: { id: PACK_ID },
  "package-feeds": { id: "npm", child: ["@djdl/sdk"] },
  "platform-feeds": { id: "npm", child: ["polaris-key", "@polaris-key/node"] },
};

function cases(): Case[] {
  const list: Case[] = [];
  const enc = encodeURIComponent;
  for (const section of SECTIONS) {
    for (const p of section.items) {
      if (!p.ready) continue;
      const path = p.path ? `/${p.path}` : "";
      list.push({ name: `djdl:${p.page}`, hash: `#/p/djdl${path}` });
      if (p.inNav)
        list.push({ name: `empty:${p.page}`, hash: `#/p/empty${path}` });
      const rec = p.record && RECORD_IDS[p.page];
      if (p.record?.ready && rec) {
        const tabs = p.record.tabs ?? [undefined];
        for (const tab of tabs)
          list.push({
            name: `djdl:${p.page}/record${tab ? `/${tab}` : ""}`,
            hash: `#/p/djdl${path}/${enc(rec.id)}${tab ? `/${tab}` : ""}`,
          });
        if (p.record.child && rec.child)
          for (const tab of p.record.child.tabs ?? [undefined])
            list.push({
              name: `djdl:${p.page}/record/${p.record.child.segment}${tab ? `/${tab}` : ""}`,
              hash: `#/p/djdl${path}/${enc(rec.id)}/${p.record.child.segment}/${rec.child.map(enc).join("/")}${tab ? `/${tab}` : ""}`,
            });
      }
    }
  }
  list.push({ name: `long:overview`, hash: `#/p/${LONG_SLUG}` });
  list.push({ name: `long:settings`, hash: `#/p/${LONG_SLUG}/settings` });
  for (const p of GLOBAL_PAGES) {
    if (!p.ready) continue;
    list.push({ name: `global:${p.page}`, hash: `#/${p.path}` });
    const rec = p.record && RECORD_IDS[p.page];
    if (p.record?.ready && rec) {
      for (const tab of p.record.tabs ?? [undefined])
        list.push({
          name: `global:${p.page}/record${tab ? `/${tab}` : ""}`,
          hash: `#/${p.path}/${enc(rec.id)}${tab ? `/${tab}` : ""}`,
        });
      if (p.record.child && rec.child)
        for (const tab of p.record.child.tabs ?? [undefined])
          list.push({
            name: `global:${p.page}/record/${p.record.child.segment}${tab ? `/${tab}` : ""}`,
            hash: `#/${p.path}/${enc(rec.id)}/${p.record.child.segment}/${rec.child.map(enc).join("/")}${tab ? `/${tab}` : ""}`,
          });
    }
  }
  // Query-addressed views and overlays.
  list.push(
    { name: "djdl:activity?table", hash: "#/p/djdl/activity?view=table" },
    {
      name: "djdl:rollouts?view=matrix&cell",
      hash: "#/p/djdl/distribution/rollouts?view=matrix&cell=rel_240:altstore",
    },
    {
      name: "djdl:rollouts?view=readiness",
      hash: "#/p/djdl/distribution/rollouts?view=readiness",
    },
    {
      name: "djdl:rollouts?cell",
      hash: "#/p/djdl/distribution/rollouts?cell=rel_240:direct",
    },
    {
      name: "djdl:outlets?outlet",
      hash: "#/p/djdl/distribution/outlets?outlet=altstore",
    },
    {
      name: "djdl:catalog-editor?entry",
      hash: "#/p/djdl/config/catalog/edit?entry=network.timeout",
    },
    {
      name: "dialog:set-secret",
      hash: "#/p/djdl/keys",
      act: async (page) => {
        await page.getByRole("button", { name: "Set secret" }).first().click();
        await page.getByRole("dialog").first().waitFor();
      },
    },
    {
      name: "dialog:delete-product",
      hash: "#/p/djdl/settings",
      act: async (page) => {
        await page.getByRole("button", { name: "Delete product…" }).click();
        await page
          .locator("[role=dialog],[role=alertdialog]")
          .first()
          .waitFor();
      },
    },
  );
  return list;
}

const CASES = cases();
/** `PK_LAYOUT_VIEWPORTS=1280x720,1920x1080` swaps the gate viewports for others locally. */
const VIEWPORTS: { label: string; width: number; height: number }[] = process
  .env.PK_LAYOUT_VIEWPORTS
  ? process.env.PK_LAYOUT_VIEWPORTS.split(",").map((v) => {
      const [width, height] = v.split("x").map(Number) as [number, number];
      return { label: v, width, height };
    })
  : [
      { label: "desktop", width: 1440, height: 900 },
      // A common laptop: the content column is under 1000px beside the sidebar.
      { label: "laptop", width: 1280, height: 800 },
      // A tablet or a narrow window: no sidebar, but too narrow for wide tables.
      { label: "tablet", width: 768, height: 1024 },
      { label: "phone", width: 390, height: 844 },
    ];
const THEMES = ["dark", "light"] as const;

// ── Harness ──────────────────────────────────────────────────────────────────────────────────

let server: PreviewServer;
let browser: Browser;
let base: string;
const report: Record<
  string,
  {
    violations: LayoutViolation[];
    scrollers: ScrollMetric[];
    gaps: string[];
    errors: string[];
    /** The page drew an error or not-found state instead of its content. */
    errorState: boolean;
  }
> = {};

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
  // `PK_LAYOUT_BROWSER=webkit|firefox` runs the same lint in another engine locally.
  const engine = { chromium, firefox, webkit }[
    (process.env.PK_LAYOUT_BROWSER ?? "chromium") as "chromium"
  ];
  browser = await engine.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
  const lines: string[] = ["", "── Layout lint report ──"];
  let total = 0;
  for (const [key, r] of Object.entries(report)) {
    total += r.violations.length;
    lines.push(
      `${r.violations.length ? "FAIL" : "ok  "} ${key}${r.errorState ? "  (error state)" : ""}${r.gaps.length ? `  (fixture gaps: ${r.gaps.join(", ")})` : ""}`,
    );
    for (const v of r.violations)
      lines.push(
        `     · [${v.rule}/${v.kind}] ${v.detail}\n         at ${v.where}`,
      );
  }
  lines.push(
    `── ${total} violation(s) over ${Object.keys(report).length} page loads ──`,
  );
  printSync(`${lines.join("\n")}\n`);
  if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 2));
});

/**
 * Straight to stdout, synchronously: the runner shows console output only for failing tests, and
 * an async write of a report this long is cut off when the worker exits. The report is wanted
 * whole, on a green run too.
 */
function printSync(text: string): void {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
    }
  }
}

async function open(
  c: Case,
  theme: "dark" | "light",
  viewport: { width: number; height: number },
): Promise<{ page: Page; gaps: string[]; errors: string[] }> {
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
  const gaps: string[] = [];
  const errors: string[] = [];
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      if (route.request().method() !== "GET")
        return route.fulfill({ json: { ok: true } });
      const body = resolve(url.pathname);
      if (body === undefined) {
        gaps.push(url.pathname);
        return route.fulfill({ status: 404, json: { error: "not_found" } });
      }
      return route.fulfill({ json: body });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/manage.html${c.hash}`);
  await page
    .locator("[data-page-title], [data-error-action]")
    .first()
    .waitFor({ timeout: 15_000 });
  // Let queries settle: no skeletons, no spinners, for a beat.
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          "#content [data-skeleton], #content [aria-busy=true]",
        ),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(350);
  if (c.act) {
    await c.act(page);
    await page.waitForTimeout(400);
  }
  // A nested scroller (a virtualized table, a drawer body) is measured at its end, where a
  // virtualizer has drawn its last rows and only a real gap can remain below them.
  const nested = await page.evaluate(() => {
    let n = 0;
    for (const e of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      if (e.id === "content") continue;
      const o = getComputedStyle(e).overflowY;
      if (
        (o === "auto" || o === "scroll") &&
        e.scrollHeight > e.clientHeight + 1
      ) {
        e.scrollTop = e.scrollHeight;
        n += 1;
      }
    }
    return n;
  });
  if (nested) await page.waitForTimeout(300);
  return { page, gaps, errors };
}

const slug = (s: string) =>
  s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");

async function shoot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${file}.png` });
  const scrolls = await page.evaluate(() => {
    const m = document.getElementById("content");
    if (!m || m.scrollHeight <= m.clientHeight + 1) return false;
    m.scrollTop = m.scrollHeight;
    return true;
  });
  if (scrolls) {
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${file}--bottom.png` });
    await page.evaluate(() => {
      document.getElementById("content")!.scrollTop = 0;
    });
  }
}

/** `PK_LAYOUT_ONLY=desktop/dark` narrows a local run to one combination. */
const ONLY = process.env.PK_LAYOUT_ONLY;
/** `PK_LAYOUT_CASES=overview,settings` narrows a local run to cases whose name contains one. */
const ONLY_CASES = process.env.PK_LAYOUT_CASES?.split(",");

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    if (ONLY && ONLY !== `${vp.label}/${theme}`) continue;
    describe(`layout · ${vp.label} ${vp.width}×${vp.height} · ${theme}`, () => {
      for (const c of CASES) {
        if (ONLY_CASES && !ONLY_CASES.some((n) => c.name.includes(n))) continue;
        it(c.name, async () => {
          const { page, gaps, errors } = await open(c, theme, vp);
          try {
            const { violations, scrollers } = await page.evaluate(probeLayout, {
              trailingSlack: TRAILING_SLACK,
              rows: vp.width >= 1024,
            });
            const csp = await page.evaluate(() =>
              (window as unknown as { __v: string[] }).__v.splice(0),
            );
            const errorState =
              (await page.locator("#content [data-error-action]").count()) > 0;
            report[`${vp.label}/${theme} ${c.name} ${c.hash}`] = {
              violations,
              scrollers,
              gaps: [...new Set(gaps)],
              errors,
              errorState,
            };
            if (SHOTS)
              await shoot(page, `${slug(c.name)}--${vp.label}-${theme}`);
            expect(csp, "CSP violations").toEqual([]);
            expect(
              violations.map(
                (v) => `[${v.rule}/${v.kind}] ${v.detail} @ ${v.where}`,
              ),
            ).toEqual([]);
          } finally {
            await page.context().close();
          }
        });
      }
    });
  }
}
