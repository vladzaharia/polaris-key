import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { GLOBAL_PAGES, SECTIONS } from "../src/console/nav.js";
import {
  DEVICE_ID,
  fixtureImage,
  IMG_ORIGIN,
  LONG_SLUG,
  PACK_ID,
  resolve,
} from "./layoutFixtures.js";
import {
  columnBreaches,
  emptyStateStarBreaches,
  lintFindings,
  forcedColourBreaches,
  shellStateBreaches,
  unlabelledScrollers,
} from "./pageChecks.js";
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
 * 768×1024 (a tablet) and 390×844, plus 360×780 (ADMIN.md's narrowest) for a few product pages
 * whose top bar is the tightest (the product switcher beside the environment badge), in the
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
// The console shell's policy as the Worker sends it with an image host configured.
const CSP = appSecurityHeaders(new Headers(), {
  imgOrigin: IMG_ORIGIN,
}).get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const REPORT = process.env.PK_LAYOUT_REPORT;
/** The page wrapper's bottom padding is 24px; 48 allows a card's own padding on top of it. */
const TRAILING_SLACK = 48;

/**
 * Masthead and stretch overshoots that belong to a page's own composition, each with the package
 * that fixes it (ST-48 builds the shell; the area packages build their screens on it). The list
 * only shrinks: a full run fails when an entry no longer matches a violation, so delete the entry
 * in the change that fixes the page. A new page never joins it.
 */
const MASTHEAD_DEBT: {
  /** The case name (`djdl:licenses/record/keys`). */
  cases: RegExp;
  /** `rule/kind`. */
  kinds: readonly string[];
  owner: string;
  why: string;
}[] = [
  {
    cases: /^djdl:licenses\/record/,
    kinds: ["masthead/first-content", "masthead/height"],
    owner: "LX-30",
    why: "the holder line, key entries, id, device limit, sign-in and changed-by run to three rows",
  },
  {
    cases: /^djdl:license-batches\/record/,
    kinds: ["masthead/first-content", "masthead/height"],
    owner: "LX-30",
    why: "a notice sits between the masthead and the batch",
  },
  {
    cases: /^(djdl|empty):package-feeds|^global:platform-feeds/,
    kinds: ["masthead/first-content", "masthead/height"],
    owner: "F-38",
    why: "the feed switcher is a second row under the orientation line",
  },
  {
    cases: /^djdl:releases\/record/,
    kinds: ["masthead/first-content", "masthead/height"],
    owner: "the release record's package (follow-up of ST-48)",
    why: "the release's facts run to three rows on a phone and two at the 1024 px rail",
  },
  {
    cases: /^djdl:outlets/,
    kinds: ["right-align/card-consistency"],
    owner: "the Distribution keys card's package (follow-up of ST-48)",
    why: "at the 1024 px rail (never measured before ST-48) the warning row ends 17 px short of its neighbours",
  },
  {
    cases: /^djdl:(outlets|credentials)$/,
    kinds: ["masthead/height"],
    owner: "CF1 follow-up (masthead copy and action row)",
    why: "at 390 px with 200 % text the description wraps to three lines under a two-line title, with the action or meta beneath (outlets 360 px, credentials 448 px, budget 352 px)",
  },
  {
    cases: /^global:api-tokens$/,
    kinds: ["masthead/height"],
    owner: "the API tokens page's package (follow-up of ST-48)",
    why: "the error state's masthead repeats the description on a phone",
  },
  {
    cases: /^long:overview$/,
    kinds: ["masthead/height"],
    owner: "the product Overview's package (follow-up of ST-48)",
    why: "at 360 px a two-line name, a two-line description and the full-width action exceed 176 px",
  },
  {
    cases: /^global:platform-operations$/,
    kinds: ["equal-height/grown-card"],
    owner: "ST-51",
    why: "56 px rows lengthen the Cron jobs stack, and Queues stretches to match it (STRETCH_CELL)",
  },
];
const debtMatched = new Set<number>();

/** Splits a page's violations into new ones and those a MASTHEAD_DEBT entry owns. */
function withoutDebt(
  name: string,
  violations: LayoutViolation[],
): LayoutViolation[] {
  return violations.filter((v) => {
    const i = MASTHEAD_DEBT.findIndex(
      (d) => d.cases.test(name) && d.kinds.includes(`${v.rule}/${v.kind}`),
    );
    if (i < 0) return true;
    debtMatched.add(i);
    return false;
  });
}

interface Case {
  name: string;
  hash: string;
  /** Opens a drawer or dialog after the page settles. */
  act?: (page: Page) => Promise<void>;
  /** The case needs a window at least this wide (a control that is not drawn below it). */
  minWidth?: number;
}

// ── The case list: nav.ts's pages, their records and tabs, the overlays ──────────────────────

const RECORD_IDS: Record<string, { id: string; child?: string[] }> = {
  devices: { id: DEVICE_ID },
  licenses: { id: "lic_1" },
  "license-batches": { id: "batch_long" },
  tiers: { id: "pro" },
  profiles: { id: "base" },
  releases: { id: "v0.4.2" },
  deliverables: { id: PACK_ID },
  "package-feeds": { id: "npm", child: ["@djdl/sdk"] },
  "platform-feeds": { id: "npm", child: ["polaris-key", "@polaris-key/node"] },
  // PS-06: the built-in storefront's own page.
  storefronts: { id: "polaris-key" },
};

function cases(): Case[] {
  const list: Case[] = [];
  const enc = encodeURIComponent;
  for (const section of SECTIONS) {
    for (const p of section.items) {
      const path = p.path ? `/${p.path}` : "";
      list.push({ name: `djdl:${p.page}`, hash: `#/p/djdl${path}` });
      if (p.inNav)
        list.push({ name: `empty:${p.page}`, hash: `#/p/empty${path}` });
      const rec = p.record && RECORD_IDS[p.page];
      if (p.record && rec) {
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
    list.push({ name: `global:${p.page}`, hash: `#/${p.path}` });
    const rec = p.record && RECORD_IDS[p.page];
    if (p.record && rec) {
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
    {
      name: "home:table",
      hash: "#/",
      // The Cards/Table switch is not drawn below 640 px: a phone always shows Cards.
      minWidth: 640,
      act: async (page) => {
        await page.getByRole("radio", { name: "Table" }).click();
        // A phone draws the table as cards (`mobile="cards"`): wait on the choice, not the role.
        await page
          .locator("[role=radio][aria-checked=true]", { hasText: "Table" })
          .waitFor();
      },
    },
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
    // B-217: the Add to storefronts flow, at the steps whose rows wrapped sideways at 200 %.
    ...(["prerequisites", "assets", "run"] as const).map((step) => ({
      name: `djdl:storefronts?flow=${step}`,
      hash: `#/p/djdl/distribution/storefronts?flow=add&stores=google-play&step=${step}`,
    })),
    // B-216: the New license wizard's segments at 200 % text (they read "Lim…" and "Deli…").
    {
      name: "dialog:new-license",
      hash: "#/p/djdl/license/licenses",
      act: async (page) => {
        await page.getByRole("button", { name: "New license" }).click();
        await page.getByRole("dialog").first().waitFor();
      },
    },
    {
      name: "dialog:set-secret",
      hash: "#/p/djdl/settings/keys",
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
/** The cases the zoom rows open: Home, tables, a record, a settings page and an overlay. */
const ZOOM_CASES = [
  "global:home",
  "home:table",
  "djdl:overview",
  "djdl:licenses",
  "djdl:licenses/record/overview",
  "djdl:devices",
  "djdl:keys",
  "djdl:settings",
  "djdl:services",
  "djdl:app-sign-in",
  "djdl:releases",
  "djdl:deliverables/record/delivery",
  "djdl:activity?table",
  "djdl:storefronts?flow=prerequisites",
  "djdl:storefronts?flow=assets",
  "djdl:storefronts?flow=run",
  "dialog:new-license",
  "long:overview",
  "dialog:set-secret",
];
/** Home (Cards and Table) and a product's Overview. */
const HOME_CASES = ["global:home", "home:table", "djdl:overview"];
/** The pages the phone-at-200%-text row opens. */
const TEXT200_CASES = [
  "djdl:settings",
  "djdl:services",
  "djdl:portal",
  "djdl:licenses/record/overview",
  // CF1 / M1: the pages that scrolled sideways at 390 px with 200 % text.
  "djdl:catalog-edit",
  "djdl:catalog-editor?entry",
  "djdl:integration",
  "djdl:releases/record/builds",
  "djdl:outlets",
  "djdl:credentials",
  "djdl:storefronts",
  "djdl:storefronts?flow=prerequisites",
  "djdl:storefronts?flow=assets",
  "djdl:storefronts?flow=run",
  "djdl:activity",
  "global:platform-deployment",
  "djdl:settings-members",
];
/** The console's content column at its widest (BRAND.md §7.6). */
const CONSOLE_COLUMN_MAX = 1760;
/** `PK_LAYOUT_VIEWPORTS=1280x720,1920x1080` swaps the gate viewports for others locally. */
const VIEWPORTS: {
  label: string;
  width: number;
  height: number;
  /** Only these cases (by name) at this viewport. */
  only?: readonly string[];
  /** Only the cases this accepts (the wide and zoom rows skip the empty-state twins). */
  accept?: (name: string) => boolean;
  /** The root font size as a percentage (WCAG 1.4.4 text resize), on top of the viewport. */
  rootFontPercent?: number;
  /** The device pixel ratio: browser zoom is a smaller CSS viewport at a higher ratio. */
  deviceScaleFactor?: number;
  /** Emulate a Windows contrast theme, or `prefers-contrast: more`. */
  forcedColors?: "active";
  contrast?: "more";
}[] = process.env.PK_LAYOUT_VIEWPORTS
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
      // The shell v2 matrix (ST-48): the icon rail at its narrowest (1024), the iPad (834) and the
      // phone widths (390 above, 360 below). The canvas is inset only from 1024 px.
      {
        label: "rail",
        width: 1024,
        height: 768,
        accept: (n) => !n.startsWith("empty:"),
      },
      {
        label: "ipad",
        width: 834,
        height: 1112,
        accept: (n) => !n.startsWith("empty:"),
      },
      { label: "phone", width: 390, height: 844 },
      // Home and Overview at the laptop the owner works on (1512). Overview's own 200 % text (its
      // masthead sentence, the By platform rows) belongs to the Overview package.
      { label: "mac", width: 1512, height: 818, only: HOME_CASES },
      // ADMIN.md's narrowest width, for the pages with a product in the top bar: the switcher's
      // chevron once spilled out of its border box here (ADMIN.md §2.2).
      {
        label: "small-phone",
        width: 360,
        height: 780,
        only: [...ZOOM_CASES, "djdl:health", "djdl:rollouts"],
      },
      // UI-KITS.md §7.1's wide desktop: every page with content (the empty-state twins add
      // nothing to a width check). The column stays capped (CONSOLE_COLUMN_MAX).
      {
        label: "wide",
        width: 1920,
        height: 1080,
        accept: (n) => !n.startsWith("empty:"),
      },
      // 200 % zoom in a 1280 × 800 and a 1440 × 900 window, and 400 % in 1280 × 1024
      // (320 × 256 CSS px, WCAG 1.4.10): the key pages, a table, a record, an overlay.
      ...[
        { label: "zoom200", width: 640, height: 400, deviceScaleFactor: 2 },
        {
          label: "zoom200-wide",
          width: 720,
          height: 450,
          deviceScaleFactor: 2,
        },
        { label: "zoom400", width: 320, height: 256, deviceScaleFactor: 4 },
      ].map((v) => ({ ...v, only: ZOOM_CASES })),
      // 200 % text on a phone (WCAG 1.4.4; a text-only zoom keeps the window): Home, and the
      // Settings tabs and a licence record, where a word broke into letters, a control ran off
      // the screen and a date input spilled.
      {
        label: "phone-text200",
        width: 390,
        height: 844,
        rootFontPercent: 200,
        only: ["global:home", "home:table", "djdl:overview", ...TEXT200_CASES],
      },
      // Forced colours (a Windows contrast theme) and `prefers-contrast: more`: Home, Licenses and
      // Services.
      {
        label: "forced-colors",
        width: 1440,
        height: 900,
        forcedColors: "active" as const,
        only: [
          "global:home",
          "home:table",
          "djdl:licenses",
          "djdl:services",
          "djdl:app-sign-in",
          "dialog:set-secret",
        ],
      },
      {
        label: "more-contrast",
        width: 1440,
        height: 900,
        contrast: "more" as const,
        only: [
          "global:home",
          "home:table",
          "djdl:licenses",
          "djdl:services",
          "djdl:app-sign-in",
          "dialog:set-secret",
        ],
      },
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
  // A full run owes the debt list its shrinking: an entry that matched nothing is paid.
  if (!ONLY && !ONLY_CASES && !process.env.PK_LAYOUT_VIEWPORTS) {
    const paid = MASTHEAD_DEBT.filter((_, i) => !debtMatched.has(i));
    if (paid.length)
      throw new Error(
        `MASTHEAD_DEBT entries that no longer match a violation (delete them): ${paid.map((d) => `${d.cases} (${d.owner})`).join(", ")}`,
      );
  }
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
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    rootFontPercent?: number;
    forcedColors?: "active";
    contrast?: "more";
  },
): Promise<{ page: Page; gaps: string[]; errors: string[] }> {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    colorScheme: theme,
    forcedColors: viewport.forcedColors ?? "none",
    contrast: viewport.contrast ?? "no-preference",
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
    const image = fixtureImage(url);
    if (image)
      return route.fulfill({
        body: image,
        headers: {
          "content-type": "image/png",
          "access-control-allow-origin": "*",
        },
      });
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
  if (viewport.rootFontPercent)
    await ctx.addInitScript((pct) => {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = `${pct}%`;
      });
    }, viewport.rootFontPercent);
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
        if (vp.only && !vp.only.includes(c.name)) continue;
        if (vp.accept && !vp.accept(c.name)) continue;
        if (c.minWidth && vp.width < c.minWidth) continue;
        if (ONLY_CASES && !ONLY_CASES.some((n) => c.name.includes(n))) continue;
        it(c.name, async () => {
          const { page, gaps, errors } = await open(c, theme, vp);
          try {
            const { violations, scrollers } = await page.evaluate(probeLayout, {
              // The page's bottom padding is in rem, so it grows with the text.
              trailingSlack:
                TRAILING_SLACK * ((vp.rootFontPercent ?? 100) / 100),
              rows: vp.width >= 1024,
            });
            const csp = await page.evaluate(() =>
              (window as unknown as { __v: string[] }).__v.splice(0),
            );
            const errorState =
              (await page.locator("#content [data-error-action]").count()) > 0;
            const found = withoutDebt(c.name, violations);
            report[`${vp.label}/${theme} ${c.name} ${c.hash}`] = {
              violations: found,
              scrollers,
              gaps: [...new Set(gaps)],
              errors,
              errorState,
            };
            if (SHOTS)
              await shoot(page, `${slug(c.name)}--${vp.label}-${theme}`);
            expect(csp, "CSP violations").toEqual([]);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth - window.innerWidth,
              ),
              "page-level horizontal scroll",
            ).toBeLessThanOrEqual(0);
            expect(
              await unlabelledScrollers(page),
              "sideways tables outside a labelled region",
            ).toEqual([]);
            if (vp.label === "wide" || vp.label.startsWith("zoom")) {
              // ui:lint over the built page (`pnpm ui:lint --html`; pageChecks.ts).
              // Every rule, with 24 px touch targets (WCAG 2.5.8) at every size.
              expect(
                await lintFindings(page, { minTouch: 24 }),
                "ui:lint findings",
              ).toEqual([]);
            }
            if (
              ["desktop", "phone", "rail"].includes(vp.label) &&
              (await page.locator("header[data-masthead]").count()) > 0
            )
              // axe zero over the masthead and any workbench (ST-48): landmarks, names, contrast.
              expect(
                [
                  ...(await axeWithin(page, "header[data-masthead]")),
                  ...((await page.locator("[data-workbench]").count()) > 0
                    ? await axeWithin(page, "[data-workbench]")
                    : []),
                ],
                "axe: masthead and workbench",
              ).toEqual([]);
            expect(
              await shellStateBreaches(page),
              "shell state colours (B2, B4, B17)",
            ).toEqual([]);
            expect(
              await emptyStateStarBreaches(page),
              "stationary star (BRAND.md §7.7)",
            ).toEqual([]);
            if (vp.forcedColors)
              expect(
                await forcedColourBreaches(page),
                "forced-colour boundaries",
              ).toEqual([]);
            if (vp.forcedColors) {
              // B-009: a sidebar group header is a row, not a control box. It and the single-page
              // link opt out with data-forced-flat, so neither is drawn with a 1 px border.
              const boxed = await page.evaluate(() =>
                [
                  ...document.querySelectorAll<HTMLElement>(
                    "[data-section-header]",
                  ),
                ]
                  // The current page's row keeps its 2 px selected border (the non-colour cue).
                  .filter(
                    (el) =>
                      el.checkVisibility() && !el.hasAttribute("aria-current"),
                  )
                  .map((el) => ({
                    flat: el.hasAttribute("data-forced-flat"),
                    border: getComputedStyle(el).borderTopWidth,
                    label: (el.textContent ?? "").trim().slice(0, 30),
                  }))
                  .filter((h) => !h.flat || h.border !== "0px")
                  .map((h) => `${h.label}: flat=${h.flat} border=${h.border}`),
              );
              expect(
                boxed,
                "sidebar group headers are flat in forced colours",
              ).toEqual([]);
            }
            if (vp.forcedColors && c.name === "djdl:services") {
              // State never rests on colour alone: in forced colours an on switch must draw
              // differently from an off one (track fill and knob). The fixture has every
              // switch on, so an off twin is a clone with the unchecked state attributes.
              const looks = await page.evaluate(() => {
                const sw = document.querySelector<HTMLElement>(
                  '[role="switch"][data-state="checked"]',
                );
                if (!sw) return null;
                const draw = (el: HTMLElement) =>
                  `${getComputedStyle(el).backgroundColor}|${getComputedStyle(el.firstElementChild!).backgroundColor}`;
                const on = draw(sw);
                const twin = sw.cloneNode(true) as HTMLElement;
                for (const el of [twin, twin.firstElementChild!])
                  el.setAttribute("data-state", "unchecked");
                sw.after(twin);
                const off = draw(twin);
                twin.remove();
                return { on, off };
              });
              expect(looks, "an on switch is drawn").not.toBeNull();
              expect(
                looks!.on,
                "on and off switches look the same in forced colours",
              ).not.toBe(looks!.off);
            }
            expect(
              await columnBreaches(
                page,
                "#content > div",
                CONSOLE_COLUMN_MAX,
                false,
              ),
              "content column",
            ).toEqual([]);
            expect(
              found.map(
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

// ── Home's product card (owner polish 2026-10-07) ─────────────────────────────────────────────

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

/** axe-core (WCAG 2.2 A/AA) over one element of the page; one line per failing node. */
async function axeWithin(page: Page, selector: string): Promise<string[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (sel) => {
    const a = (
      window as unknown as {
        axe: {
          run: (
            ctx: Element,
            opts: unknown,
          ) => Promise<{
            violations: { id: string; nodes: { target: unknown[] }[] }[];
          }>;
        };
      }
    ).axe;
    const r = await a.run(document.querySelector(sel)!, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      resultTypes: ["violations"],
    });
    return r.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id} @ ${n.target.join(" ")}`),
    );
  }, selector);
}

describe("Home's product card (owner polish 2026-10-07)", () => {
  const HOME: Case = { name: "global:home", hash: "#/" };
  const CARDS = 'main [aria-label="Products"]';

  for (const theme of THEMES) {
    it(`${theme}: one row of named feature glyphs; on a phone, the name and one pip per feature in its accent`, async () => {
      const desk = await open(HOME, theme, { width: 1440, height: 900 });
      try {
        const page = desk.page;
        const card = page.locator(`${CARDS} article[aria-label="DJDL"]`);
        const icons = card.locator("[data-feature-link]");
        expect(await icons.count()).toBe(6);
        for (const label of ["Licensing", "Ship builds", "Cloud Sync"]) {
          // A feature with a problem names it too ("Managed config: 1 needs attention").
          const link = card.getByRole("link", { name: label, exact: true });
          expect(await link.isVisible()).toBe(true);
          expect(await link.getAttribute("title")).toBe(label);
        }
        expect(await card.locator("[data-feature-pips]").isVisible()).toBe(
          false,
        );
        // No facts, rows or footer on the card.
        expect(await card.locator("[data-service-row]").count()).toBe(0);
        expect(await card.textContent()).not.toMatch(/Synced|Changed|active/);
        expect(await axeWithin(page, CARDS)).toEqual([]);
      } finally {
        await desk.page.context().close();
      }

      const phone = await open(HOME, theme, { width: 390, height: 844 });
      try {
        const page = phone.page;
        const card = page.locator(`${CARDS} article[aria-label="DJDL"]`);
        const pips = card.getByRole("img", {
          name: "Licensing, Managed config: 1 needs attention, Ship builds, Sign-in, Cloud Sync, Commerce",
        });
        expect(await pips.isVisible()).toBe(true);
        // The glyph row steps aside; the logo, the slug with its pips beside it, and the small
        // pill at the right edge stay (products.home, phone).
        expect(
          await card.locator("[data-feature-icons]").first().isVisible(),
        ).toBe(false);
        // The card draws two logos (40 px, hidden on a phone; 32 px, phone only): the visible one.
        for (const sel of [
          "[data-logo]:visible",
          "[data-card-header] [data-status]",
        ])
          expect(await card.locator(sel).first().isVisible(), sel).toBe(true);
        expect(await card.getByText("djdl", { exact: true }).isVisible()).toBe(
          true,
        );
        expect(await card.getByRole("link", { name: "DJDL" }).isVisible()).toBe(
          true,
        );
        // Each pip is its service's accent, as the brand tokens define it for that section.
        const colours = await card.locator("[data-pip]").evaluateAll((els) =>
          els.map((el) => {
            const probe = document.createElement("span");
            probe.setAttribute(
              "data-service",
              el.getAttribute("data-service")!,
            );
            probe.style.color = "var(--pk-accent)";
            document.body.append(probe);
            const want = getComputedStyle(probe).color;
            probe.remove();
            return {
              service: el.getAttribute("data-service"),
              got: getComputedStyle(el).backgroundColor,
              want,
            };
          }),
        );
        // One pip per feature, in canonical order, each in its feature's accent.
        expect(colours.map((c) => c.service)).toEqual([
          "license",
          "config",
          "release",
          "identity",
          "sync",
          "commerce",
        ]);
        for (const c of colours) expect(c.got, c.service!).toBe(c.want);
        expect(new Set(colours.map((c) => c.got)).size).toBe(colours.length);
        expect(await axeWithin(page, CARDS)).toEqual([]);
      } finally {
        await phone.page.context().close();
      }
    });
  }
});

// ── `?setting=` deep links land on their row (UX review M6) ───────────────────────────────────

describe("?setting= deep links", () => {
  const LINKS: [string, string, string][] = [
    [
      "a product row",
      "#/p/djdl/settings?setting=license.defaults.deviceLimit",
      "setting-license.defaults.deviceLimit",
    ],
    [
      "a Polaris Locker switch",
      "#/p/djdl/settings/portal?setting=identity.keyEntry.claimByKey",
      "setting-identity.keyEntry.claimByKey",
    ],
    [
      "a platform setting row",
      "#/platform/settings?setting=LAZY_DELTAS",
      "platform-setting-LAZY_DELTAS",
    ],
  ];
  for (const [what, hash, id] of LINKS) {
    it(`${what} takes the focus and scrolls into view`, async () => {
      const { page } = await open({ name: `link:${id}`, hash }, "dark", {
        width: 1440,
        height: 900,
      });
      try {
        await page.waitForFunction(
          (rowId) =>
            document.getElementById(rowId)?.contains(document.activeElement),
          id,
          { timeout: 1500 },
        );
        const box = await page.evaluate((rowId) => {
          const r = document.getElementById(rowId)!.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, h: innerHeight };
        }, id);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.bottom).toBeLessThanOrEqual(box.h);
      } finally {
        await page.context().close();
      }
    });
  }
});

// ── A dialog's own <form> wraps the body and footer (B-018) ───────────────────────────────────

describe("a dialog whose form wraps its body and footer", () => {
  it("keeps the footer inside a short window; the body scrolls instead", async () => {
    const { page } = await open(
      { name: "dialog:issue-ci-token", hash: "#/p/djdl/settings/keys" },
      "dark",
      { width: 1024, height: 360 },
    );
    try {
      await page.getByRole("button", { name: "Issue token…" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Issue a CI token" });
      await dialog.waitFor();
      const box = await dialog.evaluate((el) => {
        const submit = el.querySelector<HTMLElement>("button[type=submit]")!;
        const r = submit.getBoundingClientRect();
        return { bottom: r.bottom, top: r.top, h: innerHeight };
      });
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(box.h);
    } finally {
      await page.context().close();
    }
  });
});

// ── A keyboard-focused primary or danger button shows a ring (CF1 / B1) ──────────────────────
// ST-48's unlayered `box-shadow: none` on the primary variant once removed the ring from every
// main action. A focus ring is an outline or a box-shadow; "none" for both fails WCAG 2.4.7.

describe("focus ring on primary and danger buttons", () => {
  const targets = [
    {
      hash: "#/p/djdl/license/licenses",
      name: "New license",
      variant: "primary",
    },
    {
      hash: "#/p/djdl/distribution/rollouts",
      name: "Start rollout…",
      variant: "primary",
    },
    {
      hash: "#/p/djdl/settings",
      name: "Delete product…",
      variant: "danger",
    },
  ] as const;
  for (const theme of THEMES) {
    for (const t of targets) {
      it(`${t.name} · ${theme}`, async () => {
        const { page } = await open(
          { name: `focus:${t.name}`, hash: t.hash },
          theme,
          { width: 1440, height: 900 },
        );
        try {
          const button = page.getByRole("button", { name: t.name }).first();
          await button.waitFor();
          // A key press first, so the next focus() is a keyboard focus (`:focus-visible`).
          await page.keyboard.press("Shift");
          await button.focus();
          const ring = await button.evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
              visible: el.matches(":focus-visible"),
              variant: el.getAttribute("data-variant"),
              shadow: cs.boxShadow,
              outline:
                cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0,
            };
          });
          expect(ring.visible, "keyboard focus").toBe(true);
          expect(ring.variant).toBe(t.variant);
          expect(
            ring.shadow !== "none" || ring.outline,
            `ring: ${JSON.stringify(ring)}`,
          ).toBe(true);
        } finally {
          await page.context().close();
        }
      });
    }
  }
});
