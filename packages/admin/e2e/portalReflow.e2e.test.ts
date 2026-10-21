import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type Handler, type Reply, portalRoutes } from "./portalFixtures.js";
import {
  axe,
  h1,
  horizontalOverflow,
  smallTargets,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";

/**
 * WCAG 1.4.10 reflow on the product page (EXPERIENCE.md §7.3): no page-level sideways scroll at
 * 320 CSS px or at 200 % text, however long the product's or the developer's name. The section tabs
 * scroll inside their own labelled strip; long names wrap.
 */
let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

const LONG_NAME =
  "Nightfall Chronicles Complete Collection Definitive Anniversary Edition";
/** One unbroken 60-character word: the worst case for wrapping. */
const LONG_DEV = "Lanternworks".padEnd(60, "x");

function longNames(slug: string): Record<string, Handler> {
  const routes = portalRoutes("three");
  const product = routes[`/api/products/${slug}`] as (req: Request) => Reply;
  const library = routes["/api/library"] as (req: Request) => Reply;
  const patch = (o: Record<string, unknown>): Record<string, unknown> => ({
    ...o,
    name: LONG_NAME,
    developerName: LONG_DEV,
  });
  return {
    [`/api/products/${slug}`]: (req) => {
      const r = product(req);
      return { ...r, body: patch(r.body as Record<string, unknown>) };
    },
    "/api/library": (req) => {
      const r = library(req);
      const body = r.body as { products: Record<string, unknown>[] };
      return {
        ...r,
        body: {
          ...body,
          products: body.products.map((p) =>
            p.product === slug ? patch(p) : p,
          ),
        },
      };
    },
  };
}

/** With PK_SHOTS_DIR set, each row is also saved in both themes (before/after review shots). */
const SHOTS = process.env.PK_SHOTS_DIR;
const SHOT_ROWS = [
  { label: "320-text200", width: 320, height: 640, text: 200 },
  { label: "390-text200", width: 390, height: 844, text: 200 },
  { label: "1440", width: 1440, height: 900, text: 100 },
] as const;

describe.skipIf(!SHOTS)("reflow screenshots", () => {
  for (const { label, width, height, text } of SHOT_ROWS) {
    for (const theme of ["dark", "light"] as const) {
      it(`${label} ${theme}`, async () => {
        const o = await portal.open("three", "/#/p/nightfall", {
          width,
          height,
          theme,
          routes: longNames("nightfall"),
        });
        try {
          await h1(o.page, LONG_NAME);
          await o.page.evaluate((pct) => {
            document.documentElement.style.setProperty(
              "font-size",
              `${pct}%`,
              "important",
            );
          }, text);
          await o.page.waitForTimeout(400);
          await o.page.screenshot({
            fullPage: true,
            path: `${SHOTS}/${label}-${theme}.png`,
          });
        } finally {
          await o.close();
        }
      });
    }
  }
});

/** The elements whose right edge passes the window's, for a failure message (not a gate). */
function widest(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .filter((e) => e.checkVisibility())
      // Inside a scroller, not on the page.
      .filter((e) => {
        for (let a = e.parentElement; a; a = a.parentElement) {
          const ox = getComputedStyle(a).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") return false;
        }
        return true;
      })
      // The outermost: its parent still fits.
      .filter(
        (e) =>
          !e.parentElement ||
          e.parentElement.getBoundingClientRect().right <=
            window.innerWidth + 1,
      )
      .slice(0, 8)
      .map(
        (e) =>
          `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 30)}" ${e.getAttribute("aria-label") ?? ""} ${Math.round(e.getBoundingClientRect().right)}`,
      ),
  );
}

const ROWS = [
  { label: "320 + 200 % text", width: 320, height: 640, text: 200 },
  { label: "390 + 200 % text", width: 390, height: 844, text: 200 },
  { label: "320", width: 320, height: 640, text: 100 },
  { label: "1440", width: 1440, height: 900, text: 100 },
] as const;

