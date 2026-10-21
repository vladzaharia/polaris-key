import { afterAll, beforeAll, describe, it } from "vitest";
import {
  h1,
  shoot,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { portalRoutes, type Handler } from "./portalFixtures.js";
import { SHIPPED } from "./portalStates.js";

/**
 * Stabilization package E2 (B-075 to B-091): what only a browser can show about the Library,
 * Discover and the product page. The markup half of each fix is in the portal unit tests.
 *
 * - the Devices card's heading starts inside the first screen at 1280 × 800 and 1440 × 900 (the
 *   License card is compact at desk widths);
 * - the Library toolbar and the product page read and tab in the order they are drawn (no CSS
 *   `order`, WCAG 2.4.3);
 * - on a touch screen the section pills and the Grid/List segments are 44 px tall;
 * - an open dialog's scrim covers the "Missing a license?" strip;
 * - a right-to-left name in a tile starts at the icon's side.
 */

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

describe.concurrent("the product page at desk widths", () => {
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
  ] as const) {
    it(`Devices starts inside the first screen at ${width} × ${height}`, async ({
      expect,
    }) => {
      const o = await portal.open("three", "/#/p/nightfall", {
        width,
        height,
      });
      try {
        await h1(o.page, "Nightfall");
        await o.page.locator("#section-devices-h").waitFor();
        await shoot(o.page, `e2-product-${width}`);
        const at = await o.page.evaluate(() => ({
          devices: document
            .querySelector("#section-devices-h")!
            .getBoundingClientRect().top,
          license: document
            .querySelector("#section-license")!
            .getBoundingClientRect().height,
          scrolled: window.scrollY,
        }));
        console.log(`E2 devices heading y at ${width}x${height}:`, at);
        expect(at.scrolled).toBe(0);
        expect(at.devices, "Devices heading top").toBeLessThan(height);
        expect(
          at.devices,
          "Devices heading top, with its own line inside the screen too",
        ).toBeLessThanOrEqual(height - 28);
      } finally {
        await o.close();
      }
    });
  }
});

describe.concurrent("tab order is the visual order (B-076)", () => {
  for (const width of [390, 768, 1024, 1440]) {
    it(`the Library toolbar at ${width}`, async ({ expect }) => {
      const o = await portal.open("twelve", "/", { width, height: 900 });
      try {
        await h1(o.page, "Your library");
        await o.page.waitForSelector("[data-library-search]");
        const bad = await o.page.evaluate(() => {
          // `next` reads after `prev`: on a later row, or on the same row and not to its left.
          const after = (prev: DOMRect, next: DOMRect): boolean =>
            next.top >= prev.bottom - 2 ||
            (Math.abs(next.top - prev.top) < 24 && next.left >= prev.left - 1);
          const toolbar = document
            .querySelector("[data-library-search]")!
            .closest("div.flex-wrap")!;
          const els = [
            ...toolbar.querySelectorAll<HTMLElement>(
              "input, button, select, [role=radio]",
            ),
          ].filter((e) => e.checkVisibility());
          const out: string[] = [];
          for (let i = 1; i < els.length; i++) {
            const a = els[i - 1]!.getBoundingClientRect();
            const b = els[i]!.getBoundingClientRect();
            if (!after(a, b))
              out.push(
                `${els[i - 1]!.outerHTML.slice(0, 50)} -> ${els[i]!.outerHTML.slice(0, 50)}`,
              );
          }
          return { count: els.length, out };
        });
        expect(bad.count).toBeGreaterThan(3);
        expect(bad.out).toEqual([]);
      } finally {
        await o.close();
      }
    });

    it(`the product page cards at ${width}`, async ({ expect }) => {
      const o = await portal.open("three", "/#/p/nightfall", {
        width,
        height: 900,
      });
      try {
        await h1(o.page, "Nightfall");
        await o.page.locator("#section-devices-h").waitFor();
        const res = await o.page.evaluate(() => {
          const cards = [
            ...document.querySelectorAll<HTMLElement>("[data-section]"),
          ].map((c) => {
            const r = c.getBoundingClientRect();
            return {
              id: c.dataset.section!,
              top: r.top + window.scrollY,
              left: Math.round(r.left),
            };
          });
          // Nothing between a card and the page's content is moved by CSS `order`.
          const orders = [
            ...document.querySelectorAll("[data-section]"),
          ].filter((c) => {
            for (
              let e: Element | null = c;
              e && !e.matches("main");
              e = e.parentElement
            )
              if (getComputedStyle(e).order !== "0") return true;
            return false;
          });
          return { cards, ordered: orders.length };
        });
        expect(res.ordered, "elements moved by CSS order").toBe(0);
        const columns = new Set(res.cards.map((c) => c.left));
        if (columns.size === 1) {
          // One column: the DOM order is the page's order.
          const tops = res.cards.map((c) => c.top);
          expect(tops, res.cards.map((c) => c.id).join(",")).toEqual(
            [...tops].sort((a, b) => a - b),
          );
        } else {
          // Two columns: each column reads top to bottom in DOM order.
          for (const left of columns) {
            const tops = res.cards
              .filter((c) => c.left === left)
              .map((c) => c.top);
            expect(tops).toEqual([...tops].sort((a, b) => a - b));
          }
        }
      } finally {
        await o.close();
      }
    });
  }
});

