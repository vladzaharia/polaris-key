import { afterAll, beforeAll, describe, it } from "vitest";
import {
  axe,
  h1,
  h1Count,
  horizontalOverflow,
  RESOLUTIONS,
  shoot,
  smallTargets,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { portalRoutes, type Handler } from "./portalFixtures.js";
import { SHIPPED } from "./portalStates.js";

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
      RESOLUTIONS.forEach((size, i) => {
        const theme: Theme = i % 2 === 0 ? "dark" : "light";
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
          } finally {
            await o.close();
          }
        });
      });
    });
  }
});

/** A fixture's reply body, for a variation on it. */
function body<T>(h: Handler | undefined): T {
  const reply = typeof h === "function" ? h(undefined as never) : h;
  return reply!.body as T;
}

describe("the signed-in header (PORTAL.md §3.2, §8)", () => {
  // The widest realistic row: twelve products (so the ⌘K trigger), a two-digit Discover count and
  // a long name on the account chip.
  const twelve = portalRoutes("twelve");
  const me = body<{ account: Record<string, unknown> }>(twelve["/api/me"]);
  const routes = {
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
          name: "Maximiliana Fennick-Oyelaran",
          email: "maximiliana.fennick-oyelaran@fennick.studio",
        },
      },
    },
  };
  const WIDTHS = [
    761, 768, 800, 820, 844, 880, 899, 900, 960, 1024, 1100, 1179, 1180, 1280,
    1366, 1440, 1920, 2560,
  ];

  it("keeps every control on screen, inside the gutter, at every desktop width", async ({
    expect,
  }) => {
    const o = await portal.open("twelve", "/", { width: 761, routes });
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
          .toMatch(
            /Polaris Key: your library · Library12 · Discover24 · Jump to a product · Activate license · Account: Maximiliana Fennick-Oyelaran/,
          );
      }
    } finally {
      await o.close();
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
