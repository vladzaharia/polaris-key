import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Locator, Page } from "playwright";
import {
  startPortal,
  type Opened,
  type PortalHarness,
} from "./portalHarness.js";
import { FIXTURE_NOW, type PortalScenario } from "./portalFixtures.js";

/**
 * The Library and Discover motion (notes/S-23 §4.2, §6.1, §6.6; MO-07), in the BUILT portal under
 * the Worker's CSP, with motion on:
 *
 *   - the first load staggers the tiles (pk-enter on `slow`, 30 ms apart, at most 6 steps =
 *     180 ms), then nothing is left animating and the stagger is off: a search undone brings
 *     tiles back without one, and a return to the Library has none;
 *   - developer art fades in once decoded, on `base`, and its box never moves (no layout shift);
 *   - a tile lifts under the pointer (2 px, its shadow, its art at 1.03) and presses (0.98) for its
 *     own link only, never for its quick action;
 *   - Grid ↔ List is ONE `list` View Transition that names a handful of regions (the products'
 *     view leaves on `micro`, the new one rises in after `fast`), never more than the 30-row budget,
 *     and leaves no name behind;
 *   - on Discover, a just-added tile's plate pops in once (pk-pop-in on `slow`) and its ring fades
 *     in once (pk-fade-in on `base`, opacity only), and not again after a reload through `?added=`;
 *   - in the Library, a product added under 24 hours ago (PX-24: the fixtures' Mossgarden is a
 *     minute old) says "Added just now", which pops in once (pk-pop-in on `slow`), and its ring
 *     fades in once (pk-fade-in on `base`); never again on a refetch, a search, a sort, a view
 *     switch or a return to the Library;
 *   - under prefers-reduced-motion and under html[data-motion="reduce"] every one of these is an
 *     instant swap: no View Transition starts and `document.getAnimations()` is empty after each
 *     interaction.
 *
 * Zero CSP violations throughout. With `PK_SHOTS_DIR` set it also saves frame strips (animations
 * slowed ×0.1) of the stagger, the Grid → List transition, the ring and the Library's "Added just
 * now".
 */

const SHOTS = process.env.PK_SHOTS_DIR;
type Motion = "no-preference" | "reduce";

let portal: PortalHarness;

beforeAll(async () => {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  portal = await startPortal();
});

afterAll(async () => {
  await portal?.stop();
});

// ── The in-page probe ───────────────────────────────────────────────────────────────────────────

interface AnimEvent {
  phase: "start" | "end" | "cancel";
  kind: "animation" | "transition";
  /** The keyframes' name, or the transitioned property. */
  name: string;
  duration: number;
  delay: number;
  /** A short tag for the target: `li:3` (an item of a list, its index), `img`, `ring`, `plate`… */
  target: string;
}

interface VtStart {
  vt: string | null;
  named: number;
}

interface Probe {
  log: AnimEvent[];
  vt: (string | null)[];
  starts: VtStart[];
  pseudo: Record<string, { name: string; duration: number; delay: number }>;
  shifts: { value: number; art: boolean }[];
}

/**
 * Installed before the app runs (an init script, then a reload): every CSS animation and
 * transition with its resolved timing, every change of html[data-vt], every
 * startViewTransition call (with how many elements are named at that moment), the
 * ::view-transition pseudo animations while one runs, and every layout shift (with whether it
 * moved developer art).
 */