describe.concurrent("touch targets (B-081, B-082)", () => {
  it("the product's section pills are 44 px tall on a touch screen", async ({
    expect,
  }) => {
    const o = await portal.open("three", "/#/p/nightfall", {
      width: 768,
      height: 1024,
      hasTouch: true,
    });
    try {
      await h1(o.page, "Nightfall");
      const heights = await o.page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "nav[aria-label=Sections] [data-nav-section]",
          ),
        ].map((a) => a.getBoundingClientRect().height),
      );
      expect(heights.length).toBeGreaterThan(2);
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    } finally {
      await o.close();
    }
  });

  it("the Grid and List segments are 44 px tall on a touch screen", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", {
      width: 390,
      height: 844,
      hasTouch: true,
    });
    try {
      await h1(o.page, "Your library");
      await o.page.waitForSelector("[role=radiogroup][aria-label=View]");
      const heights = await o.page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "[role=radiogroup][aria-label=View] [role=radio]",
          ),
        ].map((a) => a.getBoundingClientRect().height),
      );
      expect(heights.length).toBe(2);
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    } finally {
      await o.close();
    }
  });
});

/**
 * Stabilization LF1 (EXPERIENCE §7.3): on a touch screen every customer control is 44 px tall (a
 * text link inside a sentence is excused), on the screens people use most. `smallTargets` only
 * flags crowded targets under 24 px, so this measures the height itself.
 */
const TOUCH_STATES = [
  "library-1",
  "library-12",
  "library-error",
  "boot-error",
  "activate-enter",
  "activate-confirm",
  "product",
  "product-load-error",
  "product-remove-device",
  "product-remove-license",
  "product-install-sources",
  "account",
  "account-delete",
  "account-link-both",
  "device-limit",
  "download-flow",
  "library-entry-remove",
];

describe("every customer control is 44 px tall on a touch screen", () => {
  for (const id of TOUCH_STATES) {
    it(`${id} at 390`, async ({ expect }) => {
      const st = SHIPPED.find((x) => x.id === id);
      expect(st, `state ${id}`).toBeDefined();
      const o = await portal.open(st!.scenario, st!.path, {
        width: 390,
        height: 844,
        theme: "light",
        hasTouch: true,
        routes: st!.routes,
      });
      try {
        await st!.ready(o.page);
        await o.page.waitForTimeout(300);
        const under = await o.page.evaluate(() => {
          const SEL =
            "a[href], button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, summary, [role=radio], [role=tab], [role=menuitem]";
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>(SEL)) {
            if (el.closest("[inert], [aria-hidden=true]")) continue;
            if ((el as HTMLButtonElement).disabled) continue;
            if (!el.checkVisibility({ visibilityProperty: true })) continue;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            if (r.width <= 1 || r.height <= 1) continue;
            // Skip-link and other visually hidden controls.
            if (cs.clipPath === "inset(50%)") continue;
            // A name link stretched over its whole card or row (`after:absolute after:inset-0`):
            // the card is the target.
            if (getComputedStyle(el, "::after").position === "absolute")
              continue;
            // A link inside a sentence is excused (WCAG 2.5.8 inline exception).
            if (cs.display === "inline") {
              const own = (el.textContent ?? "").trim();
              const line = (el.parentElement?.textContent ?? "").trim();
              if (line.length > own.length) continue;
            }
            const label = (
              el.getAttribute("aria-label") ??
              el.textContent ??
              ""
            )
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 40);
            if (r.height < 43.5)
              out.push(
                `${el.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`,
              );
          }
          return out;
        });
        expect(under).toEqual([]);
      } finally {
        await o.close();
      }
    });
  }
});

