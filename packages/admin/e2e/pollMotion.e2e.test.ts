import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { atRest } from "./atRest.js";
import { fixtureImage, IMG_ORIGIN, resolve } from "./layoutFixtures.js";
import { frameStrip, SHOTS } from "./strips.js";
import { closeContext } from "./teardown.js";
import { startPortal, type PortalHarness } from "./portalHarness.js";

/**
 * MO-13.5: the 30-second poll and the list audit, in the BUILT console under the Worker's CSP.
 *
 * Platform → Status refetches `/platform/operations` and `/platform/deployment` every
 * `OPERATIONS_REFRESH_MS` (30 s; `platformStatus.tsx`). The page's clock is driven by
 * `page.clock.fastForward(30_000)`, so the real interval fires, in both themes and under
 * prefers-reduced-motion:
 *
 *   - an UNCHANGED poll (only `generatedAt` moves) starts no animation, no transition, no View
 *     Transition and tints nothing;
 *   - a CHANGED poll (a queue backlog, a failed job) starts no View Transition and tints no row
 *     (the page has no `highlight()` and no list transition): the one cue is a status pill whose
 *     WORD changes, which pops in once (`pk-pop-in`); every pill, row and Checks line that
 *     appears or moves does so at once. Under reduced motion nothing animates.
 *
 * The list audit measures, from the `::view-transition-*` animations of one transition, whether
 * entering items start before the moving survivors have landed (a crossing) on the lists whose
 * rows enter while others move: the Licenses table (holder-state and facet filters), Platform →
 * Members, and the Library's Grid/List switch. The portal's Devices card carries the same class
 * (`pk-vt-table`), checked in the DOM.
 *
 * With `PK_SHOTS_DIR` set it also saves strips: `poll-unchanged-*`, `poll-changed-*`,
 * `members-filter-*`, `members-clear-*` (dark, light, reduced).
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders(new Headers(), {
  imgOrigin: IMG_ORIGIN,
}).get("content-security-policy")!;
const POLL = 30_000;

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

type Variant = "dark" | "light" | "reduced";
const VARIANTS: Variant[] = ["dark", "light", "reduced"];

interface Served {
  /** Requests answered per pathname. */
  hits: Record<string, number>;
  /** Replies that replace the fixtures'. */
  override: Record<string, unknown>;
}

async function openConsole(
  variant: Variant,
  hash: string,
  waitFor: string,
  o: { clock?: boolean } = {},
): Promise<{ page: Page; served: Served }> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: variant === "light" ? "light" : "dark",
    reducedMotion: variant === "reduced" ? "reduce" : "no-preference",
  });
  const served: Served = { hits: {}, override: {} };
  await ctx.addInitScript(() => {
    const w = window as unknown as { __v: string[] };
    w.__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__v.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
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
      served.hits[url.pathname] = (served.hits[url.pathname] ?? 0) + 1;
      if (route.request().method() !== "GET")
        return route.fulfill({ json: { ok: true } });
      const body = served.override[url.pathname] ?? resolve(url.pathname);
      return body === undefined
        ? route.fulfill({ status: 404, json: { error: "not_found" } })
        : route.fulfill({ json: body });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  if (o.clock) await page.clock.install();
  await page.goto(`${base}/manage.html${hash}`);
  await page.getByText(waitFor, { exact: true }).first().waitFor({
    timeout: 15_000,
  });
  await installProbe(page);
  await atRest(page);
  return { page, served };
}

// ── The in-page probe ───────────────────────────────────────────────────────────────────────────

interface Pseudo {
  pseudo: string;
  name: string;
  duration: number;
  delay: number;
  /** A group animation whose box or transform changes: a survivor that moves. */
  moved: boolean;
}
interface Started {
  kind: "animation" | "transition";
  name: string;
  /** The target's tag and its first 24 characters of text. */
  target: string;
}
interface Probe {
  started: Started[];
  vt: (string | null)[];
  runs: { pseudo: Pseudo[]; done: boolean }[];
}

async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __m: Probe };
    w.__m = { started: [], vt: [], runs: [] };
    const target = (e: Event): string => {
      const el = e.target as Element;
      return `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 24)}`;
    };
    document.addEventListener(
      "animationstart",
      (e) => {
        const ev = e as AnimationEvent;
        if (ev.pseudoElement || /shimmer|spin/.test(ev.animationName)) return;
        w.__m.started.push({
          kind: "animation",
          name: ev.animationName,
          target: target(e),
        });
      },
      true,
    );
    document.addEventListener(
      "transitionstart",
      (e) => {
        const ev = e as TransitionEvent;
        if (ev.pseudoElement) return;
        w.__m.started.push({
          kind: "transition",
          name: ev.propertyName,
          target: target(e),
        });
      },
      true,
    );
    new MutationObserver(() =>
      w.__m.vt.push(document.documentElement.getAttribute("data-vt")),
    ).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-vt"],
    });
    const doc = document as unknown as {
      startViewTransition?: (...a: unknown[]) => { finished: Promise<void> };
    };
    const original = doc.startViewTransition?.bind(document);
    if (!original) return;
    doc.startViewTransition = (...args: unknown[]) => {
      const run: Probe["runs"][number] = { pseudo: [], done: false };
      w.__m.runs.push(run);
      const seen = new Map<string, Pseudo>();
      let polling = true;
      const poll = (): void => {
        document.getAnimations().forEach((a, i) => {
          const pseudo = (a.effect as KeyframeEffect | null)?.pseudoElement;
          if (!pseudo?.startsWith("::view-transition")) return;
          const t = a.effect!.getTiming();
          const kf = (a.effect as KeyframeEffect).getKeyframes();
          const first = kf[0] as Record<string, unknown> | undefined;
          const last = kf[kf.length - 1] as Record<string, unknown> | undefined;
          const moved =
            pseudo.startsWith("::view-transition-group(") &&
            (["transform", "width", "height"] as const).some(
              (p) => first?.[p] !== last?.[p],
            );
          seen.set(`${i}:${pseudo}`, {
            pseudo,
            name: (a as CSSAnimation).animationName ?? "",
            duration: Number(t.duration),
            delay: Number(t.delay ?? 0),
            moved,
          });
        });
        if (polling) requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
      const t = (original as (...a: unknown[]) => { finished: Promise<void> })(
        ...args,
      );
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
  page.evaluate(
    () =>
      JSON.parse(
        JSON.stringify((window as unknown as { __m: Probe }).__m),
      ) as Probe,
  );
const reset = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const m = (window as unknown as { __m: Probe }).__m;
    m.started.length = 0;
    m.vt.length = 0;
    m.runs.length = 0;
  });
