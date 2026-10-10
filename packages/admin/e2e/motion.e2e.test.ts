import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";
import { h1, startPortal, type PortalHarness } from "./portalHarness.js";

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
 * - the portal's own navigations (MO-05): Library → product → Library pairs the tile's art and name
 *   with the product hero (`pk-hero`, `pk-hero-title`) in a `forward` and a `back` transition;
 *   every navigation lands at the top (or its deep-linked section, or the tile Back came from)
 *   with focus on the new page's h1, once; a JumpPalette jump starts no transition over the
 *   closing palette; section links scroll smoothly only when motion is allowed;
 * - console navigation (MO-04), through real clicks and Back: a sibling page is `route`, a
 *   drill-down `forward` (the licence's name flies into the record title once the record is
 *   cached), Back `back`, a record's tab `tab` (the indicator morphs, the panel fades, the main
 *   region stays); focus lands on the new page's h1 and the live region announces it; a change of
 *   query alone starts nothing; the SegmentedControl's thumb slides with a transform-only
 *   animation on the `slow` token;
 * - a list mutation over a long list names at most LIST_BUDGET (30) rows;
 * - zero `securitypolicyviolation` events throughout;
 * - with `reducedMotion: "reduce"` the same interactions start no transition, run no animation
 *   with a duration, and leave `document.getAnimations()` empty.
 *
 * Both routers call `viewTransition()` themselves (MO-04 the console's, MO-05 the portal's), so the
 * route checks drive real navigations. The list checks still drive the layer's real source
 * (`src/ui/motion/viewTransition.ts`, bundled here by Vite) inside the page against the built
 * `motion.css`. The bundle is evaluated over the DevTools protocol, which the page's CSP does not
 * govern (as `portalHarness.axe` does); what it does in the page (data attributes, CSSOM names) is
 * still subject to it. Area packages add their own pattern here (S-23 §10).
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];
type Motion = "no-preference" | "reduce";

