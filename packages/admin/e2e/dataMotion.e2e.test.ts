import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";

/**
 * The console's data surfaces in motion (notes/S-23 §6.1 list, status, meter, skeleton; MO-09), in
 * the BUILT console under the Worker's exact CSP, on a 60-row Licenses table:
 *
 *   - a facet filter runs ONE `list` View Transition that names at most LIST_BUDGET (30) rows
 *     (only the rows on screen, since 60 is over the budget) and MOVES the surviving rows: React
 *     keeps the keyed row elements, so each survivor pairs with itself (an old and a new picture
 *     in one group) instead of leaving and coming back;
 *   - Clear filters brings the hidden rows back as entering rows, after the survivors land
 *     (`micro` + `base`, then `fast`);
 *   - an open facet menu stays above the moving rows (it is named for the transition);
 *   - a new filter chip pops in, a removed one fades out and then leaves the DOM;
 *   - the bulk-action bar enters and exits on the tokens and leaves the DOM after its exit;
 *   - a seat meter's fill draws its share by transform (a fifth of its track);
 *   - with prefers-reduced-motion, and with html[data-motion="reduce"] (the in-app preference,
 *     MO-12), every one of these is an instant swap: no View Transition starts, nothing animates,
 *     and `document.getAnimations()` is empty right after each interaction;
 *   - zero `securitypolicyviolation` events throughout.
 *
 * With `PK_SHOTS_DIR` set it also saves frame strips (animations slowed ×0.1 over the DevTools
 * protocol) of the filter, Clear filters and the bulk bar, for review (MO-13 collects them).
 *
 * Kept apart from e2e/motion.e2e.test.ts (as e2e/shellMotion.e2e.test.ts is) so the area packages
 * built in parallel do not collide in one file.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const LIST_BUDGET = 30;
const SHOTS = process.env.PK_SHOTS_DIR;

const NOW = Math.floor(Date.now() / 1000);
/** 60 licenses: every third one is disabled, the rest active. */
const LICENSES = Array.from({ length: 60 }, (_, i) => ({
  id: `lic_${i + 1}`,
  name: `Seat ${String(i + 1).padStart(2, "0")}`,
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
}));
const ROUTES: Record<string, unknown> = {
  ...CORE_ROUTES,
  "/manage/api/products/djdl/license/licenses": { licenses: LICENSES },
  "/manage/api/products/djdl/license/tiers": { tiers: [] },
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

async function openLicenses(
  opts: {
    theme?: "dark" | "light";
    motion?: Motion;
    dataMotion?: boolean;
  } = {},
): Promise<Page> {
  const theme = opts.theme ?? "dark";
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: theme,
    reducedMotion: opts.motion ?? "no-preference",
  });
  await ctx.addInitScript(
    ([t, dataMotion]) => {
      window.localStorage.setItem("pk-admin-theme", t as string);
      const w = window as unknown as { __v: string[] };
      w.__v = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        w.__v.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`),
      );
      // The in-app preference (MO-12), before the app's first paint.
      if (dataMotion)
        document.addEventListener("readystatechange", () =>
          document.documentElement.setAttribute("data-motion", "reduce"),
        );
    },
    [theme, opts.dataMotion ?? false] as const,
  );
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
  await page.goto(`${base}/manage.html#/p/djdl/license/licenses`);
  await page.getByText("Seat 01", { exact: true }).waitFor();
  if (opts.dataMotion)
    expect(
      await page.evaluate(() => document.documentElement.dataset.motion),
    ).toBe("reduce");
  await installProbe(page);
  await atRest(page);
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

// ── The in-page probe ─────────────────────────────────────────────────────────────────────────────

interface AnimEvent {
  phase: "start" | "end" | "cancel";
  name: string;
  duration: number;
  delay: number;
  state: string | null;
  tag: string;
  connected: boolean;
}

/** One View Transition, seen from inside the page. */
interface VtRecord {
  type: string | null;
  /** Rows of the table body named when the transition started (computed name ≠ none). */
  namedBefore: number;
  /** Rows on screen when it started. */
  onScreen: number;
  /** Named rows once the update had run. */
  namedAfter: number;
  /** Elements named both before and after: survivors, paired with themselves. */
  survivors: number;
  /** Every `::view-transition-*` animation seen while it ran: pseudo, name and timing. */
  pseudo: { pseudo: string; name: string; duration: number; delay: number }[];
  done: boolean;
}

interface Probe {
  log: AnimEvent[];
  vt: (string | null)[];
  runs: VtRecord[];
}

/**
 * Record every CSS animation (resolved timing at its start), every change of html[data-vt] and
 * every View Transition the app starts (by wrapping document.startViewTransition: the layer reads
 * it at call time). Installed over the DevTools protocol after load, so the page's CSP is untouched.
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __m: Probe };
    if (w.__m) return;
    w.__m = { log: [], vt: [], runs: [] };
    const timings = new WeakMap<Element, Map<string, EffectTiming>>();
    const record =
      (phase: AnimEvent["phase"]) =>
      (e: Event): void => {
        const ev = e as AnimationEvent;
        if (ev.pseudoElement) return;
        const el = ev.target as Element;
        const anim = el
          .getAnimations?.()
          .find((a) => (a as CSSAnimation).animationName === ev.animationName);
        let byName = timings.get(el);
        if (!byName) timings.set(el, (byName = new Map()));
        const timing =
          anim?.effect?.getTiming() ?? byName.get(ev.animationName);
        if (timing) byName.set(ev.animationName, timing);
        w.__m.log.push({
          phase,
          name: ev.animationName,
          duration: Number(timing?.duration ?? Number.NaN),
          delay: Number(timing?.delay ?? 0),
          state: el.getAttribute("data-state"),
          tag: el.tagName.toLowerCase(),
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

    const doc = document as unknown as {
      startViewTransition?: (update: () => void) => {
        finished: Promise<void>;
      };
    };
    const original = doc.startViewTransition?.bind(document);
    if (!original) return;
    const rows = (): Element[] =>
      Array.from(document.querySelectorAll("main#content tbody > tr"));
    const named = (): Element[] =>
      rows().filter((r) => getComputedStyle(r).viewTransitionName !== "none");
    doc.startViewTransition = (update: () => void) => {
      const vh = window.innerHeight;
      const before = named();
      const run: VtRecord = {
        type: document.documentElement.getAttribute("data-vt"),
        namedBefore: before.length,
        onScreen: rows().filter((r) => {
          const b = r.getBoundingClientRect();
          return b.bottom > 0 && b.top < vh;
        }).length,
        namedAfter: 0,
        survivors: 0,
        pseudo: [],
        done: false,
      };
      w.__m.runs.push(run);
      const seen = new Map<string, VtRecord["pseudo"][number]>();
      let polling = true;
      const poll = (): void => {
        document.getAnimations().forEach((a, i) => {
          const pseudo = (a.effect as KeyframeEffect | null)?.pseudoElement;
          if (!pseudo?.startsWith("::view-transition")) return;
          const t = a.effect!.getTiming();
          seen.set(`${i}:${pseudo}`, {
            pseudo,
            name: (a as CSSAnimation).animationName ?? "",
            duration: Number(t.duration),
            delay: Number(t.delay ?? 0),
          });
        });
        if (polling) requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
      const t = original(() => {
        update();
        const after = named();
        run.namedAfter = after.length;
        run.survivors = before.filter((el) => after.includes(el)).length;
      });
      void t.finished
        .catch(() => undefined)
        .then(() => {
          polling = false;
          run.pseudo = [...seen.values()];
          run.done = true;
        });
      return t;
    };
  });
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => {
    const m = (window as unknown as { __m: Probe }).__m;
    return JSON.parse(JSON.stringify(m)) as Probe;
  });
const takeLog = (page: Page): Promise<AnimEvent[]> =>
  page.evaluate(() => (window as unknown as { __m: Probe }).__m.log.splice(0));
const takeRuns = async (page: Page): Promise<VtRecord[]> => {
  await page
    .waitForFunction(
      () => (window as unknown as { __m: Probe }).__m.runs.every((r) => r.done),
      null,
      { timeout: 5000 },
    )
    .catch(() => undefined);
  return page.evaluate(() =>
    (window as unknown as { __m: Probe }).__m.runs.splice(0),
  );
};

/** Animations running anywhere in the document right now (pseudo-elements included). */
const running = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document
      .getAnimations()
      .map(
        (a) =>
          `${(a as CSSAnimation).animationName ?? a.constructor.name}${
            (a.effect as KeyframeEffect | null)?.pseudoElement ?? ""
          }`,
      ),
  );

async function atRest(page: Page, timeout = 3000): Promise<void> {
  await page
    .waitForFunction(() => document.getAnimations().length === 0, null, {
      timeout,
    })
    .catch(() => undefined);
}

/** The resolved motion tokens in ms (0 under reduced motion). */
async function tokens(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const out: Record<string, number> = {};
    for (const k of ["micro", "fast", "base", "slow"]) {
      const raw = cs.getPropertyValue(`--pk-duration-${k}`).trim();
      const n = parseFloat(raw);
      out[k] = raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
    }
    return out;
  });
}

