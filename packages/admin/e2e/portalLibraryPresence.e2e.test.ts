import { afterAll, beforeAll, describe, it } from "vitest";
import type { Page } from "playwright";
import {
  h1,
  horizontalOverflow,
  shoot,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { portalRoutes, type Handler } from "./portalFixtures.js";

/**
 * Library and Discover presence (PX-27; B12). The Library's 2-7 product grid at 360, 390, 768,
 * 1024, 1440 and 1920 px (and 700, one column at its widest) in both themes, with hosted art, with none, with a very long name and a
 * right-to-left one, at three and four products:
 *
 * - each tile draws its art edge to edge, at most 280 px tall;
 * - the key tile ends the grid, takes its whole row when the products fill theirs (else one cell);
 * - "Missing a license?" closes the page;
 * - the page title is 48/52 from 761 px and 32/36 below it;
 * - a long name stays inside its tile; no horizontal page scroll.
 *
 * With `PK_SHOTS_DIR` set it saves `presence-<case>-<n>-<size>-<theme>.png` there.
 */

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

const SIZES = [
  { label: "360", width: 360, height: 780 },
  { label: "390", width: 390, height: 844 },
  // One column at its widest: the 280 px cap applies, the art stays whole over a blurred copy.
  { label: "700", width: 700, height: 900 },
  { label: "768", width: 768, height: 1024 },
  { label: "1024", width: 1024, height: 768 },
  { label: "1440", width: 1440, height: 900 },
  { label: "1920", width: 1920, height: 1080 },
] as const;

type Variant = "art" | "noart" | "long" | "rtl";
const NAMES: Record<Variant, string | null> = {
  art: null,
  noart: null,
  long: "The Extraordinarily Long Titled Expedition of the Wandering Cartographers Guild: Collector’s Edition",
  rtl: "لعبة الأحجار الكريمة والمغامرات الكبرى في الصحراء",
};

interface LibBody {
  products: Record<string, unknown>[];
}

function libraryRoute(
  variant: Variant,
  count: number,
): Record<string, Handler> {
  const base = portalRoutes("three")["/api/library"] as () => { body: LibBody };
  return {
    "/api/library": () => {
      const res = base();
      const first = res.body.products;
      // More products than the scenario holds: copies under new slugs.
      const products = Array.from({ length: count }, (_, i) => {
        const p = first[i % first.length]!;
        return i < first.length
          ? p
          : { ...p, product: `${String(p.product)}-${i}`, name: `Extra ${i}` };
      }).map((p, i) => ({
        ...p,
        ...(variant === "noart" ? { iconUrl: null, headerUrl: null } : {}),
        ...(NAMES[variant] && i === 0 ? { name: NAMES[variant] } : {}),
      }));
      return { body: { ...res.body, products } };
    },
  };
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector("section[aria-labelledby='all-h'] ul")!;
    const g = grid.getBoundingClientRect();
    const items = [...grid.children].map((li) => li.getBoundingClientRect());
    const rows = new Map<number, DOMRect[]>();
    for (const r of items) {
      const key = Math.round(r.top);
      rows.set(key, [...(rows.get(key) ?? []), r]);
    }
    const last = [...rows.entries()].sort((a, b) => a[0] - b[0]).pop()![1];
    const lastRight = Math.max(...last.map((r) => r.right));
    const lastLeft = Math.min(...last.map((r) => r.left));
    const arts = [...grid.querySelectorAll("article > [data-art]")].map(
      (el) => {
        const a = el.getBoundingClientRect();
        const card = el.closest("article")!.getBoundingClientRect();
        return { h: a.height, w: a.width, cardW: card.width };
      },
    );
    const names = [...grid.querySelectorAll("article h3")].map((h) => {
      const a = h.closest("article")!.getBoundingClientRect();
      const r = h.getBoundingClientRect();
      return { inside: r.left >= a.left - 1 && r.right <= a.right + 1 };
    });
    const title = getComputedStyle(document.querySelector("h1")!);
    const key = document.querySelector("li[aria-labelledby='key-tile-h']");
    const strip = document.querySelector(
      "section[aria-labelledby='missing-h']",
    );
    return {
      // PX-34: the key tile takes the whole row when the products fill theirs, else one cell: it
      // is never part of a row, and a last row of cells may end short.
      fullRow: (() => {
        const cols = getComputedStyle(grid)
          .gridTemplateColumns.split(" ")
          .filter(Boolean).length;
        const products = items.length - 1;
        const k = items[items.length - 1]!;
        if (cols < 2) return lastLeft - g.left < 2 && g.right - lastRight < 2;
        const cell = items[0]!.width;
        return products % cols === 0
          ? Math.abs(k.width - g.width) < 2
          : Math.abs(k.width - cell) < 2;
      })(),
      arts,
      names,
      titleSize: title.fontSize,
      titleLine: title.lineHeight,
      key: Boolean(key),
      keyLast: key ? grid.lastElementChild === key : false,
      strip: Boolean(strip),
      stripAfter: strip
        ? Boolean(
            grid.compareDocumentPosition(strip) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : false,
    };
  });
}

