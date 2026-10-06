import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";
import { startPortal, type PortalHarness } from "./portalHarness.js";

/**
 * The motion smoke suite (notes/S-23 §6.8, D9; MO-03): the built SPA in real Chromium under the
 * Worker's exact CSP, with motion ON (`reducedMotion: "no-preference"`), in both themes. Every other
 * e2e suite runs with `reducedMotion: "reduce"` so its screenshots and layout probes see final
 * states; this one keeps the motion itself honest:
 *
 * - a Dialog's enter and exit run with durations equal to the resolved `--pk-duration-*` tokens,
 *   and the node stays in the DOM until the exit has finished, then leaves;
 * - the Cmd-K palette, the product switcher and the phone navigation drawer (console) and the
 *   JumpPalette (portal) close through their exit, and nothing is left animating afterwards
 *   (enter animations fill `backwards`, so a page at rest has `document.getAnimations()` empty);
 * - a console and a portal route change set `html[data-vt="route"]`, animate only the main region
 *   on the tokens, and finish (the chrome is never named);
 * - a list mutation over a long list names at most LIST_BUDGET (30) rows;
 * - zero `securitypolicyviolation` events throughout;
 * - with `reducedMotion: "reduce"` the same interactions start no transition, run no animation
 *   with a duration, and leave `document.getAnimations()` empty.
 *
 * No route calls `viewTransition()` yet (MO-04 wires the console router, MO-05 the portal's), so
 * the route and list checks drive the layer's real source (`src/ui/motion/viewTransition.ts`,
 * bundled here by Vite) inside the page against the built `motion.css`. The bundle is evaluated over
 * the DevTools protocol, which the page's CSP does not govern (as `portalHarness.axe` does); what it
 * does in the page (data attributes, CSSOM names) is still subject to it. When MO-04 and MO-05
 * land, those tests switch to a real navigation and drop the injected layer. Area packages add
 * their own pattern here (S-23 §10).
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];
type Motion = "no-preference" | "reduce";

/** A license row for the list check: enough of them that the list is over the budget. */
const NOW = Math.floor(Date.now() / 1000);
const LONG_LIST = Array.from({ length: 48 }, (_, i) => ({
  id: `lic_${i + 1}`,
  name: `Seat ${String(i + 1).padStart(2, "0")}`,
  email: `seat${i + 1}@example.com`,
  status: "active",
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
}));
const ROUTES: Record<string, unknown> = {
  ...CORE_ROUTES,
  "/manage/api/products/djdl/license/licenses": { licenses: LONG_LIST },
  "/manage/api/products/djdl/license/tiers": { tiers: [] },
};

let server: PreviewServer;
let browser: Browser;
let base: string;
let portal: PortalHarness;
/** `src/ui/motion/viewTransition.ts` as an IIFE that sets `window.__pkMotion`. */
let LAYER: string;

beforeAll(async () => {
  if (!existsSync(`${here}dist/manage.html`)) {
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  }
  const out = await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: `${here}src/ui/motion/viewTransition.ts`,
        formats: ["iife"],
        name: "__pkMotion",
      },
    },
  });
  const output = (Array.isArray(out) ? out[0]! : out) as {
    output: { code?: string }[];
  };
  LAYER = `${output.output[0]!.code!}\nwindow.__pkMotion = __pkMotion;`;
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
});

// ── The console under the Worker's CSP ───────────────────────────────────────────────────────────

