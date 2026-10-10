import { afterAll, beforeAll, describe, it } from "vitest";
import {
  axe,
  h1,
  h1Count,
  horizontalOverflow,
  RESOLUTIONS,
  shoot,
  smallTargets,
  unlabelledScrollers,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import type { Page } from "playwright";
import { portalRoutes, type Handler } from "./portalFixtures.js";
import { SHIPPED, toConfirm } from "./portalStates.js";

/**
 * The customer site at every other size (PORTAL.md §8, §9). `portalQuality.e2e.test.ts` holds
 * each shipped §4 state to the quality bar and its visual baseline at 1440 and 390 px; this suite
 * opens every one of them again, fresh, at each of `RESOLUTIONS` (320 and 360 px phones, 768 and
 * 820 px tablets upright, 1024 px on its side, an 844 × 390 phone on its side, 2560 px and 200 %
 * zoom) and checks, with no pixel baselines:
 *
 * - zero Content-Security-Policy violations;
 * - zero axe violations (WCAG 2.2 A/AA and best practices);
 * - exactly one visible `h1`;
 * - no horizontal page scroll (§8);
 * - no pointer target under 24 × 24 px that SC 2.5.8 does not excuse (`smallTargets`).
 *
 * The theme alternates with the size (dark at the first, light at the next, …), so both themes
 * meet every layout tier without doubling the run; each state already passes axe in both themes
 * at 1440 and 390 px. With `PK_SHOTS_DIR` set it saves `<state>-<size>-<theme>.png` there.
 */

let portal: PortalHarness;

beforeAll(async () => {
  portal = await startPortal();
});

afterAll(async () => {
  await portal?.stop();
});

describe.concurrent("every shipped §4 state at every size", () => {
  for (const state of SHIPPED) {
    describe(`§${state.section} ${state.title} (${state.id})`, () => {
      RESOLUTIONS.flatMap((size, i) =>
        size.bothThemes
          ? (["dark", "light"] as Theme[]).map((theme) => ({ size, theme }))
          : [{ size, theme: (i % 2 === 0 ? "dark" : "light") as Theme }],
      ).forEach(({ size, theme }) => {
        it(`${size.label} (${size.width} × ${size.height}), ${theme}`, async ({
          expect,
        }) => {
          const o = await portal.open(state.scenario, state.path, {
            theme,
            width: size.width,
            height: size.height,
            deviceScaleFactor: size.deviceScaleFactor,
            routes: state.routes,
          });
          try {
            await state.ready(o.page);
            await shoot(o.page, `${state.id}-${size.label}-${theme}`);
            expect.soft(await o.violations(), "CSP violations").toEqual([]);
            expect.soft(await axe(o.page), "axe violations").toEqual([]);
            expect.soft(await h1Count(o.page), "visible h1 count").toBe(1);
            expect
              .soft(await horizontalOverflow(o.page), "horizontal scroll")
              .toBeLessThanOrEqual(0);
            expect
              .soft(await smallTargets(o.page), "targets under 24 × 24 px")
              .toEqual([]);
            expect
              .soft(
                await unlabelledScrollers(o.page),
                "sideways scrollers outside a labelled region",
              )
              .toEqual([]);
          } finally {
            await o.close();
          }
        });
      });
    });
  }
});

/**
 * Tab to the open dialog's scrolling body (a `region` while it overflows) and read its focus
 * outline; null when Tab never reaches it.
 */
async function focusScrollingBody(
  page: Page,
): Promise<{ style: string; width: string } | null> {
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el?.matches("[role=dialog] [role=region]")) return null;
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: cs.outlineWidth };
    });
    if (ring) return ring;
  }
  return null;
}

/** A fixture's reply body, for a variation on it. */
function body<T>(h: Handler | undefined): T {
  const reply = typeof h === "function" ? h(undefined as never) : h;
  return reply!.body as T;
}

