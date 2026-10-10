import { afterAll, beforeAll, describe, it } from "vitest";
import {
  axe,
  forcedColourBreaches,
  h1Count,
  horizontalOverflow,
  shoot,
  startPortal,
  unlabelledScrollers,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { SHIPPED } from "./portalStates.js";

/**
 * The customer site under the two contrast preferences (UI-KITS.md §7.1; WCAG 1.4.11): every
 * shipped §4 state, in both themes, with `forced-colors: active` (a Windows contrast theme) and
 * with `prefers-contrast: more`. Each render must still pass axe (its colour-contrast rule is off
 * under forced colours, where the system picks the colours), keep one `h1` and no horizontal
 * scroll; under forced colours every control also shows a boundary and every selected tab or
 * radio card a 2 px border (`forcedColourBreaches`). With `PK_SHOTS_DIR` set it saves
 * `<state>-forced-<theme>.png` and `<state>-more-<theme>.png` there.
 */

let portal: PortalHarness;

beforeAll(async () => {
  portal = await startPortal();
});

afterAll(async () => {
  await portal?.stop();
});

const THEMES: Theme[] = ["dark", "light"];

describe.concurrent(
  "every shipped §4 state under forced colours and more contrast",
  () => {
    for (const state of SHIPPED) {
      describe(`§${state.section} ${state.title} (${state.id})`, () => {
        for (const theme of THEMES) {
          it(`forced-colors, ${theme}`, async ({ expect }) => {
            const o = await portal.open(state.scenario, state.path, {
              theme,
              forcedColors: "active",
              routes: state.routes,
            });
            try {
              await state.ready(o.page);
              await shoot(o.page, `${state.id}-forced-${theme}`);
              expect
                .soft(
                  await axe(o.page, { forcedColors: true }),
                  "axe violations",
                )
                .toEqual([]);
              expect.soft(await h1Count(o.page), "visible h1 count").toBe(1);
              expect
                .soft(await horizontalOverflow(o.page), "horizontal scroll")
                .toBeLessThanOrEqual(0);
              expect
                .soft(
                  await forcedColourBreaches(o.page),
                  "forced-colour boundaries",
                )
                .toEqual([]);
              expect
                .soft(await unlabelledScrollers(o.page), "sideways tables")
                .toEqual([]);
            } finally {
              await o.close();
            }
          });
          it(`prefers-contrast: more, ${theme}`, async ({ expect }) => {
            const o = await portal.open(state.scenario, state.path, {
              theme,
              contrast: "more",
              routes: state.routes,
            });
            try {
              await state.ready(o.page);
              await shoot(o.page, `${state.id}-more-${theme}`);
              expect.soft(await axe(o.page), "axe violations").toEqual([]);
              expect.soft(await h1Count(o.page), "visible h1 count").toBe(1);
              expect
                .soft(await horizontalOverflow(o.page), "horizontal scroll")
                .toBeLessThanOrEqual(0);
            } finally {
              await o.close();
            }
          });
        }
      });
    }
  },
);