/** `--pk-ease-emphasized` (MO-01), as the browser resolves it: the shared element's curve. */
const EMPHASIZED = "cubic-bezier(0.05, 0.7, 0.1, 1)";

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
/** The record a drill-down opens (MO-04): the first row, with a key and a device. */
const RECORD = {
  ...LONG_LIST[0]!,
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
const ROUTES: Record<string, unknown> = {
  ...CORE_ROUTES,
  "/manage/api/products/djdl/license/licenses": { licenses: LONG_LIST },
  "/manage/api/products/djdl/license/licenses/lic_1": RECORD,
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

// ── Portal navigations (MO-05): the router's own View Transitions, observed ──────────────────────

/** What one real portal navigation did, from the click to the page at rest. */
interface NavRun {
  /** Calls to document.startViewTransition (the router's, through the motion layer). */
  started: number;
  /** Every `::view-transition-*` animation seen while it ran, with its timing and curve. */
  pseudo: { pseudo: string; duration: number; delay: number; easing: string }[];
  /** Every `focusin` while it ran, as "TAG text": the page is heard once. */
  focus: string[];
  /** The focused element at rest, as "TAG text". */
  active: string;
  scrollY: number;
  /** Elements still named through the CSSOM, and tiles still marked as a source, at rest. */
  leftNamed: number;
  leftMarked: number;
}

interface NavWatch {
  started: number;
  transitions: { finished: Promise<unknown> }[];
  seen: Map<string, { duration: number; delay: number; easing: string }>;
  focus: string[];
  polling: boolean;
  onFocus: (e: FocusEvent) => void;
}

/**
 * Watch the next navigation: wrap document.startViewTransition (the layer reads it at each call),
 * poll the pseudo-element animations every frame, and log focus. Over the DevTools protocol, so
 * the page's CSP is untouched.
 */
async function armNavigation(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Evaluated in the page: helpers must be defined inside (and no eval: the CSP forbids it).
    const describe = (el: Element | null): string =>
      el
        ? `${el.tagName} ${(el.textContent ?? "").trim().slice(0, 40)}`
        : "none";
    const w = window as unknown as { __nav?: NavWatch };
    const doc = document as unknown as {
      startViewTransition?: (...a: unknown[]) => { finished: Promise<unknown> };
    };
    const original = Document.prototype as unknown as {
      startViewTransition?: (...a: unknown[]) => { finished: Promise<unknown> };
    };
    const nav: NavWatch = {
      started: 0,
      transitions: [],
      seen: new Map(),
      focus: [],
      polling: true,
      onFocus: (e) => nav.focus.push(describe(e.target as Element)),
    };
    w.__nav = nav;
    if (original.startViewTransition)
      doc.startViewTransition = (...a: unknown[]) => {
        nav.started++;
        const t = original.startViewTransition!.apply(document, a);
        nav.transitions.push(t);
        return t;
      };
    const poll = (): void => {
      for (const a of document.getAnimations()) {
        const effect = a.effect as KeyframeEffect | null;
        const pseudo = effect?.pseudoElement;
        if (!effect || !pseudo?.startsWith("::view-transition")) continue;
        const t = effect.getTiming();
        nav.seen.set(pseudo, {
          duration: Number(t.duration),
          delay: Number(t.delay ?? 0),
          // CSS animations carry their curve on the keyframes, not the timing.
          easing: String(effect.getKeyframes()[0]?.easing ?? t.easing),
        });
      }
      if (nav.polling) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
    document.addEventListener("focusin", nav.onFocus);
  });
}

/** Wait until focus is on the `heading` h1 and every transition has finished, then report. */
async function settleNavigation(page: Page, heading: string): Promise<NavRun> {
  return page.evaluate(async (heading) => {
    const describe = (el: Element | null): string =>
      el
        ? `${el.tagName} ${(el.textContent ?? "").trim().slice(0, 40)}`
        : "none";
    const nav = (window as unknown as { __nav: NavWatch }).__nav;
    const landed = (): boolean => {
      const a = document.activeElement;
      return a?.tagName === "H1" && a.textContent?.trim() === heading;
    };
    for (let i = 0; i < 300 && !landed(); i++)
      await new Promise((r) => setTimeout(r, 16));
    for (const t of nav.transitions) await t.finished.catch(() => undefined);
    // One more frame and task, so the router's cleanup (chained on `finished`) has run.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    nav.polling = false;
    document.removeEventListener("focusin", nav.onFocus);
    delete (document as unknown as { startViewTransition?: unknown })
      .startViewTransition;
    return {
      started: nav.started,
      pseudo: [...nav.seen].map(([pseudo, t]) => ({ pseudo, ...t })),
      focus: nav.focus,
      active: describe(document.activeElement),
      scrollY: window.scrollY,
      leftNamed: [...document.querySelectorAll<HTMLElement>("*")].filter(
        (el) => el.style.getPropertyValue("view-transition-name") !== "",
      ).length,
      leftMarked: document.querySelectorAll("[data-vt-source]").length,
    };
  }, heading);
}

/** The run's pseudo-element animations by name. */
const byPseudo = (
  run: NavRun,
): Record<string, NavRun["pseudo"][number] | undefined> =>
  Object.fromEntries(run.pseudo.map((p) => [p.pseudo, p]));

/** Click a product section link the way a user does, and read the scroll in the same task. */
async function clickSectionLink(
  page: Page,
  section: string,
): Promise<{ before: number; sync: number; target: number }> {
  return page.evaluate((section) => {
    const link = document.querySelector<HTMLAnchorElement>(
      `nav[aria-label="On this page"] a[href$="/${section}"]`,
    )!;
    const before = window.scrollY;
    link.click();
    const el = document.getElementById(`section-${section}`)!;
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    // The page's scroll padding: the sticky header (and, below desk, the section pills).
    const padding =
      parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) ||
      0;
    // Where the section lands: its top at the scroll padding plus its margin (or the page's end).
    const target = Math.min(
      window.scrollY + el.getBoundingClientRect().top - padding - margin,
      document.documentElement.scrollHeight - window.innerHeight,
    );
    return { before, sync: window.scrollY, target };
  }, section);
}

// ── The console's own transitions (MO-04: the router starts them) ─────────────────────────────────

/** One View Transition the page started, as the watcher saw it. */
interface Started {
  /** `html[data-vt]` when it started. */
  type: string | null;
  /** Every `::view-transition-*` animation seen while it ran: name and resolved timing. */
  pseudo: Record<string, { name: string; duration: number; delay: number }>;
  done: boolean;
}

/**
 * Wrap `document.startViewTransition` so every transition the page itself starts is recorded with
 * the pseudo-element animations it ran (polled each frame until `finished`). Installed over the
 * DevTools protocol, like the probe; the page's own code calls it.
 */
