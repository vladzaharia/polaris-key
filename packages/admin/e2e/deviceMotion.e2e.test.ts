import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page, Request } from "playwright";
import {
  axe,
  startPortal,
  type Opened,
  type Override,
  type PortalHarness,
} from "./portalHarness.js";
import type { PortalScenario } from "./portalFixtures.js";

/**
 * Portal devices and activation moments (notes/S-23 §6.1, §6.4–§6.6; MO-06), in the BUILT portal
 * under the Worker's CSP, with motion on:
 *
 *   - Remove on a device opens its confirm in place (the expand pattern: the region's grid row on
 *     `moderate`, its content fading in after `micro`), focus on the confirm's heading;
 *   - Remove <device> frees the seat: ONE `list` View Transition naming at most LIST_BUDGET (30)
 *     rows, the row gone, the count counting to the new number, the meter's freed segment easing
 *     its colour and pulsing once, the new count said in text (the card, the meter's name and the
 *     live region), focus on the product's h1, and nothing left animating or named afterwards;
 *   - the Activate dialog's step changes are `dialog` View Transitions over the panel (the size
 *     morph on `moderate`, the old step out on `fast`, the new one in on `base` after `micro`);
 *   - the first add on an account draws the check and bursts six sparks, once; a second add (a
 *     different product) shows the check only, with no burst;
 *   - FreeDevicePage's success draws the check, with no sparks;
 *   - under prefers-reduced-motion and under html[data-motion="reduce"] each of these is an
 *     instant swap to the same end state: no View Transition starts, nothing animates with a
 *     duration, and `document.getAnimations()` is empty right after each interaction. The busy
 *     Add button's spinner is a still ring (the claim is held open, so the spinner always shows,
 *     however fast the run).
 *
 * Zero CSP violations throughout; axe passes on every state at rest. With `PK_SHOTS_DIR` set it
 * also saves frame strips (animations slowed ×0.1) of the expand, the removal and the Done step.
 * Kept apart from e2e/motion.e2e.test.ts, as the other area packages' suites are.
 */

const SHOTS = process.env.PK_SHOTS_DIR;
const LIST_BUDGET = 30;
const DELIBERATE = 480;
const SLOW = 320;
const MODERATE = 260;
const BASE = 200;
const FAST = 120;
const MICRO = 80;

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
  /** `expand`, `expand-body`, `seg:<i>`, `check`, `spark`, or the tag name. */
  target: string;
}

interface VtStart {
  vt: string | null;
  /** Elements named when the transition started (the old state's names). */
  named: number;
  /** Of those, the device rows. */
  rows: number;
}

interface Probe {
  log: AnimEvent[];
  vt: (string | null)[];
  starts: VtStart[];
  pseudo: Record<string, { name: string; duration: number; delay: number }>;
}

/**
 * Installed before the app runs (an init script, then a reload): every CSS animation and
 * transition with its resolved timing, every change of html[data-vt], every startViewTransition
 * call with how many elements (and device rows) are named at that moment, and the
 * ::view-transition pseudo animations while one runs.
 */