const doneRuns = async (page: Page): Promise<Probe["runs"]> => {
  await page
    .waitForFunction(
      () => (window as unknown as { __m: Probe }).__m.runs.every((r) => r.done),
      null,
      { timeout: 6000 },
    )
    .catch(() => undefined);
  return (await probe(page)).runs;
};
const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v);
const running = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document
      .getAnimations()
      .map((a) => (a as CSSAnimation).animationName ?? "")
      .filter((n) => !/spin|shimmer/.test(n)),
  );

/**
 * Does an entering item start before the moving survivors have landed? Every named element shows
 * as `match-element` in the pseudo selector, so the animations are told apart by name: an entering
 * item is a `new` picture on `pk-enter` (the `:only-child` rule), a leaving one an `old` picture on
 * `pk-fade-out`, a survivor that moves a `group` animation whose box or transform changes (the main
 * region, `pk-main`, is the page around the list and is left out).
 */
interface Crossing {
  entering: number;
  leaving: number;
  movedSurvivors: number;
  /** Entering items by start delay: "delay+duration" -> count. */
  enterTimings: Record<string, number>;
  /** The latest end (delay + duration) of a moving survivor's group, ms. */
  survivorsEnd: number | null;
  /** An entering item starts before the survivors have landed. */
  crossing: boolean;
}
function crossingOf(pseudo: Pseudo[]): Crossing {
  const entering = pseudo.filter(
    (p) =>
      p.pseudo.startsWith("::view-transition-new(") && p.name === "pk-enter",
  );
  const moved = pseudo.filter(
    (p) =>
      p.pseudo.startsWith("::view-transition-group(") &&
      !p.pseudo.includes("(pk-main)") &&
      p.moved,
  );
  const survivorsEnd = moved.length
    ? Math.max(...moved.map((p) => p.delay + p.duration))
    : null;
  const enterTimings: Record<string, number> = {};
  for (const p of entering)
    enterTimings[`${p.delay}+${p.duration}`] =
      (enterTimings[`${p.delay}+${p.duration}`] ?? 0) + 1;
  return {
    entering: entering.length,
    leaving: pseudo.filter(
      (p) =>
        p.pseudo.startsWith("::view-transition-old(") &&
        p.name === "pk-fade-out",
    ).length,
    movedSurvivors: moved.length,
    enterTimings,
    survivorsEnd,
    crossing:
      survivorsEnd !== null && entering.some((p) => p.delay < survivorsEnd),
  };
}

