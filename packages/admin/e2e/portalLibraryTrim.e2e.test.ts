import { afterAll, beforeAll, describe, it } from "vitest";
import {
  axe,
  h1,
  horizontalOverflow,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";

/**
 * PX-35: the Library's trimmed shell. No header Activate, no footer (Help and Privacy live in the
 * account menu), a sticky "Missing a license?" strip, and a denser tile grid: two columns on
 * phones, three from 761 px, four from 1180 px, five from 1700 px.
 */
let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

const SIZES = [
  { width: 320, height: 640, columns: 2 },
  { width: 360, height: 780, columns: 2 },
  { width: 390, height: 844, columns: 2 },
  { width: 1440, height: 900, columns: 4 },
  { width: 1920, height: 1080, columns: 5 },
] as const;

describe("the Library shell trim", () => {
  for (const { width, height, columns } of SIZES) {
    const theme: Theme = width % 2 === 0 ? "dark" : "light";
    it(`${width} px: ${columns} columns, no footer, no Activate in the header, clean`, async ({
      expect,
    }) => {
      const o = await portal.open("three", "/#/?view=grid", {
        width,
        height,
        theme,
      });
      try {
        await h1(o.page, "Your library");
        await o.page.getByRole("article").first().waitFor();
        await o.page.waitForTimeout(300);
        expect(await o.page.getByRole("contentinfo").count()).toBe(0);
        expect(
          await o.page
            .getByRole("banner")
            .getByRole("button", { name: /^Activate/ })
            .count(),
        ).toBe(0);
        expect(
          await o.page
            .getByRole("navigation", { name: "Phone" })
            .getByRole("button")
            .count(),
        ).toBe(0);
        const grid = await o.page.evaluate(() => {
          const ul = document.querySelector("main ul")!;
          const tiles = [...ul.querySelectorAll("article")].map((a) =>
            a.getBoundingClientRect(),
          );
          return {
            columns: getComputedStyle(ul).gridTemplateColumns.split(" ").length,
            maxHeight: Math.max(...tiles.map((r) => r.height)),
            minWidth: Math.min(...tiles.map((r) => r.width)),
          };
        });
        expect(grid.columns).toBe(columns);
        expect(grid.maxHeight).toBeLessThanOrEqual(width < 761 ? 300 : 290);
        expect(await horizontalOverflow(o.page)).toBeLessThanOrEqual(0);
        expect(await axe(o.page)).toEqual([]);
        expect(await o.violations()).toEqual([]);
        // The tiles' targets: the action and the overflow menu are 44 px on a touch viewport only;
        // never under 40 px.
        const small = await o.page.evaluate(
          () =>
            [...document.querySelectorAll("main article button")]
              .map((b) => b.getBoundingClientRect())
              .filter((r) => r.height < 40 || r.width < 40).length,
        );
        expect(small).toBe(0);
      } finally {
        await o.close();
      }
    });
  }

  it("the account menu opens Activate first, with Help and Privacy at its foot", async ({
    expect,
  }) => {
    const o = await portal.open("three", "/", { width: 1440 });
    try {
      await h1(o.page, "Your library");
      await o.page
        .getByRole("banner")
        .getByRole("button", { name: /^Account:/ })
        .click();
      const items = await o.page.getByRole("menuitem").allInnerTexts();
      expect(items).toEqual([
        "Activate a license",
        "Account",
        "Sign-in methods",
        "Appearance",
        "Help",
        "Privacy",
        "Sign out",
      ]);
    } finally {
      await o.close();
    }
  });

  it("1440: the strip is one line, sticks to the bottom while scrolling and ends the page below the last tile", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", { width: 1440, height: 900 });
    try {
      await h1(o.page, "Your library");
      await o.page.getByRole("article").first().waitFor();
      const strip = o.page.getByRole("region", { name: "Missing a license?" });
      await strip.waitFor();
      const box = async () => (await strip.boundingBox())!;
      // Scrolled to the top, with the page longer than the screen: pinned to the viewport bottom.
      const top = await box();
      expect(Math.round(top.y + top.height)).toBe(900);
      expect(top.height).toBeLessThanOrEqual(64);
      for (const a of await strip.getByRole("link").all())
        expect((await a.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // At the end: it rests below the last row of tiles, never over it.
      await o.page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      );
      await o.page.waitForTimeout(200);
      const end = await box();
      const lastBottom = await o.page.evaluate(() =>
        Math.max(
          ...[...document.querySelectorAll("main article")].map(
            (a) => a.getBoundingClientRect().bottom,
          ),
        ),
      );
      expect(lastBottom).toBeLessThanOrEqual(end.y + 0.5);
      expect(Math.round(end.y + end.height)).toBe(900);
    } finally {
      await o.close();
    }
  });

  it("390: the strip sits above the phone bar, collapsed, and opens upward", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", { width: 390, height: 844 });
    try {
      await h1(o.page, "Your library");
      const strip = o.page.getByRole("region", { name: "Missing a license?" });
      const bar = o.page.getByRole("navigation", { name: "Phone" });
      const toggle = strip.getByRole("button", { name: "Missing a license?" });
      await toggle.waitFor();
      const s = (await strip.boundingBox())!;
      const b = (await bar.boundingBox())!;
      expect(Math.round(s.y + s.height)).toBeLessThanOrEqual(Math.round(b.y));
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await strip.locator("a").count()).toBe(2);
      expect(await strip.locator("a").first().isVisible()).toBe(false);
      const closedTop = s.y;
      await toggle.click();
      const link = strip.getByRole("link", { name: "Connect Steam" });
      await link.waitFor();
      const open = (await strip.boundingBox())!;
      // The ways open above the button, and the strip grows upward.
      expect(open.y).toBeLessThan(closedTop);
      expect(Math.round(open.y + open.height)).toBe(Math.round(s.y + s.height));
      expect((await link.boundingBox())!.y).toBeLessThan(
        (await toggle.boundingBox())!.y,
      );
      expect(await horizontalOverflow(o.page)).toBeLessThanOrEqual(0);
      expect(await axe(o.page)).toEqual([]);
    } finally {
      await o.close();
    }
  });
});
