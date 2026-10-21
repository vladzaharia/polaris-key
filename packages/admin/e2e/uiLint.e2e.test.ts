import { afterAll, beforeAll, describe, it } from "vitest";
import { lintFindings } from "./pageChecks.js";
import {
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { SHIPPED } from "./portalStates.js";

/**
 * `pnpm ui:lint --html` over the BUILT customer site at the wide and zoomed sizes (UI-KITS.md
 * §7.1; PX-26): the same in-page modernity lint that runs over the mockup boards and the kits'
 * own pages (`@polaris-key/ui-qa`, `lintPage`), every rule, on every shipped §4 state at 1920 × 1080, at 200 %
 * zoom (640 × 400 CSS px at 2) and at 400 % (320 × 256 at 4), in both themes. The console is
 * linted at the same sizes in `layout.e2e.test.ts`. From the command line, the same sizes run
 * against a live page with `pnpm ui:lint --html=<url> --size=1920x1080,640x400@2,320x256@4`.
 */

const SIZES = [
  { label: "1920", width: 1920, height: 1080, deviceScaleFactor: 1 },
  { label: "zoom200", width: 640, height: 400, deviceScaleFactor: 2 },
  { label: "zoom400", width: 320, height: 256, deviceScaleFactor: 4 },
] as const;
const THEMES: Theme[] = ["dark", "light"];

let portal: PortalHarness;

beforeAll(async () => {
  portal = await startPortal();
});

afterAll(async () => {
  await portal?.stop();
});

describe.concurrent(
  "ui:lint over the built customer site, wide and zoomed",
  () => {
    for (const state of SHIPPED) {
      describe(`§${state.section} ${state.title} (${state.id})`, () => {
        for (const size of SIZES) {
          for (const theme of THEMES) {
            it(`${size.label}, ${theme}`, async ({ expect }) => {
              const o = await portal.open(state.scenario, state.path, {
                theme,
                width: size.width,
                height: size.height,
                deviceScaleFactor: size.deviceScaleFactor,
                routes: state.routes,
              });
              try {
                await state.ready(o.page);
                // Below the `desk` breakpoint (760 px) the layout is the touch one: 44 px targets; above it 24 px.
                expect(
                  await lintFindings(
                    o.page,
                    // 24 px from the desk breakpoint up (WCAG 2.5.8), as the console.
                    { minTouch: size.width < 760 ? 44 : 24 },
                  ),
                ).toEqual([]);
              } finally {
                await o.close();
              }
            });
          }
        }
      });
    }
  },
);
