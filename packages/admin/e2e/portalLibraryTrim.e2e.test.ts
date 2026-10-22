import { afterAll, beforeAll, describe, it } from "vitest";
import { portalRoutes, type Handler } from "./portalFixtures.js";
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
        expect(grid.maxHeight).toBeLessThanOrEqual(width < 761 ? 400 : 290);
        expect(await horizontalOverflow(o.page)).toBeLessThanOrEqual(0);
        // Nothing extends past its tile: no action, name, pill or glyph spills out.
        const spills = await o.page.evaluate(() =>
          [
            ...document.querySelectorAll("main ul > li > div, main ul > li"),
          ].flatMap((cell) => {
            const card = cell.querySelector("article") ?? cell;
            const c = card.getBoundingClientRect();
            return [
              ...card.querySelectorAll(
                "button, a, h3, p, li, span.rounded-full, svg[role=img]",
              ),
            ]
              .filter((e) => !e.closest("[data-art]"))
              .map((e) => ({ e, r: e.getBoundingClientRect() }))
              .filter(
                ({ r }) =>
                  r.width > 0 &&
                  (r.right > c.right + 0.5 || r.left < c.left - 0.5),
              )
              .map(
                ({ e }) =>
                  `${e.tagName} "${(e.textContent ?? "").trim().slice(0, 24)}"`,
              );
          }),
        );
        expect(spills).toEqual([]);
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
      expect(top.height).toBeLessThanOrEqual(66);
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
      expect(await strip.locator("a").count()).toBe(1);
      expect(await strip.locator("a").first().isVisible()).toBe(false);
      const closedTop = s.y;
      await toggle.click();
      const link = strip.getByRole("link", { name: "Add it in Sign-in methods" });
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

  it("Activate from the account menu leaves focus in the dialog's key field", async ({
    expect,
  }) => {
    const o = await portal.open("three", "/", { width: 1440 });
    try {
      await h1(o.page, "Your library");
      await o.page
        .getByRole("banner")
        .getByRole("button", { name: /^Account:/ })
        .click();
      await o.page
        .getByRole("menuitem", { name: "Activate a license" })
        .click();
      const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
      await dialog.waitFor();
      await o.page.waitForTimeout(400);
      expect(
        await dialog
          .getByRole("textbox", { name: "License key" })
          .evaluate((el) => el === document.activeElement),
      ).toBe(true);
    } finally {
      await o.close();
    }
  });

  for (const width of [320, 360, 390, 412]) {
    it(`the twelve-product grid at ${width} px: every name shows, nothing spills out of a tile`, async ({
      expect,
    }) => {
      const o = await portal.open("twelve", "/", { width, height: 844 });
      try {
        await h1(o.page, "Your library");
        // Phones default to the list at 8+: ask for the grid.
        await o.page.getByRole("radio", { name: "Grid" }).click();
        await o.page.locator("[data-library-grid=compact]").waitFor();
        await o.page.waitForTimeout(400);
        const r = await o.page.evaluate(() => {
          const names = [...document.querySelectorAll("main article h3")].map(
            (h) => ({
              name: h.textContent,
              w: h.getBoundingClientRect().width,
            }),
          );
          const spills = [...document.querySelectorAll("main article")].flatMap(
            (card) => {
              const c = card.getBoundingClientRect();
              return [
                ...card.querySelectorAll(
                  "button, a, h3, p, li, span.rounded-full, svg[role=img]",
                ),
              ]
                .filter((e) => !e.closest("[data-art]"))
                .map((e) => ({ e, r: e.getBoundingClientRect() }))
                .filter(
                  ({ r }) =>
                    r.width > 0 &&
                    (r.right > c.right + 0.5 || r.left < c.left - 0.5),
                )
                .map(
                  ({ e }) =>
                    `${e.tagName} "${(e.textContent ?? "").trim().slice(0, 24)}"`,
                );
            },
          );
          return { names, spills };
        });
        expect(r.names.length).toBe(12);
        expect(r.names.filter((n) => n.w <= 40)).toEqual([]);
        expect(r.spills).toEqual([]);
        expect(await horizontalOverflow(o.page)).toBeLessThanOrEqual(0);
      } finally {
        await o.close();
      }
    });
  }

  it("the desktop strip is one line from 1180 px, and its disclosure closes on Escape and outside press", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", { width: 1180, height: 900 });
    try {
      await h1(o.page, "Your library");
      const strip = o.page.getByRole("region", { name: "Missing a license?" });
      await strip.waitFor();
      expect((await strip.boundingBox())!.height).toBeLessThanOrEqual(66);
      await o.page.setViewportSize({ width: 390, height: 844 });
      const toggle = strip.getByRole("button", { name: "Missing a license?" });
      await toggle.click();
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await o.page.keyboard.press("Escape");
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await toggle.evaluate((el) => el === document.activeElement)).toBe(
        true,
      );
      await toggle.click();
      await o.page.mouse.click(200, 120);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await o.close();
    }
  });

  /** A library of `count` products (copies under new slugs). */
  const libraryOf = (count: number): Record<string, Handler> => {
    const base = portalRoutes("three")["/api/library"] as () => {
      body: { products: Record<string, unknown>[] };
    };
    return {
      "/api/library": () => {
        const res = base();
        const first = res.body.products;
        const products = Array.from({ length: count }, (_, i) => {
          const p = first[i % first.length]!;
          return i < first.length
            ? p
            : {
                ...p,
                product: `${String(p.product)}-${i}`,
                name: `Extra ${i}`,
              };
        });
        return { body: { ...res.body, products } };
      },
    };
  };

  const FOCUS_CASES = [
    {
      label: "3 products at 360",
      scenario: "three",
      path: "/",
      width: 360,
      height: 780,
      count: 3,
    },
    {
      label: "7 products at 1024",
      scenario: "three",
      path: "/",
      width: 1024,
      height: 768,
      count: 7,
    },
    {
      label: "the list at 1440",
      scenario: "twelve",
      path: "/#/?view=list",
      width: 1440,
      height: 900,
      count: 12,
    },
  ] as const;
  for (const c of FOCUS_CASES) {
    it(`Tab never leaves a focused control under the sticky strip (${c.label})`, async ({
      expect,
    }) => {
      const o = await portal.open(c.scenario, c.path, {
        width: c.width,
        height: c.height,
        routes: c.scenario === "three" ? libraryOf(c.count) : undefined,
      });
      try {
        await h1(o.page, "Your library");
        await o.page.locator("[data-missing-strip]").waitFor();
        await o.page.waitForTimeout(500);
        await o.page.locator("h1").first().focus();
        const hidden: string[] = [];
        for (let i = 0; i < 70; i++) {
          await o.page.keyboard.press("Tab");
          await o.page.waitForTimeout(40);
          const r = await o.page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            const strip = document.querySelector("[data-missing-strip]")!;
            const phone = document.querySelector("nav[aria-label='Phone']");
            if (
              !el ||
              el === document.body ||
              strip.contains(el) ||
              phone?.contains(el)
            )
              return null;
            const a = el.getBoundingClientRect();
            const s = strip.getBoundingClientRect();
            const bar = document
              .querySelector("nav[aria-label='Phone']")
              ?.getBoundingClientRect();
            const over = (b: DOMRect | undefined | null) =>
              !!b &&
              b.height > 0 &&
              a.bottom > b.top + 0.5 &&
              a.top < b.bottom - 0.5;
            return over(s) || over(bar)
              ? `${el.tagName} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}"`
              : null;
          });
          if (r) hidden.push(r);
        }
        expect(hidden).toEqual([]);
      } finally {
        await o.close();
      }
    });
  }

  it("the strip's first item is Activate a license in every Library state", async ({
    expect,
  }) => {
    for (const [scenario, path] of [
      ["one", "/"],
      ["twelve", "/"],
      ["twelve", "/#/?view=list"],
    ] as const) {
      const o = await portal.open(scenario, path, { width: 1440 });
      try {
        await h1(o.page, "Your library");
        const strip = o.page.getByRole("region", {
          name: "Missing a license?",
        });
        const first = strip.getByRole("button", { name: "Activate a license" });
        await first.click();
        await o.page
          .getByRole("dialog", { name: "Activate a license" })
          .waitFor();
      } finally {
        await o.close();
      }
    }
  });
});