async function watchTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __vt?: Started[] };
    if (w.__vt) return;
    w.__vt = [];
    const doc = document as unknown as {
      startViewTransition?: (update: () => void) => ViewTransition;
    };
    const original = doc.startViewTransition?.bind(document);
    if (!original) return;
    doc.startViewTransition = (update: () => void) => {
      const run: Started = {
        type: document.documentElement.getAttribute("data-vt"),
        pseudo: {},
        done: false,
      };
      w.__vt!.push(run);
      const t = original(update);
      let polling = true;
      const poll = (): void => {
        for (const a of document.getAnimations()) {
          const effect = a.effect as KeyframeEffect | null;
          const pseudo = effect?.pseudoElement;
          if (!pseudo?.startsWith("::view-transition")) continue;
          const timing = effect!.getTiming();
          run.pseudo[pseudo] = {
            name: (a as CSSAnimation).animationName ?? "",
            duration: Number(timing.duration),
            delay: Number(timing.delay ?? 0),
          };
        }
        if (polling) requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
      void t.finished.finally(() => {
        polling = false;
        run.done = true;
      });
      return t;
    };
  });
}

/** Run `action`, wait until every transition it started has finished, and return them. */
async function transitionsOf(
  page: Page,
  action: () => Promise<unknown>,
): Promise<Started[]> {
  await page.evaluate(() => {
    (window as unknown as { __vt: Started[] }).__vt.length = 0;
  });
  await action();
  // A navigation's transition starts on the hashchange, a task after the click.
  await page.waitForTimeout(100);
  await page.waitForFunction(() =>
    (window as unknown as { __vt: Started[] }).__vt.every((r) => r.done),
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  return page.evaluate(() =>
    (window as unknown as { __vt: Started[] }).__vt.splice(0),
  );
}

/**
 * The page's h1 (`heading`) has focus, and the live region announced the page by its title
 * (`announced`: a record is announced by noun and id, "License lic_1") (ADMIN.md §5.6).
 */
async function focusedHeading(
  page: Page,
  heading: string,
  announced = heading,
): Promise<void> {
  await page.waitForFunction(
    (n) =>
      document.activeElement?.tagName === "H1" &&
      document.activeElement.textContent?.trim() === n,
    heading,
  );
  expect(
    await page.locator("#route-announcer").textContent(),
    "the live region announces the page",
  ).toBe(`${announced}, page loaded`);
}

/**
 * The `view-transition-name`s that took part (from the pseudo-elements seen): a portal navigation
 * (MO-05) or a console transition (MO-04).
 */
const groupNames = (run: NavRun | Started): string[] =>
  [
    ...new Set(
      (Array.isArray(run.pseudo)
        ? run.pseudo.map((p) => p.pseudo)
        : Object.keys(run.pseudo)
      ).map((p) => p.replace(/^.*\((.*)\)$/, "$1")),
    ),
  ].sort();

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
      await watchTransitions(page);
      await atRest(page);
      // A real navigation (MO-04): the sidebar's Tiers, a sibling of Licenses.
      const [run, ...more] = await transitionsOf(page, () =>
        page
          .getByRole("navigation", { name: "Console" })
          .first()
          .getByRole("link", { name: "Tiers" })
          .click(),
      );
      expect(more, "one navigation, one transition").toEqual([]);
      expect(run!.type).toBe("route");
      expect(run!.pseudo["::view-transition-old(pk-main)"]).toEqual({
        name: "pk-fade-out",
        duration: tk.fast,
        delay: 0,
      });
      expect(run!.pseudo["::view-transition-new(pk-main)"]).toEqual({
        name: "pk-fade-in",
        duration: tk.base,
        delay: tk.micro,
      });
      // The chrome (top bar, sidebar, switcher) is never named: only the main region moves.
      expect(groupNames(run!)).toEqual(["pk-main"]);
      expect(
        await page.evaluate(() => (window as unknown as { __m: Probe }).__m.vt),
      ).toEqual(["route", null]);
      await focusedHeading(page, "Tiers");
      expect(await running(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });

    it(`console navigation: forward into a record, its tabs, Back, and the name as a shared element (${theme})`, async () => {
      const page = await openConsole(theme, "no-preference");
      const tk = await tokens(page);
      await page.getByText("Seat 01").first().waitFor();
      await watchTransitions(page);
      await atRest(page);
      const row = (): Locator =>
        page.locator("main#content table tbody a", { hasText: "Seat 01" });
      const tabs = (): Locator =>
        page.getByRole("navigation", { name: "License sections" });

      // A drill-down: forward. The main region slides on the tokens (md out, lg in). The record
      // is not cached yet, so the name's other end is not on the new page: it leaves with the list.
      const [forward, ...f2] = await transitionsOf(page, () =>
        row().first().click(),
      );
      expect(f2).toEqual([]);
      expect(forward!.type).toBe("forward");
      expect(forward!.pseudo["::view-transition-old(pk-main)"]).toEqual({
        name: "pk-vt-out-start",
        duration: tk.fast,
        delay: 0,
      });
      expect(forward!.pseudo["::view-transition-new(pk-main)"]).toEqual({
        name: "pk-vt-in-end",
        duration: tk.base,
        delay: tk.micro,
      });
      expect(groupNames(forward!)).toContain("pk-main");
      await focusedHeading(page, "Seat 01", "License lic_1");
      expect(await running(page)).toEqual([]);

      // A record tab: the indicator slides (slow), the panel fades through, the main region and
      // the header stay where they are. Focus stays on the tab (the page is the same).
      const [tab, ...t2] = await transitionsOf(page, () =>
        tabs()
          .getByRole("link", { name: /^Devices/ })
          .click(),
      );
      expect(t2).toEqual([]);
      expect(tab!.type).toBe("tab");
      expect(groupNames(tab!)).toEqual(["pk-indicator", "pk-tabpanel"]);
      expect(
        tab!.pseudo["::view-transition-group(pk-indicator)"],
      ).toMatchObject({ duration: tk.slow });
      expect(tab!.pseudo["::view-transition-old(pk-tabpanel)"]).toEqual({
        name: "pk-fade-out",
        duration: tk.fast,
        delay: 0,
      });
      expect(tab!.pseudo["::view-transition-new(pk-tabpanel)"]).toEqual({
        name: "pk-fade-in",
        duration: tk.base,
        delay: tk.micro,
      });
      expect(
        await tabs()
          .getByRole("link", { name: /^Devices/ })
          .evaluate((a) => a === document.activeElement),
      ).toBe(true);
      expect(await page.locator(".pk-vt-indicator").count()).toBe(1);

      // Back across the tab is still a tab; Back out of the record is back.
      const [tabBack] = await transitionsOf(page, () => page.goBack());
      expect(tabBack!.type).toBe("tab");
      const [back, ...b2] = await transitionsOf(page, () => page.goBack());
      expect(b2).toEqual([]);
      expect(back!.type).toBe("back");
      expect(back!.pseudo["::view-transition-old(pk-main)"]?.name).toBe(
        "pk-vt-out-end",
      );
      expect(back!.pseudo["::view-transition-new(pk-main)"]?.name).toBe(
        "pk-vt-in-start",
      );
      await focusedHeading(page, "Licenses");

      // The record is cached now: the name flies from its row into the record's title.
      const [again] = await transitionsOf(page, () => row().first().click());
      expect(again!.type).toBe("forward");
      expect(groupNames(again!)).toEqual(["pk-key", "pk-main"]);
      expect(Object.keys(again!.pseudo)).toEqual(
        expect.arrayContaining([
          "::view-transition-old(pk-key)",
          "::view-transition-new(pk-key)",
        ]),
      );
      expect(again!.pseudo["::view-transition-group(pk-key)"]).toMatchObject({
        duration: tk.slow,
      });
      await focusedHeading(page, "Seat 01", "License lic_1");
      // The one-shot name is gone from the row once the transition is over.
      await page.goBack();
      await row().first().waitFor();
      await atRest(page);
      expect(
        await row()
          .first()
          .locator("[data-vt-shared]")
          .evaluate((el) => (el as HTMLElement).style.cssText),
      ).toBe("");

      // A change of query alone is not a page change: the router starts nothing.
      const query = await transitionsOf(page, () =>
        page.evaluate(() => {
          location.hash = "#/p/djdl/license/licenses?q=Seat";
        }),
      );
      expect(query.filter((r) => r.type !== "list")).toEqual([]);

      // A navigation from an overlay (the Cmd-K palette) swaps the page under the palette's exit:
      // a transition's snapshots would paint over the closing palette (S-23 §3.4).
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.waitFor();
      await atRest(page);
      await page.keyboard.type("Tiers");
      const fromPalette = await transitionsOf(page, async () => {
        await page.keyboard.press("Enter");
        await palette.waitFor({ state: "detached" });
      });
      expect(fromPalette).toEqual([]);
      await focusedHeading(page, "Tiers");
      await atRest(page);

      expect(await running(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });

    it(`the SegmentedControl's thumb slides with a transform-only animation on the slow token (${theme})`, async () => {
      const page = await openConsole(
        theme,
        "no-preference",
        "#/p/djdl/activity",
      );
      const tk = await tokens(page);
      await watchTransitions(page);
      const group = page.getByRole("radiogroup", { name: "View" });
      await group.waitFor();
      await atRest(page);
      await page.evaluate(() => {
        (window as unknown as { __vt: Started[] }).__vt.length = 0;
      });
      await group.getByRole("radio", { name: "Table" }).click();
      const anims = await page.evaluate(() =>
        document.getAnimations().map((a) => {
          const effect = a.effect as KeyframeEffect;
          return {
            target: (effect.target as Element).hasAttribute(
              "data-segmented-thumb",
            ),
            duration: Number(effect.getTiming().duration),
            properties: [
              ...new Set(
                effect
                  .getKeyframes()
                  .flatMap((k) =>
                    Object.keys(k).filter(
                      (p) =>
                        ![
                          "offset",
                          "easing",
                          "composite",
                          "computedOffset",
                        ].includes(p),
                    ),
                  ),
              ),
            ],
          };
        }),
      );
      // One transform-only slide of the thumb; besides it, only the labels' colours ease.
      expect(anims.filter((a) => a.target)).toEqual([
        { target: true, duration: tk.slow, properties: ["transform"] },
      ]);
      expect(anims.filter((a) => !a.target)).toEqual(
        anims
          .filter((a) => !a.target)
          .map(() => ({
            target: false,
            duration: tk.fast,
            properties: ["color"],
          })),
      );
      expect(await group.getAttribute("data-moving")).toBe("");
      await atRest(page);
      expect(await group.getAttribute("data-moving")).toBeNull();
      expect(
        await group
          .getByRole("radio", { name: "Table" })
          .getAttribute("data-state"),
      ).toBe("checked");
      // The view lives in the query: no View Transition.
      expect(
        await page.evaluate(
          () => (window as unknown as { __vt: Started[] }).__vt.length,
        ),
      ).toBe(0);
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

    it(`Library → product → Library: the tile's art and name fly into the hero and back; scroll and focus land (${theme})`, async () => {
      const o = await portal.open("three", "/", {
        theme,
        reducedMotion: "no-preference",
        height: 720,
      });
      const page = o.page;
      await h1(page, "Your library");
      // The tile's art has loaded (the media proxy answers the fixtures' art).
      await page
        .locator(
          "article[aria-labelledby='tile-nightfall'] > [data-art='image'] img:not([data-blur])",
        )
        .waitFor();
      await installProbe(page);
      const tk = await tokens(page);
      await atRest(page);
      // Scrolled a little, the tile still on screen: the product must open at the top.
      await page.evaluate(() => window.scrollTo(0, 120));

      await armNavigation(page);
      await page
        .getByRole("article", { name: "Nightfall" })
        .getByRole("link", { name: "Nightfall", exact: true })
        .click();
      const fwd = await settleNavigation(page, "Nightfall");
      expect(fwd.started, "one View Transition").toBe(1);
      const f = byPseudo(fwd);
      // The UA animates a group only when it has an old and a new end: these are the pairs.
      expect(f["::view-transition-group(pk-hero)"]).toMatchObject({
        duration: tk.slow,
        easing: EMPHASIZED,
      });
      expect(f["::view-transition-group(pk-hero-title)"]).toMatchObject({
        duration: tk.slow,
        easing: EMPHASIZED,
      });
      // The icon in front of the art's lower edge flies with it (or the art would cover it).
      expect(f["::view-transition-group(pk-hero-icon)"]).toMatchObject({
        duration: tk.slow,
        easing: EMPHASIZED,
      });
      // The main region slides forward: out at `fast`, in at `base` after `micro`.
      expect(f["::view-transition-old(pk-main)"]).toMatchObject({
        duration: tk.fast,
        delay: 0,
      });
      expect(f["::view-transition-new(pk-main)"]).toMatchObject({
        duration: tk.base,
        delay: tk.micro,
      });
      // The chrome is never named.
      expect(groupNames(fwd)).toEqual([
        "pk-hero",
        "pk-hero-icon",
        "pk-hero-title",
        "pk-main",
      ]);
      expect(fwd.scrollY, "the product opens at the top").toBe(0);
      expect(fwd.active).toBe("H1 Nightfall");
      expect(
        fwd.focus.filter((f) => f.startsWith("H1")),
        "the heading takes focus once",
      ).toEqual(["H1 Nightfall"]);
      expect(fwd.leftNamed, "the one-shot names are gone").toBe(0);
      expect(fwd.leftMarked, "the source mark is gone").toBe(0);
      expect(await running(page)).toEqual([]);

      await atRest(page);
      await armNavigation(page);
      await page
        .getByRole("main")
        .getByRole("link", { name: "Library", exact: true })
        .click();
      const back = await settleNavigation(page, "Your library");
      expect(back.started).toBe(1);
      const b = byPseudo(back);
      expect(b["::view-transition-group(pk-hero)"]).toMatchObject({
        duration: tk.slow,
      });
      expect(b["::view-transition-group(pk-hero-title)"]).toMatchObject({
        duration: tk.slow,
      });
      expect(b["::view-transition-group(pk-hero-icon)"]).toMatchObject({
        duration: tk.slow,
      });
      expect(b["::view-transition-new(pk-main)"]).toMatchObject({
        duration: tk.base,
        delay: tk.micro,
      });
      expect(groupNames(back)).toEqual([
        "pk-hero",
        "pk-hero-icon",
        "pk-hero-title",
        "pk-main",
      ]);
      expect(
        await page.evaluate(() => (window as unknown as { __m: Probe }).__m.vt),
      ).toEqual(["forward", null, "back", null]);
      // Back lands where the morph lands: the tile it came from, on screen.
      const tile = await page.evaluate(() => {
        const r = document
          .querySelector("article[aria-labelledby='tile-nightfall']")!
          .getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });
      expect(tile.top).toBeGreaterThanOrEqual(0);
      expect(tile.bottom).toBeLessThanOrEqual(tile.vh);
      expect(back.active).toBe("H1 Your library");
      expect(back.focus.filter((f) => f.startsWith("H1"))).toEqual([
        "H1 Your library",
      ]);
      expect(back.leftNamed).toBe(0);
      expect(back.leftMarked).toBe(0);
      expect(await running(page)).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`a route between top-level pages fades the main region through; a deep link lands on its section (${theme})`, async () => {
      const o = await portal.open("three", "/", {
        theme,
        reducedMotion: "no-preference",
      });
      const page = o.page;
      await h1(page, "Your library");
      await installProbe(page);
      const tk = await tokens(page);
      await atRest(page);
      await page.evaluate(() => window.scrollTo(0, 200));

      await armNavigation(page);
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: /^Discover/ })
        .click();
      const run = await settleNavigation(page, "Discover");
      expect(run.started).toBe(1);
      const t = byPseudo(run);
      expect(t["::view-transition-old(pk-main)"]).toMatchObject({
        duration: tk.fast,
        delay: 0,
      });
      expect(t["::view-transition-new(pk-main)"]).toMatchObject({
        duration: tk.base,
        delay: tk.micro,
      });
      // A sibling page: only the main region moves; nothing flies.
      expect(groupNames(run)).toEqual(["pk-main"]);
      expect(run.scrollY).toBe(0);
      expect(run.active).toBe("H1 Discover");
      expect(run.focus.filter((f) => f.startsWith("H1"))).toEqual([
        "H1 Discover",
      ]);
      expect(
        await page.evaluate(() => (window as unknown as { __m: Probe }).__m.vt),
      ).toEqual(["route", null]);

      // A deep link into a section: the page opens there, the heading still takes focus.
      await atRest(page);
      await armNavigation(page);
      await page.evaluate(() => {
        window.location.hash = "#/account/appearance";
      });
      const deep = await settleNavigation(page, "Account");
      expect(deep.started).toBe(1);
      const section = await page.evaluate(() => {
        const r = document
          .getElementById("section-appearance")!
          .getBoundingClientRect();
        return { top: r.top, vh: window.innerHeight };
      });
      expect(section.top).toBeGreaterThanOrEqual(0);
      expect(section.top).toBeLessThan(section.vh);
      expect(deep.scrollY, "scrolled to the section").toBeGreaterThan(0);
      expect(deep.active).toBe("H1 Account");
      expect(await running(page)).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`a jump from the JumpPalette swaps the page under the closing palette: no View Transition over its scrim (${theme})`, async () => {
      const o = await portal.open("twelve", "/", {
        theme,
        reducedMotion: "no-preference",
      });
      const page = o.page;
      await h1(page, "Your library");
      await page.getByText("Glyphsmith").first().waitFor();
      await installProbe(page);
      const tk = await tokens(page);
      await atRest(page);
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Jump to a product" });
      await palette.waitFor();
      await atRest(page);
      await takeLog(page);
      // Typing filters the results; nothing animates while typing.
      await page.keyboard.type("glyph");
      expect(await running(page), "typing animated the results").toEqual([]);
      expect(
        (await takeLog(page)).filter((e) => e.duration > 0),
        "typing started an animation",
      ).toEqual([]);

      await armNavigation(page);
      await page.keyboard.press("Enter");
      const run = await settleNavigation(page, "Glyphsmith");
      await palette.waitFor({ state: "detached" });
      await atRest(page);
      // The palette left through its exit, on its token, while the page swapped beneath it.
      expect(
        pick(await takeLog(page), "end", (e) => e.role === "dialog").map(
          (e) => [e.name, e.duration, e.connected],
        ),
      ).toEqual([["pk-exit", tk.base, true]]);
      expect(
        run.started,
        "no View Transition while a dialog is on screen",
      ).toBe(0);
      expect(run.pseudo).toEqual([]);
      expect(run.active, "focus on the product's heading, after the exit").toBe(
        "H1 Glyphsmith",
      );
      expect(run.scrollY).toBe(0);
      expect(await running(page)).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`a link in the account menu swaps the page under the closing menu; focus lands after it leaves (${theme})`, async () => {
      const o = await portal.open("three", "/", {
        theme,
        reducedMotion: "no-preference",
      });
      const page = o.page;
      await h1(page, "Your library");
      await installProbe(page);
      const tk = await tokens(page);
      await atRest(page);
      await page.getByRole("button", { name: /^Account: / }).click();
      const menu = page.getByRole("menu");
      await menu.waitFor();
      await atRest(page);
      await takeLog(page);
      await armNavigation(page);
      await menu.getByRole("menuitem", { name: "Sign-in methods" }).click();
      const run = await settleNavigation(page, "Account");
      await menu.waitFor({ state: "detached" });
      await atRest(page);
      expect(
        pick(await takeLog(page), "end", (e) => e.role === "menu").map((e) => [
          e.name,
          e.duration,
          e.connected,
        ]),
        "the menu left through its exit",
      ).toEqual([["pk-fade-out", tk.fast, true]]);
      expect(run.started, "no View Transition over the closing menu").toBe(0);
      // The menu hands focus back to its trigger as it leaves; the heading takes it after that.
      expect(run.active).toBe("H1 Account");
      expect(await running(page)).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`a section link scrolls smoothly when motion is allowed (${theme})`, async () => {
      const o = await portal.open("three", "/#/p/nightfall", {
        theme,
        reducedMotion: "no-preference",
      });
      const page = o.page;
      await h1(page, "Nightfall");
      await page.locator("#section-help").waitFor();
      const s = await clickSectionLink(page, "help");
      expect(s.target, "the section is below the fold").toBeGreaterThan(0);
      expect(s.sync, "smooth: nothing has moved yet in the click's task").toBe(
        s.before,
      );
      await expect
        .poll(() => page.evaluate(() => window.scrollY))
        .toBeGreaterThan(s.before);
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
      // A real navigation (MO-04): the router starts no transition; focus still moves.
      await watchTransitions(page);
      const route = await transitionsOf(page, () =>
        page
          .getByRole("navigation", { name: "Console" })
          .first()
          .getByRole("link", { name: "Tiers" })
          .click(),
      );
      expect(route).toEqual([]);
      await focusedHeading(page, "Tiers");
      expect(
        await page.evaluate(() => (window as unknown as { __m: Probe }).__m.vt),
        "html[data-vt] was never set",
      ).toEqual([]);
      expect(await running(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });

    it(`console navigation: drill-down, tabs, Back and the SegmentedControl are instant swaps (${theme})`, async () => {
      const page = await openConsole(theme, "reduce");
      await page.getByText("Seat 01").first().waitFor();
      await watchTransitions(page);
      await takeLog(page);
      const none = async (
        what: string,
        action: () => Promise<unknown>,
      ): Promise<void> => {
        expect(
          await transitionsOf(page, action),
          `${what}: a transition`,
        ).toEqual([]);
        expect(await running(page), `${what}: still animating`).toEqual([]);
      };
      await none("drill-down", () =>
        page
          .locator("main#content table tbody a", { hasText: "Seat 01" })
          .first()
          .click(),
      );
      await focusedHeading(page, "Seat 01", "License lic_1");
      await none("tab", () =>
        page
          .getByRole("navigation", { name: "License sections" })
          .getByRole("link", { name: /^Devices/ })
          .click(),
      );
      await none("Back across the tab", () => page.goBack());
      await none("Back", () => page.goBack());
      await focusedHeading(page, "Licenses");
      expect(
        await transitionsOf(page, () =>
          page.evaluate(() => {
            location.hash = "#/p/djdl/activity";
          }),
        ),
        "sibling: a transition",
      ).toEqual([]);
      const group = page.getByRole("radiogroup", { name: "View" });
      await group.waitFor();
      // The lazy section's skeleton keeps its 150 ms grace under reduced motion (a delay, not
      // motion: S-23 §6.6), so let the page settle before the next interaction.
      await atRest(page);
      await takeLog(page);
      await group.getByRole("radio", { name: "Table" }).click();
      expect(await running(page), "the thumb animated").toEqual([]);
      expect(await group.getAttribute("data-moving")).toBeNull();
      expect(
        (await takeLog(page)).filter((e) => e.duration > 0 || e.delay > 0),
        "an animation ran with a duration",
      ).toEqual([]);
      expect(
        await page.evaluate(() => (window as unknown as { __m: Probe }).__m.vt),
        "html[data-vt] was never set",
      ).toEqual([]);
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
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`portal: navigations are instant swaps: no transition starts, nothing animates, scroll and focus still land (${theme})`, async () => {
      const o = await portal.open("three", "/", { theme, height: 720 });
      const page = o.page;
      await h1(page, "Your library");
      await installProbe(page);
      await takeLog(page);
      await page.evaluate(() => window.scrollTo(0, 120));
      const steps: Array<[string, () => Promise<void>]> = [
        [
          "Nightfall",
          () =>
            page
              .getByRole("article", { name: "Nightfall" })
              .getByRole("link", { name: "Nightfall", exact: true })
              .click(),
        ],
        [
          "Your library",
          () =>
            page
              .getByRole("main")
              .getByRole("link", { name: "Library", exact: true })
              .click(),
        ],
        [
          "Discover",
          () =>
            page
              .getByRole("navigation", { name: "Main" })
              .getByRole("link", { name: /^Discover/ })
              .click(),
        ],
      ];
      for (const [heading, act] of steps) {
        await armNavigation(page);
        await act();
        const run = await settleNavigation(page, heading);
        expect(run, heading).toMatchObject({
          started: 0,
          pseudo: [],
          active: `H1 ${heading}`,
          leftNamed: 0,
          leftMarked: 0,
        });
        expect(
          run.focus.filter((f) => f.startsWith("H1")),
          heading,
        ).toEqual([`H1 ${heading}`]);
        expect(await running(page), heading).toEqual([]);
      }
      expect(
        (await takeLog(page)).filter((e) => e.duration > 0 || e.delay > 0),
        "an animation ran with a duration",
      ).toEqual([]);
      expect(
        await page.evaluate(() => (window as unknown as { __m: Probe }).__m.vt),
        "html[data-vt] was never set",
      ).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`portal: html[data-motion="reduce"] (the in-app preference) makes the same navigations instant swaps (${theme})`, async () => {
      const o = await portal.open("three", "/", {
        theme,
        reducedMotion: "no-preference",
      });
      const page = o.page;
      await h1(page, "Your library");
      await page.evaluate(() => {
        document.documentElement.dataset.motion = "reduce";
      });
      await installProbe(page);
      await atRest(page);
      await takeLog(page);
      await armNavigation(page);
      await page
        .getByRole("article", { name: "Nightfall" })
        .getByRole("link", { name: "Nightfall", exact: true })
        .click();
      const fwd = await settleNavigation(page, "Nightfall");
      await armNavigation(page);
      await page.goBack();
      const back = await settleNavigation(page, "Your library");
      for (const run of [fwd, back])
        expect(run).toMatchObject({ started: 0, pseudo: [], leftNamed: 0 });
      expect(await running(page)).toEqual([]);
      expect(
        (await takeLog(page)).filter((e) => e.duration > 0 || e.delay > 0),
      ).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`portal: Back lands on the tile it came from, motion or not (${theme})`, async () => {
      const o = await portal.open("twelve", "/", { theme, height: 720 });
      const page = o.page;
      await h1(page, "Your library");
      await page.getByText("Glyphsmith").first().waitFor();
      // A tile below the fold.
      const tile = page.locator("main article").last();
      const name = (await tile.locator("h3").textContent())!.trim();
      await tile.scrollIntoViewIfNeeded();
      await armNavigation(page);
      await tile.getByRole("link", { name, exact: true }).click();
      const fwd = await settleNavigation(page, name);
      expect(fwd).toMatchObject({ started: 0, scrollY: 0 });
      await armNavigation(page);
      await page
        .getByRole("main")
        .getByRole("link", { name: "Library", exact: true })
        .click();
      const back = await settleNavigation(page, "Your library");
      expect(back.started).toBe(0);
      expect(back.scrollY, "scrolled down to the tile").toBeGreaterThan(0);
      const box = await page.evaluate((name) => {
        const article = [...document.querySelectorAll("main article")].find(
          (a) => a.querySelector("h3")?.textContent?.trim() === name,
        )!;
        const r = article.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      }, name);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(box.vh);
      expect(back.active).toBe("H1 Your library");
      expect(await running(page)).toEqual([]);
      expect(await o.violations()).toEqual([]);
      await o.close();
    });

    it(`portal: a section link scrolls instantly (${theme})`, async () => {
      const o = await portal.open("three", "/#/p/nightfall", { theme });
      const page = o.page;
      await h1(page, "Nightfall");
      await page.locator("#section-help").waitFor();
      const s = await clickSectionLink(page, "help");
      expect(s.target).toBeGreaterThan(0);
      expect(s.sync, "instant: already there in the click's task").toBe(
        s.target,
      );
      expect(await o.violations()).toEqual([]);
      await o.close();
    });
  }
});
