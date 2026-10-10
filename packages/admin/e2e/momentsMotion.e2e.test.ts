import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";

/**
 * The console's moments and counters in motion (EXPERIENCE.md §0.7; notes/S-23 §6.1, §6.4; MO-11),
 * in the BUILT console under the Worker's exact CSP:
 *
 *   - Overview's first load: the Needs attention items rise in one after another (`pk-enter`,
 *     30 ms apart on the stagger token), and the first release's banner draws its check and bursts
 *     six sparks once; the sparks leave the DOM when their animations end, the moment is stored,
 *     and a reload shows no banner and no burst; the page then comes to rest;
 *   - Keys: the trust window's ring runs ONE `pk-draw` animation over the whole window (300 s),
 *     started where the window stands (about 60 s in), aria-hidden, with the seconds in text;
 *   - Keys: the refreshed share fills its meter by a transform transition on the tokens and its
 *     percentage counts up to the value;
 *   - with prefers-reduced-motion, and with html[data-motion="reduce"] (MO-12), every one of these
 *     reaches the same end state at once: no animation starts, no View Transition starts, and
 *     `document.getAnimations()` is empty after each interaction; the ring shows the spent share as
 *     a still picture;
 *   - zero `securitypolicyviolation` events throughout.
 *
 * Kept apart from e2e/motion.e2e.test.ts (as the other area suites are) so packages built in
 * parallel do not collide in one file.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const KEYS = CORE_ROUTES["/manage/api/products/djdl/keys"] as {
  now: number;
  keys: { status: string }[];
};

/** Keys after a rotation: no staged key, the refreshed share of the new one. */
const REFRESHED_KEYS = {
  now: NOW,
  keys: KEYS.keys.filter((k) => k.status !== "staged"),
  refresh: {
    kid: "djdl-2026-a1",
    activatedAt: NOW - 3 * DAY,
    activeDevices: 1310,
    refreshedDevices: 1204,
    windowDays: 30,
  },
};

let server: PreviewServer;
let browser: Browser;
let base: string;

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
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
});

type Motion = "no-preference" | "reduce";

interface AnimStart {
  name: string;
  tag: string;
  /** The element's parent carries `.pk-stagger` (a staggered list item). */
  staggered: boolean;
  delay: number;
  duration: number;
}

interface Probe {
  starts: AnimStart[];
  /** Every CSS transition that started: the property and the element's classes. */
  transitions: { property: string; cls: string; duration: number }[];
  vt: number;
  v: string[];
}

/**
 * Record every CSS animation start (with its resolved timing), every View Transition the app
 * starts and every CSP violation, from before the app's first script (an init script over the
 * DevTools protocol, which the page's CSP does not govern).
 */