async function openConsole(
  theme: Theme,
  motion: Motion,
  hash = "#/p/djdl/license/licenses",
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport,
    colorScheme: theme,
    reducedMotion: motion,
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
    if (url.pathname.startsWith("/manage/api/")) {
      const body = ROUTES[url.pathname];
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
  await page.locator("[data-page-title]").first().waitFor();
  await installProbe(page);
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

// ── The in-page probe ─────────────────────────────────────────────────────────────────────────────

/** One CSS animation event, with the timing the browser resolved for it. */
interface AnimEvent {
  phase: "start" | "end" | "cancel";
  name: string;
  pseudo: string;
  duration: number;
  delay: number;
  role: string | null;
  state: string | null;
  side: string | null;
  /** Was the element still in the document when the event fired? */
  connected: boolean;
}

interface Probe {
  log: AnimEvent[];
  vt: (string | null)[];
}

/**
 * Record every CSS animation's start, end and cancel (with its resolved duration and delay) and
 * every change of `html[data-vt]`. Installed over the DevTools protocol after load; listening needs
 * no markup, so the page's CSP is untouched.
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __m: Probe };
    if (w.__m) return;
    w.__m = { log: [], vt: [] };
    // A finished animation that fills `backwards` has already left getAnimations() by its
    // animationend, so the timing is read at its start and remembered per element.
    const timings = new WeakMap<Element, Map<string, EffectTiming>>();
    const record =
      (phase: AnimEvent["phase"]) =>
      (e: Event): void => {
        const ev = e as AnimationEvent;
        const el = ev.target as Element;
        const key = `${ev.animationName}${ev.pseudoElement}`;
        const anim = el
          .getAnimations?.()
          .find(
            (a) =>
              (a as CSSAnimation).animationName === ev.animationName &&
              ((a.effect as KeyframeEffect | null)?.pseudoElement ?? "") ===
                ev.pseudoElement,
          );
        let byName = timings.get(el);
        if (!byName) timings.set(el, (byName = new Map()));
        const timing = anim?.effect?.getTiming() ?? byName.get(key);
        if (timing) byName.set(key, timing);
        w.__m.log.push({
          phase,
          name: ev.animationName,
          pseudo: ev.pseudoElement,
          duration: Number(timing?.duration ?? Number.NaN),
          delay: Number(timing?.delay ?? 0),
          role: el.getAttribute("role"),
          state: el.getAttribute("data-state"),
          side: el.getAttribute("data-side"),
          connected: el.isConnected,
        });
      };
    document.addEventListener("animationstart", record("start"), true);
    document.addEventListener("animationend", record("end"), true);
    document.addEventListener("animationcancel", record("cancel"), true);
    new MutationObserver(() =>
      w.__m.vt.push(document.documentElement.getAttribute("data-vt")),
    ).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-vt"],
    });
  });
}

const takeLog = (page: Page): Promise<AnimEvent[]> =>
  page.evaluate(() => (window as unknown as { __m: Probe }).__m.log.splice(0));

/** The resolved motion tokens, in ms, read from `<html>` (0 under reduced motion). */
type Tokens = Record<
  "instant" | "micro" | "fast" | "base" | "moderate" | "slow" | "deliberate",
  number
>;
async function tokens(page: Page): Promise<Tokens> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const ms = (name: string): number => {
      const raw = cs.getPropertyValue(`--pk-duration-${name}`).trim();
      const n = parseFloat(raw);
      return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
    };
    return Object.fromEntries(
      [
        "instant",
        "micro",
        "fast",
        "base",
        "moderate",
        "slow",
        "deliberate",
      ].map((k) => [k, ms(k)]),
    ) as Tokens;
  });
}

/** Animations still running anywhere in the document (pseudo-elements included). */
const running = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document
      .getAnimations()
      .map(
        (a) =>
          `${(a as CSSAnimation).animationName ?? a.constructor.name}${
            (a.effect as KeyframeEffect | null)?.pseudoElement ?? ""
          } on ${
            ((a.effect as KeyframeEffect | null)?.target as Element | null)
              ?.tagName ?? "?"
          }`,
      ),
  );

/** Wait until nothing animates (a page at rest), up to `timeout` ms. */
async function atRest(page: Page, timeout = 3000): Promise<void> {
  await page
    .waitForFunction(() => document.getAnimations().length === 0, null, {
      timeout,
    })
    .catch(() => undefined);
}

/** The events of one phase for animations on elements with this role (or pseudo, or side). */
const pick = (
  log: AnimEvent[],
  phase: AnimEvent["phase"],
  match: (e: AnimEvent) => boolean,
): AnimEvent[] => log.filter((e) => e.phase === phase && match(e));

// ── The View Transition driver (the layer's real source, injected) ───────────────────────────────

interface VtRun {
  /** `html[data-vt]` right after viewTransition() returned. */
  during: string | null;
  /** Every `::view-transition-*` animation seen while the transition ran. */
  pseudo: { pseudo: string; duration: number; delay: number }[];
  /** Calls to document.startViewTransition. */
  started: number;
  /** Rows named for the transition (computed `view-transition-name` other than none). */
  namedRows: number;
  rows: number;
  /** Rows on screen when the transition started. */
  onScreen: number;
  /** `html[data-vt]` and named rows once `finished` resolved. */
  after: string | null;
  namedAfter: number;
}

/**
 * Run `viewTransition(update, { type, list })` in the page: `navigate` (a hash) is the update, and
 * `listSelector` names the list whose rows take part. Polls the running pseudo-element animations
 * each frame until `finished`.
 */