const bodyRowCount = (page: Page): Promise<number> =>
  page.locator("main#content tbody > tr[data-row-id]").count();

async function openStatusMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Filter by status" }).click();
  await page.getByRole("checkbox", { name: /^Disabled/ }).waitFor();
  await atRest(page);
}

// ── Motion on ─────────────────────────────────────────────────────────────────────────────────────

describe("motion on: the Licenses table under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`a facet filter on 60 rows names at most 30 and moves the survivors; Clear filters brings rows back after them (${theme})`, async () => {
      const page = await openLicenses({ theme });
      const tk = await tokens(page);
      expect(await bodyRowCount(page)).toBe(60);
      await openStatusMenu(page);
      await takeRuns(page);

      await page.getByRole("checkbox", { name: /^Disabled/ }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("main#content tbody > tr[data-row-id]")
            .length === 20,
      );
      const [run, ...more] = await takeRuns(page);
      expect(more, "one transition per filter").toEqual([]);
      expect(run!.type).toBe("list");
      expect(run!.namedBefore).toBeGreaterThan(0);
      expect(run!.namedBefore).toBeLessThanOrEqual(LIST_BUDGET);
      expect(run!.namedBefore, "over the budget: only the rows on screen").toBe(
        run!.onScreen,
      );
      expect(run!.namedAfter).toBeLessThanOrEqual(LIST_BUDGET);
      // Survivors keep their element, so each is one group with an old and a new picture (the UA
      // cross-fade), not an old-only exit plus a new-only entry.
      expect(run!.survivors, "surviving rows move").toBeGreaterThan(0);
      const paired = run!.pseudo.filter(
        (p) =>
          p.pseudo.startsWith("::view-transition-new(") &&
          p.name.startsWith("-ua-view-transition-fade-in"),
      );
      expect(paired.length).toBeGreaterThanOrEqual(run!.survivors);
      const moved = run!.pseudo.filter(
        (p) =>
          p.pseudo.startsWith("::view-transition-group(") &&
          p.name.startsWith("-ua-view-transition-group-anim"),
      );
      expect(moved.length).toBeGreaterThanOrEqual(run!.survivors);
      // The filtered-out rows on screen leave by a `micro` fade.
      expect(
        run!.pseudo.some(
          (p) =>
            p.pseudo.startsWith("::view-transition-old(") &&
            p.name === "pk-fade-out" &&
            p.duration === tk.micro,
        ),
      ).toBe(true);
      // The facet menu stayed open and above the rows.
      await expect
        .poll(() =>
          page.getByRole("checkbox", { name: /^Disabled/ }).isChecked(),
        )
        .toBe(true);
      const after = await probe(page);
      expect(after.vt).toEqual(["list", null]);
      expect(
        await page.evaluate(
          () =>
            Array.from(
              document.querySelectorAll("main#content tbody > tr"),
            ).filter((r) => getComputedStyle(r).viewTransitionName !== "none")
              .length,
        ),
        "the names are gone after the transition",
      ).toBe(0);
      await atRest(page);
      expect(await running(page)).toEqual([]);

      // Clear filters: the hidden rows come back as entering rows, after the survivors land.
      await page.keyboard.press("Escape");
      await atRest(page);
      await takeRuns(page);
      await page.getByRole("button", { name: "Clear filters" }).first().click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("main#content tbody > tr[data-row-id]")
            .length === 60,
      );
      const [back] = await takeRuns(page);
      expect(back!.type).toBe("list");
      expect(back!.namedBefore).toBeLessThanOrEqual(LIST_BUDGET);
      // 60 rows again: the new state names only the rows on screen.
      expect(back!.namedAfter).toBeGreaterThan(0);
      expect(back!.namedAfter).toBeLessThanOrEqual(LIST_BUDGET);
      const entering = back!.pseudo.filter(
        (p) =>
          p.pseudo.startsWith("::view-transition-new(") &&
          p.name === "pk-enter",
      );
      expect(entering.length, "rows come back in").toBeGreaterThan(0);
      for (const e of entering)
        expect([e.duration, e.delay]).toEqual([tk.fast, tk.micro + tk.base]);
      await atRest(page);
      expect(await running(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });
  }

  it("a new chip pops in; a removed one fades out, then leaves the DOM; the last one goes with its row", async () => {
    const page = await openLicenses();
    const tk = await tokens(page);
    await openStatusMenu(page);
    await takeLog(page);
    await page.getByRole("checkbox", { name: /^Disabled/ }).click();
    await page.getByRole("checkbox", { name: /^Active/ }).click();
    const chipOf = (label: string) =>
      page
        .getByRole("button", { name: `Remove filter Status: ${label}` })
        .locator("xpath=ancestor::li[1]");
    await chipOf("Active").waitFor();
    await atRest(page);
    const pop = (await takeLog(page)).filter(
      (e) => e.phase === "end" && e.tag === "li" && e.name === "pk-pop-in",
    );
    expect(pop.map((e) => e.duration)).toEqual([tk.slow, tk.slow]);

    await page.keyboard.press("Escape");
    await atRest(page);
    await takeLog(page);
    const disabled = chipOf("Disabled");
    const handle = await disabled.elementHandle();
    await page
      .getByRole("button", { name: "Remove filter Status: Disabled" })
      .click();
    await page.waitForFunction((el) => !el!.isConnected, handle);
    await atRest(page);
    const out = (await takeLog(page)).filter(
      (e) => e.phase === "end" && e.tag === "li" && e.name === "pk-fade-out",
    );
    expect(
      out.map((e) => [e.duration, e.state, e.connected]),
      "the chip faded out while still in the DOM",
    ).toEqual([[tk.base, "closed", true]]);

    // The last chip goes at once with its row, so the row never collapses after a list
    // transition has captured the page.
    await takeLog(page);
    await page
      .getByRole("button", { name: "Remove filter Status: Active" })
      .click();
    await page
      .getByRole("list", { name: "Active filters" })
      .waitFor({ state: "detached" });
    await atRest(page);
    expect(
      (await takeLog(page)).filter((e) => e.name === "pk-fade-out"),
    ).toEqual([]);
    expect(await running(page)).toEqual([]);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("the bulk-action bar enters and exits on the tokens, then the filter bar returns", async () => {
    const page = await openLicenses();
    const tk = await tokens(page);
    await takeLog(page);
    await page.getByRole("checkbox", { name: "Select Seat 01" }).click();
    const bar = page.getByText("1 selected").locator("xpath=..");
    await bar.waitFor();
    await atRest(page);
    expect(
      (await takeLog(page))
        .filter((e) => e.phase === "end" && e.name === "pk-enter")
        .map((e) => [e.duration, e.state]),
    ).toEqual([[tk.slow, "open"]]);
    expect(await page.getByRole("searchbox").count()).toBe(0);

    await page.getByRole("button", { name: "Clear selection" }).click();
    await bar.waitFor({ state: "detached" });
    await page.getByRole("searchbox").waitFor();
    await atRest(page);
    expect(
      (await takeLog(page))
        .filter((e) => e.phase === "end" && e.name === "pk-exit")
        .map((e) => [e.duration, e.state, e.connected]),
      "the bar's exit ran to its end with the node still in the DOM",
    ).toEqual([[tk.base, "closed", true]]);
    // A re-hover after the filter bar returns under the pointer starts hover transitions up to
    // ~100 ms after layout (seen once on the CI runner); they must still all end.
    await expect.poll(() => running(page), { timeout: 3000 }).toEqual([]);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("a seat meter's fill draws its share by transform: a fifth of its track", async () => {
    const page = await openLicenses();
    const box = await page.evaluate(() => {
      const meter = document.querySelector(
        'main#content tbody [role="meter"]',
      )!;
      const [track, fill] = Array.from(meter.querySelectorAll("svg rect"));
      const t = track!.getBoundingClientRect();
      const f = fill!.getBoundingClientRect();
      return {
        width: fill!.getAttribute("width"),
        transform: getComputedStyle(fill!).transform,
        ratio: f.width / t.width,
        left: f.left - t.left,
      };
    });
    expect(box.width).toBe("100%");
    expect(box.transform).toMatch(/^matrix\(0\.2, 0, 0, 1, /);
    expect(box.ratio).toBeCloseTo(0.2, 2);
    expect(Math.abs(box.left)).toBeLessThan(0.5);
    expect(await running(page)).toEqual([]);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });
});

// ── Frame strips for review (PK_SHOTS_DIR) ──────────────────────────────────────────────────────

describe.skipIf(!SHOTS)("frame strips", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`saves the filter, Clear filters and bulk-bar frames (${theme})`, async () => {
      mkdirSync(SHOTS!, { recursive: true });
      const page = await openLicenses({ theme });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Animation.enable");
      const strip = async (
        name: string,
        act: () => Promise<void>,
      ): Promise<void> => {
        await atRest(page);
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
        await act();
        for (const [i, ms] of [30, 600, 1200, 1800, 2600, 3600].entries()) {
          await page.waitForTimeout(
            i === 0 ? ms : ms - [30, 600, 1200, 1800, 2600][i - 1]!,
          );
          await page.screenshot({
            path: `${SHOTS}/console-data-${name}-${theme}-${i + 1}.png`,
          });
        }
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
        await atRest(page, 6000);
      };
      await openStatusMenu(page);
      await strip("filter", () =>
        page.getByRole("checkbox", { name: /^Disabled/ }).click(),
      );
      await page.keyboard.press("Escape");
      await strip("clear", () =>
        page.getByRole("button", { name: "Clear filters" }).first().click(),
      );
      await strip("bulk-bar-in", () =>
        page.getByRole("checkbox", { name: "Select Seat 01" }).click(),
      );
      await strip("bulk-bar-out", () =>
        page.getByRole("button", { name: "Clear selection" }).click(),
      );
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });
  }
});