function probe(dataMotion: boolean): void {
  type W = Window & { __m: Probe };
  const w = window as unknown as W;
  w.__m = { log: [], vt: [], starts: [], pseudo: {} };
  const tag = (el: Element): string => {
    if (el.matches(".pk-expand")) return "expand";
    if (el.parentElement?.matches(".pk-expand")) return "expand-body";
    if (el.matches(".pk-seg"))
      return `seg:${[...el.parentElement!.children].indexOf(el)}`;
    if (el.closest(".pk-check")) return "check";
    if (el.parentElement?.matches(".pk-burst")) return "spark";
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
  for (const [type, phase, kind] of [
    ["animationstart", "start", "animation"],
    ["animationend", "end", "animation"],
    ["animationcancel", "cancel", "animation"],
    ["transitionstart", "start", "transition"],
    ["transitionend", "end", "transition"],
    ["transitioncancel", "cancel", "transition"],
  ] as const)
    document.addEventListener(type, record(phase, kind), true);

  const doc = document as unknown as {
    startViewTransition?: (...a: unknown[]) => unknown;
  };
  const start = doc.startViewTransition;
  if (start)
    doc.startViewTransition = function (...a: unknown[]) {
      const named = [...document.querySelectorAll("*")].filter(
        (el) => getComputedStyle(el).viewTransitionName !== "none",
      );
      w.__m.starts.push({
        vt: document.documentElement.getAttribute("data-vt"),
        named: named.length,
        rows: named.filter((el) => el.matches("#section-devices ul > li"))
          .length,
      });
      const t = start.apply(document, a) as { finished: Promise<unknown> };
      let polling = true;
      const poll = (): void => {
        for (const anim of document.getAnimations()) {
          const pseudo = (anim.effect as KeyframeEffect | null)?.pseudoElement;
          if (!pseudo?.startsWith("::view-transition")) continue;
          const tt = anim.effect!.getTiming();
          w.__m.pseudo[pseudo] = {
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

  // The in-app preference (MO-12) as the app stores it.
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

type Motion = "no-preference" | "reduce";

interface OpenOptions {
  motion?: Motion;
  /** The in-app Reduce motion preference (MO-12: html[data-motion="reduce"]) on top of `motion`. */
  dataMotion?: boolean;
  theme?: "dark" | "light";
  width?: number;
  height?: number;
  routes?: Record<string, Override>;
}

async function open(
  scenario: PortalScenario,
  path: string,
  o: OpenOptions = {},
): Promise<Opened> {
  const opened = await portal.open(scenario, path, {
    theme: o.theme ?? "dark",
    width: o.width,
    height: o.height,
    routes: o.routes,
    reducedMotion: o.motion ?? "no-preference",
  });
  await opened.page.context().addInitScript(probe, o.dataMotion ?? false);
  await opened.page.reload();
  await opened.violations();
  return opened;
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

const focused = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      `${document.activeElement?.tagName}:${document.activeElement?.textContent?.trim()}`,
  );

/** Inline (CSSOM) view-transition names left on the page. */
const inlineNames = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>("*")].filter(
        (el) => el.style.getPropertyValue("view-transition-name") !== "",
      ).length,
  );

const deviceRows = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "#section-devices ul > li p[data-device-name]",
      ),
    ].map((p) => p.textContent ?? ""),
  );

const starts = (e: AnimEvent[], where: string, name?: string): AnimEvent[] =>
  e.filter(
    (x) =>
      x.phase === "start" &&
      x.target === where &&
      (name === undefined || x.name === name),
  );

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
    await page.screenshot({ path: `${SHOTS}/mo06-${name}-${i}.png` });
    await page.waitForTimeout(every);
  }
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  await cdp.detach();
}

// ── Activation fixtures: two keys, each addable once ────────────────────────────────────────────

const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
const KEY2 = "pkey_quill_Lm9xT2qVb8sPzK4wNc7dRf";
const MOMENT = "pk-moment:first-activation:acct_1";