describe("the signed-in header (PORTAL.md §3.2, §8)", () => {
  // The widest realistic row: twelve products (so the ⌘K trigger), a two-digit Discover count and
  // a long name on the account chip; and the same with a right-to-left name.
  const twelve = portalRoutes("twelve");
  const me = body<{ account: Record<string, unknown> }>(twelve["/api/me"]);
  const routesFor = (name: string) => ({
    "/api/library": {
      body: {
        ...body<Record<string, unknown>>(twelve["/api/library"]),
        discoverCount: 24,
      },
    },
    "/api/me": {
      body: {
        ...me,
        account: {
          ...me.account,
          name,
          email: "maximiliana.fennick-oyelaran@fennick.studio",
        },
      },
    },
  });
  const WIDTHS = [
    761, 768, 800, 820, 844, 880, 899, 900, 960, 1024, 1100, 1179, 1180, 1280,
    1366, 1440, 1920, 2560,
  ];
  const NAMES = [
    "Maximiliana Fennick-Oyelaran",
    "Dr. Maximiliana Fennick",
    "عبد الرحمن الفاسي-بنعبد الله",
  ];

  for (const name of NAMES) {
    it(`keeps every control on screen, inside the gutter, at every desktop width (${name})`, async ({
      expect,
    }) => {
      const o = await portal.open("twelve", "/", {
        width: 761,
        routes: routesFor(name),
      });
      try {
        await h1(o.page, "Your library");
        for (const width of WIDTHS) {
          await o.page.setViewportSize({ width, height: 900 });
          const row = await o.page.evaluate(() => {
            const inner = document.querySelector("header > div")!;
            const pad = parseFloat(getComputedStyle(inner).paddingRight);
            const box = inner.getBoundingClientRect();
            const parts = [...inner.children].map((c) =>
              c.getBoundingClientRect(),
            );
            return {
              contentRight: box.right - pad,
              rights: parts.map((r) => r.right),
              lefts: parts.map((r) => r.left),
            };
          });
          expect
            .soft(
              await horizontalOverflow(o.page),
              `horizontal scroll at ${width}`,
            )
            .toBeLessThanOrEqual(0);
          // Nothing past the header's own gutter, and lockup, nav and actions never overlap.
          expect
            .soft(Math.max(...row.rights), `header row at ${width}`)
            .toBeLessThanOrEqual(row.contentRight + 0.5);
          for (let i = 1; i < row.lefts.length; i++)
            expect
              .soft(
                row.lefts[i]! - row.rights[i - 1]!,
                `header gap ${i} at ${width}`,
              )
              .toBeGreaterThanOrEqual(16);
          const visible = await o.page.evaluate(() =>
            [...document.querySelectorAll("header a, header button")]
              .filter((e) => e.checkVisibility())
              .map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim())
              .join(" · "),
          );
          expect
            .soft(visible, `header controls at ${width}`)
            .toBe(
              `Polaris Key: your library · Library12 · Discover24 · Jump to a product · Activate license · Account: ${name}`,
            );
          // From 1180 px the chip shows the full name. It truncates only once the ⌘K field has
          // given way to its 176 px floor, or the chip has reached its 18rem cap.
          const chip = await o.page.evaluate(() => {
            const button = document.querySelector<HTMLElement>(
              'header button[aria-label^="Account:"]',
            )!;
            const span = button.querySelector<HTMLElement>('span[dir="auto"]');
            const jump = document.querySelector<HTMLElement>(
              'header button[aria-label="Jump to a product"]',
            );
            return span?.checkVisibility()
              ? {
                  text: span.textContent,
                  clipped: span.scrollWidth > span.clientWidth,
                  chip: button.getBoundingClientRect().width,
                  jump: jump?.getBoundingClientRect().width ?? 0,
                }
              : null;
          });
          if (width >= 1180) {
            expect.soft(chip?.text, `the chip's name at ${width}`).toBe(name);
            if (chip?.clipped)
              expect
                .soft(
                  chip.jump <= 176.5 || chip.chip >= 287.5,
                  `the name truncates before ⌘K gives way at ${width} (⌘K ${chip.jump} px, chip ${chip.chip} px)`,
                )
                .toBe(true);
          } else expect.soft(chip, `the chip at ${width}`).toBeNull();
        }
      } finally {
        await o.close();
      }
    });
  }

  it("gives ⌘K, Activate and the account chip one height: 40 px, 44 on a coarse pointer", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", {
      width: 1024,
      routes: routesFor(NAMES[0]!),
    });
    try {
      await h1(o.page, "Your library");
      const heights = () =>
        o.page.evaluate(() =>
          [
            'header button[aria-label="Jump to a product"]',
            'header button[aria-label="Activate license"]',
            'header button[aria-label^="Account:"]',
          ].map((sel) =>
            Math.round(
              [...document.querySelectorAll(sel)]
                .find((e) => e.checkVisibility())!
                .getBoundingClientRect().height,
            ),
          ),
        );
      for (const width of [1024, 1440]) {
        await o.page.setViewportSize({ width, height: 900 });
        expect.soft(await heights(), `at ${width}`).toEqual([40, 40, 40]);
      }
    } finally {
      await o.close();
    }
  });
});