// ── Platform → Status: the 30-second poll ────────────────────────────────────────────────────────

type Ops = {
  generatedAt: number;
  queues: {
    deltas: { backlogCount: number };
    deadLetter: {
      backlogCount: number;
      oldestMessageAt: number | null;
    };
  };
  jobs: {
    latest: {
      connectorPoll: {
        outcome: string;
        steps: { step: string; outcome: string; error?: string }[];
      };
    };
  };
};
const OPS = "/manage/api/platform/operations";
const DEPLOY = "/manage/api/platform/deployment";

/** The Status page's visible facts: area words, queue lines, check titles, job meta. */
const facts = (page: Page) =>
  page.evaluate(() => {
    const text = (sel: string): string[] =>
      Array.from(document.querySelectorAll(sel)).map((e) =>
        (e.textContent ?? "").replace(/\s+/g, " ").trim(),
      );
    const area = (label: string): string[] =>
      text(`ul[aria-label="${label}"] > li`);
    return {
      areas: area("Health by area"),
      queues: area("Queues"),
      jobs: area("Scheduled jobs"),
      checks: text("main#content table tbody tr").map((t) => t.slice(0, 80)),
      pills: text("[data-status='pill']"),
    };
  });

/** The top of every row-like line on the page, by its text, so a move shows as a delta. */
const tops = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const el of Array.from(
      document.querySelectorAll(
        "main#content ul[aria-label] > li, main#content table tbody tr",
      ),
    )) {
      const key = (el.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      out[key] = Math.round(el.getBoundingClientRect().top);
    }
    return out;
  });

describe("Platform → Status: the 30-second poll", () => {
  for (const variant of VARIANTS)
    it(`an unchanged poll does nothing; a changed poll pops the changed word and nothing else (${variant})`, async () => {
      const { page, served } = await openConsole(
        variant,
        "#/platform/status",
        "Health by area",
        { clock: true },
      );
      const ops = structuredClone(resolve(OPS)) as Ops;
      served.override[OPS] = ops;
      served.override[DEPLOY] = resolve(DEPLOY);
      await page.getByText("Scheduled jobs", { exact: true }).first().waitFor();
      await atRest(page);
      await reset(page);
      const run = async (name: string, act: () => Promise<void>) => {
        const before = served.hits[OPS] ?? 0;
        const go = async () => {
          await act();
          await expect
            .poll(() => served.hits[OPS] ?? 0, { timeout: 6000 })
            .toBeGreaterThan(before);
          // Let the render and any animation it starts begin.
          await page.waitForTimeout(250);
        };
        if (SHOTS)
          await frameStrip(page, name, go, {
            theme: variant,
            offsets: variant === "reduced" ? [400] : undefined,
          });
        else await go();
      };

      // ── Unchanged: only `generatedAt` moves (as on the Worker, which stamps every read).
      const idle = await facts(page);
      const idleTops = await tops(page);
      ops.generatedAt += POLL / 1000;
      await run("poll-unchanged", () => page.clock.fastForward(POLL));
      const same = await probe(page);
      expect(same.runs, "no View Transition").toEqual([]);
      expect(same.vt, "html[data-vt] never set").toEqual([]);
      expect(same.started, "nothing animates or transitions").toEqual([]);
      expect(await running(page)).toEqual([]);
      expect(
        await page.locator(".pk-row-highlight").count(),
        "nothing tinted",
      ).toBe(0);
      expect(await facts(page)).toEqual(idle);
      expect(await tops(page)).toEqual(idleTops);

      // ── Changed: a queue backlog (4 → 9, dead letters 0 → 3) and a failed connector poll.
      await reset(page);
      ops.generatedAt += POLL / 1000;
      ops.queues.deltas.backlogCount = 9;
      ops.queues.deadLetter.backlogCount = 3;
      ops.queues.deadLetter.oldestMessageAt = ops.generatedAt - 600;
      ops.jobs.latest.connectorPoll.outcome = "failed";
      ops.jobs.latest.connectorPoll.steps = [
        { step: "asc:poll", outcome: "failed", error: "401 from App Store" },
      ];
      await run("poll-changed", () => page.clock.fastForward(POLL));
      const changed = await probe(page);
      const after = await facts(page);
      const afterTops = await tops(page);
      const moved = Object.entries(afterTops)
        .filter(([k, v]) => idleTops[k] !== undefined && idleTops[k] !== v)
        .map(([k, v]) => `${k}: ${idleTops[k]} -> ${v}`);
      const appeared = Object.keys(afterTops).filter(
        (k) => idleTops[k] === undefined,
      );
      // The poll's report, for the QA record (printed once per variant).
      console.info(
        `[poll ${variant}] ` +
          JSON.stringify({
            viewTransitions: changed.runs.length,
            dataVt: changed.vt,
            started: changed.started,
            tinted: await page.locator(".pk-row-highlight").count(),
            before: idle,
            after,
            moved,
            appeared,
          }),
      );
      expect(changed.runs, "no View Transition on a poll").toEqual([]);
      expect(changed.vt).toEqual([]);
      expect(
        await page.locator(".pk-row-highlight, .pk-row").count(),
        "no row is tinted: the page has no highlight()",
      ).toBe(0);
      expect(after).not.toEqual(idle);
      const names = changed.started.map((s) => s.name);
      if (variant === "reduced") {
        expect(changed.started, "an instant swap").toEqual([]);
        expect(await running(page)).toEqual([]);
      } else {
        // The only cue: a pill whose word changed (Scheduled jobs and Update delivery, OK → Degraded) pops once.
        const pops = changed.started.filter((s) => s.name === "pk-pop-in");
        expect(pops.map((p) => p.target)).toEqual([
          "span:Degraded",
          "span:Degraded",
        ]);
        // Everything that started is the pop or a pill's colour easing; no tint, no slide.
        expect(
          names.filter((n) => n !== "pk-pop-in" && !/color/.test(n)),
          JSON.stringify(changed.started),
        ).toEqual([]);
      }
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    });
});