function probeScript([theme, dataMotion]: readonly [string, boolean]): void {
  window.localStorage.setItem("pk-admin-theme", theme);
  const w = window as unknown as { __p: Probe };
  w.__p = { starts: [], transitions: [], vt: 0, v: [] };
  document.addEventListener(
    "transitionrun",
    (e) => {
      const ev = e as TransitionEvent;
      if (ev.pseudoElement) return;
      const el = ev.target as Element;
      const t = el
        .getAnimations()
        .find(
          (a) => (a as CSSTransition).transitionProperty === ev.propertyName,
        )
        ?.effect?.getTiming();
      w.__p.transitions.push({
        property: ev.propertyName,
        cls: typeof el.className === "string" ? el.className : "",
        duration: Number(t?.duration ?? -1),
      });
    },
    true,
  );
  document.addEventListener("securitypolicyviolation", (e) =>
    w.__p.v.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`),
  );
  document.addEventListener(
    "animationstart",
    (e) => {
      const ev = e as AnimationEvent;
      if (ev.pseudoElement) return;
      const el = ev.target as Element;
      const anim = el
        .getAnimations()
        .find((a) => (a as CSSAnimation).animationName === ev.animationName) as
        | CSSAnimation
        | undefined;
      const t = anim?.effect?.getTiming();
      w.__p.starts.push({
        name: ev.animationName,
        tag: el.tagName.toLowerCase(),
        staggered: el.parentElement?.classList.contains("pk-stagger") ?? false,
        delay: Number(t?.delay ?? -1),
        duration: Number(t?.duration ?? -1),
      });
    },
    true,
  );
  const start = document.startViewTransition?.bind(document);
  if (start)
    document.startViewTransition = ((...a: unknown[]) => {
      w.__p.vt++;
      return (start as (...x: unknown[]) => ViewTransition)(...a);
    }) as typeof document.startViewTransition;
  if (dataMotion)
    document.addEventListener("readystatechange", () =>
      document.documentElement.setAttribute("data-motion", "reduce"),
    );
}

async function open(
  hash: string,
  opts: {
    motion?: Motion;
    dataMotion?: boolean;
    routes?: Record<string, unknown>;
  } = {},
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: opts.motion ?? "no-preference",
  });
  await ctx.addInitScript(probeScript, [
    "dark",
    opts.dataMotion ?? false,
  ] as const);
  const routes = { ...CORE_ROUTES, ...opts.routes };
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
  if (opts.dataMotion)
    await page.waitForFunction(
      () => document.documentElement.dataset.motion === "reduce",
    );
  return page;
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => (window as unknown as { __p: Probe }).__p);

/**
 * Animations that MOVE: an instant swap still fires `animationstart` for its 0 ms animation. The
 * spinner is not exempt: under reduced motion it is a still ring, like every loading indicator.
 */
const moving = (p: Probe): AnimStart[] =>
  p.starts.filter((s) => s.duration > 0 || s.delay > 0);

async function atRest(page: Page, timeout = 4000): Promise<void> {
  await page
    .waitForFunction(() => document.getAnimations().length === 0, null, {
      timeout,
    })
    .catch(() => undefined);
}

const runningAnimations = (page: Page): Promise<number> =>
  page.evaluate(() => document.getAnimations().length);

/** The resolved stagger step in ms (0 under reduced motion). */
const staggerStep = (page: Page): Promise<number> =>
  page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--pk-stagger-step",
      ),
    ),
  );

const RELEASE_TITLE = "2.4.0 is live on stable";
const REDUCED: { label: string; motion: Motion; dataMotion: boolean }[] = [
  { label: "prefers-reduced-motion", motion: "reduce", dataMotion: false },
  {
    label: 'html[data-motion="reduce"]',
    motion: "no-preference",
    dataMotion: true,
  },
];

describe("Overview: the first load staggers the attention list and the first release bursts once", () => {
  it("motion on: items rise 30 ms apart, six sparks burst and leave, the moment is stored", async () => {
    const page = await open("#/p/djdl");
    await page.getByText(RELEASE_TITLE).waitFor();
    const list = page
      .getByRole("region", { name: "Needs attention" })
      .getByRole("list");
    await list.waitFor();
    // The burst leaves the DOM when its animations end (never on a timer).
    await page.waitForFunction(
      () => document.querySelector(".pk-burst") === null,
    );
    await atRest(page);
    const p = await probe(page);
    const step = await staggerStep(page);
    expect(step).toBe(30);
    const items = p.starts.filter((s) => s.staggered && s.name === "pk-enter");
    const count = await list.getByRole("listitem").count();
    expect(count).toBeGreaterThanOrEqual(2);
    expect(items.map((s) => s.delay)).toEqual(
      Array.from({ length: count }, (_, i) => Math.min(i, 6) * step),
    );
    // Six sparks and one check draw, on the tokens.
    const sparks = p.starts.filter((s) => s.name === "pk-burst");
    expect(sparks).toHaveLength(6);
    expect(new Set(sparks.map((s) => s.duration))).toEqual(new Set([480]));
    expect(p.starts.some((s) => s.name === "pk-draw" && s.tag === "path")).toBe(
      true,
    );
    // The class leaves once the items have landed; the page is at rest.
    expect(await list.getAttribute("class")).not.toMatch(/\bpk-stagger\b/);
    expect(await runningAnimations(page)).toBe(0);
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("pk-moment:first-release:djdl"),
      ),
    ).not.toBeNull();
    // A reload is a new document: the moment is stored, so no banner and no burst.
    await page.reload();
    await page
      .getByRole("region", { name: "Needs attention" })
      .getByRole("list")
      .waitFor();
    await atRest(page);
    expect(await page.getByText(RELEASE_TITLE).count()).toBe(0);
    const again = await probe(page);
    expect(again.starts.filter((s) => s.name === "pk-burst")).toEqual([]);
    expect(again.v).toEqual([]);
    expect(p.v).toEqual([]);
    await page.context().close();
  });

  for (const r of REDUCED)
    it(`${r.label}: the same banner and items at once, nothing animates, no View Transition`, async () => {
      const page = await open("#/p/djdl", {
        motion: r.motion,
        dataMotion: r.dataMotion,
      });
      await page.getByText(RELEASE_TITLE).waitFor();
      const list = page
        .getByRole("region", { name: "Needs attention" })
        .getByRole("list");
      await list.waitFor();
      expect(await staggerStep(page)).toBe(0);
      const banner = page.locator('[data-moment="first-release:djdl"]');
      expect(await banner.locator(".pk-celebration[data-static]").count()).toBe(
        1,
      );
      expect(await banner.locator(".pk-burst").count()).toBe(0);
      expect(await runningAnimations(page)).toBe(0);
      expect(await list.getByRole("listitem").count()).toBeGreaterThanOrEqual(
        2,
      );
      // An interaction is an instant swap too.
      await banner.getByRole("button", { name: "Dismiss" }).click();
      expect(await banner.count()).toBe(0);
      // The only banner: focus goes to the page heading, never the body.
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
        "H1",
      );
      expect(await runningAnimations(page)).toBe(0);
      const p = await probe(page);
      expect(moving(p)).toEqual([]);
      expect(p.vt).toBe(0);
      expect(p.v).toEqual([]);
      await page.context().close();
    });
});

describe("Keys: the trust window's ring", () => {
  const ring = (page: Page) =>
    page.locator("[data-countdown-ring] .pk-countdown circle");

  it("motion on: one pk-draw over the whole window, started where it stands; the seconds in text", async () => {
    const page = await open("#/p/djdl/keys");
    const strip = page.getByRole("list", { name: "Key rotation" });
    await strip.waitFor();
    const step = strip.getByRole("listitem").nth(1);
    expect(await step.textContent()).toMatch(/[34]:\d\d left/);
    expect(
      await page.locator("[data-countdown-ring]").getAttribute("aria-hidden"),
    ).toBe("true");
    await ring(page).waitFor();
    const anim = await ring(page).evaluate((el) =>
      el.getAnimations().map((a) => ({
        name: (a as CSSAnimation).animationName,
        duration: Number(a.effect?.getTiming().duration),
        delay: Number(a.effect?.getTiming().delay),
        state: a.playState,
      })),
    );
    expect(anim).toHaveLength(1);
    expect(anim[0]!.name).toBe("pk-draw");
    expect(anim[0]!.duration).toBe(300_000);
    expect(anim[0]!.state).toBe("running");
    // Started about 60 s into the window (the key was prepared a minute before the fixture's
    // now): a negative delay, so the ring is already a fifth drained.
    expect(anim[0]!.delay).toBeLessThan(-55_000);
    expect(anim[0]!.delay).toBeGreaterThan(-80_000);
    // The ring as drawn: about a fifth of its 100 units already gone.
    const offset = await ring(page).evaluate((el) =>
      parseFloat(getComputedStyle(el).strokeDashoffset),
    );
    expect(offset).toBeGreaterThan(18);
    expect(offset).toBeLessThan(27);
    expect((await probe(page)).v).toEqual([]);
    await page.context().close();
  });

  for (const r of REDUCED)
    it(`${r.label}: no animation; the ring is a still picture of the spent share, the text exact`, async () => {
      const page = await open("#/p/djdl/keys", {
        motion: r.motion,
        dataMotion: r.dataMotion,
      });
      const strip = page.getByRole("list", { name: "Key rotation" });
      await strip.waitFor();
      await ring(page).waitFor();
      expect(await strip.getByRole("listitem").nth(1).textContent()).toMatch(
        /[34]:\d\d left/,
      );
      const still = await ring(page).evaluate((el) => ({
        running: el.getAnimations().length,
        offset: parseFloat(getComputedStyle(el).strokeDashoffset),
      }));
      expect(still.running).toBe(0);
      // About a fifth of the window spent: the same place the animation would be.
      expect(still.offset).toBeGreaterThan(18);
      expect(still.offset).toBeLessThan(27);
      expect(await runningAnimations(page)).toBe(0);
      const p = await probe(page);
      expect(p.vt).toBe(0);
      expect(p.v).toEqual([]);
      await page.context().close();
    });
});

describe("Keys: the refreshed share's meter and count", () => {
  const routes = { "/manage/api/products/djdl/keys": REFRESHED_KEYS };
  const fill = (page: Page) =>
    page.locator("[data-refreshed-meter] .pk-meter-fill");
  const digits = (page: Page) =>
    page.locator("[data-count-up] [aria-hidden='true']");
  const scaleX = (page: Page): Promise<number> =>
    fill(page).evaluate(
      (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a,
    );

  it("motion on: the fill moves by a transform transition and the number counts up to 91 %", async () => {
    const page = await open("#/p/djdl/keys", { routes });
    await fill(page).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-count-up] [aria-hidden='true']")
          ?.textContent === "91%",
    );
    await atRest(page);
    expect(await scaleX(page)).toBeCloseTo(0.91, 2);
    expect(await runningAnimations(page)).toBe(0);
    const p = await probe(page);
    // The fill moved from empty by one transform transition on the `slow` token.
    expect(
      p.transitions.filter(
        (t) => t.cls.includes("pk-meter-fill") && t.property === "transform",
      ),
    ).toEqual([
      { property: "transform", cls: expect.any(String), duration: 320 },
    ]);
    expect(p.v).toEqual([]);
    await page.context().close();
  });

  for (const r of REDUCED)
    it(`${r.label}: the meter and the number are at their value from the start`, async () => {
      const page = await open("#/p/djdl/keys", {
        routes,
        motion: r.motion,
        dataMotion: r.dataMotion,
      });
      await fill(page).waitFor();
      expect(await digits(page).textContent()).toBe("91%");
      expect(await scaleX(page)).toBeCloseTo(0.91, 2);
      expect(await runningAnimations(page)).toBe(0);
      const p = await probe(page);
      expect(moving(p)).toEqual([]);
      expect(p.vt).toBe(0);
      expect(p.v).toEqual([]);
      await page.context().close();
    });
});