/** A promise the test opens by hand: a route awaits it to keep a request in flight. */
interface Latch {
  wait: Promise<void>;
  open: () => void;
}
function latch(): Latch {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** With `holdClaim`, the first claim stays in flight until the latch opens. */
function activateRoutes(holdClaim?: Latch): Record<string, Override> {
  const added = new Set<string>();
  const of = (key: string) =>
    key === KEY
      ? { slug: "mossgarden", name: "Mossgarden", id: "lic_mossgarden" }
      : { slug: "quill", name: "Quill", id: "lic_quill_2" };
  const keyOf = (req: Request) => (req.postDataJSON() as { key: string }).key;
  return {
    "POST /api/activate/preview": (req) => {
      const p = of(keyOf(req));
      return {
        body: {
          verdict: added.has(p.slug) ? "already_yours" : "addable",
          product: {
            slug: p.slug,
            name: p.name,
            developerName: "Little Fern",
            iconUrl: null,
            headerUrl: null,
          },
          entries: null,
          license: added.has(p.slug)
            ? { id: p.id }
            : {
                tier: "standard",
                tierLabel: "Standard",
                status: "active",
                usable: true,
                expiresAt: null,
                deviceLimit: 5,
              },
          platforms: ["macos", "windows"],
        },
      };
    },
    "POST /api/claim/license-key": async (req) => {
      await holdClaim?.wait;
      const p = of(keyOf(req));
      added.add(p.slug);
      return {
        body: {
          ok: true,
          license: { id: p.id, product: p.slug, productName: p.name },
        },
      };
    },
  };
}

/** Each busy control's spinner: its computed animation and how many animations it is running. */
const spinners = (
  page: Page,
): Promise<{ animation: string; running: number }[]> =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[aria-busy="true"] .animate-pk-spin',
      ),
    ].map((el) => ({
      animation: getComputedStyle(el).animationName,
      running: el.getAnimations().length,
    })),
  );

/**
 * Activates `key`. With `held`, the claim (held by activateRoutes) stays in flight until `check`
 * has run, so the busy Add button and its spinner are on screen however fast the run is.
 */
async function activate(
  page: Page,
  key: string,
  name: string,
  held?: { claim: Latch; check: () => Promise<void> },
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Activate a license" });
  await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "License key" }).fill(key);
  await dialog.getByRole("button", { name: "Continue" }).click();
  const confirm = page.getByRole("dialog", {
    name: `Add ${name} to your account?`,
  });
  await confirm.getByRole("button", { name: `Add ${name}` }).click();
  if (held)
    try {
      await held.check();
    } finally {
      held.claim.open();
    }
  await page
    .getByRole("dialog", { name: `${name} is in your library` })
    .waitFor();
}

// ── Motion on ─────────────────────────────────────────────────────────────────────────────────