function probe(dataMotion: boolean): void {
  type W = Window & { __m: Probe; __v: string[] };
  const w = window as unknown as W;
  w.__m = { log: [], vt: [], starts: [], pseudo: {}, shifts: [] };
  const tag = (el: Element): string => {
    if (el.matches("[data-ring]")) return "ring";
    if (el.matches("[data-cue='text']")) return "added";
    if (el.matches("img.pk-img-in")) return "img";
    if (el.closest("[data-art]") && el.textContent?.includes("In your library"))
      return "plate";
    const parent = el.parentElement;
    if (parent?.matches("ul, tbody"))
      return `${el.tagName.toLowerCase()}:${[...parent.children].indexOf(el)}`;
    return el.tagName.toLowerCase();
  };
  const timing = new WeakMap<Element, Map<string, EffectTiming>>();
  const record =
    (phase: AnimEvent["phase"], kind: AnimEvent["kind"]) =>
    (e: Event): void => {
      const el = e.target as Element;
      const name =
        kind === "animation"
          ? (e as AnimationEvent).animationName
          : (e as TransitionEvent).propertyName;
      const pseudo =
        (e as AnimationEvent | TransitionEvent).pseudoElement ?? "";
      const key = `${kind}:${name}${pseudo}`;
      const anim = el.getAnimations?.().find((a) => {
        const own =
          kind === "animation"
            ? (a as CSSAnimation).animationName === name
            : (a as CSSTransition).transitionProperty === name;
        return (
          own &&
          ((a.effect as KeyframeEffect | null)?.pseudoElement ?? "") === pseudo
        );
      });
      let byKey = timing.get(el);
      if (!byKey) timing.set(el, (byKey = new Map()));
      const t = anim?.effect?.getTiming() ?? byKey.get(key);
      if (t) byKey.set(key, t);
      w.__m.log.push({
        phase,
        kind,
        name: `${name}${pseudo}`,
        duration: Number(t?.duration ?? Number.NaN),
        delay: Number(t?.delay ?? 0),
        target: tag(el),
      });
    };
  document.addEventListener(
    "animationstart",
    record("start", "animation"),
    true,
  );
  document.addEventListener("animationend", record("end", "animation"), true);
  document.addEventListener(
    "animationcancel",
    record("cancel", "animation"),
    true,
  );
  document.addEventListener(
    "transitionstart",
    record("start", "transition"),
    true,
  );
  document.addEventListener("transitionend", record("end", "transition"), true);
  document.addEventListener(
    "transitioncancel",
    record("cancel", "transition"),
    true,
  );

  const start = (
    document as unknown as {
      startViewTransition?: (...a: unknown[]) => unknown;
    }
  ).startViewTransition;
  if (start)
    (
      document as unknown as {
        startViewTransition: (...a: unknown[]) => unknown;
      }
    ).startViewTransition = function (...a: unknown[]) {
      const named = [...document.querySelectorAll("*")].filter(
        (el) => getComputedStyle(el).viewTransitionName !== "none",
      ).length;
      w.__m.starts.push({
        vt: document.documentElement.getAttribute("data-vt"),
        named,
      });
      const t = start.apply(document, a) as { finished: Promise<unknown> };
      let polling = true;
      const poll = (): void => {
        for (const anim of document.getAnimations()) {
          const pseudo = (anim.effect as KeyframeEffect | null)?.pseudoElement;
          if (!pseudo?.startsWith("::view-transition")) continue;
          const tt = anim.effect!.getTiming();
          // Keyed by the animation too: every `match-element` row shares one pseudo selector,
          // so a bare selector key kept only whichever row the browser listed last.
          w.__m.pseudo[`${pseudo}|${(anim as CSSAnimation).animationName}`] = {
            name: (anim as CSSAnimation).animationName,
            duration: Number(tt.duration),
            delay: Number(tt.delay ?? 0),
          };
        }
        if (polling) requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
      t.finished.finally(() => (polling = false)).catch(() => undefined);
      return t;
    };

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as unknown as {
      value: number;
      sources?: { node?: Node | null }[];
    }[])
      w.__m.shifts.push({
        value: entry.value,
        art: (entry.sources ?? []).some((s) => {
          const n = s.node;
          return n instanceof Element && !!n.closest("[data-art]");
        }),
      });
  }).observe({ type: "layout-shift", buffered: true });

  // The in-app preference (MO-12) as the app stores it: its entry module applies it to
  // <html data-motion> before the first render.
  if (dataMotion) window.localStorage.setItem("pk-admin-motion", "reduce");
  document.addEventListener(
    "readystatechange",
    () =>
      new MutationObserver(() =>
        w.__m.vt.push(document.documentElement.getAttribute("data-vt")),
      ).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-vt"],
      }),
    { once: true },
  );
}

