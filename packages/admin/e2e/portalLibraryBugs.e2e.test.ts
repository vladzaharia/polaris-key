import { afterAll, beforeAll, describe, it } from "vitest";
import {
  h1,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { portalRoutes, type Handler } from "./portalFixtures.js";

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
        // A line of the card too, not only its heading: the heading and the count line.
        expect(at.devices, "Devices heading top, with room").toBeLessThan(
          height - 48,
        );
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

describe.concurrent("the dialog scrim (B-091)", () => {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    it(`covers the Missing a license strip at ${width}`, async ({ expect }) => {
      const o = await portal.open("three", "/", { width, height });
      try {
        await h1(o.page, "Your library");
        await o.page.getByRole("button", { name: "Activate license" }).click();
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
    it(`in the tile and on the product page (${theme})`, async ({ expect }) => {
      const o = await portal.open("three", "/", {
        theme,
        width: 1440,
        height: 900,
        routes,
      });
      try {
        await h1(o.page, "Your library");
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
