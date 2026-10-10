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
 * Art and hero rendering (PX-30; B4, B12). The library's one-product hero at 1024, 1180, 1440,
 * 1920 px, 1023 × 900 stacked, an 844 × 390 phone on its side and a 390 px phone, in both themes,
 * with art, without art, and with a very long name:
 *
 * - the art is never cropped (`object-fit: contain`) and nothing is drawn over it;
 * - the primary action is on the first screen (inside the viewport) at 1023 × 900 and 844 × 390;
 * - the hero is side by side from 1024 px and on a short screen from 560 px;
 * - no horizontal page scroll.
 *
 * With `PK_SHOTS_DIR` set it saves `hero-<case>-<size>-<theme>.png` there (the PR's evidence).
 */

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

const SIZES = [
  { label: "1024", width: 1024, height: 768, side: true },
  { label: "1023x900", width: 1023, height: 900, side: false },
  { label: "1180", width: 1180, height: 800, side: true },
  { label: "1440", width: 1440, height: 900, side: true },
  { label: "1920", width: 1920, height: 1080, side: true },
  { label: "844x390", width: 844, height: 390, side: true },
  { label: "390", width: 390, height: 844, side: false },
] as const;

type Variant = "art" | "noart" | "long";
const LONG =
  "The Extraordinarily Long Titled Expedition of the Wandering Cartographers Guild: Collector’s Edition";

function libraryRoute(variant: Variant): Record<string, Handler> {
  if (variant === "art") return {};
  const base = portalRoutes("one")["/api/library"] as () => {
    body: { products: Record<string, unknown>[] };
  };
  return {
    "/api/library": () => {
      const res = base();
      return {
        body: {
          ...res.body,
          products: res.body.products.map((p) => ({
            ...p,
            ...(variant === "noart" ? { iconUrl: null, headerUrl: null } : {}),
            ...(variant === "long" ? { name: LONG } : {}),
          })),
        },
      };
    },
  };
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const hero = document.querySelector(
      "article[aria-labelledby='hero-name']",
    )!;
    const art = hero.querySelector("[data-art]") as HTMLElement;
    const panel = hero.children[1] as HTMLElement;
    const cta = panel.querySelector("a[aria-label], button") as HTMLElement;
    const a = art.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const c = cta.getBoundingClientRect();
    const img = art.querySelector(
      "img:not([data-blur])",
    ) as HTMLImageElement | null;
    return {
      sideBySide: a.right <= p.left + 1 && a.top < p.bottom && p.top < a.bottom,
      ctaBottom: c.bottom,
      viewport: innerHeight,
      fit: img ? getComputedStyle(img).objectFit : null,
      artText: art.textContent?.trim() ?? "",
      artW: a.width,
      artH: a.height,
    };
  });
}

describe.concurrent("library hero art", () => {
  for (const variant of ["art", "noart", "long"] as const) {
    SIZES.forEach((size) => {
      for (const theme of ["dark", "light"] as const satisfies Theme[])
        it(`${variant}: ${size.label}, ${theme}`, async ({ expect }) => {
          const o = await portal.open("one", "/", {
            theme,
            width: size.width,
            height: size.height,
            routes: libraryRoute(variant),
          });
          try {
            await h1(o.page, "Your library");
            await o.page.waitForSelector(
              "article[aria-labelledby='hero-name']",
            );
            await shoot(o.page, `hero-${variant}-${size.label}-${theme}`);
            const g = await geometry(o.page);
            expect(g.sideBySide, "side by side").toBe(size.side);
            expect(g.artText, "no text over the art").toBe("");
            if (variant !== "noart") expect(g.fit).toBe("contain");
            if (size.label === "1023x900" || size.label === "844x390")
              expect(
                g.ctaBottom,
                "action on the first screen",
              ).toBeLessThanOrEqual(g.viewport);
            expect(await horizontalOverflow(o.page)).toBeLessThanOrEqual(0);
          } finally {
            await o.close();
          }
        });
    });
  }
});