interface OpenOptions {
  motion?: Motion;
  /** The in-app Reduce motion preference (MO-12: html[data-motion="reduce"]) on top of `motion`. */
  dataMotion?: boolean;
  theme?: "dark" | "light";
  /** Hold every /media/ response until the returned release() is called. */
  holdMedia?: boolean;
}

interface Session extends Opened {
  release: () => void;
}

/** Open a portal page with the probe in place from the first script on (an init script + reload). */
async function open(
  scenario: PortalScenario,
  path: string,
  o: OpenOptions = {},
): Promise<Session> {
  const opened = await portal.open(scenario, path, {
    theme: o.theme ?? "dark",
    reducedMotion: o.motion ?? "no-preference",
  });
  let release = (): void => undefined;
  if (o.holdMedia) {
    const gate = new Promise<void>((r) => (release = r));
    // Page routes run before the harness's context routes; fallback() hands the request on.
    await opened.page.route("**/media/**", async (route) => {
      await gate;
      await route.fallback();
    });
  }
  await opened.page.context().addInitScript(probe, o.dataMotion ?? false);
  await opened.page.reload();
  await opened.violations();
  return { ...opened, release };
}

const log = (page: Page): Promise<AnimEvent[]> =>
  page.evaluate(() => (window as unknown as { __m: Probe }).__m.log.splice(0));

const state = (page: Page): Promise<Probe> =>
  page.evaluate(() => (window as unknown as { __m: Probe }).__m);

/** Animations still running anywhere (pseudo-elements included). */
const running = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document.getAnimations().map((a) => {
      const name =
        (a as CSSAnimation).animationName ??
        (a as CSSTransition).transitionProperty ??
        a.constructor.name;
      const e = a.effect as KeyframeEffect | null;
      return `${name}${e?.pseudoElement ?? ""} on ${(e?.target as Element | null)?.tagName ?? "?"}`;
    }),
  );

async function atRest(page: Page, timeout = 4000): Promise<void> {
  await page
    .waitForFunction(() => document.getAnimations().length === 0, null, {
      timeout,
    })
    .catch(() => undefined);
}

/** Wait until every developer-art image on screen has loaded and shows. */
async function artShown(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const imgs = [
      ...document.querySelectorAll<HTMLImageElement>("img.pk-img-in"),
    ];
    const onScreen = imgs.filter((i) => {
      const r = i.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    });
    return (
      onScreen.length > 0 &&
      onScreen.every((i) => i.hasAttribute("data-loaded"))
    );
  });
}

/** The tiles' list (`ul`) or the list view's `tbody`. */
const items = (page: Page): Locator =>
  page.locator("section[aria-labelledby='all-h'] :is(ul, tbody)").first();

/** Computed transform of the element matched by `selector` (inside the tile named `name`). */
async function transformOf(
  page: Page,
  name: string,
  selector: string,
): Promise<string> {
  return page.evaluate(
    ({ name, selector }) => {
      const card = document.querySelector(
        `article[aria-labelledby='${name}']`,
      )!;
      const el =
        selector === "wrapper"
          ? card.parentElement!
          : (card.querySelector(selector) as Element);
      return getComputedStyle(el).transform;
    },
    { name, selector },
  );
}

/** With PK_SHOTS_DIR: slow every animation ×0.1, run `act`, and save `frames` screenshots. */
async function strip(
  page: Page,
  name: string,
  act: () => Promise<void>,
  frames = 6,
  every = 300,
): Promise<void> {
  if (!SHOTS) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
  await act();
  for (let i = 0; i < frames; i++) {
    await page.screenshot({ path: `${SHOTS}/mo07-${name}-${i}.png` });
    await page.waitForTimeout(every);
  }
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  await cdp.detach();
}

