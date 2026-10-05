import { afterAll, beforeAll, describe, it } from "vitest";
import {
  axe,
  h1Count,
  horizontalOverflow,
  matchBaseline,
  shoot,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { PENDING, SHIPPED } from "./portalStates.js";

/**
 * The customer site's quality bar (PORTAL.md §8, §9 item 10; PX-20). Every shipped §4 state, in
 * both themes at 1440 and 390 px:
 *
 * - zero Content-Security-Policy violations under the Worker's exact policy;
 * - zero axe violations (WCAG 2.2 A/AA and best practices);
 * - exactly one visible `h1`;
 * - no horizontal page scroll, at 1440 and at 360 px;
 * - its visual baseline (portalHarness.ts explains the platform sets and how to re-record).
 *
 * States whose work package has not landed are listed as todos with their package ids
 * (portalStates.ts), so the suite grows with each PX front-end package.
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

// Concurrent: each test has its own browser context, so up to vitest's `maxConcurrency` pages run
// side by side in the one Chromium.
describe.concurrent("every shipped §4 state passes the quality bar", () => {
  it("names each state once", ({ expect }) => {
    const ids = SHIPPED.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const state of SHIPPED) {
    describe(`§${state.section} ${state.title} (${state.id})`, () => {
      for (const theme of THEMES) {
        for (const w of WIDTHS) {
          it(`${theme}, ${w.width} px`, async ({ expect }) => {
            const o = await portal.open(state.scenario, state.path, {
              theme,
              width: w.width,
              height: w.height,
              routes: state.routes,
            });
            try {
              await state.ready(o.page);
              const name = `${state.id}-${w.label}-${theme}`;
              await shoot(o.page, name);
              expect.soft(await o.violations(), "CSP violations").toEqual([]);
              expect.soft(await axe(o.page), "axe violations").toEqual([]);
              expect.soft(await h1Count(o.page), "visible h1 count").toBe(1);
              expect
                .soft(await horizontalOverflow(o.page), "horizontal scroll")
                .toBeLessThanOrEqual(0);
              const visual = await matchBaseline(o.page, name);
              expect
                .soft(
                  visual.status === "match" || visual.status === "recorded",
                  visual.detail,
                )
                .toBe(true);
              if (w.width === 390) {
                await o.page.setViewportSize({ width: 360, height: 780 });
                await o.page.waitForTimeout(100);
                expect
                  .soft(
                    await horizontalOverflow(o.page),
                    "horizontal scroll at 360 px",
                  )
                  .toBeLessThanOrEqual(0);
              }
              expect
                .soft(await o.violations(), "CSP violations after checks")
                .toEqual([]);
            } finally {
              await o.close();
            }
          });
        }
      }
    });
  }
});

describe("§4 states still to build (PX-20 is rolling)", () => {
  for (const p of PENDING) {
    it.todo(`§${p.section} ${p.title} (${p.wp.join(", ")})`);
  }
});