describe("the product page reflows", () => {
  for (const { label, width, height, text } of ROWS) {
    for (const path of ["/#/p/nightfall", "/#/p/nightfall/license"]) {
      const theme: Theme = width % 2 === 0 ? "dark" : "light";
      it(`${label}: ${path}, long names, no sideways scroll`, async ({
        expect,
      }) => {
        const o = await portal.open("three", path, {
          width,
          height,
          theme,
          routes: longNames("nightfall"),
        });
        try {
          await h1(o.page, LONG_NAME);
          if (text !== 100)
            // Through the CSSOM: the page's CSP refuses a style element.
            await o.page.evaluate((pct) => {
              document.documentElement.style.setProperty(
                "font-size",
                `${pct}%`,
                "important",
              );
            }, text);
          await o.page.waitForTimeout(400);
          const over = await horizontalOverflow(o.page);
          // On a failure the message names the elements that pass the window's edge.
          expect(over > 0 ? await widest(o.page) : []).toEqual([]);
          expect(over).toBeLessThanOrEqual(0);
          // The long names stay inside their own boxes.
          const spill = await o.page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main h1, main h1 ~ div, [data-product-actions]",
              ),
            ]
              .filter((e) => e.scrollWidth > e.clientWidth + 1)
              .map((e) => `${e.tagName} ${e.scrollWidth}>${e.clientWidth}`),
          );
          expect(spill).toEqual([]);
          // The tab strip (a nav of links, each a tab stop) scrolls inside itself when it must:
          // its box is never wider than the window.
          const strip = await o.page.evaluate(() => {
            const nav = document.querySelector<HTMLElement>(
              "[data-section-pills]",
            );
            if (!nav || !nav.checkVisibility()) return null;
            const box = nav.getBoundingClientRect();
            return {
              right: Math.round(box.right),
              inner: window.innerWidth,
              left: Math.round(box.left),
            };
          });
          if (strip) {
            expect(strip.left).toBeGreaterThanOrEqual(0);
            expect(strip.right).toBeLessThanOrEqual(strip.inner);
          }
          expect(await smallTargets(o.page, 24)).toEqual([]);
          const violations = await axe(o.page);
          expect(violations).toEqual([]);
        } finally {
          await o.close();
        }
      });
    }
  }
});

/** A 60-character display name with spaces, and an unbroken 40-character address. */
const LONG_PERSON =
  "Maximilian Alexander Fennick-Vandersteen the Third of Harbor";
const LONG_EMAIL = `${"a".repeat(30)}@example.org`;

function longPerson(): Record<string, Handler> {
  const base = portalRoutes("three")["/api/me"] as (req: Request) => Reply;
  return {
    "/api/me": (req) => {
      const r = base(req);
      const body = r.body as { account: Record<string, unknown> };
      return {
        ...r,
        body: {
          ...body,
          account: { ...body.account, name: LONG_PERSON, email: LONG_EMAIL },
        },
      };
    },
  };
}

const IDENTITY_ROWS = [
  { label: "320", width: 320, height: 640, text: 100 },
  { label: "1280 + 200 % text", width: 1280, height: 800, text: 200 },
  { label: "1440", width: 1440, height: 900, text: 100 },
] as const;

describe("identity rows wrap instead of cutting the name", () => {
  // The Account page still scrolls sideways at 320 px with 200 % text outside the identity rows
  // (provider rows, the Changing-a-method note, Download my data): a follow-up, not this check.
  for (const { label, width, height, text } of IDENTITY_ROWS) {
    for (const path of ["/#/account", "/#/account/methods"]) {
      const theme: Theme = width % 2 === 0 ? "dark" : "light";
      it(`${label}: ${path}, long name and address, no sideways scroll`, async ({
        expect,
      }) => {
        const o = await portal.open("three", path, {
          width,
          height,
          theme,
          routes: longPerson(),
        });
        try {
          await h1(o.page, "Account");
          if (text !== 100)
            await o.page.evaluate((pct) => {
              document.documentElement.style.setProperty(
                "font-size",
                `${pct}%`,
                "important",
              );
            }, text);
          await o.page.waitForTimeout(400);
          const over = await horizontalOverflow(o.page);
          expect(over > 0 ? await widest(o.page) : []).toEqual([]);
          expect(over).toBeLessThanOrEqual(0);
          // No text in main is clipped by an ellipsis in a row with the long values.
          const clipped = await o.page.evaluate(() =>
            [...document.querySelectorAll("main *")]
              .filter(
                (e) =>
                  e.children.length === 0 &&
                  getComputedStyle(e).textOverflow === "ellipsis" &&
                  e.scrollWidth > e.clientWidth + 1 &&
                  /Maximilian|aaaaaaaa/.test(e.textContent ?? ""),
              )
              .map((e) => (e.textContent ?? "").slice(0, 30)),
          );
          expect(clipped).toEqual([]);
        } finally {
          await o.close();
        }
      });
    }
  }
});