describe("Discover: a failed Add leaves the row where it is (B-080)", () => {
  for (const width of [1440, 390]) {
    it(`no tile changes height at ${width}`, async ({ expect }) => {
      const o = await portal.open("three", "/#/discover", {
        width,
        height: 900,
        routes: {
          "POST /api/discover/mossgarden/claim": () => ({
            status: 500,
            body: { error: "internal" },
          }),
        },
      });
      try {
        await h1(o.page, "Discover");
        const button = o.page.getByRole("button", {
          name: "Add to library: Mossgarden",
        });
        await button.waitFor();
        const heights = () =>
          o.page.evaluate(() =>
            [...document.querySelectorAll("main article")].map((a) =>
              Math.round(a.getBoundingClientRect().height),
            ),
          );
        const before = await heights();
        await button.click();
        await o.page.getByRole("alert").filter({ hasText: "Couldn" }).waitFor();
        await o.page.waitForTimeout(300);
        expect(await heights()).toEqual(before);
      } finally {
        await o.close();
      }
    });
  }
});

describe.concurrent("the dialog scrim (B-091)", () => {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    it(`covers the Missing a license strip at ${width}`, async ({ expect }) => {
      const o = await portal.open("three", "/", { width, height });
      try {
        await h1(o.page, "Your library");
        await o.page
          .getByRole("button", { name: "Activate a license" })
          .first()
          .click();
        await o.page.getByRole("dialog").waitFor();
        const hit = await o.page.evaluate(() => {
          const strip = document.querySelector("[data-missing-strip]")!;
          const r = strip.getBoundingClientRect();
          const at = document.elementFromPoint(
            r.left + r.width / 2,
            Math.min(r.top + r.height / 2, window.innerHeight - 2),
          );
          const overlay = document.querySelector(
            "[data-state=open][class*=fixed]",
          );
          return {
            inStrip: strip.contains(at),
            at: at?.outerHTML.slice(0, 80),
            dim: overlay ? getComputedStyle(overlay).backgroundColor : null,
          };
        });
        expect(hit.inStrip, hit.at).toBe(false);
      } finally {
        await o.close();
      }
    });
  }
});

describe.concurrent("a right-to-left name starts at the icon (B-078)", () => {
  const name = "لعبة الأحجار الكريمة والمغامرات الكبرى في الصحراء";
  const base = portalRoutes("three")["/api/library"] as () => {
    body: { products: Record<string, unknown>[] };
  };
  const routes: Record<string, Handler> = {
    "/api/library": () => {
      const res = base();
      return {
        body: {
          ...res.body,
          products: res.body.products.map((p, i) =>
            i === 0 ? { ...p, name } : p,
          ),
        },
      };
    },
  };
  for (const theme of ["dark"] as Theme[]) {
    it(`in the Library tile (${theme})`, async ({ expect }) => {
      const o = await portal.open("three", "/", {
        theme,
        width: 1440,
        height: 900,
        routes,
      });
      try {
        await h1(o.page, "Your library");
        await o.page.waitForSelector("article h3");
        const at = await o.page.evaluate((text) => {
          const h3 = [...document.querySelectorAll("article h3")].find((h) =>
            h.textContent?.includes(text.slice(0, 6)),
          )!;
          const article = h3.closest("article")!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(h3);
          const first = range.getClientRects()[0]!;
          const box = h3.getBoundingClientRect();
          return {
            textLeft: first.left - box.left,
            textRight: box.right - first.right,
            icon: article.left,
          };
        }, name);
        // The line begins at the box's left edge (beside the icon), not its right.
        expect(at.textLeft).toBeLessThan(at.textRight + 1);
      } finally {
        await o.close();
      }
    });
  }
});

describe.concurrent("the Library skeleton is a tile's size (B-084)", () => {
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1440, 900],
  ] as const) {
    it(`the skeleton tile and the loaded tile are as tall at ${width}`, async ({
      expect,
    }) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const base = portalRoutes("three")["/api/library"] as () => {
        body: unknown;
      };
      const routes: Record<string, Handler> = {
        "/api/library": async () => {
          await gate;
          return base();
        },
      };
      const o = await portal.open("three", "/", { width, height, routes });
      try {
        await o.page.waitForSelector("[aria-busy] > div");
        const skeleton = await o.page.evaluate(
          () =>
            document.querySelector("[aria-busy] > div")!.getBoundingClientRect()
              .height,
        );
        release();
        await o.page.waitForSelector("article h3");
        const tile = await o.page.evaluate(
          () =>
            document
              .querySelector("article")!
              .closest("li")!
              .getBoundingClientRect().height,
        );
        console.log(`E2 skeleton ${skeleton} tile ${tile} at ${width}`);
        expect(Math.abs(skeleton - tile)).toBeLessThanOrEqual(4);
      } finally {
        release();
        await o.close();
      }
    });
  }
});