describe("motion on: devices and activation under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const)
    it(`Remove expands in place, then the row leaves in one list transition while the count and meter follow (${theme})`, async () => {
      const s = await open("three", "/#/p/nightfall/devices", { theme });
      const { page } = s;
      await page
        .getByRole("heading", { level: 1, name: "Nightfall" })
        .waitFor();
      await page.getByText("Studio PC").first().waitFor();
      await atRest(page);
      await log(page);
      expect(await deviceRows(page)).toEqual([
        "Mara's MacBook Pro",
        "Studio PC",
      ]);

      // The confirm opens in place.
      await page
        .getByRole("button", { name: "Remove Studio PC" })
        .first()
        .click();
      await page.getByRole("heading", { name: "Remove Studio PC?" }).waitFor();
      await expect.poll(() => focused(page)).toBe("H3:Remove Studio PC?");
      await atRest(page);
      const opening = await log(page);
      expect(
        starts(opening, "expand", "grid-template-rows").map((e) => e.duration),
      ).toEqual([MODERATE]);
      expect(
        starts(opening, "expand-body", "opacity").map((e) => [
          e.duration,
          e.delay,
        ]),
      ).toEqual([[FAST, MICRO]]);
      expect(await running(page)).toEqual([]);
      expect(await axe(page)).toEqual([]);

      // Remove it: one list transition, at most 30 rows named.
      await page
        .getByRole("button", { name: "Remove Studio PC", exact: true })
        .last()
        .click();
      await expect.poll(() => deviceRows(page)).toEqual(["Mara's MacBook Pro"]);
      await expect.poll(() => focused(page)).toBe("H1:Nightfall");
      await atRest(page);
      const m = await state(page);
      expect(m.starts).toHaveLength(1);
      expect(m.starts[0]!.vt).toBe("list");
      expect(m.starts[0]!.rows).toBe(2);
      expect(m.starts[0]!.rows).toBeLessThanOrEqual(LIST_BUDGET);
      // The main region, the card, its blocks and its rows (and an overlay or two): a handful.
      expect(m.starts[0]!.named).toBeLessThanOrEqual(LIST_BUDGET);
      expect(m.vt).toEqual(["list", null]);
      // The rows close up on `base`.
      expect(
        Object.entries(m.pseudo).some(
          ([k, v]) =>
            k.startsWith("::view-transition-group(") && v.duration === BASE,
        ),
      ).toBe(true);
      const removal = await log(page);
      // The freed seat's segment eases its colour and pulses once; the others stay still.
      expect(
        starts(removal, "seg:1")
          .map((e) => [e.name, e.duration])
          .sort(),
      ).toEqual([
        ["background-color", BASE],
        ["transform", SLOW],
        ["transform", SLOW],
      ]);
      expect(starts(removal, "seg:0")).toEqual([]);
      expect(starts(removal, "seg:2")).toEqual([]);
      // Said in words: the count, the meter's name, the live region.
      const devices = page.getByRole("region", { name: "Devices" });
      await expect
        .poll(() =>
          devices.locator("[data-count-up] [aria-hidden]").textContent(),
        )
        .toBe("1");
      expect(await devices.textContent()).toContain("of 3 devices in use");
      await devices
        .getByRole("img", { name: "1 of 3 devices in use" })
        .waitFor();
      expect(await page.locator("#pk-announcer").textContent()).toContain(
        "Studio PC was removed. 1 of 3 devices in use.",
      );
      // Nothing left behind.
      expect(await running(page)).toEqual([]);
      expect(await inlineNames(page)).toBe(0);
      expect(await page.locator(".pk-vt-list, [data-changed]").count()).toBe(0);
      expect(await axe(page)).toEqual([]);
      expect(await s.violations()).toEqual([]);
      await s.close();
    });

  it("saves the expand and removal frames (PK_SHOTS_DIR)", async () => {
    if (!SHOTS) return;
    const s = await open("three", "/#/p/nightfall/devices");
    const { page } = s;
    await page.getByText("Studio PC").first().waitFor();
    await atRest(page);
    await strip(page, "expand", () =>
      page.getByRole("button", { name: "Remove Studio PC" }).first().click(),
    );
    await atRest(page, 8000);
    await strip(page, "remove", () =>
      page
        .getByRole("button", { name: "Remove Studio PC", exact: true })
        .last()
        .click(),
    );
    await s.close();
  });

  it("the Activate steps morph as dialog transitions; the first add celebrates once, the next shows the check only", async () => {
    const claim = latch();
    const s = await open("three", "/", { routes: activateRoutes(claim) });
    const { page } = s;
    await page
      .getByRole("heading", { level: 1, name: "Your library" })
      .waitFor();
    await atRest(page);
    await log(page);
    await page.getByRole("button", { name: "Activate license" }).click();
    await activate(page, KEY, "Mossgarden", {
      claim,
      // While the claim is in flight the busy Add button's spinner turns.
      check: async () => {
        await expect.poll(() => spinners(page)).not.toEqual([]);
        for (const sp of await spinners(page)) {
          expect(sp.animation).toBe("pk-spin");
          expect(sp.running).toBeGreaterThan(0);
        }
      },
    });
    await expect
      .poll(() => focused(page))
      .toBe("H2:Mossgarden is in your library");
    await atRest(page);
    let m = await state(page);
    // enter → confirm, confirm → done: two dialog transitions over the panel.
    expect(m.starts.map((x) => x.vt)).toEqual(["dialog", "dialog"]);
    expect(m.pseudo["::view-transition-group(pk-dialog)"]?.duration).toBe(
      MODERATE,
    );
    expect(m.pseudo["::view-transition-old(pk-dialog)"]).toMatchObject({
      name: "pk-fade-out",
      duration: FAST,
    });
    expect(m.pseudo["::view-transition-new(pk-dialog)"]).toMatchObject({
      name: "pk-fade-in",
      duration: BASE,
      delay: MICRO,
    });
    // The success moment: the check draws, six sparks burst, once.
    const first = await log(page);
    expect(
      starts(first, "check", "pk-draw").map((e) => [e.duration, e.delay]),
    ).toEqual([[MODERATE, FAST]]);
    const sparks = starts(first, "spark", "pk-burst");
    expect(sparks).toHaveLength(6);
    expect(sparks.every((e) => e.duration === DELIBERATE)).toBe(true);
    expect(await page.locator(".pk-burst").count()).toBe(0);
    expect(await running(page)).toEqual([]);
    expect(await page.evaluate((k) => localStorage.getItem(k), MOMENT)).toBe(
      "1",
    );
    expect(await axe(page)).toEqual([]);

    // A second add, another product: the check only.
    await page.getByRole("button", { name: "Activate another" }).click();
    await activate(page, KEY2, "Quill");
    await atRest(page);
    const second = await log(page);
    expect(starts(second, "spark")).toEqual([]);
    expect(starts(second, "check")).toEqual([]);
    expect(
      await page
        .getByRole("dialog")
        .locator(".pk-celebration[data-static]")
        .count(),
    ).toBe(1);
    m = await state(page);
    expect(m.starts.every((x) => x.vt === "dialog")).toBe(true);
    expect(await running(page)).toEqual([]);
    expect(await s.violations()).toEqual([]);
    await s.close();
  });

  it("saves the Done step's frames (PK_SHOTS_DIR)", async () => {
    if (!SHOTS) return;
    const s = await open("three", "/", { routes: activateRoutes() });
    const { page } = s;
    await page.getByRole("button", { name: "Activate license" }).click();
    const dialog = page.getByRole("dialog", { name: "Activate a license" });
    await dialog.getByRole("textbox", { name: "License key" }).fill(KEY);
    await dialog.getByRole("button", { name: "Continue" }).click();
    const add = page.getByRole("button", { name: "Add Mossgarden" });
    await add.waitFor();
    await atRest(page);
    await strip(page, "activate-done", () => add.click(), 8, 250);
    await s.close();
  });

  it("FreeDevicePage's success draws the check, with no sparks and no transition", async () => {
    const s = await open(
      "twelve",
      "/#/p/orbit-survey/free-device?return=orbitsurvey%3A%2F%2Fretry",
    );
    const { page } = s;
    await page
      .getByRole("heading", {
        level: 1,
        name: "Your license is on 2 of 2 devices",
      })
      .waitFor();
    await atRest(page);
    await log(page);
    await page.getByRole("button", { name: "Remove Work laptop" }).click();
    await page
      .getByRole("heading", { level: 1, name: "Work laptop was removed" })
      .waitFor();
    await expect.poll(() => focused(page)).toBe("H1:Work laptop was removed");
    await atRest(page);
    const e = await log(page);
    expect(starts(e, "check", "pk-draw").map((x) => x.duration)).toEqual([
      MODERATE,
    ]);
    expect(starts(e, "spark")).toEqual([]);
    expect((await state(page)).starts).toEqual([]);
    expect(await running(page)).toEqual([]);
    expect(await axe(page)).toEqual([]);
    expect(await s.violations()).toEqual([]);
    await s.close();
  });
});

