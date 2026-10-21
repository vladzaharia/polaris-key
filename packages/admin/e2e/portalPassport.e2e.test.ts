import { afterAll, beforeAll, describe, it } from "vitest";
import type { Page } from "playwright";
import {
  axe,
  h1,
  horizontalOverflow,
  settle,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { forcedColourBreaches } from "./pageChecks.js";
import { REQUEST_STATES } from "./portalRequestStates.js";
import type { Override } from "./portalHarness.js";
import { mkdirSync } from "node:fs";

/**
 * The product passport (PX-33; SIGN-IN.md "Layout: the product passport"): in a window at least
 * 60 rem (960 CSS px) wide whose width to height ratio is at least 1.2, an app request's header
 * leaves the top of the card and becomes a 17.5 rem start pane beside the form; everywhere else
 * (portrait, a tablet held upright, a phone, a squarer window) it stays the stacked strip. With
 * `PK_PASSPORT_SHOTS` set it saves a screenshot per row there.
 */

const REQ = "/api/signin/requests/rq_AAAAAAAAAAAAAAAAAAAAAA";
const SHOTS = process.env.PK_PASSPORT_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const base = REQUEST_STATES.find((s) => s.id === "app-signin")!;

function withArt(art: string | null): Record<string, Override> {
  const routes = { ...base.routes } as Record<string, { body: any }>;
  const view = routes[REQ]!.body;
  routes[REQ] = {
    body: {
      ...view,
      client: { ...view.client, ...(art ? { artUrl: art } : {}) },
    },
  };
  return routes as Record<string, Override>;
}

/** The portal-direct card: no request handle and no product context. */
function direct(): Record<string, Override> {
  const caps = (base.routes!["/api/capabilities"] as { body: any }).body;
  const { product: _p, ...rest } = caps;
  return { "/api/capabilities": { body: rest } as Override };
}

interface Row {
  label: string;
  width: number;
  height: number;
  passport: boolean;
}
const ROWS: Row[] = [
  { label: "1440x900", width: 1440, height: 900, passport: true },
  { label: "1180x800", width: 1180, height: 800, passport: true },
  { label: "1024x768", width: 1024, height: 768, passport: true },
  { label: "960x700", width: 960, height: 700, passport: true },
  { label: "959x700", width: 959, height: 700, passport: false },
  { label: "1000x900", width: 1000, height: 900, passport: false },
  { label: "834x1194", width: 834, height: 1194, passport: false },
  { label: "390x844", width: 390, height: 844, passport: false },
];

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

interface Geometry {
  card: { x: number; y: number; w: number; h: number };
  pane: { x: number; y: number; w: number; h: number; bg: string };
  h1: { x: number; y: number };
  art: {
    x: number;
    y: number;
    visible: boolean;
    w: number;
    h: number;
    loaded: boolean;
    fit: string;
    alt: string | null;
  } | null;
  foot: { x: number; y: number; w: number; h: number } | null;
  cardBg: string;
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const r = (el: Element) => el.getBoundingClientRect();
    const card = document.querySelector("[data-passport]")!;
    const pane = document.querySelector("[data-pane='passport']")!;
    const h1 = document.querySelector("h1")!;
    const art = document.querySelector<HTMLImageElement>("[data-pane-art]");
    const foot = [...card.children].at(-1)!;
    const rc = r(card);
    const rp = r(pane);
    const rf = r(foot);
    return {
      card: { x: rc.x, y: rc.y, w: rc.width, h: rc.height },
      pane: {
        x: rp.x,
        y: rp.y,
        w: rp.width,
        h: rp.height,
        bg: getComputedStyle(pane).backgroundColor,
      },
      h1: { x: r(h1).x, y: r(h1).y },
      art: art
        ? {
            x: r(art).x,
            y: r(art).y,
            visible: art.offsetParent !== null,
            w: r(art).width,
            h: r(art).height,
            loaded: art.complete && art.naturalWidth > 0,
            fit: getComputedStyle(art).objectFit,
            alt: art.getAttribute("alt"),
          }
        : null,
      foot:
        foot === pane ? null : { x: rf.x, y: rf.y, w: rf.width, h: rf.height },
      cardBg: getComputedStyle(card).backgroundColor,
    };
  });
}