async function runViewTransition(
  page: Page,
  opts: { type: string; navigate?: string; listSelector?: string },
): Promise<VtRun> {
  const loaded = await page.evaluate(
    () => typeof (window as { __pkMotion?: unknown }).__pkMotion === "object",
  );
  if (!loaded) await page.evaluate(LAYER);
  return page.evaluate(async ({ type, navigate, listSelector }) => {
    type Layer = {
      viewTransition: (
        update: () => void,
        o: { type: string; list?: Element | null },
      ) => { updateCallbackDone: Promise<void>; finished: Promise<void> };
    };
    const layer = (window as unknown as { __pkMotion: Layer }).__pkMotion;
    const doc = document as unknown as {
      startViewTransition?: (...a: unknown[]) => unknown;
    };
    const original = doc.startViewTransition;
    let started = 0;
    if (original)
      doc.startViewTransition = (...a: unknown[]) => {
        started++;
        return original.apply(document, a);
      };
    const list = listSelector ? document.querySelector(listSelector) : null;
    const rows = list ? Array.from(list.children) : [];
    const named = (): number =>
      rows.filter((r) => getComputedStyle(r).viewTransitionName !== "none")
        .length;
    const vh = window.innerHeight;
    const onScreen = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > 0 && b.top < vh;
    }).length;

    const seen = new Map<string, { duration: number; delay: number }>();
    let polling = true;
    const poll = (): void => {
      for (const a of document.getAnimations()) {
        const pseudo = (a.effect as KeyframeEffect | null)?.pseudoElement;
        if (!pseudo?.startsWith("::view-transition")) continue;
        const t = a.effect!.getTiming();
        seen.set(pseudo, {
          duration: Number(t.duration),
          delay: Number(t.delay ?? 0),
        });
      }
      if (polling) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);

    let namedRows = 0;
    const handle = layer.viewTransition(
      () => {
        if (navigate) location.hash = navigate;
      },
      { type, list },
    );
    const during = document.documentElement.getAttribute("data-vt");
    namedRows = named();
    await handle.updateCallbackDone;
    await handle.finished;
    // One more frame, so the layer's cleanup (chained on `finished`) has run.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    polling = false;
    if (original) doc.startViewTransition = original;
    return {
      during,
      pseudo: [...seen].map(([pseudo, t]) => ({ pseudo, ...t })),
      started,
      namedRows,
      rows: rows.length,
      onScreen,
      after: document.documentElement.getAttribute("data-vt"),
      namedAfter: named(),
    };
  }, opts);
}

// ── Motion on ─────────────────────────────────────────────────────────────────────────────────────