/** Move the mouse to the middle of `target`, as a pointer does (the tile's link covers its art). */
async function pointAt(page: Page, target: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

const SLOW = 320;
const BASE = 200;
const FAST = 120;
const MICRO = 80;
const STEP = 30;

/** The Library's cue (PX-24): "Added just now" and the ring, as the probe tags them. */
const cueEvents = (events: AnimEvent[]): AnimEvent[] =>
  events.filter((e) => e.target === "added" || e.target === "ring");

/** The classes on Mossgarden's text and ring: none of the cue's motion is left on them. */
const cueClasses = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-cue]")].map(
      (el) => `${el.getAttribute("data-cue")}: ${el.className}`,
    ),
  );

// ── Motion on ─────────────────────────────────────────────────────────────────────────────────

describe("motion on: the Library and Discover under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const)
    it(`the first load staggers the tiles in at most 6 steps, once (${theme})`, async () => {
      const s = await open("twelve", "/", { theme });
      const { page } = s;
      await page
        .getByRole("heading", { level: 1, name: "Your library" })
        .waitFor();
      await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
      await atRest(page);
      const events = await log(page);
      const starts = events.filter(
        (e) =>
          e.phase === "start" &&
          e.name === "pk-enter" &&
          e.target.startsWith("li:"),
      );
      expect(starts.map((e) => e.target).sort()).toEqual(
        Array.from({ length: 12 }, (_, i) => `li:${i}`).sort(),
      );
      for (const e of starts) {
        const i = Number(e.target.slice(3));
        expect(e.duration, e.target).toBe(SLOW);
        expect(e.delay, e.target).toBe(Math.min(i, 6) * STEP);
      }
      expect(Math.max(...starts.map((e) => e.delay))).toBe(6 * STEP);
      expect(
        events.filter((e) => e.phase === "cancel" && e.name === "pk-enter"),
      ).toEqual([]);
      // Once it has run, the stagger is off and nothing is left animating.
      await expect
        .poll(() => items(page).getAttribute("class"))
        .not.toMatch(/\bpk-stagger\b/);
      expect(await running(page)).toEqual([]);

      // A search, then Show all: the tiles come back in place, without a stagger.
      await page.getByRole("searchbox").fill("orbit");
      await page.getByText("Showing 1 of 12 ·").waitFor();
      await page.getByRole("button", { name: "Show all" }).click();
      await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
      await atRest(page);
      expect(
        (await log(page)).filter(
          (e) => e.kind === "animation" && e.name === "pk-enter",
        ),
      ).toEqual([]);
      expect(await running(page)).toEqual([]);
      expect(await s.violations()).toEqual([]);
      if (theme === "dark")
        await strip(
          page,
          "first-load",
          () => page.reload().then(() => undefined),
          6,
          150,
        );
      await s.close();
    });

  it("a return to the Library never staggers (the tile morph back from a product is MO-05's)", async () => {
    const s = await open("twelve", "/");
    const { page } = s;
    await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
    await atRest(page);
    await log(page);
    await page.evaluate(() => (location.hash = "#/account"));
    await page.getByRole("heading", { level: 1, name: "Account" }).waitFor();
    await page.evaluate(() => (location.hash = "#/"));
    await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
    await atRest(page);
    expect(await items(page).getAttribute("class")).not.toMatch(
      /\bpk-stagger\b/,
    );
    expect(
      (await log(page)).filter(
        (e) => e.kind === "animation" && e.name === "pk-enter",
      ),
    ).toEqual([]);
    expect(await s.violations()).toEqual([]);
    await s.close();
  });

  it("developer art fades in once decoded, on base, and never moves its box", async () => {
    const s = await open("three", "/", { holdMedia: true });
    const { page } = s;
    await page.getByRole("article", { name: "Nightfall" }).waitFor();
    await atRest(page);
    const boxes = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("article div[data-art='image']")].map(
          (el) => {
            const r = el.getBoundingClientRect();
            const img = el.querySelector("img:not([data-blur])")!;
            return {
              box: [r.x, r.y, r.width, r.height].map(Math.round),
              opacity: getComputedStyle(img).opacity,
              loaded: img.hasAttribute("data-loaded"),
            };
          },
        ),
      );
    const held = await boxes();
    expect(held.length).toBeGreaterThan(0);
    // Not loaded yet: the tint holds the 16:9 box, the image waits unseen.
    for (const b of held)
      expect(b).toMatchObject({ opacity: "0", loaded: false });
    await log(page);
    s.release();
    await artShown(page);
    await atRest(page);
    const shown = await boxes();
    expect(shown.map((b) => b.box)).toEqual(held.map((b) => b.box));
    for (const b of shown)
      expect(b).toMatchObject({ opacity: "1", loaded: true });
    const fades = (await log(page)).filter(
      (e) => e.kind === "transition" && e.target === "img" && e.phase === "end",
    );
    expect(fades.length).toBeGreaterThanOrEqual(held.length);
    for (const f of fades)
      expect([f.name, f.duration]).toEqual(["opacity", BASE]);
    const { shifts } = await state(page);
    expect(
      shifts.filter((x) => x.art),
      "a layout shift moved art",
    ).toEqual([]);
    expect(await s.violations()).toEqual([]);
    await s.close();
  });

  it("a tile lifts under the pointer and presses for its own link, never for its quick action", async () => {
    const s = await open("three", "/");
    const { page } = s;
    const card = page.getByRole("article", { name: "Nightfall" });
    await card.waitFor();
    await artShown(page);
    await atRest(page);
    await pointAt(page, card.locator("div[data-art='image']"));
    await atRest(page);
    expect(await transformOf(page, "tile-nightfall", "wrapper")).toBe(
      "matrix(1, 0, 0, 1, 0, -2)",
    );
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector("article[aria-labelledby='tile-nightfall']")!
              .parentElement!,
            "::before",
          ).opacity,
      ),
    ).toBe("1");
    expect(await transformOf(page, "tile-nightfall", "img.pk-img-in")).toBe(
      "matrix(1.03, 0, 0, 1.03, 0, 0)",
    );

    // Press the tile's link (anywhere on the art opens the product): the tile presses.
    await page.mouse.down();
    await atRest(page);
    expect(await transformOf(page, "tile-nightfall", "wrapper")).toBe(
      "matrix(0.98, 0, 0, 0.98, 0, 0)",
    );
    // Let go somewhere else, so no click lands.
    await page.mouse.move(2, 2);
    await page.mouse.up();
    await atRest(page);
    expect(await transformOf(page, "tile-nightfall", "wrapper")).toBe("none");

    // Press the quick action: the button presses, the tile only stays lifted.
    const action = card
      .locator("div.relative.mt-auto button, div.relative.mt-auto a")
      .first();
    await action.hover();
    await page.mouse.down();
    await atRest(page);
    expect(await transformOf(page, "tile-nightfall", "wrapper")).toBe(
      "matrix(1, 0, 0, 1, 0, -2)",
    );
    await page.mouse.move(2, 2);
    await page.mouse.up();
    await atRest(page);
    expect(await running(page)).toEqual([]);
    expect(await s.violations()).toEqual([]);
    await s.close();
  });

  for (const theme of ["dark", "light"] as const)
    it(`Grid ↔ List is one list View Transition within the 30-row budget (${theme})`, async () => {
      const s = await open("twelve", "/", { theme });
      const { page } = s;
      await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
      await atRest(page);
      await log(page);

      const toList = async () => {
        await page.getByRole("radio", { name: "List" }).click();
      };
      await toList();
      await page.getByRole("table", { name: "Your products" }).waitFor();
      await page.waitForFunction(
        () => !document.documentElement.hasAttribute("data-vt"),
      );
      await atRest(page);
      const m = await state(page);
      expect(m.starts.map((x) => x.vt)).toEqual(["list"]);
      expect(m.vt).toEqual(["list", null]);
      // The page's blocks, the products section, its heading and its view, the main region: a
      // handful, nowhere near the 30-row budget.
      expect(m.starts[0]!.named).toBeGreaterThan(2);
      expect(m.starts[0]!.named).toBeLessThanOrEqual(31);
      const pseudo = Object.values(m.pseudo);
      // The grid leaves on `micro`; the list rises in on `base` after `fast`.
      expect(pseudo).toContainEqual({
        name: "pk-fade-out",
        duration: MICRO,
        delay: 0,
      });
      expect(pseudo).toContainEqual({
        name: "pk-enter",
        duration: BASE,
        delay: FAST,
      });
      // Nothing outlives the transition: no names, no animation.
      expect(
        await page.evaluate(
          () =>
            [...document.querySelectorAll("*")].filter(
              (el) => getComputedStyle(el).viewTransitionName !== "none",
            ).length,
        ),
      ).toBe(0);
      expect(await running(page)).toEqual([]);
      // The view switch never restaggers the list.
      expect(
        (await log(page)).filter(
          (e) =>
            e.kind === "animation" &&
            e.name === "pk-enter" &&
            e.target.startsWith("tr:"),
        ),
      ).toEqual([]);

      // And back to the grid: one more list transition.
      await page.getByRole("radio", { name: "Grid" }).click();
      await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
      await page.waitForFunction(
        () => !document.documentElement.hasAttribute("data-vt"),
      );
      expect((await state(page)).starts.map((x) => x.vt)).toEqual([
        "list",
        "list",
      ]);
      await atRest(page);
      expect(await running(page)).toEqual([]);
      expect(await s.violations()).toEqual([]);

      if (theme === "dark") await strip(page, "grid-to-list", toList, 6, 250);
      await s.close();
    });

  it("on Discover, a just-added tile's plate pops in and its ring fades in, once, and not after a reload", async () => {
    const s = await open("three", "/#/discover");
    const { page } = s;
    await page.getByRole("article", { name: "Mossgarden" }).waitFor();
    await atRest(page);
    await log(page);
    await page
      .getByRole("button", { name: "Add to library: Mossgarden" })
      .click();
    await page.getByRole("link", { name: "Open Mossgarden" }).waitFor();
    await atRest(page);
    const came = (await log(page)).filter(
      (e) =>
        e.kind === "animation" &&
        (e.target === "plate" || e.target === "ring") &&
        e.phase === "end",
    );
    // The plate pops; the ring only fades (a scaled 1 px ring would pass inside the card's edge).
    expect(came.map((e) => [e.target, e.name, e.duration]).sort()).toEqual([
      ["plate", "pk-pop-in", SLOW],
      ["ring", "pk-fade-in", BASE],
    ]);
    expect(await running(page)).toEqual([]);

    // The URL now says ?added=mossgarden: after a reload the tile is simply added.
    expect(page.url()).toContain("added=mossgarden");
    await page.reload();
    await page.getByRole("link", { name: "Open Mossgarden" }).waitFor();
    await atRest(page);
    expect(
      (await log(page)).filter(
        (e) => e.target === "plate" || e.target === "ring",
      ),
    ).toEqual([]);
    expect(await page.locator("[data-ring]").count()).toBe(1);
    expect(await s.violations()).toEqual([]);
    if (SHOTS) {
      // One more add, slowed, for the strip.
      await strip(
        page,
        "ring",
        () =>
          page.getByRole("button", { name: "Add to library: Quill" }).click(),
        4,
        250,
      );
    }
    await s.close();
  });

  for (const theme of ["dark", "light"] as const)
    it(`the Library's "Added just now" pops in once and its ring fades in once, never again (${theme})`, async () => {
      const s = await open("twelve", "/", { theme });
      const { page } = s;
      const card = page.getByRole("article", { name: "Mossgarden" });
      await card.waitFor();
      await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
      await atRest(page);
      // First under the default sort, saying so.
      expect(
        await page
          .locator("section[aria-labelledby='all-h'] article h3")
          .first()
          .textContent(),
      ).toBe("Mossgarden");
      await card.getByText("Added just now").waitFor();
      const came = cueEvents(await log(page));
      // The text pops; the ring only fades (a scaled ring would pass inside the card's edge).
      expect(
        came
          .filter((e) => e.phase === "end")
          .map((e) => [e.target, e.name, e.duration])
          .sort(),
      ).toEqual([
        ["added", "pk-pop-in", SLOW],
        ["ring", "pk-fade-in", BASE],
      ]);
      expect(came.filter((e) => e.phase === "cancel")).toEqual([]);
      expect(await running(page)).toEqual([]);
      // Nothing is left waiting to replay.
      await expect
        .poll(() => cueClasses(page))
        .toEqual([
          expect.not.stringMatching(/pk-pop-in|pk-content-in/),
          expect.not.stringMatching(/pk-pop-in|pk-content-in/),
        ]);

      const quiet = async (what: string): Promise<void> => {
        await page.getByRole("article", { name: "Mossgarden" }).waitFor();
        await atRest(page);
        expect(cueEvents(await log(page)), what).toEqual([]);
        expect(await running(page), what).toEqual([]);
        expect(await page.locator("[data-ring]").count(), what).toBe(1);
      };

      // A refetch: a minute later the library is stale, and coming back to the tab refetches it.
      const libraryFetches = () =>
        s.requests.filter((r) => r === "GET /api/library").length;
      const before = libraryFetches();
      await page.clock.setFixedTime((FIXTURE_NOW + 60) * 1000);
      await page.evaluate(() =>
        // React Query listens on window.
        window.dispatchEvent(new Event("visibilitychange")),
      );
      await expect.poll(libraryFetches).toBeGreaterThan(before);
      await quiet("refetch");

      // A search that hides it, then Show all.
      await page.getByRole("searchbox").fill("orbit");
      await page.getByText("Showing 1 of 12 ·").waitFor();
      await page.getByRole("button", { name: "Show all" }).click();
      await quiet("search");

      // By name, where it keeps its place, and back to Recently added.
      const sort = page.getByRole("combobox", { name: "Sort" });
      await sort.selectOption("name");
      await page.getByText("By name").waitFor();
      await quiet("sort by name");
      await sort.selectOption("recent");
      await page.getByText("Recently added first").waitFor();
      await quiet("sort by recent");

      // Grid → List → Grid.
      await page.getByRole("radio", { name: "List" }).click();
      await page.getByRole("table", { name: "Your products" }).waitFor();
      await page.waitForFunction(
        () => !document.documentElement.hasAttribute("data-vt"),
      );
      await atRest(page);
      expect(cueEvents(await log(page)), "grid → list").toEqual([]);
      expect(await page.locator("tbody [data-ring]").count()).toBe(1);
      await page.getByRole("radio", { name: "Grid" }).click();
      await page.waitForFunction(
        () => !document.documentElement.hasAttribute("data-vt"),
      );
      await quiet("list → grid");

      // A return to the Library.
      await page.evaluate(() => (location.hash = "#/account"));
      await page.getByRole("heading", { level: 1, name: "Account" }).waitFor();
      await page.evaluate(() => (location.hash = "#/"));
      await quiet("return");
      expect(await s.violations()).toEqual([]);

      if (theme === "dark")
        await strip(
          page,
          "added-just-now",
          () => page.reload().then(() => undefined),
          6,
          150,
        );
      await s.close();
    });

  it("staggers Discover's offers on their first load", async () => {
    const s = await open("three", "/#/discover");
    const { page } = s;
    await page.getByRole("article", { name: "Quill" }).waitFor();
    await atRest(page);
    const starts = (await log(page)).filter(
      (e) =>
        e.phase === "start" &&
        e.name === "pk-enter" &&
        e.target.startsWith("li:"),
    );
    expect(starts.map((e) => [e.target, e.delay]).sort()).toEqual([
      ["li:0", 0],
      ["li:1", STEP],
      ["li:2", 2 * STEP],
      ["li:3", 3 * STEP],
    ]);
    expect(await running(page)).toEqual([]);
    expect(await s.violations()).toEqual([]);
    await s.close();
  });
});