describe("the product passport at every size", () => {
  for (const theme of ["dark", "light"] as Theme[]) {
    for (const row of ROWS) {
      it(`${row.label}, ${theme}: ${row.passport ? "pane beside the form" : "stacked strip"}`, async ({
        expect,
      }) => {
        const o = await portal.open(base.scenario, base.path, {
          theme,
          width: row.width,
          height: row.height,
          routes: withArt("/media/nightfall/header"),
        });
        try {
          await base.ready(o.page);
          await settle(o.page);
          const g = await geometry(o.page);
          if (SHOTS)
            await o.page.screenshot({
              path: `${SHOTS}/${row.label}-${theme}.png`,
              fullPage: true,
            });
          if (row.passport) {
            const rem = 16;
            expect(g.pane.w, "pane is 17.5 rem").toBeCloseTo(17.5 * rem, 0);
            expect(g.card.w, "card is about 46 rem").toBeCloseTo(46 * rem, 0);
            expect(
              g.h1.x,
              "form pane beside, not under",
            ).toBeGreaterThanOrEqual(g.pane.x + g.pane.w);
            expect(
              Math.abs(g.pane.y - g.card.y),
              "pane starts at the card's top",
            ).toBeLessThanOrEqual(2);
            expect(
              Math.abs(g.pane.h + g.foot!.h - g.card.h),
              "the receipt closes the pane: no void under it",
            ).toBeLessThanOrEqual(3);
            expect(g.pane.bg, "neutral pane, not the card's ground").not.toBe(
              g.cardBg,
            );
            expect(g.art, "art is drawn").not.toBeNull();
            expect(g.art!.loaded, "art loads under the CSP").toBe(true);
            expect(g.art!.alt).toBe("");
            expect(g.art!.fit).toBe("cover");
            // 16:10 unless the 40 % cap bites on a short step, then it is cropped (cover), never taller.
            expect(g.art!.w / g.art!.h).toBeGreaterThanOrEqual(1.59);
            expect(g.art!.h, "at most 40 % of the pane").toBeLessThanOrEqual(
              g.pane.h * 0.4 + 1,
            );
            expect(
              g.foot!.x + g.foot!.w,
              "trust receipt is at the pane's foot",
            ).toBeLessThanOrEqual(g.pane.x + g.pane.w + 1);
            expect(g.foot!.y).toBeGreaterThanOrEqual(g.pane.y + g.pane.h - 1);
            expect(
              Math.abs(g.art!.y - g.pane.y),
              "art runs from the pane's top",
            ).toBeLessThanOrEqual(2);
            expect(
              Math.abs(g.art!.w - g.pane.w),
              "art runs edge to edge",
            ).toBeLessThanOrEqual(2);
          } else {
            expect(
              g.art?.visible ?? false,
              "art is not drawn in the stacked layout",
            ).toBe(false);
            expect(
              o.requests.filter((r) => r.includes("/header")),
              "and never fetched",
            ).toEqual([]);
            expect(
              Math.abs(g.pane.w - g.card.w),
              "strip spans the card",
            ).toBeLessThanOrEqual(2);
            expect(g.h1.y, "form below the strip").toBeGreaterThanOrEqual(
              g.pane.y + g.pane.h - 1,
            );
            expect(g.card.w).toBeLessThanOrEqual(28.5 * 16 + 1);
          }
          expect.soft(await o.violations(), "CSP violations").toEqual([]);
          expect.soft(await axe(o.page), "axe violations").toEqual([]);
          expect
            .soft(await horizontalOverflow(o.page), "horizontal scroll")
            .toBeLessThanOrEqual(0);
        } finally {
          await o.close();
        }
      });
    }
  }
});