describe("motion on: the console under the Worker's CSP", () => {
  for (const theme of THEMES) {
    it(`a dialog enters and exits on the tokens, and leaves the DOM after its exit (${theme})`, async () => {
      const page = await openConsole(theme, "no-preference");
      const tk = await tokens(page);
      expect(tk).toMatchObject({
        instant: 0,
        micro: 80,
        fast: 120,
        base: 200,
        moderate: 260,
        slow: 320,
        deliberate: 480,
      });
      await atRest(page);
      await takeLog(page);

      await page
        .getByRole("button", { name: "Create license" })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await atRest(page);
      const enter = await takeLog(page);
      const dialogEnter = pick(enter, "end", (e) => e.role === "dialog");
      expect(dialogEnter.map((e) => [e.name, e.duration])).toEqual([
        ["pk-enter", tk.slow],
      ]);
      const scrimEnter = pick(
        enter,
        "end",
        (e) => e.role === null && e.name === "pk-fade-in",
      );
      expect(scrimEnter.map((e) => e.duration)).toContain(tk.base);
      expect(await running(page), "an enter left an animation behind").toEqual(
        [],
      );

      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await atRest(page);
      const exit = await takeLog(page);
      const dialogExit = pick(exit, "end", (e) => e.role === "dialog");
      expect(
        dialogExit.map((e) => [e.name, e.duration, e.state, e.connected]),
        "the dialog's exit ran to its end while the node was still in the DOM",
      ).toEqual([["pk-exit", tk.base, "closed", true]]);
      expect(
        pick(exit, "end", (e) => e.name === "pk-fade-out").map(
          (e) => e.duration,
        ),
        "the scrim fades out on the base token",
      ).toContain(tk.base);
      expect(pick(exit, "cancel", () => true)).toEqual([]);
      expect(await page.locator("[role=dialog]").count()).toBe(0);
      expect(await running(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });

    it(`the Cmd-K palette, the product switcher and the phone navigation close through their exit (${theme})`, async () => {
      const page = await openConsole(theme, "no-preference");
      const tk = await tokens(page);
      const closes = async (
        name: string,
        openIt: () => Promise<void>,
        target: () => Locator,
        expected: { name: string; duration: number },
      ): Promise<void> => {
        await atRest(page);
        await takeLog(page);
        await openIt();
        await target().waitFor();
        await atRest(page);
        expect(
          await running(page),
          `${name}: the enter left an animation`,
        ).toEqual([]);
        await takeLog(page);
        await page.keyboard.press("Escape");
        await target().waitFor({ state: "detached" });
        await atRest(page);
        const log = await takeLog(page);
        const exit = pick(
          log,
          "end",
          (e) => e.state === "closed" && e.name === expected.name,
        );
        expect(
          exit.map((e) => [e.duration, e.connected]),
          `${name}: the exit ran on its token with the node still in the DOM`,
        ).toContainEqual([expected.duration, true]);
        expect(
          pick(log, "cancel", () => true),
          `${name}: cancelled`,
        ).toEqual([]);
        expect(await running(page), `${name}: still animating`).toEqual([]);
        expect(await violations(page), `${name}: CSP violations`).toEqual([]);
      };

      await closes(
        "command palette",
        () => page.keyboard.press("Control+k"),
        () => page.getByRole("dialog", { name: "Command palette" }),
        { name: "pk-exit", duration: tk.base },
      );
      await closes(
        "product switcher",
        () => page.getByRole("button", { name: /^Product: DJDL/ }).click(),
        () => page.getByRole("listbox", { name: "Products" }),
        { name: "pk-fade-out", duration: tk.fast },
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await closes(
        "phone navigation",
        () => page.getByRole("button", { name: "Open navigation" }).click(),
        () => page.getByRole("dialog", { name: "Navigation" }),
        // MO-10: the drawer slides back out to the inline start.
        { name: "pk-nav-out", duration: tk.base },
      );
      await page.context().close();
    });

    it(`a route change sets html[data-vt="route"], fades only the main region on the tokens, and finishes (${theme})`, async () => {
      const page = await openConsole(theme, "no-preference");
      const tk = await tokens(page);
      await atRest(page);
      const run = await runViewTransition(page, {
        type: "route",
        navigate: "#/p/djdl/license/tiers",
      });
      expect(run.started).toBe(1);
      expect(run.during).toBe("route");
      const t = Object.fromEntries(run.pseudo.map((p) => [p.pseudo, p]));
      expect(t["::view-transition-old(pk-main)"]).toEqual({
        pseudo: "::view-transition-old(pk-main)",
        duration: tk.fast,
        delay: 0,
      });
      expect(t["::view-transition-new(pk-main)"]).toEqual({
        pseudo: "::view-transition-new(pk-main)",
        duration: tk.base,
        delay: tk.micro,
      });
      // The chrome (top bar, sidebar, switcher) is never named: only the main region moves.
      const names = new Set(
        run.pseudo.map((p) => p.pseudo.replace(/^.*\((.*)\)$/, "$1")),
      );
      expect([...names]).toEqual(["pk-main"]);
      expect(run.after).toBeNull();
      expect(
        await page.evaluate(() => (window as unknown as { __m: Probe }).__m.vt),
      ).toEqual(["route", null]);
      await page.locator("[data-page-title]", { hasText: "Tiers" }).waitFor();
      expect(await running(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });

    it(`a list mutation over ${LONG_LIST.length} rows names at most 30 of them (${theme})`, async () => {
      const page = await openConsole(theme, "no-preference");
      await page.getByText("Seat 01").first().waitFor();
      await atRest(page);
      const run = await runViewTransition(page, {
        type: "list",
        listSelector: "main#content table tbody",
      });
      expect(run.rows, "the list is over the budget").toBeGreaterThan(30);
      expect(run.started).toBe(1);
      expect(run.during).toBe("list");
      expect(run.namedRows).toBeGreaterThan(0);
      expect(run.namedRows).toBeLessThanOrEqual(30);
      expect(run.namedRows, "only the rows on screen are named").toBe(
        run.onScreen,
      );
      // Groups: the named rows, the main region and nothing else (the chrome stays live).
      const groups = run.pseudo.filter((p) =>
        p.pseudo.startsWith("::view-transition-group("),
      );
      expect(groups.length).toBeLessThanOrEqual(run.namedRows + 1);
      expect(run.after).toBeNull();
      expect(run.namedAfter, "the names are removed after the transition").toBe(
        0,
      );
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });
  }
});

describe("motion on: the portal under the Worker's CSP", () => {
  for (const theme of THEMES) {
    it(`the JumpPalette closes through its exit and leaves nothing animating (${theme})`, async () => {
      const o = await portal.open("twelve", "/", {
        theme,
        reducedMotion: "no-preference",
      });
      const page = o.page;
      await page
        .getByRole("heading", { level: 1, name: "Your library" })
        .waitFor();
      await page.getByText("Glyphsmith").first().waitFor();
      await installProbe(page);
      const tk = await tokens(page);
      await atRest(page);
      await takeLog(page);
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Jump to a product" });
      await palette.waitFor();
      await atRest(page);
      const enter = await takeLog(page);
      expect(
        pick(enter, "end", (e) => e.role === "dialog").map((e) => [
          e.name,
          e.duration,
        ]),
      ).toEqual([["pk-enter", tk.slow]]);
      expect(await running(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "detached" });
      await atRest(page);
      const exit = await takeLog(page);
      expect(
        pick(exit, "end", (e) => e.role === "dialog").map((e) => [
          e.name,
          e.duration,
          e.connected,
        ]),
      ).toEqual([["pk-exit", tk.base, true]]);
      expect(pick(exit, "cancel", () => true)).toEqual([]);
      expect(await running(page)).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`a portal route change sets html[data-vt="route"] and finishes (${theme})`, async () => {
      const o = await portal.open("three", "/", {
        theme,
        reducedMotion: "no-preference",
      });
      const page = o.page;
      await page
        .getByRole("heading", { level: 1, name: "Your library" })
        .waitFor();
      await installProbe(page);
      const tk = await tokens(page);
      await atRest(page);
      const run = await runViewTransition(page, {
        type: "route",
        navigate: "#/account/appearance",
      });
      expect(run.started).toBe(1);
      expect(run.during).toBe("route");
      const t = Object.fromEntries(run.pseudo.map((p) => [p.pseudo, p]));
      expect(t["::view-transition-old(pk-main)"]?.duration).toBe(tk.fast);
      expect(t["::view-transition-new(pk-main)"]?.duration).toBe(tk.base);
      expect(run.after).toBeNull();
      expect(await running(page)).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });
  }
});

// ── Reduced motion: instant swaps (D3) ────────────────────────────────────────────────────────────

describe("reduced motion: the same interactions are instant swaps", () => {
  for (const theme of THEMES) {
    it(`console: the tokens collapse, overlays open and close with nothing animating, no transition starts (${theme})`, async () => {
      const page = await openConsole(theme, "reduce");
      const tk = await tokens(page);
      expect(
        Object.values(tk).every((v) => v === 0),
        JSON.stringify(tk),
      ).toBe(true);
      await takeLog(page);

      await page
        .getByRole("button", { name: "Create license" })
        .first()
        .click();
      await page.getByRole("dialog").waitFor();
      expect(await running(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      expect(await running(page)).toEqual([]);

      await page.keyboard.press("Control+k");
      await page.getByRole("dialog").waitFor();
      expect(await running(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      expect(await running(page)).toEqual([]);

      const moved = (await takeLog(page)).filter(
        (e) => e.duration > 0 || e.delay > 0,
      );
      expect(moved, "an animation ran with a duration").toEqual([]);

      await page.getByText("Seat 01").first().waitFor();
      const list = await runViewTransition(page, {
        type: "list",
        listSelector: "main#content table tbody",
      });
      expect(list).toMatchObject({
        started: 0,
        during: null,
        pseudo: [],
        namedRows: 0,
      });
      const route = await runViewTransition(page, {
        type: "route",
        navigate: "#/p/djdl/license/tiers",
      });
      expect(route).toMatchObject({ started: 0, during: null, pseudo: [] });
      await page.locator("[data-page-title]", { hasText: "Tiers" }).waitFor();
      expect(
        await page.evaluate(() => (window as unknown as { __m: Probe }).__m.vt),
        "html[data-vt] was never set",
      ).toEqual([]);
      expect(await running(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });

    it(`portal: the JumpPalette opens and closes with nothing animating, no transition starts (${theme})`, async () => {
      const o = await portal.open("twelve", "/", { theme });
      const page = o.page;
      await page
        .getByRole("heading", { level: 1, name: "Your library" })
        .waitFor();
      await page.getByText("Glyphsmith").first().waitFor();
      await installProbe(page);
      await takeLog(page);
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Jump to a product" });
      await palette.waitFor();
      expect(await running(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "detached" });
      expect(await running(page)).toEqual([]);
      expect(
        (await takeLog(page)).filter((e) => e.duration > 0 || e.delay > 0),
      ).toEqual([]);
      const route = await runViewTransition(page, {
        type: "route",
        navigate: "#/account/appearance",
      });
      expect(route).toMatchObject({ started: 0, during: null, pseudo: [] });
      expect(await o.violations()).toEqual([]);
      await o.close();
    });
  }
});