// ── The pill's changed-word pop on a licence record (MO-13.2's status-pill strip) ───────────────

describe("a status pill pops its changed word", () => {
  /** Open a licence record, flip its status on the Worker, refetch past the 30 s stale time. */
  async function flip(id: string, shows: string): Promise<Started[]> {
    const { page, served } = await openConsole(
      "dark",
      `#/p/djdl/license/licenses/${id}`,
      shows,
      { clock: true },
    );
    const key = `/manage/api/products/djdl/license/licenses/${id}`;
    const record = structuredClone(resolve(key)) as Record<string, unknown>;
    await atRest(page);
    await reset(page);
    served.override[key] = { ...record, status: "disabled" };
    await page.clock.fastForward(60_000);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    await page.getByText("Disabled", { exact: true }).first().waitFor();
    await page.waitForTimeout(150);
    const started = (await probe(page)).started;
    await closeContext(page.context());
    return started;
  }

  it("a floating licence's Active pill pops 'Disabled' once (the same pill, a new word)", async () => {
    const started = await flip("lic_10", "Active");
    console.info(`[pill lic_10] ${JSON.stringify(started)}`);
    expect(
      started.filter((s) => s.name === "pk-pop-in").map((s) => s.target),
    ).toEqual(["span:Disabled"]);
  });

  it("a Waiting record that becomes Disabled swaps its pill (a different component: no pop)", async () => {
    const started = await flip("lic_1", "Waiting");
    console.info(`[pill lic_1] ${JSON.stringify(started)}`);
    // MO-13.2's status-pill strip: HeaderStatus returns a bare StatusPill while waiting and
    // LicenseStatus otherwise, so React remounts the pill and its first word never pops.
    expect(started.filter((s) => s.name === "pk-pop-in")).toEqual([]);
  });
});

// ── The list audit ──────────────────────────────────────────────────────────────────────────────

const rowCount = (page: Page, sel: string): Promise<number> =>
  page.locator(sel).count();