describe("what never gets a pane or art", () => {
  it("portal-direct sign-in has no pane at 1440x900", async ({ expect }) => {
    const o = await portal.open("signedOut", "/signin", {
      theme: "light",
      width: 1440,
      height: 900,
      routes: direct(),
    });
    try {
      await h1(o.page, "Sign in");
      expect(await o.page.locator("[data-pane]").count()).toBe(0);
      const w = await o.page.evaluate(
        () =>
          document.querySelector("main > div")!.getBoundingClientRect().width,
      );
      expect(w).toBeLessThanOrEqual(28.5 * 16 + 1);
      if (SHOTS)
        await o.page.screenshot({ path: `${SHOTS}/direct-1440-light.png` });
    } finally {
      await o.close();
    }
  });

  it("no art: icon and text only, no generated fill", async ({ expect }) => {
    const o = await portal.open(base.scenario, base.path, {
      theme: "dark",
      width: 1440,
      height: 900,
      routes: withArt(null),
    });
    try {
      await base.ready(o.page);
      await settle(o.page);
      const g = await geometry(o.page);
      expect(g.art).toBeNull();
      expect(g.pane.w).toBeCloseTo(280, 0);
      expect(await o.page.locator("[data-pane] img").count()).toBe(0);
    } finally {
      await o.close();
    }
  });

  it("forced colours: the pane is bounded by a border and uses system colours", async ({
    expect,
  }) => {
    const o = await portal.open(base.scenario, base.path, {
      theme: "dark",
      width: 1440,
      height: 900,
      forcedColors: "active",
      routes: withArt("/media/nightfall/header"),
    });
    try {
      await base.ready(o.page);
      await settle(o.page);
      const edge = await o.page.evaluate(() => {
        const s = getComputedStyle(
          document.querySelector("[data-pane='passport']")!,
        );
        return {
          w: s.borderRightWidth,
          c: s.borderRightColor,
          b: s.borderBottomWidth,
        };
      });
      expect(edge.w).toBe("1px");
      expect(edge.b, "no hairline under the pane").toBe("0px");
      expect(edge.c).not.toBe("rgba(0, 0, 0, 0)");
      expect(await forcedColourBreaches(o.page)).toEqual([]);
      if (SHOTS)
        await o.page.screenshot({
          path: `${SHOTS}/forced-1440.png`,
          fullPage: true,
        });
    } finally {
      await o.close();
    }
  });

  for (const [width, height, wide] of [
    [1440, 900, false],
    [1280, 800, false],
    [1024, 768, false],
    [2560, 1440, true],
  ] as const) {
    it(`200 % text at ${width}x${height}: ${wide ? "the pane stays, and the form keeps 28.5 rem" : "the strip stacks, the pane is never wider than the form"}`, async ({
      expect,
    }) => {
      const o = await portal.open(base.scenario, base.path, {
        theme: "light",
        width,
        height,
        routes: withArt("/media/nightfall/header"),
      });
      try {
        await base.ready(o.page);
        await o.page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        await settle(o.page);
        const g = await geometry(o.page);
        const form = await o.page.evaluate(
          () =>
            document
              .querySelector("[data-step]")!
              .parentElement!.getBoundingClientRect().width,
        );
        if (wide) {
          expect(g.h1.x).toBeGreaterThanOrEqual(g.pane.x + g.pane.w);
          expect(form).toBeGreaterThanOrEqual(28.5 * 32 - 2);
        } else {
          expect(
            g.h1.y,
            "stacked: form below the strip",
          ).toBeGreaterThanOrEqual(g.pane.y + g.pane.h - 1);
          expect(g.art?.visible ?? false).toBe(false);
        }
        expect(
          g.pane.w,
          "pane never wider than the form",
        ).toBeGreaterThanOrEqual(wide ? 0 : form - 2);
        expect(await horizontalOverflow(o.page)).toBeLessThanOrEqual(0);
        if (SHOTS)
          await o.page.screenshot({
            path: `${SHOTS}/text200-${width}x${height}.png`,
            fullPage: true,
          });
      } finally {
        await o.close();
      }
    });
  }

  it("production capabilities (no product): the card is 46 rem from the first paint, and the key on-ramp keeps the pane", async ({
    expect,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const view = withArt("/media/nightfall/header")[REQ] as { body: unknown };
    const o = await portal.open(base.scenario, base.path, {
      theme: "dark",
      width: 1440,
      height: 900,
      routes: {
        ...direct(),
        ...withArt("/media/nightfall/header"),
        [REQ]: async () => {
          await gate;
          return view as never;
        },
      },
    });
    try {
      await o.page.locator("[data-header='loading']").waitFor();
      const card = () =>
        o.page.evaluate(() => {
          const r = document
            .querySelector("[data-passport]")!
            .getBoundingClientRect();
          return { x: Math.round(r.x), w: Math.round(r.width) };
        });
      const loading = await card();
      expect(loading.w).toBe(736);
      release();
      await base.ready(o.page);
      await settle(o.page);
      expect(await card()).toEqual(loading);
      await o.page.getByRole("button", { name: "Have a license key?" }).click();
      await h1(o.page, "Have a license key?");
      await settle(o.page);
      expect(await card(), "on-ramp: same card").toEqual(loading);
      const pane = await o.page.evaluate(() => {
        const p = document.querySelector("[data-pane='passport']")!;
        return {
          art: Boolean(p.querySelector("[data-pane-art]")),
          text: p.textContent ?? "",
        };
      });
      expect(pane.art, "on-ramp keeps the art").toBe(true);
      expect(pane.text).toContain("Diceroll");
      expect(pane.text).toContain("Mara's Pixel 8");
      expect(pane.text).not.toContain("Your license, downloads and devices");
      if (SHOTS)
        await o.page.screenshot({
          path: `${SHOTS}/onramp-1440.png`,
          fullPage: true,
        });
    } finally {
      await o.close();
    }
  });
});