/** The header lockup's wordmark, in px: the Locker horizontal lockup at 44 px draws it about 102 px wide (BRAND §15). */
async function wordmarkWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const svg = [
      ...document.querySelectorAll(
        "header a[aria-label^='Polaris Locker'] svg",
      ),
    ].find((el) => el.getBoundingClientRect().width > 0)!;
    // The wordmark is the lockup's last group (the Locker lockup draws its mark as bare paths).
    const groups = svg.querySelectorAll("g");
    return groups[groups.length - 1]!.getBoundingClientRect().width;
  });
}

describe.concurrent("discover grid presence", () => {
  // From 1180 px, three columns: two or four tiles take two, so no row is mostly empty.
  for (const width of [1280, 1440, 1920]) {
    it(`no row has an empty cell at ${width}`, async ({ expect }) => {
      const o = await portal.open("three", "/#/discover", {
        width,
        height: 900,
      });
      try {
        await h1(o.page, "Discover");
        const cells = await o.page.evaluate(() => {
          const grid = document.querySelector(
            "section[aria-labelledby='offers-h'] ul",
          )!;
          const cols = getComputedStyle(grid)
            .gridTemplateColumns.split(" ")
            .filter(Boolean).length;
          return { cols, count: grid.children.length };
        });
        expect
          .soft(
            cells.count % cells.cols,
            `${cells.count} tiles in ${cells.cols} columns`,
          )
          .toBe(0);
      } finally {
        await o.close();
      }
    });
  }
});

describe.concurrent("library 2-7 grid presence", () => {
  for (const variant of ["art", "noart", "long", "rtl"] as const) {
    for (const count of [3, 4] as const) {
      SIZES.forEach((size) => {
        for (const theme of ["dark", "light"] as const satisfies Theme[])
          it(`${variant} x${count}: ${size.label}, ${theme}`, async ({
            expect,
          }) => {
            const o = await portal.open("three", "/", {
              theme,
              width: size.width,
              height: size.height,
              routes: libraryRoute(variant, count),
            });
            try {
              await h1(o.page, "Your library");
              await o.page.waitForSelector("li[aria-labelledby='key-tile-h']");
              await o.page.waitForTimeout(300);
              await shoot(
                o.page,
                `presence-${variant}-${count}-${size.label}-${theme}`,
              );
              const g = await geometry(o.page);
              expect.soft(g.key, "key tile").toBe(true);
              expect.soft(g.keyLast, "key tile ends the grid").toBe(true);
              expect
                .soft(g.strip && g.stripAfter, "Missing a license? after")
                .toBe(true);
              expect
                .soft(g.fullRow, "key tile spans its row or is one cell")
                .toBe(true);
              for (const a of g.arts) {
                expect.soft(a.h, "art height").toBeLessThanOrEqual(280.5);
                expect
                  .soft(a.w, "art is edge to edge")
                  .toBeGreaterThanOrEqual(a.cardW - 2.5);
              }
              expect
                .soft(
                  g.names.every((n) => n.inside),
                  "names inside tiles",
                )
                .toBe(true);
              const wide = size.width >= 761;
              expect.soft(g.titleSize).toBe(wide ? "48px" : "32px");
              expect.soft(g.titleLine).toBe(wide ? "52px" : "36px");
              expect
                .soft(await horizontalOverflow(o.page), "horizontal scroll")
                .toBeLessThanOrEqual(0);
              if (size.label === "1440" || size.label === "390")
                expect
                  .soft(await wordmarkWidth(o.page), "header wordmark width")
                  .toBeCloseTo(102, -1);
            } finally {
              await o.close();
            }
          });
      });
    }
  }
});