describe("the tablet and short-screen rules (PORTAL.md §8)", () => {
  /** The rows of a grid's items: each item's top, rounded, mapped to the items in that row. */
  const rowsOf = (page: Page, list: string, item: string) =>
    page.evaluate(
      ({ list, item }) => {
        const ul = document.querySelector(list)!;
        const box = ul.getBoundingClientRect();
        return {
          columns: getComputedStyle(ul).gridTemplateColumns.split(" ").length,
          width: box.width,
          items: [...ul.children].map((li) => {
            const r = li.getBoundingClientRect();
            const a = item ? li.querySelector(item) : null;
            const ar = a?.getBoundingClientRect();
            return {
              top: Math.round(r.top),
              width: r.width,
              action: ar
                ? {
                    top: Math.round(ar.top),
                    height: ar.height,
                    fits: a!.scrollWidth <= a!.clientWidth,
                  }
                : null,
            };
          }),
        };
      },
      { list, item },
    );

  /** Compact tiles whose status pill overlaps their icon (the pill is the art's only child span). */
  const pillsOverIcons = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-library-grid=compact] article")]
        .map((tile) => {
          const pill = tile.querySelector(
            ":scope > :first-child span.absolute",
          );
          const icon = tile.querySelector(
            ":scope > div > div:first-child > :first-child",
          );
          if (!pill || !icon) return null;
          const a = pill.getBoundingClientRect();
          const b = icon.getBoundingClientRect();
          const overlap =
            a.width > 0 &&
            a.left < b.right &&
            b.left < a.right &&
            a.top < b.bottom &&
            b.top < a.bottom;
          return overlap ? tile.getAttribute("aria-labelledby") : null;
        })
        .filter(Boolean),
    );

  it("Needs attention: three columns from 900 px, one-line actions that line up", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", { width: 900 });
    try {
      await h1(o.page, "Your library");
      await o.page.getByRole("region", { name: /Needs attention/ }).waitFor();
      const SHELF = "section[aria-labelledby=attention-h] > ul";
      for (const width of [900, 1024, 1280, 1440, 1920, 2560]) {
        await o.page.setViewportSize({ width, height: 900 });
        const grid = await rowsOf(o.page, SHELF, "a.w-full");
        // A truncated label shows in full on hover.
        expect
          .soft(
            await o.page.evaluate(
              (sel) =>
                [...document.querySelectorAll(`${sel} a.w-full`)].every(
                  (a) => a.getAttribute("title") === a.textContent?.trim(),
                ),
              SHELF,
            ),
            `action titles at ${width}`,
          )
          .toBe(true);
        expect.soft(grid.columns, `columns at ${width}`).toBe(3);
        expect.soft(grid.items.length).toBe(3);
        for (const [i, it] of grid.items.entries()) {
          expect
            .soft(it.action!.height, `action ${i} height at ${width}`)
            .toBeLessThanOrEqual(40);
          expect
            .soft(it.action!.fits, `action ${i} label at ${width}`)
            .toBe(true);
        }
        const tops = grid.items.map((it) => it.action!.top);
        expect
          .soft(
            Math.max(...tops) - Math.min(...tops),
            `action tops at ${width}`,
          )
          .toBeLessThanOrEqual(1);
      }
      // Two columns at 761–899 px: the odd third card spans both.
      await o.page.setViewportSize({ width: 768, height: 1024 });
      const tablet = await rowsOf(o.page, SHELF, "");
      expect(tablet.columns).toBe(2);
      expect(tablet.items[2]!.width).toBeCloseTo(tablet.width, 0);
    } finally {
      await o.close();
    }
  });

  it("Ready to add: on tablets the odd third offer spans both columns", async ({
    expect,
  }) => {
    const o = await portal.open("empty", "/", { width: 768, height: 1024 });
    try {
      await o.page.getByRole("region", { name: /Ready to add/ }).waitFor();
      const grid = await rowsOf(
        o.page,
        "section[aria-labelledby=ready-h] > ul",
        "",
      );
      expect(grid.columns).toBe(2);
      expect(grid.items).toHaveLength(3);
      expect(grid.items[2]!.width).toBeCloseTo(grid.width, 0);
    } finally {
      await o.close();
    }
  });

  it("the compact grid keeps three columns on tablets, every action label inside its button", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", { width: 761 });
    try {
      await h1(o.page, "Your library");
      await o.page.locator("[data-library-grid=compact]").waitFor();
      for (const width of [761, 768, 820, 899]) {
        await o.page.setViewportSize({ width, height: 1024 });
        const grid = await rowsOf(
          o.page,
          "[data-library-grid=compact]",
          "article .mt-auto > :first-child",
        );
        expect.soft(grid.columns, `columns at ${width}`).toBe(3);
        for (const [i, it] of grid.items.entries())
          expect
            .soft(it.action?.fits, `tile ${i}'s action at ${width}`)
            .toBe(true);
        expect
          .soft(await pillsOverIcons(o.page), `pills over icons at ${width}`)
          .toEqual([]);
      }
      // Four columns from 1180 px: the narrowest tiles, at 1180–1250 px, too.
      for (const width of [1180, 1220]) {
        await o.page.setViewportSize({ width, height: 900 });
        expect
          .soft(await pillsOverIcons(o.page), `pills over icons at ${width}`)
          .toEqual([]);
      }
    } finally {
      await o.close();
    }
  });

  it("Account → Appearance: the three theme swatches are one width", async ({
    expect,
  }) => {
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1440, 900],
    ] as const) {
      const o = await portal.open("three", "/#/account/appearance", {
        width,
        height,
      });
      try {
        await h1(o.page, "Account");
        const widths = await o.page.evaluate(() =>
          [...document.querySelectorAll("[data-swatch]")].map(
            (s) => s.getBoundingClientRect().width,
          ),
        );
        expect.soft(widths, `swatches at ${width}`).toHaveLength(3);
        expect
          .soft(
            Math.max(...widths) - Math.min(...widths),
            `swatch widths at ${width}: ${widths.join(", ")}`,
          )
          .toBeLessThanOrEqual(1);
        // 112 px wherever the cards have room; on a tablet they shrink together, never collapse.
        if (width !== 768)
          expect.soft(Math.round(widths[0]!), `at ${width}`).toBe(112);
        else expect.soft(widths[0]!, `at ${width}`).toBeGreaterThanOrEqual(64);
      } finally {
        await o.close();
      }
    }
  });

  it("the product page: one column with pills below 1024 px, device names whole", async ({
    expect,
  }) => {
    const three = portalRoutes("three");
    const detail = "/api/licenses/nightfall/lic_nightfall";
    const routes = {
      [detail]: () => {
        const b = body<{ devices: { label: string }[] }>(three[detail]);
        return {
          body: {
            ...b,
            devices: b.devices.map((d, i) =>
              i === 0
                ? { ...d, label: "Maximiliana's MacBook Air (Studio)" }
                : d,
            ),
          },
        };
      },
    };
    const o = await portal.open("three", "/#/p/nightfall", {
      width: 768,
      height: 1024,
      routes,
    });
    try {
      await h1(o.page, "Nightfall");
      const layout = () =>
        o.page.evaluate(() => ({
          columns: getComputedStyle(document.querySelector("[data-columns]")!)
            .display,
          pills:
            document
              .querySelector("nav[aria-label=Sections]")
              ?.checkVisibility() ?? false,
          clipped: [
            ...document.querySelectorAll(
              "[data-device-name], [data-platform-name]",
            ),
          ]
            .filter((e) => e.scrollWidth > e.clientWidth)
            .map((e) => e.textContent),
        }));
      for (const width of [768, 820]) {
        await o.page.setViewportSize({ width, height: 1024 });
        expect.soft(await layout(), `at ${width}`).toMatchObject({
          columns: "flex",
          pills: true,
        });
      }
      for (const width of [820, 1024, 1180]) {
        await o.page.setViewportSize({ width, height: 900 });
        expect
          .soft(
            (await layout()).clipped,
            `device and platform names at ${width}`,
          )
          .toEqual([]);
      }
      // Main · side from 1024 px, the pills until 1180 px.
      await o.page.setViewportSize({ width: 1024, height: 900 });
      expect(await layout()).toMatchObject({ columns: "grid", pills: true });
      // In the narrow side column Remove sits under the meta line: the name has the row.
      for (const width of [1024, 1440]) {
        await o.page.setViewportSize({ width, height: 900 });
        const rows = await o.page.evaluate(() =>
          [...document.querySelectorAll("#section-devices li")]
            .map((li) => {
              const name = li.querySelector("[data-device-name]");
              const remove = li.querySelector("button[aria-label^=Remove]");
              if (!name || !remove) return null;
              const meta = name.nextElementSibling!.getBoundingClientRect();
              return remove.getBoundingClientRect().top >= meta.bottom;
            })
            .filter((r) => r !== null),
        );
        expect.soft(rows.length, `device rows at ${width}`).toBeGreaterThan(0);
        expect
          .soft(rows.every(Boolean), `Remove under the meta at ${width}`)
          .toBe(true);
      }
      await o.page.setViewportSize({ width: 1024, height: 900 });
      // The long name's Remove confirmation: both labels inside their buttons.
      const devices = o.page.getByRole("region", { name: "Devices" });
      await devices
        .getByRole("button", {
          name: "Remove Maximiliana's MacBook Air (Studio)",
        })
        .click();
      const panel = devices.locator('[id^="remove-"]');
      await panel.getByRole("button", { name: "Keep it" }).waitFor();
      const fits = await panel
        .getByRole("button")
        .evaluateAll((bs) =>
          bs.map((b) => [b.textContent, b.scrollWidth <= b.clientWidth]),
        );
      expect(fits).toEqual([
        ["Keep it", true],
        ["Remove", true],
      ]);
    } finally {
      await o.close();
    }
  });

  it("short screens: the header scrolls away and what stuck under it sticks to the top", async ({
    expect,
  }) => {
    const header = (page: Page) =>
      page.evaluate(
        () => getComputedStyle(document.querySelector("header")!).position,
      );
    const pillsTop = (page: Page, label: string) =>
      page.evaluate((label) => {
        const nav = document.querySelector(`nav[aria-label="${label}"]`);
        return nav?.checkVisibility() ? getComputedStyle(nav).top : null;
      }, label);
    const sizes = [
      { width: 844, height: 390, position: "static" },
      { width: 640, height: 400, dpr: 2, position: "static" },
      { width: 1440, height: 500, position: "static" },
      { width: 768, height: 1024, position: "sticky" },
      { width: 1440, height: 900, position: "sticky" },
    ];
    for (const s of sizes) {
      const o = await portal.open("three", "/#/p/nightfall", {
        width: s.width,
        height: s.height,
        deviceScaleFactor: s.dpr,
      });
      try {
        await h1(o.page, "Nightfall");
        expect
          .soft(await header(o.page), `header at ${s.width}×${s.height}`)
          .toBe(s.position);
        if (s.position === "static" && s.width < 1180)
          expect
            .soft(
              await pillsTop(o.page, "Sections"),
              `product pills at ${s.width}×${s.height}`,
            )
            .toBe("0px");
      } finally {
        await o.close();
      }
    }
    const o = await portal.open("three", "/#/account", {
      width: 640,
      height: 400,
      deviceScaleFactor: 2,
    });
    try {
      await h1(o.page, "Account");
      expect(await pillsTop(o.page, "Account sections")).toBe("0px");
    } finally {
      await o.close();
    }
  });

  it("short screens: the art steps aside, so the task is on the first screen", async ({
    expect,
  }) => {
    for (const [width, height] of [
      [844, 390],
      [667, 375],
    ] as const) {
      const o = await portal.open("three", "/", { width, height });
      try {
        await toConfirm(o.page);
        const where = await o.page.evaluate(() => {
          const dialog = document.querySelector("[role=dialog]")!;
          const line = [...dialog.querySelectorAll("p")].find((p) =>
            p.textContent?.startsWith("Key recognized"),
          )!;
          const body = line.closest(".pk-scroll")!;
          return {
            line: line.getBoundingClientRect().bottom,
            body: body.getBoundingClientRect().bottom,
          };
        });
        expect
          .soft(where.line, `"Key recognized" at ${width}×${height}`)
          .toBeLessThanOrEqual(where.body);
      } finally {
        await o.close();
      }
    }
    for (const [width, height] of [
      [844, 390],
      [932, 430],
      [667, 375],
    ] as const) {
      const o = await portal.open("three", "/#/p/nightfall", { width, height });
      try {
        await h1(o.page, "Nightfall");
        const { bottom, limit } = await o.page.evaluate(() => {
          const lead = document.querySelector(
            "[data-product-actions] > :first-child",
          )!;
          // The fixed phone bar, when there is one, covers the bottom of the screen.
          const bar = [...document.querySelectorAll("nav")].find(
            (n) =>
              getComputedStyle(n).position === "fixed" && n.checkVisibility(),
          );
          return {
            bottom: lead.getBoundingClientRect().bottom,
            limit: bar ? bar.getBoundingClientRect().top : window.innerHeight,
          };
        });
        expect
          .soft(bottom, `the lead action at ${width}×${height}`)
          .toBeLessThanOrEqual(limit);
      } finally {
        await o.close();
      }
    }
  });

  it("a focused dialog body that scrolls draws its focus ring (WCAG 2.4.7)", async ({
    expect,
  }) => {
    const o = await portal.open("three", "/", { width: 667, height: 375 });
    try {
      await toConfirm(o.page);
      const ring = await focusScrollingBody(o.page);
      expect(ring).toEqual({ style: "solid", width: "2px" });
    } finally {
      await o.close();
    }
  });

  it("one product: the hero's download is on the first screen from 1024 px and on a short screen", async ({
    expect,
  }) => {
    for (const [width, height] of [
      [1024, 768],
      [1179, 900],
      [844, 390],
    ] as const) {
      const o = await portal.open("one", "/", { width, height });
      try {
        await h1(o.page, "Your library");
        const hero = o.page.locator("article[aria-labelledby=hero-name]");
        await hero.waitFor();
        const where = await hero.evaluate((article) => {
          const box = article.firstElementChild!;
          const art = box.getBoundingClientRect();
          const button = article
            .querySelector("button")!
            .getBoundingClientRect();
          const img = box.querySelector("img:not([data-blur])");
          return {
            bottom: button.bottom,
            // Side by side: the panel starts beside the art, not under it.
            sideBySide: button.left >= art.right - 1,
            // Never cropped (PX-30): the column stretches to the panel, and the art is contained
            // in it over a blurred copy.
            fit: img ? getComputedStyle(img).objectFit : null,
          };
        });
        expect
          .soft(where.bottom, `the download at ${width}×${height}`)
          .toBeLessThanOrEqual(height);
        expect.soft(where.sideBySide, `side by side at ${width}`).toBe(true);
        expect.soft(where.fit, `the art at ${width}×${height}`).toBe("contain");
      } finally {
        await o.close();
      }
    }
  });

  it("short screens: the focused flows drop their art too", async ({
    expect,
  }) => {
    for (const s of [
      {
        scenario: "twelve" as const,
        path: "/#/p/orbit-survey/free-device?return=orbitsurvey%3A%2F%2Fretry",
        heading: "Your license is on 2 of 2 devices",
      },
      {
        scenario: "three" as const,
        path: "/#/p/nightfall/download?platform=linux",
        heading: "Download Nightfall for Linux",
      },
    ]) {
      const o = await portal.open(s.scenario, s.path, {
        width: 844,
        height: 390,
      });
      try {
        await h1(o.page, s.heading);
        // The flow's card (FocusedFlow's FlowCard): its art strip, then its body with the icon.
        const card = await o.page.evaluate(() => {
          const section = document.querySelector(
            'main section[class*="max-w-[41rem]"]',
          )!;
          const icon = section.lastElementChild!.firstElementChild!;
          return {
            art: section.firstElementChild!.checkVisibility(),
            // The icon no longer overlaps: it sits wholly inside the card.
            iconInside:
              icon.getBoundingClientRect().top >=
              section.getBoundingClientRect().top,
          };
        });
        expect
          .soft(card, `the flow card on ${s.path}`)
          .toEqual({ art: false, iconInside: true });
      } finally {
        await o.close();
      }
    }
  });

  it("Jump to a product gives focus back to its opener when closed without a jump", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", { width: 900 });
    try {
      await h1(o.page, "Your library");
      await o.page.locator("[data-library-grid=compact]").waitFor();
      const trigger = o.page
        .getByRole("banner")
        .getByRole("button", { name: "Jump to a product" });
      const dialog = o.page.getByRole("dialog", { name: "Jump to a product" });
      const focused = () =>
        o.page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent,
        );
      for (const width of [900, 1440]) {
        await o.page.setViewportSize({ width, height: 900 });
        await trigger.focus();
        await o.page.keyboard.press("Enter");
        await dialog.waitFor();
        await o.page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        // Radix hands focus back a task after the dialog unmounts.
        await expect
          .poll(focused, { message: `after Escape at ${width}` })
          .toBe("Jump to a product");
      }
      // ⌘K from a tile's link, then Escape: back on the link.
      const link = o.page
        .locator("[data-library-grid]")
        .getByRole("link", { name: "Glyphsmith", exact: true });
      await link.focus();
      await o.page.keyboard.press("Control+k");
      await dialog.waitFor();
      await o.page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await expect.poll(focused).toBe("Glyphsmith");
    } finally {
      await o.close();
    }
  });

  /**
   * How much of the focused element the sticky and fixed chrome covers (0 to 1): the header, the
   * section pills, the phone bar. Sampled on a 5 × 5 grid of points with `elementsFromPoint`, so
   * only chrome painted over it counts (the skip link draws above the header), and chrome that
   * holds the focus itself does not.
   */
  const coveredFocus = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const bars = [...document.querySelectorAll("header, nav")].filter(
        (b) =>
          ["fixed", "sticky"].includes(getComputedStyle(b).position) &&
          !b.contains(el),
      );
      let covered = 0;
      let total = 0;
      for (let i = 0; i < 5; i++)
        for (let j = 0; j < 5; j++) {
          const x = r.left + 1 + ((r.width - 2) * i) / 4;
          const y = r.top + 1 + ((r.height - 2) * j) / 4;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          total++;
          const top = document.elementFromPoint(x, y);
          if (top && !el.contains(top) && bars.some((b) => b.contains(top)))
            covered++;
        }
      return {
        covered: total ? covered / total : 0,
        what: `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`,
      };
    });

  it("Tab never leaves focus more than half under the sticky or fixed chrome", async ({
    expect,
  }) => {
    const pages = [
      { path: "/", heading: "Your library" },
      { path: "/#/p/nightfall", heading: "Nightfall" },
      { path: "/#/account", heading: "Account" },
    ];
    const sizes = [
      { width: 640, height: 400, dpr: 2 },
      { width: 667, height: 375 },
      { width: 390, height: 844 },
    ];
    for (const s of sizes)
      for (const pg of pages) {
        const o = await portal.open("three", pg.path, {
          width: s.width,
          height: s.height,
          deviceScaleFactor: s.dpr,
        });
        try {
          await h1(o.page, pg.heading);
          const seen = new Set<string>();
          for (let i = 0; i < 80; i++) {
            await o.page.keyboard.press("Tab");
            const f = await coveredFocus(o.page);
            if (!f) continue;
            if (seen.has(f.what) && i > 10) break;
            seen.add(f.what);
            expect
              .soft(
                f.covered,
                `${f.what} on ${pg.path} at ${s.width}×${s.height}`,
              )
              .toBeLessThanOrEqual(0.5);
          }
        } finally {
          await o.close();
        }
      }
  });

  it("a section jump on a short screen lands just under the sticky stack", async ({
    expect,
  }) => {
    for (const s of [
      { width: 740, height: 360, nav: "Sections" },
      { width: 1280, height: 480, nav: "On this page" },
    ]) {
      const o = await portal.open("three", "/#/p/nightfall", {
        width: s.width,
        height: s.height,
      });
      try {
        await h1(o.page, "Nightfall");
        await o.page
          .locator(`nav[aria-label="${s.nav}"] a[data-nav-section=license]`)
          .click();
        // Reduced motion: the jump is instant; give layout a frame.
        await o.page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => r(null))),
        );
        const { top, stack } = await o.page.evaluate(() => {
          const section = document.getElementById("section-license")!;
          const box = section.getBoundingClientRect();
          // The sticky stack: chrome stuck at the top that spans the section's column.
          let stack = 0;
          for (const bar of document.querySelectorAll("header, nav")) {
            const pos = getComputedStyle(bar).position;
            if (pos !== "fixed" && pos !== "sticky") continue;
            if (!bar.checkVisibility()) continue;
            const b = bar.getBoundingClientRect();
            if (b.top > 1 || b.right <= box.left || b.left >= box.right)
              continue;
            stack = Math.max(stack, b.bottom);
          }
          return { top: box.top, stack };
        });
        expect
          .soft(
            top - stack,
            `License's top under the stack at ${s.width}×${s.height}`,
          )
          .toBeGreaterThanOrEqual(0);
        expect
          .soft(
            top - stack,
            `License's top under the stack at ${s.width}×${s.height}`,
          )
          .toBeLessThanOrEqual(16);
      } finally {
        await o.close();
      }
    }
  });
});

