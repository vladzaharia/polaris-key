import { afterAll, beforeAll, describe, it } from "vitest";
import type { Page } from "playwright";
import {
  axe,
  h1,
  horizontalOverflow,
  startPortal,
  type Opened,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";

/**
 * The Polaris Key storefront's three flows (PS-05, notes/S-21 §6.5), in the built SPA under the
 * Worker's exact CSP, in both themes at 1440 and 390 px (and 360 px for the page's width):
 *
 * - add from a tile: an open product from its Discover tile becomes a library entry ("Free to
 *   use", no licence);
 * - add from the product page: `#/discover/lumen-raw`, the second way chosen, Add, and the page
 *   is replaced by the product's library page with its heading focused;
 * - remove an entry: Remove from library on the entry's tile, confirmed inline, and focus lands
 *   on the Library's heading.
 *
 * Every step: zero CSP violations, zero axe violations, no horizontal scroll.
 */

const WIDTHS = [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile", width: 390, height: 844 },
] as const;
const THEMES: Theme[] = ["dark", "light"];

let portal: PortalHarness;

beforeAll(async () => {
  portal = await startPortal();
});

afterAll(async () => {
  await portal?.stop();
});

type Expect = Parameters<Parameters<typeof it>[1]>[0]["expect"];

/**
 * The quality bar at this step: CSP, axe, and no sideways scroll (at 360 px on phones too). Like
 * every state of the quality bar, the page is checked from its top: scrolled, a tile's name link
 * passes under the sticky header, which axe's target-size rule reads as an obscured target.
 */
async function clean(
  expect: Expect,
  o: Opened,
  width: number,
  step: string,
): Promise<void> {
  await o.page.evaluate(() => window.scrollTo(0, 0));
  expect.soft(await o.violations(), `${step}: CSP violations`).toEqual([]);
  expect.soft(await axe(o.page), `${step}: axe violations`).toEqual([]);
  expect
    .soft(await horizontalOverflow(o.page), `${step}: horizontal scroll`)
    .toBeLessThanOrEqual(0);
  if (width === 390) {
    await o.page.setViewportSize({ width: 360, height: 780 });
    await o.page.waitForTimeout(100);
    expect
      .soft(await horizontalOverflow(o.page), `${step}: scroll at 360 px`)
      .toBeLessThanOrEqual(0);
    await o.page.setViewportSize({ width: 390, height: 844 });
  }
}

const focusedText = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.textContent ?? null);

describe.concurrent("the storefront's flows (PS-05)", () => {
  for (const theme of THEMES)
    for (const w of WIDTHS) {
      const opts = { theme, width: w.width, height: w.height };

      it(`adds an open product from its tile: ${theme}, ${w.width} px`, async ({
        expect,
      }) => {
        const o = await portal.open("storefront", "/#/discover", opts);
        try {
          const { page } = o;
          await h1(page, "Discover");
          const tile = page.getByRole("article", { name: "Driftwood Notes" });
          await tile.getByText("Free to use").waitFor();
          await clean(expect, o, w.width, "Discover");
          await tile
            .getByRole("button", { name: "Add to library: Driftwood Notes" })
            .click();
          const open = tile.getByRole("link", { name: "Open Driftwood Notes" });
          await open.waitFor();
          expect(await open.getAttribute("href")).toBe("#/p/driftwood");
          expect(o.requests).toContain("POST /api/discover/driftwood/claim");
          await clean(expect, o, w.width, "just added");

          // In the Library: an entry, "Free to use", no seat facts.
          await open.click();
          await h1(page, "Driftwood Notes");
          await page.getByText("Free to use").first().waitFor();
          expect(
            await page.getByRole("region", { name: /^Devices/ }).count(),
          ).toBe(0);
          await clean(expect, o, w.width, "entry page");
        } finally {
          await o.close();
        }
      });

      it(`adds from the storefront page by the chosen way: ${theme}, ${w.width} px`, async ({
        expect,
      }) => {
        const o = await portal.open("storefront", "/#/discover", opts);
        try {
          const { page } = o;
          await h1(page, "Discover");
          await page
            .getByRole("article", { name: "Lumen RAW" })
            .getByRole("link", { name: "Lumen RAW", exact: true })
            .click();
          await page.waitForURL(/#\/discover\/lumen-raw$/);
          await h1(page, "Lumen RAW");
          const ways = page.getByRole("region", { name: "Ways to add it" });
          await ways
            .getByRole("radio", { name: /Included with Aperture Seven/ })
            .waitFor();
          expect(
            await ways
              .getByRole("radio", { name: /Included with Aperture Seven/ })
              .isChecked(),
          ).toBe(true);
          expect(
            await page
              .getByRole("region", { name: "Screenshots" })
              .getByRole("img")
              .count(),
          ).toBe(2);
          await clean(expect, o, w.width, "storefront page");

          await ways
            .getByRole("radio", { name: /Free trial · 14 days/ })
            .check();
          const claim = page.waitForRequest(
            (r) =>
              r.method() === "POST" &&
              r.url().endsWith("/api/discover/lumen-raw/claim"),
          );
          await page.getByRole("button", { name: "Add to library" }).click();
          expect((await claim).postDataJSON()).toEqual({ path: "auto_issue" });
          await page.waitForURL(/#\/p\/lumen-raw$/);
          await h1(page, "Lumen RAW");
          await expect
            .poll(() =>
              page.evaluate(() => document.activeElement?.tagName ?? null),
            )
            .toBe("H1");
          expect(await focusedText(page)).toBe("Lumen RAW");
          await clean(expect, o, w.width, "after Add");
          // The storefront page was replaced: Back skips it, to Discover.
          await page.goBack();
          await page.waitForURL(/#\/discover$/);
          await h1(page, "Discover");
        } finally {
          await o.close();
        }
      });

      it(`removes an entry, confirmed inline: ${theme}, ${w.width} px`, async ({
        expect,
      }) => {
        const o = await portal.open("storefront", "/", opts);
        try {
          const { page } = o;
          await h1(page, "Your library");
          const tile = page.getByRole("article", { name: "Kestrel Maps" });
          await tile.getByText("Free to use").waitFor();
          await tile
            .getByRole("button", { name: "More for Kestrel Maps" })
            .click();
          await page
            .getByRole("menuitem", { name: "Remove from library" })
            .click();
          const confirm = tile.getByRole("group", {
            name: "Remove Kestrel Maps from your library?",
          });
          await confirm.waitFor();
          await page.getByRole("menu").waitFor({ state: "detached" });
          await expect.poll(() => focusedText(page)).toBe("Keep it");
          await clean(expect, o, w.width, "confirm");

          await confirm
            .getByRole("button", { name: "Remove from library" })
            .click();
          await tile.waitFor({ state: "detached" });
          expect(o.requests).toContain("DELETE /api/library/kestrel-maps");
          await expect
            .poll(() =>
              page.evaluate(() => document.activeElement?.tagName ?? null),
            )
            .toBe("H1");
          expect(await focusedText(page)).toBe("Your library");
          await page
            .getByText("Kestrel Maps was removed from your library")
            .waitFor();
          await clean(expect, o, w.width, "removed");
        } finally {
          await o.close();
        }
      });
    }
});