// ── Reduced motion: instant swaps to the same end states (S-23 D3) ───────────────────────────

const REDUCED: { name: string; o: OpenOptions }[] = [
  { name: "prefers-reduced-motion", o: { motion: "reduce" } },
  {
    name: 'html[data-motion="reduce"]',
    o: { motion: "no-preference", dataMotion: true },
  },
];

describe("reduced motion: every change in scope is an instant swap to the same end state", () => {
  for (const { name, o } of REDUCED)
    it(`${name}: expand, removal, count and meter`, async () => {
      const s = await open("three", "/#/p/nightfall/devices", o);
      const { page } = s;
      await page.getByText("Studio PC").first().waitFor();
      if (o.dataMotion)
        expect(
          await page.evaluate(() => document.documentElement.dataset.motion),
        ).toBe("reduce");
      expect(await running(page), "load").toEqual([]);
      await page
        .getByRole("button", { name: "Remove Studio PC" })
        .first()
        .click();
      await page.getByRole("heading", { name: "Remove Studio PC?" }).waitFor();
      expect(await running(page), "expand").toEqual([]);
      await expect.poll(() => focused(page)).toBe("H3:Remove Studio PC?");
      await page
        .getByRole("button", { name: "Remove Studio PC", exact: true })
        .last()
        .click();
      await expect.poll(() => deviceRows(page)).toEqual(["Mara's MacBook Pro"]);
      expect(await running(page), "removal").toEqual([]);
      const devices = page.getByRole("region", { name: "Devices" });
      expect(
        await devices.locator("[data-count-up] [aria-hidden]").textContent(),
      ).toBe("1");
      await devices
        .getByRole("img", { name: "1 of 3 devices in use" })
        .waitFor();
      await expect.poll(() => focused(page)).toBe("H1:Nightfall");
      expect(await page.locator("#pk-announcer").textContent()).toContain(
        "Studio PC was removed. 1 of 3 devices in use.",
      );
      const m = await state(page);
      expect(m.starts, "a View Transition started").toEqual([]);
      expect(m.vt, "html[data-vt] was set").toEqual([]);
      expect(
        m.log.filter((e) => e.duration > 0 || e.delay > 0),
        "something animated with a duration",
      ).toEqual([]);
      expect(await page.locator("[data-changed]").count()).toBe(0);
      expect(await s.violations()).toEqual([]);
      await s.close();
    });

  for (const { name, o } of REDUCED)
    it(`${name}: the Activate steps swap, Done shows a still check, and the moment is spent`, async () => {
      const claim = latch();
      const s = await open("three", "/", {
        ...o,
        routes: activateRoutes(claim),
      });
      const { page } = s;
      await page
        .getByRole("heading", { level: 1, name: "Your library" })
        .waitFor();
      await page.getByRole("button", { name: "Activate license" }).click();
      await activate(page, KEY, "Mossgarden", {
        claim,
        // The busy Add button's spinner is a still ring (S-23 D3: loading indicators stand still).
        check: async () => {
          await expect.poll(() => spinners(page)).not.toEqual([]);
          for (const sp of await spinners(page))
            expect(sp).toEqual({ animation: "none", running: 0 });
        },
      });
      expect(await running(page), "done").toEqual([]);
      await expect
        .poll(() => focused(page))
        .toBe("H2:Mossgarden is in your library");
      expect(
        await page
          .getByRole("dialog")
          .locator(".pk-celebration[data-static]")
          .count(),
      ).toBe(1);
      expect(await page.locator(".pk-burst").count()).toBe(0);
      expect(await page.evaluate((k) => localStorage.getItem(k), MOMENT)).toBe(
        "1",
      );
      const m = await state(page);
      expect(m.starts).toEqual([]);
      expect(m.vt).toEqual([]);
      expect(m.log.filter((e) => e.duration > 0 || e.delay > 0)).toEqual([]);
      expect(await s.violations()).toEqual([]);
      await s.close();
    });

  for (const { name, o } of REDUCED)
    it(`${name}: FreeDevicePage's success is a still check`, async () => {
      const s = await open(
        "twelve",
        "/#/p/orbit-survey/free-device?return=orbitsurvey%3A%2F%2Fretry",
        o,
      );
      const { page } = s;
      await page.getByRole("button", { name: "Remove Work laptop" }).click();
      await page
        .getByRole("heading", { level: 1, name: "Work laptop was removed" })
        .waitFor();
      expect(await running(page)).toEqual([]);
      await expect.poll(() => focused(page)).toBe("H1:Work laptop was removed");
      const m = await state(page);
      expect(m.starts).toEqual([]);
      expect(m.log.filter((e) => e.duration > 0 || e.delay > 0)).toEqual([]);
      expect(await s.violations()).toEqual([]);
      await s.close();
    });
});