describe("the target-size probe", () => {
  it("flags a crowded small target and excuses SC 2.5.8's exceptions", async ({
    expect,
  }) => {
    const o = await portal.open("signedOut", "/", { width: 800, height: 600 });
    try {
      await h1(o.page, /Sign in/);
      // Built through the CSSOM (the page's CSP refuses inline style attributes), with
      // appendChild: the Worker's types redeclare Element.append for HTMLRewriter.
      await o.page.evaluate(() => {
        const el = (
          tag: string,
          text: string,
          style: Partial<CSSStyleDeclaration> = {},
        ): HTMLElement => {
          const node = document.createElement(tag);
          node.textContent = text;
          Object.assign(node.style, style);
          return node;
        };
        const box = el("div", "", {
          position: "absolute",
          left: "0",
          top: "1600px",
          width: "600px",
        });
        const tiny = { width: "16px", height: "16px", padding: "0" };
        // Crowded: a 16 px button flush against a 40 px one.
        const row = el("div", "", { display: "flex" });
        row.appendChild(el("button", "crowded", tiny));
        row.appendChild(el("button", "big", { width: "40px", height: "40px" }));
        // Inline: a link in a sentence.
        const p = el("p", "Read the ");
        const terms = el("a", "terms");
        terms.setAttribute("href", "#terms");
        p.appendChild(terms);
        p.appendChild(document.createTextNode(" first."));
        // Spacing: a 16 px button with nothing within 12 px of its centre.
        const alone = el("button", "alone", { ...tiny, marginLeft: "300px" });
        // Visually hidden until focused.
        const skip = el("a", "hidden");
        skip.setAttribute("href", "#hidden");
        skip.className = "sr-only";
        for (const child of [row, p, alone, skip]) box.appendChild(child);
        document.body.appendChild(box);
      });
      expect(await smallTargets(o.page)).toEqual([
        'button "crowded" 16×16 crowded by button "big" 40×40',
      ]);
    } finally {
      await o.close();
    }
  });
});