// ── Reduced motion: instant swaps (S-23 D3) ──────────────────────────────────────────────────────

describe("reduced motion: every data-surface change is an instant swap", () => {
  for (const variant of [
    { label: "prefers-reduced-motion", motion: "reduce" as Motion },
    {
      label: 'html[data-motion="reduce"]',
      motion: "no-preference" as Motion,
      dataMotion: true,
    },
  ]) {
    it(`no transition starts and nothing animates: filter, chip, clear, bulk bar (${variant.label})`, async () => {
      const page = await openLicenses(variant);
      const tk = await tokens(page);
      expect(
        Object.values(tk).every((v) => v === 0),
        JSON.stringify(tk),
      ).toBe(true);
      await takeLog(page);
      await takeRuns(page);

      const swapped = async (what: string): Promise<void> => {
        expect(await running(page), `${what}: still animating`).toEqual([]);
      };

      await page.getByRole("button", { name: "Filter by status" }).click();
      const disabled = page.getByRole("checkbox", { name: /^Disabled/ });
      await disabled.waitFor();
      await swapped("facet menu");
      await disabled.click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("main#content tbody > tr[data-row-id]")
            .length === 20,
      );
      await swapped("filter");
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Remove filter Status: Disabled" })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("main#content tbody > tr[data-row-id]")
            .length === 60,
      );
      expect(
        await page
          .getByRole("button", { name: "Remove filter Status: Disabled" })
          .count(),
        "the chip went at once",
      ).toBe(0);
      await swapped("chip removed");

      await page.getByRole("checkbox", { name: "Select Seat 01" }).click();
      await page.getByText("1 selected").waitFor();
      await swapped("bulk bar in");
      await page.getByRole("button", { name: "Clear selection" }).click();
      expect(
        await page.getByText("1 selected").count(),
        "the bar went at once",
      ).toBe(0);
      await page.getByRole("searchbox").waitFor();
      await swapped("bulk bar out");

      const p = await probe(page);
      expect(p.runs, "no View Transition started").toEqual([]);
      expect(p.vt, "html[data-vt] was never set").toEqual([]);
      expect(
        p.log.filter((e) => e.duration > 0),
        "an animation ran with a duration",
      ).toEqual([]);
      expect(await violations(page)).toEqual([]);
      await page.context().close();
    });
  }
});