// ── Reduced motion: instant swaps (S-23 D3) ──────────────────────────────────────────────────

const REDUCED: { name: string; o: OpenOptions }[] = [
  { name: "prefers-reduced-motion", o: { motion: "reduce" } },
  {
    name: 'html[data-motion="reduce"]',
    o: { motion: "no-preference", dataMotion: true },
  },
];

describe("reduced motion: every Library and Discover change is an instant swap", () => {
  for (const { name, o } of REDUCED)
    it(`${name}: no stagger, no fade, no lift or press, no View Transition, nothing animating`, async () => {
      const s = await open("twelve", "/", { ...o, holdMedia: true });
      const { page } = s;
      await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
      if (o.dataMotion)
        expect(
          await page.evaluate(() => document.documentElement.dataset.motion),
        ).toBe("reduce");
      expect(await running(page), "first load").toEqual([]);
      s.release();
      await artShown(page);
      expect(await running(page), "art shown").toEqual([]);

      // Hover and press a tile: nothing moves.
      await pointAt(
        page,
        page
          .getByRole("article", { name: "Nightfall" })
          .locator("div[data-art]"),
      );
      expect(await transformOf(page, "tile-nightfall", "wrapper")).toBe("none");
      expect(await transformOf(page, "tile-nightfall", "img.pk-img-in")).toBe(
        "none",
      );
      await page.mouse.down();
      expect(await transformOf(page, "tile-nightfall", "wrapper")).toBe("none");
      await page.mouse.move(2, 2);
      await page.mouse.up();
      expect(await running(page), "hover and press").toEqual([]);

      // Grid → List and back: instant swaps.
      await page.getByRole("radio", { name: "List" }).click();
      await page.getByRole("table", { name: "Your products" }).waitFor();
      expect(await running(page), "grid → list").toEqual([]);
      await page.getByRole("radio", { name: "Grid" }).click();
      await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
      expect(await running(page), "list → grid").toEqual([]);

      const m = await state(page);
      expect(m.starts, "a View Transition started").toEqual([]);
      expect(m.vt, "html[data-vt] was set").toEqual([]);
      expect(
        m.log.filter((e) => e.duration > 0 || e.delay > 0),
        "something animated with a duration",
      ).toEqual([]);
      expect(await s.violations()).toEqual([]);
      await s.close();
    });

  for (const { name, o } of REDUCED)
    it(`${name}: Discover's Add shows the ring at once`, async () => {
      const s = await open("three", "/#/discover", o);
      const { page } = s;
      await page.getByRole("article", { name: "Mossgarden" }).waitFor();
      expect(await running(page)).toEqual([]);
      await page
        .getByRole("button", { name: "Add to library: Mossgarden" })
        .click();
      await page.getByRole("link", { name: "Open Mossgarden" }).waitFor();
      expect(await page.locator("[data-ring]").count()).toBe(1);
      expect(await running(page)).toEqual([]);
      expect(
        (await state(page)).log.filter(
          (e) =>
            e.name === "pk-pop-in" ||
            e.name === "pk-enter" ||
            e.target === "ring",
        ),
      ).toEqual([]);
      expect(await s.violations()).toEqual([]);
      await s.close();
    });

  for (const { name, o } of REDUCED)
    it(`${name}: the Library's "Added just now" and its ring are simply there`, async () => {
      const s = await open("twelve", "/", o);
      const { page } = s;
      const card = page.getByRole("article", { name: "Mossgarden" });
      await card.waitFor();
      await card.getByText("Added just now").waitFor();
      expect(await page.locator("[data-ring]").count()).toBe(1);
      expect(await running(page), "first load").toEqual([]);
      // No class is left on to replay if motion comes back on.
      await expect
        .poll(() => cueClasses(page))
        .toEqual([
          expect.not.stringMatching(/pk-pop-in|pk-content-in/),
          expect.not.stringMatching(/pk-pop-in|pk-content-in/),
        ]);
      await page.getByRole("combobox", { name: "Sort" }).selectOption("name");
      await page.getByText("By name").waitFor();
      expect(await running(page), "sort").toEqual([]);
      await page.getByRole("radio", { name: "List" }).click();
      await page.getByRole("table", { name: "Your products" }).waitFor();
      expect(await running(page), "grid → list").toEqual([]);
      expect(
        (await state(page)).log.filter(
          (e) => e.target === "added" || e.target === "ring",
        ),
      ).toEqual([]);
      expect(await s.violations()).toEqual([]);
      await s.close();
    });
});