describe("list audit: does an entering item cross a moving survivor?", () => {
  it("Platform → Members: a Role filter, then Clear filters (rows enter after the survivors land)", async () => {
    const { page } = await openConsole("dark", "#/platform/members", "Members");
    const rows = "main#content tbody > tr[data-row-id]";
    await page.locator(rows).first().waitFor();
    const all = await rowCount(page, rows);
    expect(all).toBeGreaterThan(3);
    await page
      .getByRole("button", { name: /^(Filter by role|More filters)/ })
      .first()
      .click();
    const options = page.getByRole("checkbox");
    await options.first().waitFor();
    await atRest(page);
    await reset(page);
    const count = options.count();
    expect(await count).toBeGreaterThan(1);
    // The first role that removes some rows but not all.
    let narrowed: Probe["runs"] = [];
    for (let i = 0; i < (await count) && narrowed.length === 0; i++) {
      await options.nth(i).click();
      narrowed = await doneRuns(page);
      if (narrowed.length === 0) await options.nth(i).click();
    }
    expect(narrowed.length, "a filter ran a list transition").toBe(1);
    await atRest(page);
    await page.keyboard.press("Escape");
    await reset(page);
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect.poll(() => rowCount(page, rows)).toBe(all);
    const widened = await doneRuns(page);
    const out = {
      narrow: narrowed.map((r) => crossingOf(r.pseudo)),
      widen: widened.map((r) => crossingOf(r.pseudo)),
    };
    console.info(`[audit members] ${JSON.stringify(out)}`);
    // Rows that come back (Clear filters) wait for the survivors (MO-09's .pk-vt-table).
    expect(out.widen.some((c) => c.entering > 0)).toBe(true);
    for (const c of out.widen)
      expect(c.crossing, JSON.stringify(c)).toBe(false);
    await closeContext(page.context());
  });

  it("Platform → Members: the table's rows carry pk-vt-table", async () => {
    const { page } = await openConsole("dark", "#/platform/members", "Members");
    expect(
      await page
        .locator("main#content tbody.pk-vt-table, .pk-vt-table")
        .count(),
    ).toBeGreaterThan(0);
    await closeContext(page.context());
  });

  if (SHOTS)
    for (const variant of VARIANTS)
      it(`saves the members filter/clear strips (${variant})`, async () => {
        const { page } = await openConsole(
          variant,
          "#/platform/members",
          "Members",
        );
        const role = page
          .getByRole("button", { name: /^(Filter by role|More filters)/ })
          .first();
        await role.click();
        await page.getByRole("checkbox").first().waitFor();
        await atRest(page);
        const offsets = variant === "reduced" ? [400] : undefined;
        await frameStrip(
          page,
          "members-filter",
          () => page.getByRole("checkbox").first().click(),
          {
            theme: variant,
            offsets,
          },
        );
        await frameStrip(
          page,
          "members-clear",
          async () => {
            await page.keyboard.press("Escape");
            await page
              .getByRole("button", { name: "Clear filters" })
              .first()
              .click();
          },
          { theme: variant, offsets },
        );
        await closeContext(page.context());
      });
});

// ── The portal's lists ──────────────────────────────────────────────────────────────────────────

describe("list audit: the portal (Polaris Locker)", () => {
  let portal: PortalHarness;
  beforeAll(async () => {
    portal = await startPortal();
  });
  afterAll(async () => {
    await portal?.stop();
  });

  for (const variant of VARIANTS) {
    it(`the Library's Grid/List switch: the new view rises into the section's own glide (${variant})`, async () => {
      const s = await portal.open("twelve", "/", {
        theme: variant === "light" ? "light" : "dark",
        reducedMotion: variant === "reduced" ? "reduce" : "no-preference",
      });
      const { page } = s;
      await page.getByRole("article", { name: "Glyphsmith" }).waitFor();
      await installProbe(page);
      await atRest(page);
      await reset(page);
      const toList = (): Promise<void> =>
        page.getByRole("radio", { name: "List" }).click();
      if (SHOTS)
        await frameStrip(page, "library-grid-to-list", toList, {
          theme: variant,
          offsets: variant === "reduced" ? [400] : undefined,
        });
      else await toList();
      await page.getByRole("table", { name: "Your products" }).waitFor();
      const runs = await doneRuns(page);
      if (variant === "reduced") {
        expect(runs, "an instant swap").toEqual([]);
      } else {
        const c = runs.map((r) => crossingOf(r.pseudo));
        console.info(`[audit library ${variant}] ${JSON.stringify(c)}`);
        expect(c).toHaveLength(1);
        // By the numbers the new view rises (`fast`) while two survivors still move, but they are
        // the section's own box and the page footer, which glide into the space the list rises in
        // (the strips show nothing crossing). Pinned, so a change here gets a new strip review.
        expect(c[0]!.enterTimings).toEqual({ "120+200": 2 });
      }
      expect(await s.violations()).toEqual([]);
      await s.close();
    });
  }

  it("the Devices card's list carries pk-vt-table, so its rows wait for the survivors", async () => {
    const s = await portal.open("three", "/#/p/nightfall/devices", {
      theme: "dark",
    });
    await s.page.getByText("Studio PC").first().waitFor();
    const list = s.page.locator("section[data-section] ul.pk-vt-table");
    expect(await list.count()).toBe(1);
    expect(await list.locator("> li").count()).toBe(2);
    await s.close();
  });
});
